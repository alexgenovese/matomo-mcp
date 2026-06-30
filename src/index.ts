#!/usr/bin/env node
/**
 * @alexgenovese/matomo-mcp
 * 
 * Standalone entry point per il server MCP Matomo.
 * 
 * Usage: node src/index.ts --matomo-host=URL --matomo-token=TOKEN
 * 
 * @version 1.0.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// Basic argument parser
function parseArgValue(args: string[], prefix: string): string | undefined {
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function getArgValue(argName: string): string | undefined {
  return parseArgValue(process.argv.slice(2), `--${argName}=`);
}

function getEnvValue(argName: string, envName: string): string;
function getEnvValue(argName: string, envName: string, fallback: string): string;
function getEnvValue(argName: string, envName: string, fallback?: string): string {
  const argValue = getArgValue(argName);
  if (argValue) return argValue;
  const envValue = process.env[envName];
  return envValue || (fallback ?? "");
}

// Configuration
interface Config {
  matomoHost: string;
  tokenAuth: string;
  timeout: number;
  retryCount: number;
  retryDelay: number;
  defaultFormat: string;
}

const DEFAULT_CONFIG: { timeout: number; retryCount: number; retryDelay: number; defaultFormat: string } = {
  timeout: 30000,
  retryCount: 3,
  retryDelay: 1000,
  defaultFormat: "json",
};

let config: Config | null = null;

function normalizeMatomoBaseUrl(value: string): URL {
  let url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function validateConfiguration(): string[] {
  const errors: string[] = [];

  if (!config?.matomoHost) {
    errors.push("MATOMO_HOST is required");
  }

  if (!config?.tokenAuth) {
    errors.push("MATOMO_TOKEN_AUTH is required");
  }

  return errors;
}

// URL Builders
function buildMatomoUrl(): URL {
  return new URL("index.php", normalizeMatomoBaseUrl(config!.matomoHost));
}

function buildApiUrlCandidates(): URL[] {
  const base = normalizeMatomoBaseUrl(config!.matomoHost);
  return [new URL("index.php", base), new URL("", base)];
}

function appendSearchParams(
  searchParams: URLSearchParams,
  key: string | undefined,
  value: string | number | boolean | undefined | null
) {
  if (value === undefined || value === null) return;
  searchParams.append(key || "", String(value));
}

function buildRequestBody(
  method: string,
  params: Record<string, any> = {},
  format: string = config!.defaultFormat
): URLSearchParams {
  const searchParams = new URLSearchParams();
  appendSearchParams(searchParams, "module", "API");
  appendSearchParams(searchParams, "method", method);
  appendSearchParams(searchParams, "format", format);
  appendSearchParams(searchParams, "token_auth", config!.tokenAuth);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined) appendSearchParams(searchParams, k, v);
  });

  return searchParams;
}

function detectFormat(contentType: string, fallback: string = "json"): string {
  const lower = (contentType || "").toLowerCase();
  if (lower.includes("json")) return "json";
  if (lower.includes("xml")) return "xml";
  if (lower.includes("csv")) return "csv";
  if (lower.includes("tsv")) return "tsv";
  if (lower.includes("html")) return "html";
  if (lower.startsWith("image/")) return "image";
  return fallback;
}

// Matomo API Client
async function callMatomoApi(
  method: string,
  params: Record<string, any> = {},
  options: { format?: string } = {}
): Promise<{ kind: "text" | "json" | "image"; data: string | any | Buffer; format?: string; mimeType?: string }> {
  const format = options.format || config!.defaultFormat || "json";
  const requestId = `matomo-${method}-${Date.now()}`;
  const urls = buildApiUrlCandidates();
  const body = buildRequestBody(method, params, format);

  console.error(`📥 [${requestId}] ${method}`);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config!.retryCount; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config!.timeout);

    try {
      const response = await fetch(urls[0], {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Accept": "application/json, text/plain, */*",
        },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 404 && urls.length > 1) {
        const fallbackResponse = await fetch(urls[1], {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "application/json, text/plain, */*",
          },
          body: body.toString(),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (fallbackResponse.ok) {
          const fallbackType = fallbackResponse.headers.get("content-type") || "";
          const fallbackFormat = detectFormat(fallbackType, format);

          if (fallbackFormat === "image") {
            return {
              kind: "image",
              mimeType: fallbackType.split(";")[0] || "image/png",
              data: Buffer.from(await fallbackResponse.arrayBuffer()),
            };
          }

          if (fallbackFormat === "json") {
            return {
              kind: "json",
              data: await fallbackResponse.json(),
            };
          }

          return {
            kind: "text",
            data: await fallbackResponse.text(),
            format: fallbackFormat,
          };
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      const detectedFormat = detectFormat(contentType, format);

      if (detectedFormat === "image") {
        return {
          kind: "image",
          mimeType: contentType.split(";")[0] || "image/png",
          data: Buffer.from(await response.arrayBuffer()),
        };
      }

      if (detectedFormat === "json") {
        return {
          kind: "json",
          data: await response.json(),
        };
      }

      return {
        kind: "text",
        data: await response.text(),
        format: detectedFormat,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error : new Error(String(error));

      console.error(`⚠️ [${requestId}] attempt ${attempt + 1}/${config!.retryCount} failed: ${lastError.message}`);

      if (attempt < config!.retryCount - 1) {
        const delay = config!.retryDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Matomo request failed after ${config!.retryCount} attempts: ${lastError?.message}`);
}

function formatResult(result: any, fallbackFormat: string): {
  content: Array<{ type: "text" | "image"; text?: string; data?: Buffer | string; mimeType?: string }>;
  isError: boolean;
} {
  if (!result || typeof result !== "object") {
    return {
      content: [{ type: "text", text: String(result) }],
      isError: false,
    };
  }

  if (result.kind === "image") {
    return {
      content: [{ type: "image", data: result.data, mimeType: result.mimeType }],
      isError: false,
    };
  }

  if (result.kind === "json") {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      isError: false,
    };
  }

  if (result.kind === "text") {
    return {
      content: [{ type: "text", text: result.data }],
      isError: false,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: false,
  };
}

// MCP Server
const server = new Server(
  {
    name: "matomo-direct-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const toolDefinitions: Tool[] = [
  {
    name: "matomo_call",
    description:
      "Esegue qualsiasi metodo dell'HTTP Reporting API di Matomo (es. VisitsSummary.get, SitesManager.getSitesWithViewAccess). Parametri: method, params, format.",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "Metodo nel formato Module.action (es. VisitsSummary.get)",
        },
        params: {
          type: "object",
          description: "Parametri della richiesta API",
          additionalProperties: true,
        },
        format: {
          type: "string",
          description: "Formato di risposta (json, xml, csv, tsv, html, rss, original, png)",
          default: config!.defaultFormat,
        },
      },
      required: ["method"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_list_report_metadata",
    description:
      "Recupera lista completa di report compatibili da API.getReportMetadata. Utile per esplorazione.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: { type: "integer", description: "ID del sito Matomo" },
        period: { type: "string", default: "day" },
        date: { type: "string", default: "today" },
        language: { type: "string" },
        showSubtableReports: { type: "boolean", default: true },
        hideMetricsDoc: { type: "boolean", default: false },
      },
      required: ["idSite"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_metadata",
    description:
      "Recupera metadati per report specifico tramite API.getMetadata. Include schema, unità di misura, documenti.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: { type: "integer" },
        apiModule: { type: "string" },
        apiAction: { type: "string" },
        period: { type: "string", default: "day" },
        date: { type: "string", default: "today" },
        language: { type: "string" },
        hideMetricsDoc: { type: "boolean", default: false },
        showSubtableReports: { type: "boolean", default: true },
      },
      required: ["idSite", "apiModule", "apiAction"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_processed_report",
    description:
      "Recupera report completo processato con dati numerici tramite API.getProcessedReport.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: { type: "integer" },
        apiModule: { type: "string" },
        apiAction: { type: "string" },
        period: { type: "string", default: "day" },
        date: { type: "string", default: "today" },
        language: { type: "string" },
        idGoal: { type: "string" },
        idSubtable: { type: "string" },
        segment: { type: "string" },
        flat: { type: "boolean" },
        expanded: { type: "boolean" },
        filter_truncate: { type: "integer" },
        filter_limit: { type: "integer" },
        showMetadata: { type: "boolean" },
      },
      required: ["idSite", "apiModule", "apiAction"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_row_evolution",
    description:
      "Analizza evoluzione temporale di una singola riga di report tramite API.getRowEvolution.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: { type: "integer" },
        apiModule: { type: "string" },
        apiAction: { type: "string" },
        label: { type: "string" },
        period: { type: "string", default: "day" },
        date: { type: "string", default: "today" },
        segment: { type: "string" },
        idGoal: { type: "string" },
        idSubtable: { type: "string" },
      },
      required: ["idSite", "apiModule", "apiAction", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_image_graph",
    description:
      "Genera immagine PNG dello grafico tramite ImageGraph.get.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: { type: "integer" },
        apiModule: { type: "string" },
        apiAction: { type: "string" },
        period: { type: "string", default: "day" },
        date: { type: "string", default: "today" },
        graphType: {
          type: "string",
          enum: ["evolution", "horizontalBar", "verticalBar", "pie"],
        },
        width: { type: "integer" },
        height: { type: "integer" },
        columns: { type: "string" },
        labels: { type: "string" },
        segment: { type: "string" },
        idGoal: { type: "string" },
        idSubtable: { type: "string" },
      },
      required: ["idSite", "apiModule", "apiAction"],
      additionalProperties: false,
    },
  },
];

// MCP Handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs = {} } = request.params;

  switch (name) {
    case "matomo_call": {
      const method = toolArgs?.method;
      const params = toolArgs?.params || {};
      const format = toolArgs?.format || config!.defaultFormat;

      if (!method) {
        return {
          content: [{ type: "text", text: "ERR: method is required" }],
          isError: true,
        };
      }

      return {
        content: formatResult(await callMatomoApi(method, params, { format })),
        isError: false,
      };
    }

    case "matomo_list_report_metadata": {
      const idSite = toolArgs?.idSite;
      const period = toolArgs?.period || "day";
      const date = toolArgs?.date || "today";
      const language = toolArgs?.language;
      const showSubtableReports = toolArgs?.showSubtableReports ?? true;
      const hideMetricsDoc = toolArgs?.hideMetricsDoc ?? false;

      if (idSite === undefined) {
        return {
          content: [{ type: "text", text: "ERR: idSite is required" }],
          isError: true,
        };
      }

      return {
        content: formatResult(
          await callMatomoApi("API.getReportMetadata", {
            idSite,
            period,
            date,
            language,
            showSubtableReports: showSubtableReports ? 1 : 0,
            hideMetricsDoc: hideMetricsDoc ? 1 : 0,
          }),
          config!.defaultFormat
        ),
        isError: false,
      };
    }

    case "matomo_get_metadata": {
      const idSite = toolArgs?.idSite;
      const apiModule = toolArgs?.apiModule;
      const apiAction = toolArgs?.apiAction;
      const period = toolArgs?.period || "day";
      const date = toolArgs?.date || "today";
      const language = toolArgs?.language;
      const hideMetricsDoc = toolArgs?.hideMetricsDoc ?? false;
      const showSubtableReports = toolArgs?.showSubtableReports ?? true;

      if (!idSite || !apiModule || !apiAction) {
        return {
          content: [{ type: "text", text: "ERR: idSite, apiModule, and apiAction are required" }],
          isError: true,
        };
      }

      return {
        content: formatResult(
          await callMatomoApi("API.getMetadata", {
            idSite,
            apiModule,
            apiAction,
            period,
            date,
            language,
            hideMetricsDoc: hideMetricsDoc ? 1 : 0,
            showSubtableReports: showSubtableReports ? 1 : 0,
          }),
          config!.defaultFormat
        ),
        isError: false,
      };
    }

    case "matomo_get_processed_report": {
      const idSite = toolArgs?.idSite;
      const apiModule = toolArgs?.apiModule;
      const apiAction = toolArgs?.apiAction;
      const period = toolArgs?.period || "day";
      const date = toolArgs?.date || "today";
      const language = toolArgs?.language;
      const idGoal = toolArgs?.idGoal;
      const idSubtable = toolArgs?.idSubtable;
      const segment = toolArgs?.segment;
      const flat = toolArgs?.flat;
      const expanded = toolArgs?.expanded;
      const filter_truncate = toolArgs?.filter_truncate;
      const filter_limit = toolArgs?.filter_limit;
      const showMetadata = toolArgs?.showMetadata;

      if (!idSite || !apiModule || !apiAction) {
        return {
          content: [{ type: "text", text: "ERR: idSite, apiModule, and apiAction are required" }],
          isError: true,
        };
      }

      return {
        content: formatResult(
          await callMatomoApi("API.getProcessedReport", {
            idSite,
            apiModule,
            apiAction,
            period,
            date,
            language,
            idGoal,
            idSubtable,
            segment,
            flat: flat ? 1 : 0,
            expanded: expanded ? 1 : 0,
            filter_truncate,
            filter_limit,
            showMetadata: showMetadata === undefined ? undefined : (showMetadata ? 1 : 0),
          }),
          config!.defaultFormat
        ),
        isError: false,
      };
    }

    case "matomo_get_row_evolution": {
      const idSite = toolArgs?.idSite;
      const apiModule = toolArgs?.apiModule;
      const apiAction = toolArgs?.apiAction;
      const label = toolArgs?.label;
      const period = toolArgs?.period || "day";
      const date = toolArgs?.date || "today";
      const segment = toolArgs?.segment;
      const idGoal = toolArgs?.idGoal;
      const idSubtable = toolArgs?.idSubtable;

      if (!idSite || !apiModule || !apiAction || !label) {
        return {
          content: [{ type: "text", text: "ERR: idSite, apiModule, apiAction, and label are required" }],
          isError: true,
        };
      }

      return {
        content: formatResult(
          await callMatomoApi("API.getRowEvolution", {
            idSite,
            apiModule,
            apiAction,
            label,
            period,
            date,
            segment,
            idGoal,
            idSubtable,
          }),
          config!.defaultFormat
        ),
        isError: false,
      };
    }

    case "matomo_get_image_graph": {
      const idSite = toolArgs?.idSite;
      const apiModule = toolArgs?.apiModule;
      const apiAction = toolArgs?.apiAction;
      const period = toolArgs?.period || "day";
      const date = toolArgs?.date || "today";
      const graphType = toolArgs?.graphType;
      const width = toolArgs?.width;
      const height = toolArgs?.height;
      const columns = toolArgs?.columns;
      const labels = toolArgs?.labels;
      const segment = toolArgs?.segment;
      const idGoal = toolArgs?.idGoal;
      const idSubtable = toolArgs?.idSubtable;

      if (!idSite || !apiModule || !apiAction) {
        return {
          content: [{ type: "text", text: "ERR: idSite, apiModule, and apiAction are required" }],
          isError: true,
        };
      }

      return {
        content: formatResult(
          await callMatomoApi("ImageGraph.get", {
            idSite,
            apiModule,
            apiAction,
            period,
            date,
            graphType,
            width,
            height,
            columns,
            labels,
            segment,
            idGoal,
            idSubtable,
          }), { format: "png" }),
          "png"
        ),
        isError: false,
      };
    }

    default:
      return {
        content: [{ type: "text", text: `ERR: Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// Main entry
async function showHelp() {
  console.error(`
@alexgenovese/matomo-mcp - Matomo Direct MCP Server

Usage: node src/index.ts [options]

Required:
  --matomo-host=URL        BaseURL dell'istancia Matomo
  --matomo-token=TOKEN     Auth token Matomo

Options:
  --timeout=MS             Timeout (default: 30000)
  --retry=COUNT            Retry attempts (default: 3)
  --retry-delay=MS         Retry delay (default: 1000)
  --format=FORMAT          Default format (default: json)
  --help                   Show this help

Environment:
  MATOMO_HOST, MATOMO_TOKEN_AUTH, REQUEST_TIMEOUT, RETRY_COUNT, RETRY_DELAY

Tools: matomo_call, matomo_list_report_metadata, matomo_get_metadata,
       matomo_get_processed_report, matomo_get_row_evolution, matomo_get_image_graph
`);
}

async function verifyConnection() {
  try {
    const result = await callMatomoApi("API.getMatomoVersion", {}, { format: "json" });
    console.error("✅ Matomo readable, version received");
    return result;
  } catch (error) {
    console.error(`⚠️ Matomo connection failed: ${error}`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  config = {
    matomoHost: getArgValue("matomo-host") || getEnvValue("matomo-host", "MATOMO_HOST"),
    tokenAuth: getArgValue("matomo-token") || getEnvValue("matomo-token", "MATOMO_TOKEN_AUTH"),
    timeout: parseInt(getArgValue("timeout") || process.env.REQUEST_TIMEOUT || "30000", 10),
    retryCount: parseInt(getArgValue("retry") || process.env.RETRY_COUNT || "3", 10),
    retryDelay: parseInt(getArgValue("retry-delay") || process.env.RETRY_DELAY || "1000", 10),
    defaultFormat: (getArgValue("format") || process.env.MATOMO_DEFAULT_FORMAT || "json").toLowerCase(),
  };

  const errors = validateConfiguration();
  if (errors.length > 0) {
    console.error("Errors:");
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.error("🔧 Matomo MCP Server");
  console.error(`   Host: ${config.matomoHost}`);
  console.error(`   Format: ${config.defaultFormat}`);
  console.error(`   Token: ${config.tokenAuth ? "***" : "NOT SET"}`);

  if (process.env.NODE_ENV !== "production") {
    await verifyConnection();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("✅ Matomo MCP server ready");
}

main().catch((error) => {
  console.error("💥 Fatal:", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.error("🛑 Shutdown...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("🛑 Terminate...");
  process.exit(0);
});
