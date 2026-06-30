# Matomo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js->=22.0.0-green.svg)](https://nodejs.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Direct%20Reporting-orange.svg)](https://modelcontextprotocol.io)

Matomo Direct MCP (Model Context Protocol) Server is a robust, lightweight TypeScript implementation that exposes the full power of the **Matomo Analytics HTTP Reporting API** directly to LLM agents. 

Unlike intermediary solutions, this server connects **directly** to your Matomo instance, allowing clients (like Claude Desktop, Cursor, or custom MCP wrappers) to run reporting queries, fetch historical trend analysis, inspect report metadata, and retrieve dynamically generated graph images—all through beautifully typed, auto-documented MCP tools.

---

## 🚀 Key Features

* **Direct Integration** – No proxy databases or external authentication gateways; queries the Matomo HTTP API directly using your `token_auth`.
* **Full Reporting Coverage** – Call any API method from any core or custom plugin.
* **Auto-Validated Inputs** – Every tool payload is checked against strict `JSON-Schema` schemas via the MCP SDK and Zod.
* **Image Generation Support** – Directly outputs binary PNG charts (`ImageGraph.get`) for visualization-capable LLM interfaces.
* **Resilience & Reliability** – Configurable request timeouts and robust HTTP retry logic with exponential back-off.
* **Flexible Environments** – Fully supports command-line flags, environment variables, and Docker deployment.

---

## 🛠️ Technology Stack

