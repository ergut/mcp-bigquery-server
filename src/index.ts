#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BigQuery } from '@google-cloud/bigquery';

import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import { runDailyScanIfNeeded } from './sensitive-field-scanner.js';
import {
  enforceFieldRestrictions,
  enforceAllowedTables,
  validateIsSelectStatement,
  type FieldRestrictionMap,
} from './sql-enforcement.js';

// Define configuration interface
interface ServerConfig {
  projectId: string;
  location?: string;
  keyFilename?: string;
  configFile?: string;
  maximumBytesBilled?: string;
}

// Define BigQuery configuration interfaces (discriminated union by protectionMode)
type ProtectionMode = 'off' | 'allowedTables' | 'autoProtect';

interface BigQueryConfigBase {
  maximumBytesBilled: string;
}

interface BigQueryConfigOff extends BigQueryConfigBase {
  protectionMode: 'off';
}

interface BigQueryConfigAllowedTables extends BigQueryConfigBase {
  protectionMode: 'allowedTables';
  allowedTables: string[];
  preventedFieldsInAllowedTables: FieldRestrictionMap;
}

interface BigQueryConfigAutoProtect extends BigQueryConfigBase {
  protectionMode: 'autoProtect';
  preventedFields: FieldRestrictionMap;
}

type BigQueryConfig = BigQueryConfigOff | BigQueryConfigAllowedTables | BigQueryConfigAutoProtect;

