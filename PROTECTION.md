# Protecting Sensitive Data

Data warehouses often contain highly sensitive information — patient records, social security numbers, financial data, personal contact details, and authentication secrets. When an AI agent has direct access to query your BigQuery warehouse, **there is no human in the loop to prevent it from reading sensitive columns**. A simple query like `SELECT * FROM patients` could expose thousands of PII/PHI records in a single response.

This server gives administrators fine-grained control over which columns an AI agent can access, ensuring sensitive data stays protected while still allowing the AI to perform useful analytical queries on non-sensitive fields.

## Security Model: Cooperative Guardrails, Not a SQL Firewall

**Important:** The field restrictions and table allowlists in this server are designed as **cooperative guardrails for AI agents**, not as a hard security boundary against adversarial attackers.

> **Note:** This caveat applies specifically to *field restrictions and table allowlists*, which use regex-based SQL analysis. The server's **read-only enforcement is a different mechanism** — it relies on BigQuery's own query planner (via a dry-run `statementType` check) to reject anything that isn't a `SELECT`. That check is authoritative, not cooperative: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `EXPORT DATA`, and `MERGE` cannot be smuggled past it.

The threat model is straightforward: when an AI agent queries your BigQuery warehouse, the query results are sent to the LLM provider's servers. Field restrictions prevent the agent from inadvertently including sensitive columns (PII, PHI, secrets) in those results. When the agent encounters a restriction error, it reads the guidance in the error message and reformulates its query — using aggregate functions, `EXCEPT` clauses, or simply dropping the restricted field. In practice, AI agents cooperate immediately and consistently.

This system uses regex-based SQL analysis to detect restricted field usage. We performed penetration testing during development and fixed several bypass vectors (struct-alias expansion, comma-join evasion, implicit `SELECT *`). However, regex-based parsing cannot guarantee coverage of every possible SQL construct — edge cases involving deeply nested CTEs, exotic BigQuery syntax, or adversarial query crafting may exist. The enforcement logic is designed to **fail closed** (block ambiguous queries rather than allow them), but it is not equivalent to a database-level security policy.

**What this is:**
- Effective guidance that prevents AI agents from accessing sensitive data in normal usage
- A safety net that catches common query patterns (`SELECT *`, direct field references, aliases)
- Hardened against known bypass techniques discovered through penetration testing

**What this is not:**
- A replacement for BigQuery IAM, column-level security, or row-level access policies
- A defense against a malicious human deliberately crafting bypass queries
- A certified SQL parser — it uses pattern matching, not a full AST

For environments requiring strict compliance guarantees, combine these guardrails with BigQuery's native [column-level security](https://cloud.google.com/bigquery/docs/column-level-security-intro) and [authorized views](https://cloud.google.com/bigquery/docs/authorized-views).

## Protection Modes

The server supports three protection modes, configured via `protectionMode` in `config.json`:

| Mode | Description | Default when |
|---|---|---|
| `off` | No protection — all tables and fields accessible | No config file exists |
| `allowedTables` | Table allowlist — only listed tables can be queried | Must be explicitly set |
| `autoProtect` | Auto-scans for sensitive fields, enforces `preventedFields` | Config file exists without `protectionMode` key |

### `allowedTables` Mode

Restricts the AI agent to a specific set of tables. Queries against any other table are rejected immediately. Optionally define field restrictions within allowed tables:

```json
{
  "protectionMode": "allowedTables",
  "maximumBytesBilled": "10000000000",
  "allowedTables": [
    "analytics.page_views",
    "analytics.sessions",
    "reporting.daily_summary"
  ],
  "preventedFieldsInAllowedTables": {
    "analytics.page_views": ["user_ip", "user_agent"]
  }
}
```

- `preventedFieldsInAllowedTables` is optional — defaults to `{}` (no field restrictions within allowed tables)
- The auto-scan does **not** run in this mode — all restrictions are manually configured
- `INFORMATION_SCHEMA` queries are always allowed for schema discovery

### `autoProtect` Mode (Field-Level Restrictions)

