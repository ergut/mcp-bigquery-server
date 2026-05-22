# BigQuery MCP Server
<div align="center">
  <img src="assets/mcp-bigquery-server-logo.png" alt="BigQuery MCP Server Logo" width="400"/>
</div>

## What is this? 🤔

This is a server that lets your LLMs (like Claude) talk directly to your BigQuery data — **read-only, with no ability to mutate your warehouse**. Think of it as a friendly translator that sits between your AI assistant and your database, making sure they can chat securely and efficiently.

### Quick Example
```text
You: "What were our top 10 customers last month?"
Claude: *queries your BigQuery database and gives you the answer in plain English*
```

No more writing SQL queries by hand - just chat naturally with your data!

## How Does It Work? 🛠️

This server uses the Model Context Protocol (MCP), which is like a universal translator for AI-database communication. MCP is supported by Claude Desktop, Claude Code, and a growing number of other AI clients.

Here's all you need to do:
1. Set up authentication (see below)
2. Add your project details to your MCP client's config file
3. Start chatting with your BigQuery data naturally!

### What Can It Do? 📊

- **Read-only by design** — only `SELECT` statements are allowed. Every query is validated by BigQuery's own dry-run planner before execution, so `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `EXPORT DATA`, and `MERGE` are all rejected. The AI agent cannot mutate your warehouse, period.
- Run SQL queries by just asking questions in plain English
- Access both tables and materialized views in your datasets
- Explore dataset schemas with clear labeling of resource types (tables vs views)
- Analyze data within configurable safe limits (set via `config.json` or `--maximum-bytes-billed`)
- **Protect sensitive data** — define field-level access restrictions to prevent AI agents from reading PII, PHI, financial data, and secrets. The agent receives clear guidance on how to reformulate queries using aggregates or `EXCEPT` clauses, so it remains useful without exposing individual records.
- **Auto-discover sensitive fields** — automatically scan your entire BigQuery data warehouse for columns matching sensitive patterns (names, emails, SSNs, medical records, API keys, etc.) and add them to the restricted list. New tables and columns are protected automatically on each scan — no manual maintenance required.
- **Fully configurable** — everything is driven by `config.json`. Add your own detection patterns to match your organization's naming conventions (e.g., `%guardian_name%`, `%beneficiary%`), adjust scan frequency, set billing limits, and define per-table field restrictions. The scanner picks up your custom patterns on the next run and automatically protects any matching columns across all datasets.

## Which Setup Is Right for You?

