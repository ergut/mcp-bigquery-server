# BigQuery MCP Server
[![smithery badge](https://smithery.ai/badge/@ergut/mcp-bigquery-server)](https://smithery.ai/protocol/@ergut/mcp-bigquery-server)
<div align="center">
  <img src="assets/mcp-bigquery-server-logo.png" alt="BigQuery MCP Server Logo" width="400"/>
</div>

## What is this? 🤔

This is a server that lets your LLMs (like Claude) talk directly to your BigQuery data! Think of it as a friendly translator that sits between your AI assistant and your database, making sure they can chat securely and efficiently.

<a href="https://glama.ai/mcp/servers/dflwpk8hgv"><img width="380" height="200" src="https://glama.ai/mcp/servers/dflwpk8hgv/badge" alt="BigQuery Server MCP server" /></a>

### Quick Example
```text
You: "What were our top 10 customers last month?"
Claude: *queries your BigQuery database and gives you the answer in plain English*
```

No more writing SQL queries by hand - just chat naturally with your data!

## How Does It Work? 🛠️

This server uses the Model Context Protocol (MCP), which is like a universal translator for AI-database communication. While MCP is designed to work with any AI model, right now it's available as a developer preview in Claude Desktop.

Here's all you need to do:
1. Set up authentication (see below)
2. Add your project details to Claude Desktop's config file
3. Start chatting with your BigQuery data naturally!

### What Can It Do? 📊

- Run SQL queries by just asking questions in plain English
- Access both tables and materialized views in your datasets
- Explore dataset schemas with clear labeling of resource types (tables vs views)
- Analyze data within safe limits (1GB query limit by default)
- Keep your data secure (read-only access)

## Quick Start 🚀

### Prerequisites
- Node.js 14 or higher
- Google Cloud project with BigQuery enabled
- Either Google Cloud CLI installed or a service account key file
- Claude Desktop (currently the only supported LLM interface)

### Option 1: Quick Install via Smithery (Recommended)
To install BigQuery MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/protocol/@ergut/mcp-bigquery-server), run this command in your terminal:

```bash
npx @smithery/cli install @ergut/mcp-bigquery-server --client claude
```
The installer will prompt you for:

- Your Google Cloud project ID
- BigQuery location (defaults to us-central1)

Once configured, Smithery will automatically update your Claude Desktop configuration and restart the application.

### Option 2: Manual Setup
If you prefer manual configuration or need more control:

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

2. **Add to your Claude Desktop config**
   Add this to your `claude_desktop_config.json`:

   - Basic configuration:
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
             "us-central1"
           ]
         }
       }
     }
     ```

   - With service account:
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
             "/path/to/service-account-key.json"
           ]
         }
       }
     }
     ```
     

3. **Start chatting!** 
   Open Claude Desktop and start asking questions about your data.

### Command Line Arguments

The server accepts the following arguments:
- `--project-id`: (Required) Your Google Cloud project ID
- `--location`: (Optional) BigQuery location, defaults to 'us-central1'
- `--key-file`: (Optional) Path to service account key JSON file

Example using service account:
```bash
npx @ergut/mcp-bigquery-server --project-id your-project-id --location europe-west1 --key-file /path/to/key.json
```

### Permissions Needed

You'll need one of these:
- `roles/bigquery.user` (recommended)
- OR both:
  - `roles/bigquery.dataViewer`
  - `roles/bigquery.jobUser`

## Developer Setup (Optional) 🔧

Want to customize or contribute? Here's how to set it up locally:

```bash
# Clone and install
git clone https://github.com/ergut/mcp-bigquery-server
cd mcp-bigquery-server
npm install

# Build
npm run build
```

Then update your Claude Desktop config to point to your local build:
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
        "us-central1",
        "--key-file",
        "/path/to/service-account-key.json"
      ]
    }
  }
}
```

## Current Limitations ⚠️

- MCP support is currently only available in Claude Desktop (developer preview)
- Connections are limited to local MCP servers running on the same machine
- Queries are read-only with a 1GB processing limit
- While both tables and views are supported, some complex view types might have limitations

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