The original protection mode. Auto-scans your BigQuery datasets for sensitive columns and enforces `preventedFields`. Manual entries in `preventedFields` persist through scans (the merge is additive-only). See [Field-Level Access Restrictions](#field-level-access-restrictions) below.

Existing config files without `protectionMode` continue working — they default to `autoProtect` for backward compatibility.

## Field-Level Access Restrictions

Define `preventedFields` in your config to block the AI agent from accessing specific columns:

```json
{
  "preventedFields": {
    "healthcare.patients": ["first_name", "last_name", "ssn", "date_of_birth", "email"],
    "billing.transactions": ["credit_card_number", "bank_account"]
  }
}
```

**What happens when the AI agent tries to access a restricted field:**

```sql
SELECT first_name, last_name, diagnosis FROM healthcare.patients
```

The server blocks the query and returns a clear, instructive error:

```
Restricted fields detected for table "healthcare.patients" columns "first_name", "last_name".
You can only use these columns inside ["count", "countif", "avg", "sum"]
aggregate functions or exclude them with SELECT * EXCEPT (...).
```

The AI agent learns from this error and adjusts its queries automatically. It can still run analytical queries that don't expose individual sensitive values:

```sql
-- Allowed: aggregate functions don't expose individual values
SELECT COUNT(first_name) AS patient_count, diagnosis
FROM healthcare.patients
GROUP BY diagnosis

-- Allowed: explicitly excluding restricted fields
SELECT * EXCEPT(first_name, last_name, ssn, date_of_birth, email)
FROM healthcare.patients
```

**Query pattern reference:**

| Query Pattern | Behavior |
|---|---|
| `SELECT restricted_col FROM table` | Blocked with error message |
| `SELECT * FROM table` | Blocked (would expose restricted fields) |
| `SELECT * EXCEPT(restricted_cols) FROM table` | Allowed |
| `COUNT(restricted_col)`, `AVG(...)`, `SUM(...)`, `COUNTIF(...)` | Allowed (aggregates don't expose individual values) |
| `MIN(restricted_col)`, `MAX(restricted_col)` | Blocked (returns actual individual values) |
| `SELECT non_restricted_col FROM table` | Allowed |
| `SELECT id FROM table WHERE restricted_col = '...'` | Blocked (see note below) |
| `SELECT id FROM table ORDER BY restricted_col` | Blocked (see note below) |

> **Note: Restricted fields in WHERE, ORDER BY, and other clauses are blocked**, not just fields in SELECT. Even though the query results don't contain the restricted column, the full SQL query text is sent to the LLM provider as part of the conversation. A query like `WHERE email = 'patient@example.com'` means the restricted value appears in the prompt sent to the cloud. The enforcement checks the entire query to prevent restricted data from leaving your network in any form.

**Server-side logging:** Every blocked query is logged on the server side, giving administrators visibility into what the AI agent attempted to access:
```
Query tool error: Error: Restricted fields detected for table "healthcare.patients" columns "first_name", "last_name".
```

## Automated Sensitive Field Scanner

Manually listing every sensitive column across hundreds of tables is impractical. The server includes an automated scanner that discovers sensitive columns across **all** your BigQuery datasets by querying `INFORMATION_SCHEMA.COLUMNS` with configurable SQL LIKE patterns. Discovered fields are automatically added to `preventedFields` in your config.

### How It Works

1. The scanner runs SQL LIKE pattern matching against all column names in your BigQuery project
2. Columns matching patterns like `%first_name%`, `%ssn%`, `%email%` are identified as sensitive
3. Discovered columns are merged into your config's `preventedFields`
4. The merge is **additive-only** — manually added restrictions are never removed

### Auto-Scan on Server Startup

When the MCP server starts, it checks if the config file is stale based on `sensitiveFieldScanFrequencyDays`. If stale, it automatically scans and updates the config:

```
Config is stale (scan frequency: 1 day(s)), running sensitive field scan...
Scanning all datasets for sensitive fields...
Found 1166 sensitive column(s) across 278 table(s)
Scan complete: config updated with 278 tables.
```

This means **new tables with sensitive columns are automatically protected** without any manual configuration. As your data warehouse grows, the scanner keeps up.

### Manual Scan via CLI

Run a scan on demand at any time:
```bash
npm run scan-fields -- --project-id your-project-id --config-file ./config.json
```

### Custom Patterns for Your Organization

The default patterns cover common naming conventions (names, emails, SSNs, dates of birth, medical record numbers, insurance IDs, passwords, API keys, etc.), but every organization has its own. Add custom patterns to match your schema:

```json
{
  "sensitiveFieldPatterns": [
    "%first_name%", "%last_name%", "%email%", "%ssn%",
    "%date_of_birth%", "%password%", "%api_key%",
    "%guardian_name%",
    "%emergency_contact%",
    "%beneficiary%",
    "%next_of_kin%"
  ]
}
```

On the next auto-scan (or manual `npm run scan-fields`), the scanner picks up columns matching your new patterns and automatically adds them to `preventedFields`. As your data warehouse grows and new tables are added, any columns matching your patterns are **automatically protected** without manual intervention.

### Scanner Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sensitiveFieldPatterns` | Built-in set covering names, contacts, identity, insurance, and secrets | SQL LIKE patterns to match against column names |
| `sensitiveFieldScanFrequencyDays` | `1` (daily) | Days between automatic scans. Set `0` to disable auto-scanning. |

## Required IAM Permissions

You'll need one of these:
- `roles/bigquery.user` (recommended)
- OR both:
  - `roles/bigquery.dataViewer`
  - `roles/bigquery.jobUser`
