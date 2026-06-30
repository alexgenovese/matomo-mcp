# Matomo Direct MCP Server

Matomo Direct MCP (Model Context Protocol) Server is a thin TypeScript wrapper that allows LLM agents to query a Matomo instance directly via its HTTP Reporting API.  The server exposes a set of typed tools that can be consumed by any MCP‑compatible client.

## Features

- **Full tool coverage** – Call any Matomo API method or fetch report metadata, processed reports, row evolution or image graphs.
- **TypeScript typings** – All request payloads and responses are validated against JSON‑Schema definitions.
- **Retry / timeout** – Configurable HTTP retry logic with exponential back‑off.
- **Easy deployment** – Run locally with `npm start` or build a Docker container.
- **Command line flags / env** – Seamlessly set `MATOMO_HOST` and authentication token.

## Installation

```bash
# Clone the repository
git clone https://github.com/alexgenovese/matomo-mcp.git
cd matomo-mcp

# Install dependencies
npm ci
```

## Running the Server

The server can be started in three modes:

### 1. Local development (TSX)

```bash
npm run dev
```

Loads `src/index.ts` with hot‑reloading.

### 2. Stand‑alone executable (Node)

```bash
npm run build
node dist/index.js --matomo-host=https://analytics.example.com --matomo-token=YOUR_TOKEN
```

### 3. Docker

```bash
docker build -t matomo-mcp .
# Expose the stdio transport over a TCP port if you
# want to connect from a remote MCP‑client.
# For local stdio use default STDIN/STDOUT.
```

> **Note**: The server uses the **STDIO** transport in its current form, making it a simple shell‑style program.  To expose it over HTTP you can wrap it with the `@modelcontextprotocol/inspector` or any custom transport.

## Configuration

| Option | Environment | Default | Description |
|-------|-------------|---------|-------------|
| `MATOMO_HOST` | `MATOMO_HOST` | *Required* | Base URL of the Matomo instance.
| `MATOMO_TOKEN_AUTH` | `MATOMO_TOKEN_AUTH` | *Required* | Auth token (`token_auth`).
| `REQUEST_TIMEOUT` | `REQUEST_TIMEOUT` | `30000` | HTTP request timeout in ms.
| `RETRY_COUNT` | `RETRY_COUNT` | `3` | Number of retry attempts.
| `RETRY_DELAY` | `RETRY_DELAY` | `1000` | Initial delay for retries (ms).  Exponentially multiplied on each retry.
| `MATOMO_DEFAULT_FORMAT` | `MATOMO_DEFAULT_FORMAT` | `json` | Default response format for the `matomo_call` tool.

Command line flags override environment variables.

## MCP Tool Overview

| Tool | Description |
|------|-------------|
| `matomo_call` | Generic wrapper around any Matomo API method (`module.action`). Accepts `method`, `params`, and `format`.
| `matomo_list_report_metadata` | Returns a list of all report metadata for a site (`API.getReportMetadata`).
| `matomo_get_metadata` | Details for a single report (`API.getMetadata`).
| `matomo_get_processed_report` | Full processed report data with metrics (`API.getProcessedReport`).
| `matomo_get_row_evolution` | Evolution of a single row over time using `API.getRowEvolution`.
| `matomo_get_image_graph` | Generates a PNG graph from `ImageGraph.get`.

Each tool returns **structured JSON** wrapped in a `content` array that can contain either plain text, JSON, or binary image data for consumption by the LLM.

## Usage with an MCP‑Client

```js
const Migrate = require('@modelcontextprotocol/sdk')
const client = new Migrate.Client({ transport: { type: 'stdio' } })
const tools = await client.listTools()
// Call the desired tool
const result = await client.callTool('matomo_call', {
  method: 'VisitsSummary.get',
  params: { idSite: 1, period: 'day', date: 'today' },
  format: 'json',
})
console.log(result)
```

## Limitations

- Currently only `stdio` transport is supported.  If you need HTTP/S communication, adapt the code to use `StreamableHttpServerTransport` from the SDK.
- No built‑in authentication guard; rely on the Matomo token.
- `IMAGE` results are returned as binary data – ensure your consumer handles Base64 or multipart payloads.

## Contributing

Feel free to open issues or PRs.  Follow the existing code style and run `npm run lint` before submitting.

---

> For more advanced usage, consult the [MCP SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk).
