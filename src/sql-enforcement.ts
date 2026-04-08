export type FieldRestrictionMap = Record<string, string[]>;

// Aggregation functions that allow restricted columns when used as direct arguments.
// MIN/MAX are excluded because they return actual individual values (e.g. MIN(name) leaks a real name).
export const AGGREGATE_FUNCTIONS = ["count", "countif", "avg", "sum"];

export interface StarUsage {
  qualifier?: string;
  exceptColumns: Set<string>;
  exceptBareColumns: Set<string>;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTableAliasMap(sql: string): Record<string, string> {
  const aliasMap: Record<string, string> = {};
  const tableRefPattern = /\b(?:from|join)\s+([a-z0-9_.]+)(?:\s+(?:as\s+)?([a-z0-9_]+))?/g;
  let match: RegExpExecArray | null;

  while ((match = tableRefPattern.exec(sql)) !== null) {
    const [, tableName, alias] = match;
    if (alias) {
      aliasMap[alias] = tableName;
    }
  }

  return aliasMap;
}

export function referencesSameTable(candidate: string, expected: string): boolean {
  if (candidate === expected) {
    return true;
  }
  if (candidate.endsWith(`.${expected}`)) {
    return true;
  }
  return expected.endsWith(`.${candidate}`);
}

export function extractSelectClause(sql: string): string {
  const clauses: string[] = [];

  // Standard SQL: SELECT ... FROM
  const standardMatch = sql.match(/\bselect\b([\s\S]*?)\bfrom\b/);
  if (standardMatch) {
    clauses.push(standardMatch[1]);
  }

  // Pipe syntax: |> SELECT ... (terminated by next pipe operator, end of string, or semicolon)
  const pipeSelectPattern = /\|>\s*select\b([\s\S]*?)(?=\|>|;|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pipeSelectPattern.exec(sql)) !== null) {
    clauses.push(match[1]);
  }

  return clauses.join(' , ');
}

