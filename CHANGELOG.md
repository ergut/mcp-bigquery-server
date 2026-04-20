# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2026-04-20

### Security

- **Replaced regex blocklist with BigQuery dryRun for read-only enforcement** — `EXPORT DATA`, `LOAD DATA`, `CALL`, `DECLARE`, `SET`, and other write-capable statements were missing from the old blocklist. The new approach uses BigQuery's dry run API to inspect `statementType`, so there is no blocklist to maintain and no bypass vectors. Fixes [#16](https://github.com/ergut/mcp-bigquery-server/issues/16) finding 1.
- **`maximumBytesBilled` is now server-controlled** — the value is read exclusively from the config file or `--maximum-bytes-billed` server arg; tool-call arguments can no longer override it. Prevents prompt-injection attacks that could trigger runaway billing. Fixes [#16](https://github.com/ergut/mcp-bigquery-server/issues/16) finding 2.

### Added

- **Field-level access restrictions** (`preventedFields`) — define per-table columns the AI agent may not read raw; it receives guidance to use aggregates or `SELECT * EXCEPT (...)` instead.
- **`allowedTables` protection mode** — whitelist the exact tables an agent can query; all others are denied.
- **Auto-discovery of sensitive fields** — on startup (and once daily), the server scans `INFORMATION_SCHEMA` for columns matching configurable patterns (names, emails, SSNs, medical records, API keys, etc.) and merges them into `preventedFields` automatically.
- **`--config-file` flag** — all protection settings are driven by an external `config.json`; no code changes required to tune coverage.
- **`scan-fields` CLI** (`npm run scan-fields`) — run a one-off scan to preview or pre-populate `preventedFields`.

### Fixed

- Table reference parser now handles hyphenated GCP project IDs (e.g. `my-project.dataset.table`) correctly in `allowedTables` and field-restriction enforcement.

## [1.0.3] - 2025-04-03

### Fixed

- Removed circular dependency in package.json that caused version resolution issues
- Fixed location format handling to properly support multi-region formats like "US"
- Improved error handling for different location format specifications
- Default region set to "EU"

## [1.0.0] - 2024-12-13

### Breaking Changes

- Switch from positional to named command-line arguments
  - Old: `mcp-server-bigquery project-id location`
  - New: `mcp-server-bigquery --project-id project-id --location location`

### Added

- Service account authentication support via `--key-file` parameter
- Stronger read-only validation using regex to detect forbidden SQL commands
- Explicit view support with clear labeling in resource listings
- Enhanced logging to show both table and view counts
- Project logo and improved visual documentation

### Changed

- Improved README with clearer setup instructions and MCP context
- Updated configuration examples for Claude Desktop
- Enhanced npm publish workflow with version validation
- Reorganized documentation for better user experience

### Fixed

- Updated Claude Desktop config paths in developer setup guide

## [0.1.0] - 2024-12-04

### Added

- Initial release of BigQuery MCP server
- Read-only access to BigQuery datasets
- Support for executing SQL queries with 1GB billing limit
- Authentication via Google Cloud CLI
- Table schema information access
- MIT License file

### Changed

- Updated package configuration and dependencies
- Improved README documentation with correct configuration examples

### Dependencies

- Added @modelcontextprotocol/sdk: 0.6.0
- Added @google-cloud/bigquery: ^7.3.0
- Added development dependencies: shx and typescript

[1.0.4]: https://github.com/ergut/mcp-bigquery-server/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/ergut/mcp-bigquery-server/compare/v1.0.0...v1.0.3
[1.0.0]: https://github.com/ergut/mcp-bigquery-server/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/ergut/mcp-bigquery-server/releases/tag/v0.1.0