* **Language**: [TypeScript](https://www.typescriptlang.org/) (ESNext Modules, Strict Mode)
* **Runtime**: [Node.js](https://nodejs.org/) (Recommended `>= 22.0.0` for native fetch)
* **Server Framework**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol) (v1.15.0)
* **Configuration & Validation**: [Zod](https://zod.dev/) (v3.23.8)
* **Development Tooling**: [tsx](https://github.com/privatenumber/tsx) (watch mode/TS execution), [typescript](https://www.typescriptlang.org/) compiler (v5.6.x)

---

## 📐 Project Architecture

The Matomo Direct MCP Server operates as a **STDIO transport process**. It communicates via system standard input/output streams and is fully stateless.

```
┌─────────────────┐             STDIO              ┌─────────────────────────┐
│                 │  ◄───────────────────────────► │                         │
│   MCP Client    │  (List Tools, Call Tool)       │  Matomo Direct MCP Srv  │
│ (Claude/Cursor) │  ────────────────────────────► │  (TypeScript Process)   │
└─────────────────┘                                └───────────┬─────────────┘
                                                               │
                                                       HTTPS Fetch API
                                                       (token_auth, JSON)
                                                               │
                                                               ▼
                                                   ┌─────────────────────────┐
                                                   │   Matomo Analytics      │
                                                   │   HTTP Reporting API    │
                                                   └─────────────────────────┘
```

When started, the server:
1. **Parses & Validates Configuration**: Parses CLI flags or environment variables to find the `MATOMO_HOST` and `MATOMO_TOKEN_AUTH`.
2. **Verifies Connectivity**: Performs a non-blocking startup check against `API.getMatomoVersion` to ensure the host is reachable.
3. **Exposes Typed Tools**: Publishes structured JSON-schemas describing all report actions to the client.
4. **Handles Requests**: Receives tool invocations, dynamically builds requests (serializing parameters and authentication tokens), executes HTTP queries, detects content-types (JSON, XML, TSV, CSV, PNG), and formats clean, structured outputs back to the agent.

---

## 📦 Project Structure

```text
mcp-matomo/
├── src/
│   ├── index.ts      # Standalone CLI entrypoint, configuration parsing, and startup
│   └── server.ts     # Core MCP server definition, API client, and tool handlers
├── dist/             # Compiled production JavaScript files (generated via tsc)
├── package.json      # Dependencies, compilation scripts, and metadata
├── tsconfig.json     # Strict TypeScript compiler options
├── .gitignore        # Comprehensive secrets & artifact ignore rules
└── README.md         # Documentation (this file)
```

---

## 🚥 Getting Started

### Prerequisites

* **Node.js** `>= 22.0.0`
* **npm** `>= 10.0.0`
* A running **Matomo Analytics** instance with an API token (`token_auth`).

### Installation

1. Clone the repository to your local machine:
   ```bash
   git clone https://github.com/alexgenovese/matomo-mcp.git
   cd matomo-mcp
   ```

2. Install development and runtime dependencies:
   ```bash
   npm ci
   ```

---

## ⚙️ Configuration

The server can be configured seamlessly using either **Command Line Arguments** or **Environment Variables**. CLI flags take priority over environment variables.

| CLI Argument | Environment Variable | Default | Description |
|---|---|---|---|
| `--matomo-host=URL` | `MATOMO_HOST` | *Required* | Base URL of your Matomo instance (e.g., `https://analytics.yourcompany.com/`). |
| `--matomo-token=TOKEN` | `MATOMO_TOKEN_AUTH` | *Required* | Your Matomo secret API token (`token_auth`). |
| `--timeout=MS` | `REQUEST_TIMEOUT` | `30000` | HTTP request timeout in milliseconds. |
| `--retry=COUNT` | `RETRY_COUNT` | `3` | Maximum HTTP request retries. |
| `--retry-delay=MS` | `RETRY_DELAY` | `1000` | Initial retry delay in ms. Multiplied exponentially on consecutive failures. |
| `--format=FORMAT` | `MATOMO_DEFAULT_FORMAT` | `json` | Default response format for reporting queries (e.g., `json`, `xml`). |

---

## 🏃 Running the Server

### 1. Local Development (with Hot Reloading)

Run the server directly from TypeScript source code using `tsx`:
```bash
npm run dev -- --matomo-host=https://your-matomo-url.com --matomo-token=your_token_auth
```

### 2. Production Build & Execution

Compile the TypeScript project to production-ready ES modules, then execute using Node:
```bash
# Compile TS to JS in /dist
npm run build

# Run stand-alone server
node dist/index.js --matomo-host=https://your-matomo-url.com --matomo-token=your_token_auth
```

### 3. Running with Docker

You can containerize and run the server inside a Docker environment:
```bash
# Build the Docker image
docker build -t matomo-mcp .

# Run the container
docker run -i --rm -e MATOMO_HOST="https://your-matomo-url.com" -e MATOMO_TOKEN_AUTH="your_token_auth" matomo-mcp
```

---

## 🛠️ MCP Tools Overview

The server exposes six highly focused, dynamically parameterized tools:

### 1. `matomo_call`
Generic, escape-hatch endpoint to run **any** Matomo HTTP API reporting method.
* **Required Arguments**: 
  * `method` (string): The `Module.action` signature (e.g., `VisitsSummary.get` or `UsersManager.getUsers`).
* **Optional Arguments**:
  * `params` (object): Key-value pairs representing request arguments.
  * `format` (enum): Output serialization format (`json`, `xml`, `csv`, `tsv`, `html`, `rss`, `original`, `png`).

### 2. `matomo_list_report_metadata`
Fetch the complete metadata suite of compatible reports for a site.
* **Required Arguments**: 
  * `idSite` (integer): ID of the Matomo website.
* **Optional Arguments**:
  * `period`, `date`, `language`, `showSubtableReports`, `hideMetricsDoc`.

### 3. `matomo_get_metadata`
Query granular metadata schemas, documentation, and specific column dimensions of a single report action.
* **Required Arguments**: 
  * `idSite` (integer), `apiModule` (string), `apiAction` (string).

### 4. `matomo_get_processed_report`
Retrieve high-level processed metrics, calculations, and tables complete with arithmetic.
* **Required Arguments**: 
  * `idSite` (integer), `apiModule` (string), `apiAction` (string).
* **Optional Arguments**:
  * `segment` (segment filter string), `flat` (boolean), `expanded` (boolean), `filter_limit` (integer).

### 5. `matomo_get_row_evolution`
Analyze historical trend lines for a specific report row label over time.
* **Required Arguments**: 
  * `idSite` (integer), `apiModule` (string), `apiAction` (string), `label` (string).

### 6. `matomo_get_image_graph`
Acquire raw PNG chart visualizations directly generated by Matomo's Graph Engine.
* **Required Arguments**: 
  * `idSite` (integer), `apiModule` (string), `apiAction` (string).
* **Optional Arguments**:
  * `graphType` (evolution, horizontalBar, verticalBar, pie), `width`, `height`, `columns`.

---

## 🔌 Integration Guides

### Claude Desktop Integration

To register this server with your local Claude Desktop app, edit your configuration file (usually located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add the following entry:

```json
{
  "mcpServers": {
    "matomo-direct-mcp": {
      "command": "node",
      "args": [
        "/Users/alexgenovese/Documents/GitHub/mcp/mcp-matomo/dist/index.js",
        "--matomo-host=https://your-matomo-instance.com",
        "--matomo-token=YOUR_MATOMO_TOKEN_AUTH"
      ]
    }
  }
}
```

*Note: Ensure you have compiled the server beforehand by running `npm run build`.*

---

## 💻 Development Workflow

### Coding Standards
We enforce highly clean, structured, and modern development standards:
* **Strict Types**: Explicit typings everywhere; `any` is restricted only to generic API parsing.
* **Modular ES Imports**: Node.js ES Modules are strictly enforced. Relative file imports must include the `.js` extension (e.g. `import { Server } from "./server.js"`).
* **Robust Error Handling**: Network failures are monitored and retried using structured back-offs, while standard error objects are printed to standard error (`console.error`) so as not to corrupt the STDIO transport on standard output.

### Linting
Validate codebase health and alignment to guidelines:
```bash
npm run lint
```

---

## 🤝 Contributing

Contributions are welcome! Please follow these simple steps to contribute:
1. Fork the repository and create your feature branch (`git checkout -b feature/amazing-feature`).
2. Verify changes build perfectly and conform to standard formatting guidelines.
3. Open a Pull Request detailing the purpose and scope of your modifications.

---

## 📄 License

This project is licensed under the **MIT License** - see the `package.json` file for licensing declarations.