export function parseExceptColumns(segment: string): { full: Set<string>; bare: Set<string> } {
  const full = new Set<string>();
  const bare = new Set<string>();

  segment
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      const cleaned = value.replace(/`/g, '');
      const normalized = cleaned.toLowerCase();
      full.add(normalized);

      const bareName = normalized.split('.').pop();
      if (bareName) {
        bare.add(bareName);
      }
    });

  return { full, bare };
}

export function extractStarUsages(selectClause: string): StarUsage[] {
  const usages: StarUsage[] = [];
  if (!selectClause) {
    return usages;
  }

  const starPattern = /(?:\b([a-z0-9_.]+)\.)?\*\s*(?:except\s*\(([^)]+)\))?/g;
  let match: RegExpExecArray | null;

  while ((match = starPattern.exec(selectClause)) !== null) {
    const matchIndex = match.index ?? starPattern.lastIndex - match[0].length;
    const precedingIndex = matchIndex - 1;
    const charBefore = precedingIndex >= 0 ? selectClause[precedingIndex] : ' ';

    if (charBefore === '(') {
      // Likely part of COUNT(*) or similar aggregate; skip.
      continue;
    }

    if (matchIndex > 0 && !/[,\s]/.test(charBefore)) {
      // Skip tokens appearing in string literals or identifiers (e.g. '*_suffix').
      continue;
    }

    const qualifier = match[1]?.toLowerCase();
    const exceptSegment = match[2];
    const exceptColumns = new Set<string>();
    const exceptBareColumns = new Set<string>();

    if (exceptSegment) {
      const parsed = parseExceptColumns(exceptSegment);
      parsed.full.forEach((value) => exceptColumns.add(value));
      parsed.bare.forEach((value) => exceptBareColumns.add(value));
    }

    usages.push({ qualifier, exceptColumns, exceptBareColumns });
  }

  return usages;
}

export function starUsageCoversField(
  usage: StarUsage,
  field: string,
  tableName: string,
  aliasToTableMap: Record<string, string>,
): boolean {
  if (usage.exceptBareColumns.has(field)) {
    return true;
  }

  if (usage.exceptColumns.has(field)) {
    return true;
  }

  if (usage.exceptColumns.has(`${tableName}.${field}`)) {
    return true;
  }

  if (!usage.qualifier) {
    return false;
  }

  const qualifier = usage.qualifier;
  if (usage.exceptColumns.has(`${qualifier}.${field}`)) {
    return true;
  }

  const resolvedTable = aliasToTableMap[qualifier];
  if (resolvedTable) {
    if (usage.exceptColumns.has(`${resolvedTable}.${field}`)) {
      return true;
    }
    if (usage.exceptBareColumns.has(field) && referencesSameTable(resolvedTable, tableName)) {
      return true;
    }
  }

  return false;
}

// Strip SQL comments and string literals so they don't trigger false positives
// in field reference checks.
export function stripCommentsAndLiterals(sql: string): string {
  return sql
    // Remove single-line comments (-- ...)
    .replace(/--[^\n]*/g, '')
    // Remove multi-line comments (/* ... */)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove single-quoted string literals ('...')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // Remove double-quoted identifiers ("...")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function enforceFieldRestrictions(sql: string, restrictions: FieldRestrictionMap): void {
  if (!Object.keys(restrictions).length) {
    return;
  }

  const normalizedSql = stripCommentsAndLiterals(sql.replace(/`/g, '')).toLowerCase();
  const blockedColumnsByTable: Record<string, Set<string>> = {};
  const aliasToTableMap = buildTableAliasMap(normalizedSql);
  const selectClause = extractSelectClause(normalizedSql);
  const starUsages = extractStarUsages(selectClause);

  for (const [tableName, restrictedFields] of Object.entries(restrictions)) {
    if (!normalizedSql.includes(tableName)) {
      continue;
    }

    // --- Struct-alias bypass detection ---
    // SELECT t FROM users AS t returns the whole row as a STRUCT, leaking all fields.
    // Detect bare table names or aliases in the SELECT clause not followed by a dot.
    const structAliasViolation = ((): boolean => {
      if (!selectClause.trim()) return false;

      // Check aliases that resolve to this restricted table
      for (const [alias, resolvedTable] of Object.entries(aliasToTableMap)) {
        if (!referencesSameTable(resolvedTable, tableName)) continue;
        const bareAliasPattern = new RegExp(`\\b${escapeRegExp(alias)}\\b(?!\\.)`);
        if (bareAliasPattern.test(selectClause)) return true;
      }

      // Check if the table name itself appears bare in the SELECT clause (not followed by a dot)
      const parts = tableName.split('.');
      const shortName = parts[parts.length - 1];
      const bareTablePattern = new RegExp(`\\b${escapeRegExp(shortName)}\\b(?!\\.)`);
      if (bareTablePattern.test(selectClause)) {
        // Make sure this isn't just a field name or keyword that happens to match
        // by checking whether the short name is actually used as a FROM/alias target
        const isTableRef = normalizedSql.includes(tableName) &&
          (aliasToTableMap[shortName] !== undefined ||
           new RegExp(`\\bfrom\\b[^]*\\b${escapeRegExp(shortName)}\\b`).test(normalizedSql));
        if (isTableRef) return true;
      }

      return false;
    })();

    if (structAliasViolation) {
      if (!blockedColumnsByTable[tableName]) {
        blockedColumnsByTable[tableName] = new Set<string>();
      }
      for (const field of restrictedFields) {
        blockedColumnsByTable[tableName].add(field);
      }
      continue; // Already fully blocked, skip further checks for this table
    }

    const qualifiedStarPattern = new RegExp(`\\b${escapeRegExp(tableName)}\\.\\*`);
    const aliasStarDetected = Object.entries(aliasToTableMap).some(([alias, referencedTable]) => {
      if (!referencesSameTable(referencedTable, tableName)) {
        return false;
      }
      const aliasPattern = new RegExp(`\\b${escapeRegExp(alias)}\\.\\*`);
      return aliasPattern.test(normalizedSql);
    });

    const relevantStarUsages = starUsages.filter((usage) => {
      if (!usage.qualifier) {
        return true;
      }

      const resolved = aliasToTableMap[usage.qualifier] ?? usage.qualifier;
      return referencesSameTable(resolved, tableName);
    });

    // If there's no SELECT or AGGREGATE clause (e.g. FROM table |> LIMIT 10),
    // all columns are returned implicitly — treat as SELECT * violation.
    // AGGREGATE queries are safe since they only return aggregate results.
    const hasNoSelectClause = !selectClause.trim()
      && !/\|>\s*aggregate\b/.test(normalizedSql);

    const starViolation = ((): boolean => {
      if (hasNoSelectClause) {
        return true;
      }

      if (!relevantStarUsages.length && !qualifiedStarPattern.test(normalizedSql) && !aliasStarDetected) {
        return false;
      }

      if (!relevantStarUsages.length) {
        return true;
      }

      return relevantStarUsages.some((usage) => {
        if (!usage.exceptBareColumns.size && !usage.exceptColumns.size) {
          return true;
        }

        return restrictedFields.some((field) => !starUsageCoversField(usage, field, tableName, aliasToTableMap));
      });
    })();

    if (starViolation) {
      if (!blockedColumnsByTable[tableName]) {
        blockedColumnsByTable[tableName] = new Set<string>();
      }
      for (const field of restrictedFields) {
        blockedColumnsByTable[tableName].add(field);
      }
    }

    for (const field of restrictedFields) {
      const fieldPattern = new RegExp(`\\b${escapeRegExp(field)}\\b`);
      // Match aggregate functions containing the restricted field, including complex
      // expressions like COUNTIF(field IS NOT NULL) or COUNT(DISTINCT field).
      // Uses a non-greedy match for the closing paren to handle nested expressions.
      const aggregatePattern = new RegExp(
        `\\b(?:${AGGREGATE_FUNCTIONS.join('|')})\\s*\\([^)]*\\b${escapeRegExp(field)}\\b[^)]*\\)`,
        'g',
      );

      // Remove aggregate usages and EXCEPT clauses before checking for direct field references
      const sqlWithoutAggregatedUsage = normalizedSql
        .replace(aggregatePattern, '')
        .replace(/\bexcept\s*\([^)]*\)/g, '');

      if (fieldPattern.test(sqlWithoutAggregatedUsage)) {
        if (!blockedColumnsByTable[tableName]) {
          blockedColumnsByTable[tableName] = new Set<string>();
        }
        blockedColumnsByTable[tableName].add(field);
      }
    }
  }

  if (Object.keys(blockedColumnsByTable).length) {
    // Report ALL restricted fields per table (not just the violated ones)
    // so the AI agent can fix the query in one try without a retry loop.
    const messageDetails = Object.entries(blockedColumnsByTable)
      .map(([table]) => {
        const allRestricted = restrictions[table];
        const columns = allRestricted.map((column) => `"${column}"`).join(', ');
        return `table "${table}" has restricted columns: ${columns}`;
      })
      .join('; ');

    const allowedAggregates = `[${AGGREGATE_FUNCTIONS.map((fn) => `"${fn}"`).join(', ')}]`;

    throw new Error(`Restricted fields detected — ${messageDetails}. You can only use these columns inside ${allowedAggregates} aggregate functions or exclude them with SELECT * EXCEPT (...).`);
  }
}