async function validateConfig(config: ServerConfig): Promise<void> {
  // Check if key file exists and is readable
  if (config.keyFilename) {
    const resolvedKeyPath = path.resolve(config.keyFilename);
    try {
      await fs.access(resolvedKeyPath, fsConstants.R_OK);
      // Update the config to use the resolved path
      config.keyFilename = resolvedKeyPath;
    } catch (error) {
      console.error('File access error details:', error);
      if (error instanceof Error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'EACCES') {
          throw new Error(`Permission denied accessing key file: ${resolvedKeyPath}. Please check file permissions.`);
        } else if (nodeError.code === 'ENOENT') {
          throw new Error(`Key file not found: ${resolvedKeyPath}. Please verify the file path.`);
        } else {
          throw new Error(`Unable to access key file: ${resolvedKeyPath}. Error: ${nodeError.message}`);
        }
      } else {
        throw new Error(`Unexpected error accessing key file: ${resolvedKeyPath}`);
      }
    }

    // Validate file contents
    try {
      const keyFileContent = await fs.readFile(config.keyFilename, 'utf-8');
      const keyData = JSON.parse(keyFileContent);
      
      // Basic validation of key file structure
      if (!keyData.type || keyData.type !== 'service_account' || !keyData.project_id) {
        throw new Error('Invalid service account key file format');
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Service account key file is not valid JSON');
      }
      throw error;
    }
  }

  if (config.configFile) {
    const resolvedConfigPath = path.resolve(config.configFile);
    try {
      await fs.access(resolvedConfigPath, fsConstants.R_OK);
      config.configFile = resolvedConfigPath;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'ENOENT') {
        configError = `Config file not found: ${resolvedConfigPath}. Your MCP server is configured with --config-file, which requires a valid config file. To fix this: (1) create a config file at the path above (see the example in the repository: https://github.com/ergut/mcp-bigquery-server), or (2) correct the path in --config-file, or (3) remove the --config-file flag from your MCP server settings to run without protection.`;
        console.error(configError);
      } else if (nodeError?.code === 'EACCES') {
        configError = `Permission denied accessing config file: ${resolvedConfigPath}. Please check file permissions.`;
        console.error(configError);
      } else {
        configError = `Unable to access config file: ${resolvedConfigPath}. Error: ${nodeError?.message ?? 'Unknown error'}`;
        console.error(configError);
      }
    }
  }

  // Validate project ID format (basic check)
  if (!/^[a-z0-9-]+$/.test(config.projectId)) {
    throw new Error('Invalid project ID format');
  }
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  const config: ServerConfig = {
    projectId: '',
    location: 'US' 
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Invalid argument: ${arg}`);
    }

    const key = arg.slice(2);
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
      throw new Error(`Missing value for argument: ${arg}`);
    }

    const value = args[++i];
    
    switch (key) {
      case 'project-id':
        config.projectId = value;
        break;
      case 'location':
        config.location = value;
        break;
      case 'key-file':
        config.keyFilename = value;
        break;
      case 'config-file':
        config.configFile = value;
        break;
      case 'maximum-bytes-billed':
        config.maximumBytesBilled = value;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config.projectId) {
    throw new Error(
      "Missing required argument: --project-id\n" +
      "Usage: mcp-server-bigquery --project-id <project-id> [--location <location>] [--key-file <path-to-key-file>] [--config-file <path-to-config-file>] [--maximum-bytes-billed <maximum-bytes>]"
    );
  }

  return config;
}

const server = new Server(
  {
    name: "mcp-server/bigquery",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

let config: ServerConfig;
let bigquery: BigQuery;
let resourceBaseUrl: URL;

let bigqueryConfig: BigQueryConfig;
let configError: string | null = null;

function parseFieldRestrictionMap(raw: unknown, label: string): FieldRestrictionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const normalized: FieldRestrictionMap = {};
  for (const [tableName, fields] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string')) {
      throw new Error(`Invalid field list for table "${tableName}" in ${label}. Each value must be an array of column name strings.`);
    }
    normalized[tableName.toLowerCase()] = (fields as string[]).map((field) => field.toLowerCase());
  }
  return normalized;
}

async function loadConfiguration(configFile?: string): Promise<BigQueryConfig> {
  // No --config-file flag → simple/off mode (no auto-discovery)
  if (!configFile) {
    console.error('No --config-file flag provided — protection mode: off');
    return { protectionMode: 'off', maximumBytesBilled: '1000000000' };
  }

  const resolvedPath = path.resolve(configFile);
  let fileContents: string;

  try {
    fileContents = await fs.readFile(resolvedPath, 'utf-8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    throw new Error(`Unable to read config file ${resolvedPath}: ${nodeError?.message ?? 'Unknown error'}`);
  }

  try {
    const parsed = JSON.parse(fileContents);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Config file must be a JSON object.');
    }

    const raw = parsed as Record<string, unknown>;

    // Validate maximumBytesBilled
    if (!raw.maximumBytesBilled || typeof raw.maximumBytesBilled !== 'string') {
      throw new Error('Config file must contain a maximumBytesBilled string property.');
    }
    const maximumBytesBilled = raw.maximumBytesBilled;

    // Resolve protection mode
    const rawMode = raw.protectionMode as string | undefined;
    const validModes: ProtectionMode[] = ['off', 'allowedTables', 'autoProtect'];

    if (rawMode !== undefined && !validModes.includes(rawMode as ProtectionMode)) {
      throw new Error(
        `Unknown protectionMode "${rawMode}". Valid values: ${validModes.map((m) => `"${m}"`).join(', ')}`,
      );
    }

    // Explicit "off" mode
    if (rawMode === 'off') {
      console.error(`Protection mode: off (from ${resolvedPath})`);
      return { protectionMode: 'off', maximumBytesBilled };
    }

    // "allowedTables" mode
    if (rawMode === 'allowedTables') {
      if (!Array.isArray(raw.allowedTables) || raw.allowedTables.some((t: unknown) => typeof t !== 'string')) {
        throw new Error('allowedTables mode requires an "allowedTables" array of table name strings.');
      }
      const allowedTables = (raw.allowedTables as string[]).map((t) => t.toLowerCase());
      if (allowedTables.length === 0) {
        throw new Error('allowedTables array is empty. At least one table must be listed, otherwise no queries can execute.');
      }
      const preventedFieldsInAllowedTables = parseFieldRestrictionMap(
        raw.preventedFieldsInAllowedTables,
        'preventedFieldsInAllowedTables',
      );

      console.error(`Protection mode: allowedTables (${allowedTables.length} tables, field restrictions for ${Object.keys(preventedFieldsInAllowedTables).length} tables) from ${resolvedPath}`);
      return {
        protectionMode: 'allowedTables',
        maximumBytesBilled,
        allowedTables,
        preventedFieldsInAllowedTables,
      };
    }

    // "autoProtect" mode (explicit or implicit via missing protectionMode key — backward compatible)
    const preventedFields = parseFieldRestrictionMap(raw.preventedFields, 'preventedFields');

    console.error(`Protection mode: autoProtect, maximumBytesBilled=${maximumBytesBilled}, field restrictions for ${Object.keys(preventedFields).length} tables from ${resolvedPath}`);
    return {
      protectionMode: 'autoProtect',
      maximumBytesBilled,
      preventedFields,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Config file is not valid JSON');
    }
    throw error;
  }
}

try {
  config = parseArgs();
  await validateConfig(config);
  
  console.error(`Initializing BigQuery with project ID: ${config.projectId} and location: ${config.location}`);
  
  const bigqueryOptions: {
    projectId: string;
    keyFilename?: string;
  } = {
    projectId: config.projectId
  };
  
  if (config.keyFilename) {
    console.error(`Using service account key file: ${config.keyFilename}`);
    bigqueryOptions.keyFilename = config.keyFilename;
  }
  
  bigquery = new BigQuery(bigqueryOptions);
  resourceBaseUrl = new URL(`bigquery://${config.projectId}`);

  // Load config first to determine protection mode
  if (configError) {
    // Config file was specified but inaccessible — server starts but queries are blocked
    bigqueryConfig = { protectionMode: 'off', maximumBytesBilled: config.maximumBytesBilled ?? '1000000000' };
  } else {
    bigqueryConfig = await loadConfiguration(config.configFile);
  }

  // Only run auto-scan in autoProtect mode
  if (!configError && bigqueryConfig.protectionMode === 'autoProtect') {
    const configFilePath = path.resolve(config.configFile!);
    try {
      await runDailyScanIfNeeded(bigquery, configFilePath, config.location);
      // Re-load config after scan may have updated preventedFields
      bigqueryConfig = await loadConfiguration(config.configFile);
    } catch (error) {
      console.error('Warning: daily sensitive field scan failed, using existing config.', error);
      if (bigqueryConfig.protectionMode === 'autoProtect' &&
          Object.keys(bigqueryConfig.preventedFields).length === 0) {
        // Fail closed: scan failed and no fields configured — block all queries
        configError = 'autoProtect mode: the sensitive field scanner failed and no '
          + 'existing field restrictions are configured. Queries are blocked to prevent '
          + 'accidental exposure of sensitive data. To fix: check BigQuery connectivity, '
          + 'verify your config file, run the scanner manually (npm run scan-fields), '
          + 'or switch to a different protection mode.';
        console.error(configError);
      }
    }
  }

  // CLI --maximum-bytes-billed overrides config file value when explicitly provided
  // Applied after config reload so it isn't overwritten by the scanner's re-read
  if (config.maximumBytesBilled) {
    bigqueryConfig.maximumBytesBilled = config.maximumBytesBilled;
  }
} catch (error) {
  console.error('Initialization error:', error);
  process.exit(1);
}