| | Simple Mode | Protected Mode |
|---|---|---|
| **Use when** | Personal projects, non-sensitive data | PHI, PII, financial data, HIPAA-regulated environments |
| **Install** | `npx` — no local setup needed | `npx` or local build with a `config.json` |
| **Field restrictions** | None | Define `preventedFields` to block sensitive columns |
| **Auto-scanner** | Not available | Discovers sensitive columns across all datasets automatically |
| **Setup** | [Quick Setup](#quick-setup) below | [Protected Mode Setup](#protected-mode-setup) below |

**Why local deployment matters for sensitive data:** LLM inference happens in the cloud. When an AI agent queries BigQuery, the results are sent to the LLM provider's servers (Anthropic, OpenAI, etc.) for processing — they leave your network. BigQuery IAM controls who can *reach* your data; field restrictions control what the *AI agent surfaces into LLM responses*. These are different protection boundaries. Configuring `preventedFields` ensures PHI and PII never enter the LLM conversation context, regardless of how many queries the agent runs autonomously.

## Quick Start 🚀

### Prerequisites
- Node.js 14 or higher
- Google Cloud project with BigQuery enabled
- Either Google Cloud CLI installed or a service account key file
- Any MCP-compatible client (Claude Desktop, Claude Code, etc.)

### Quick Setup

1. **Authenticate with Google Cloud:**
   ```bash
   gcloud auth application-default login
   ```

2. **Add to your MCP client's config** (e.g., `claude_desktop_config.json` for Claude Desktop, `.mcp.json` for Claude Code):
   ```json
   {
     "mcpServers": {
       "bigquery": {
         "command": "npx",
         "args": [
           "-y",
           "@ergut/mcp-bigquery-server",
           "--project-id",
           "your-project-id"
         ]
       }
     }
   }
   ```

3. **Start chatting!** Open your MCP client and ask questions about your data.

### Protected Mode Setup

For sensitive data with field-level restrictions:

1. **Authenticate with Google Cloud** (choose one method):
   - Using Google Cloud CLI (great for development):
     ```bash
     gcloud auth application-default login
     ```
   - Using a service account (recommended for production):
     ```bash
     # Save your service account key file and use --key-file parameter
     # Remember to keep your service account key file secure and never commit it to version control
     ```

2. **Add to your MCP client's config** (e.g., `claude_desktop_config.json` for Claude Desktop, `.mcp.json` for Claude Code):

   - With Application Default Credentials:
     ```json
     {
       "mcpServers": {
         "bigquery": {
           "command": "npx",
           "args": [
             "-y",
             "@ergut/mcp-bigquery-server",
             "--project-id",
             "your-project-id",
             "--location",
             "us-central1",
             "--config-file",
             "/path/to/config.json"
           ]
         }
       }
     }
     ```

   - With a service account key file:
     ```json
     {
       "mcpServers": {
         "bigquery": {
           "command": "npx",
           "args": [
             "-y",
             "@ergut/mcp-bigquery-server",
             "--project-id",
             "your-project-id",
             "--location",
             "us-central1",
             "--key-file",
             "/path/to/service-account-key.json",
             "--config-file",
             "/path/to/config.json"
           ]
         }
       }
     }
     ```


3. **Start chatting!**
   Open your MCP client and start asking questions about your data.

## Configuration

The server supports an optional `config.json` file for advanced configuration. Without a config file (i.e., no `--config-file` flag), the server runs in Simple Mode with safe defaults (1GB query limit, no field restrictions). To enable protection, pass `--config-file /path/to/config.json` when starting the server.

### config.json Structure

```json
{
  "maximumBytesBilled": "1000000000",
  "preventedFields": {
    "healthcare.patients": ["first_name", "last_name", "ssn", "date_of_birth", "email"],
    "billing.transactions": ["credit_card_number", "bank_account"]
  },
  "sensitiveFieldPatterns": [
    "%first_name%", "%last_name%", "%email%",
    "%ssn%", "%date_of_birth%", "%password%"
  ],
  "sensitiveFieldScanFrequencyDays": 1
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maximumBytesBilled` | `"1000000000"` (1GB) | Maximum bytes billed per query |
| `preventedFields` | `{}` | Table-to-columns mapping of restricted fields |
| `sensitiveFieldPatterns` | Built-in set | SQL LIKE patterns for auto-discovery |
| `sensitiveFieldScanFrequencyDays` | `1` | Days between auto-scans (`0` to disable) |

### Command Line Arguments

- `--project-id`: (Required) Your Google Cloud project ID
- `--location`: (Optional) BigQuery location, defaults to 'US'
- `--key-file`: (Optional) Path to service account key JSON file
- `--config-file`: (Optional) Path to a configuration file. If omitted, the server runs in Simple Mode with no protection — there is no implicit default of `./config.json`
- `--maximum-bytes-billed`: (Optional) Override maximum bytes billed for queries, overrides config.json value

Example using service account:
```bash
npx @ergut/mcp-bigquery-server --project-id your-project-id --location europe-west1 --key-file /path/to/key.json --config-file /path/to/config.json --maximum-bytes-billed 2000000000
```

## Protecting Sensitive Data 🔒

Data warehouses often contain highly sensitive information — patient records, social security numbers, financial data, personal contact details, and authentication secrets. When an AI agent has direct access to query your warehouse, **there is no human in the loop to prevent it from reading sensitive columns**. A `SELECT * FROM patients` could expose thousands of PII/PHI records, and the results are then sent to the LLM provider for processing — they leave your network.

This server gives administrators fine-grained control over which columns an AI agent can access. You define `preventedFields` in `config.json` and the server blocks queries that would surface those columns into LLM responses. An automated scanner discovers sensitive columns across **all** your datasets, so coverage stays current as your warehouse grows.

> **Honest caveat:** Field restrictions are cooperative guardrails for AI agents — not a hard SQL firewall against adversarial attackers. See [PROTECTION.md](PROTECTION.md#security-model-cooperative-guardrails-not-a-sql-firewall) for the full threat model.

The server supports three protection modes, set via `protectionMode` in `config.json`:

| Mode | Description |
|---|---|
| `off` | No protection — all tables and fields accessible (default when no config file is provided) |
| `allowedTables` | Table allowlist — only listed tables can be queried, with optional field restrictions within them |
| `autoProtect` | Auto-scans your datasets for sensitive columns and enforces `preventedFields` |

**See [PROTECTION.md](PROTECTION.md)** for full configuration, examples, the query pattern reference, scanner setup, and required IAM permissions.

## Local Build (Optional) 🔧

Run a local build instead of `npx` — useful for contributing, testing changes, or running a pinned version. Supports both Simple and Protected Mode.

```bash
# Clone and install
git clone https://github.com/ergut/mcp-bigquery-server
cd mcp-bigquery-server
npm install

# Build
npm run build
```

Then point your MCP client config to the local build:

```json
{
  "mcpServers": {
    "bigquery": {
      "command": "node",
      "args": [
        "/path/to/your/clone/mcp-bigquery-server/dist/index.js",
        "--project-id",
        "your-project-id",
        "--location",
        "us-central1"
      ]
    }
  }
}
```

For Protected Mode, add `"--config-file", "/path/to/config.json"` to the `args` array (and optionally `"--key-file", "/path/to/service-account-key.json"` for service account auth).

## Current Limitations ⚠️

- The JSON configuration examples follow the standard MCP server format. Any MCP-compatible client (Claude Desktop, Claude Code, etc.) can use it — refer to your client's documentation for the exact config file location
- Processing limits are configurable per query (set in `config.json` or via `--maximum-bytes-billed`)
- While both tables and views are supported, some complex view types might have limitations
- A config.json file is optional; without one the server uses safe defaults

## Support & Resources 💬

- 🐛 [Report issues](https://github.com/ergut/mcp-bigquery-server/issues)
- 💡 [Feature requests](https://github.com/ergut/mcp-bigquery-server/issues)
- 📖 [Documentation](https://github.com/ergut/mcp-bigquery-server)

## License 📝

MIT License - See [LICENSE](LICENSE) file for details.

## Author ✍️

Salih Ergüt

## Sponsorship

This project is proudly sponsored by:

<div align="center">
  <a href="https://www.oredata.com">
    <img src="assets/oredata-logo-nobg.png" alt="OREDATA" width="300"/>
  </a>
</div>

## Version History 📋

See [CHANGELOG.md](CHANGELOG.md) for updates and version history.