# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/ergut/mcp-bigquery-server/releases/tag/v0.1.0