// --- allowedTables enforcement ---

// Extract CTE names defined in WITH clauses
function extractCteNames(sql: string): Set<string> {
  const cteNames = new Set<string>();

  // Match: WITH name AS ( or , name AS (
  const withPattern = /\bwith\s+([a-z0-9_]+)\s+as\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = withPattern.exec(sql)) !== null) {
    cteNames.add(match[1]);
  }

  // Match comma-separated CTEs: , name AS (
  const commaCtePattern = /,\s*([a-z0-9_]+)\s+as\s*\(/g;
  while ((match = commaCtePattern.exec(sql)) !== null) {
    cteNames.add(match[1]);
  }

  return cteNames;
}

// Extract all table names referenced in FROM (including comma-separated) and JOIN clauses.
// Filters out CTE names. Does NOT filter INFORMATION_SCHEMA (caller decides).
export function extractReferencedTables(sql: string): string[] {
  const normalizedSql = stripCommentsAndLiterals(sql.replace(/`/g, '')).toLowerCase();
  const cteNames = extractCteNames(normalizedSql);
  const tables: string[] = [];

  // Match FROM clause with comma-separated table list.
  // Captures everything after FROM up to the next SQL keyword, pipe operator, closing paren, or semicolon.
  const fromPattern = /\bfrom\s+((?:[a-z0-9_.]+(?:\s*,\s*[a-z0-9_.]+)*))/g;
  let match: RegExpExecArray | null;

  while ((match = fromPattern.exec(normalizedSql)) !== null) {
    const tableList = match[1];
    for (const tablePart of tableList.split(',')) {
      const trimmed = tablePart.trim().split(/\s/)[0]; // Take only the table name, not alias
      if (trimmed && /^[a-z0-9_.]+$/.test(trimmed)) {
        tables.push(trimmed);
      }
    }
  }

  // Match JOIN clauses (LEFT JOIN, INNER JOIN, CROSS JOIN, etc.)
  const joinPattern = /\bjoin\s+([a-z0-9_.]+)/g;
  while ((match = joinPattern.exec(normalizedSql)) !== null) {
    tables.push(match[1]);
  }

  // Deduplicate and filter out CTE names
  const unique = [...new Set(tables)];
  return unique.filter((t) => !cteNames.has(t));
}

// Check if a queried table matches an allowed entry (bidirectional suffix matching).
// Delegates to referencesSameTable — identical logic.
export function tableMatchesAllowedEntry(queriedTable: string, allowedEntry: string): boolean {
  return referencesSameTable(queriedTable, allowedEntry);
}

// Gate: throw if any referenced table is not in the allowed list.
// Fail-closed: throws if SQL contains FROM/SELECT but no tables extracted.
export function enforceAllowedTables(sql: string, allowedTables: string[]): void {
  if (!allowedTables.length) {
    throw new Error(
      'No tables are configured as allowed. Add tables to the allowedTables list in your config file.',
    );
  }

  const normalizedAllowed = allowedTables.map((t) => t.toLowerCase());
  const referencedTables = extractReferencedTables(sql);

  // Fail-closed: if the SQL appears to read data but we extracted no tables, reject it
  const normalizedSql = sql.toLowerCase();
  if (referencedTables.length === 0 && /\b(from|select)\b/.test(normalizedSql)) {
    throw new Error(
      'Unable to determine referenced tables. Query blocked for safety in allowedTables mode.',
    );
  }

  // Filter out INFORMATION_SCHEMA references (metadata queries, not data access)
  const dataTableRefs = referencedTables.filter((t) => !t.includes('information_schema'));

  const disallowedTables = dataTableRefs.filter(
    (queried) => !normalizedAllowed.some((allowed) => tableMatchesAllowedEntry(queried, allowed)),
  );

  if (disallowedTables.length > 0) {
    const tableList = disallowedTables.map((t) => `"${t}"`).join(', ');
    const allowedList = normalizedAllowed.map((t) => `"${t}"`).join(', ');
    throw new Error(
      `Access denied: table(s) ${tableList} not in the allowed tables list. ` +
      `Allowed tables: ${allowedList}. ` +
      `To query these tables, add them to the "allowedTables" array in your config.json.`,
    );
  }
}

/**
 * Validates that the statementType returned by BigQuery's dry run is SELECT.
 * Throws if the statement is anything else (INSERT, UPDATE, DELETE, EXPORT DATA,
 * LOAD DATA, CALL, DECLARE, SET, etc.), preventing write operations regardless
 * of how they are spelled or obfuscated.
 */
export function validateIsSelectStatement(statementType: string | undefined): void {
  if (statementType !== 'SELECT') {
    throw new Error(
      `Only SELECT queries are allowed. This query was identified as: ${statementType ?? 'UNKNOWN'}`,
    );
  }
}