const SCHEMA_PATH = "schema";

function qualifyTablePath(sql: string, projectId: string): string {
  // Match FROM INFORMATION_SCHEMA.TABLES or FROM dataset.INFORMATION_SCHEMA.TABLES
  const unqualifiedPattern = /FROM\s+(?:(\w+)\.)?INFORMATION_SCHEMA\.TABLES/gi;
  return sql.replace(unqualifiedPattern, (match, dataset) => {
    if (dataset) {
      return `FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.TABLES\``;
    }
    throw new Error("Dataset must be specified when querying INFORMATION_SCHEMA (e.g. dataset.INFORMATION_SCHEMA.TABLES)");
  });
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    console.error('Fetching datasets...');
    const [datasets] = await bigquery.getDatasets();
    console.error(`Found ${datasets.length} datasets`);
    
    const resources = [];

    for (const dataset of datasets) {
      console.error(`Processing dataset: ${dataset.id}`);
      const [tables] = await dataset.getTables();
      console.error(`Found ${tables.length} tables and views in dataset ${dataset.id}`);
      
      for (const table of tables) {
        // Get the metadata to check if it's a table or view
        const [metadata] = await table.getMetadata();
        const resourceType = metadata.type === 'VIEW' ? 'view' : 'table';
        
        resources.push({
          uri: new URL(`${dataset.id}/${table.id}/${SCHEMA_PATH}`, resourceBaseUrl).href,
          mimeType: "application/json",
          name: `"${dataset.id}.${table.id}" ${resourceType} schema`,
        });
      }
    }

    console.error(`Total resources found: ${resources.length}`);
    return { resources };
  } catch (error) {
    console.error('Error in ListResourcesRequestSchema:', error);
    throw error;
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);
  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableId = pathComponents.pop();
  const datasetId = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const dataset = bigquery.dataset(datasetId!);
  const table = dataset.table(tableId!);
  const [metadata] = await table.getMetadata();

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(metadata.schema.fields, null, 2),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only BigQuery SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query") {
    // Block all queries if config file is missing/inaccessible
    if (configError) {
      return {
        content: [{ type: "text", text: configError }],
        isError: true,
      };
    }

    let sql = request.params.arguments?.sql as string;

    try {
      // Qualify INFORMATION_SCHEMA queries
      if (sql.toUpperCase().includes('INFORMATION_SCHEMA')) {
        sql = qualifyTablePath(sql, config.projectId);
      }

      // Enforce protection based on active mode
      switch (bigqueryConfig.protectionMode) {
        case 'off':
          break;
        case 'allowedTables':
          enforceAllowedTables(sql, bigqueryConfig.allowedTables);
          enforceFieldRestrictions(sql, bigqueryConfig.preventedFieldsInAllowedTables);
          break;
        case 'autoProtect':
          enforceFieldRestrictions(sql, bigqueryConfig.preventedFields);
          break;
      }

      // Use BigQuery's dry run to definitively verify this is a SELECT statement.
      // This is more reliable than a regex blocklist — the API parses the SQL and
      // reports the actual statementType, so EXPORT DATA, LOAD DATA, CALL, DECLARE,
      // SET and any future write-capable statements are all blocked automatically.
      const [dryRunJob] = await bigquery.createQueryJob({
        query: sql,
        location: config.location,
        dryRun: true,
      });
      const statementType = dryRunJob.metadata?.statistics?.query?.statementType;
      validateIsSelectStatement(statementType);

      const [rows] = await bigquery.query({
        query: sql,
        location: config.location,
        maximumBytesBilled: bigqueryConfig.maximumBytesBilled,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred while executing the query.';
      console.error('Query tool error:', error);

      // Enforcement errors (field restrictions, table allowlist) are returned as
      // non-errors so the LLM can reformulate its query based on the guidance.
      if (error instanceof Error && (
        message.includes('Only SELECT queries are allowed') ||
        message.includes('Restricted fields') ||
        message.includes('Access denied') ||
        message.includes('Unable to determine')
      )) {
        return {
          content: [{ type: "text", text: message }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('BigQuery MCP server running on stdio');
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('An unknown error occurred:', error);
    }
    process.exit(1);
  }
}

runServer().catch(console.error);
