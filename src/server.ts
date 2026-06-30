import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Matomo Direct MCP Server
 * 
 * Connetta direttamente al tuo'istanza Matomo tramite'HTTP Reporting API
 * senza proxy esterni o token Openmost.
 * 
 * Uses: @alexgenovese/matomo-mcp
 */
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

// Configuration defaults
const DEFAULT_CONFIG = {
  timeout: 30000,
  retryCount: 3,
  retryDelay: 1000,
  defaultFormat: "json",
};

interface Config {
  matomoHost: string;
  tokenAuth: string;
  timeout: number;
  retryCount: number;
  retryDelay: number;
  defaultFormat: string;
}

let config: Config | null = null;

// ===== Configuration =====

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
    errors.push("MATOMO_HOST is required. Use --matomo-host=YOUR_URL");
  }

  if (!config?.tokenAuth) {
    errors.push("MATOMO_TOKEN_AUTH is required. Use --matomo-token=YOUR_TOKEN");
  }

  if (config?.matomoHost) {
    try {
      normalizeMatomoBaseUrl(config.matomoHost);
    } catch (error) {
      errors.push(`Invalid MATOMO_HOST URL: ${config.matomoHost}`);
    }
  }

  return errors;
}

// ===== API Helpers =====

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

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      appendSearchParams(searchParams, key, value);
    }
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

// ===== Matomo API Client =====

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

// ===== Matomo Tools =====

const toolDefinitions: Tool[] = [
  {
    name: "matomo_call",
    description:
      "Esegue qualsiasi metodo dell'HTTP Reporting API di Matomo (es. VisitsSummary.get, SitesManager.getSitesWithViewAccess, Goals.get, API.getReportMetadata). " +
      "Parametri: 'module.action' per il metodo, parametric genrici, formato risposta.",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "Metodo Matomo nel formato Module.action (es. VisitsSummary.get, UsersManager.getUsers)",
        },
        params: {
          type: "object",
          description: "Parametri della richiesta API (serializzati con notazione matrice)",
          additionalProperties: true,
        },
        format: {
          type: "string",
          description: "Formato di risposta di Matomo",
          enum: ["json", "xml", "csv", "tsv", "html", "rss", "original", "png"],
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
      "Recupera la lista completa di report compatibili da API.getReportMetadata per l'istanza Matomo corrente. " +
      "Utli per'esplorazione metadati e scoperta report disponibili.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: {
          type: "integer",
          description: "ID Matomo del sito",
        },
        period: {
          type: "string",
          description: "Periodo di衰竭 (day, week, month, year)",
          default: "day",
        },
        date: {
          type: "string",
          description: "Data di inizio periodo (es. today, yesterday, last30)",
          default: "today",
        },
        language: {
          type: "string",
          description: "Codice lingua (es. en, it)",
        },
        showSubtableReports: {
          type: "boolean",
          description: "Include report di subtable prima generazione",
          default: true,
        },
        hideMetricsDoc: {
          type: "boolean",
          description: "Nasconde documentazione delle metriche",
          default: false,
        },
      },
      required: ["idSite"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_metadata",
    description:
      "Recupera metadati dettagliati per un report Matomo specifico tramite API.getMetadata. " +
      "Include schema, nomi delle metriche, unità di misura, documentazione e parametri disponibili. " +
      "Essenziale per comprender e costruire report personalizzati correttamente.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: {
          type: "integer",
          description: "ID Matomo del sito",
        },
        apiModule: {
          type: "string",
          description: "Nome del modulo API (es. VisitsSummary, UserCountry, Goal)",
        },
        apiAction: {
          type: "string",
          description: "Nome dell'azione API (es. MetricsAll, getName, getNameByCode)",
        },
        period: {
          type: "string",
          default: "day",
        },
        date: {
          type: "string",
          default: "today",
        },
        language: {
          type: "string",
        },
        hideMetricsDoc: {
          type: "boolean",
          default: false,
        },
        showSubtableReports: {
          type: "boolean",
          default: true,
        },
      },
      required: ["idSite", "apiModule", "apiAction"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_processed_report",
    description:
      "Recupera report completo processato con dati, metadati e metriche aritmetice. " +
      "Utilizza API.getProcessedReport per otten risultati numerici calcolati da Matomo. " +
      "Supporta parametri avanzati (goal, segmento, troncamento, limitazione risultati).",
    inputSchema: {
      type: "object",
      properties: {
        idSite: {
          type: "integer",
          description: "ID Matomo del sito",
        },
        apiModule: {
          type: "string",
          description: "Modulo Matomo API",
        },
        apiAction: {
          type: "string",
          description: "Azione Matomo API",
        },
        period: {
          type: "string",
          default: "day",
        },
        date: {
          type: "string",
          default: "today",
        },
        language: {
          type: "string",
        },
        idGoal: {
          type: "string",
          description: "ID obiettivo da includere",
        },
        idSubtable: {
          type: "string",
          description: "ID sottotabella da filtrare",
        },
        segment: {
          type: "string",
          description: "Filtro segmento",
        },
        flat: {
          type: "boolean",
          description: "Remove anidazione in risposta",
        },
        expanded: {
          type: "boolean",
          description: "Include righe espande ma non subtable",
        },
        filter_truncate: {
          type: "integer",
          description: "Tronca dati lunghi",
        },
        filter_limit: {
          type: "integer",
          description: "Limite di righe da restituire",
        },
        showMetadata: {
          type: "boolean",
          description: "Include metadati nella risposta",
        },
      },
      required: ["idSite", "apiModule", "apiAction"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_row_evolution",
    description:
      "Analizza evoluzione temporale di una singola riga di report (label specifica) " +
      "utilizzando API.getRowEvolution. Ideale per trend storici specifici. " +
      "Restituisce serie temporale valori da 'date' a 'period'.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: {
          type: "integer",
          description: "ID Matomo del sito",
        },
        apiModule: {
          type: "string",
          description: "Modulo Matomo API",
        },
        apiAction: {
          type: "string",
          description: "Azione Matomo API",
        },
        label: {
          type: "string",
          description: "Label o nome della riga da evolvere",
        },
        period: {
          type: "string",
          default: "day",
        },
        date: {
          type: "string",
          default: "today",
        },
        segment: {
          type: "string",
          description: "Filtro segmento",
        },
        idGoal: {
          type: "string",
          description: "ID obiettivo",
        },
        idSubtable: {
          type: "string",
          description: "ID sottotabella",
        },
      },
      required: ["idSite", "apiModule", "apiAction", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "matomo_get_image_graph",
    description:
      "Genera e restituisce immagine PNG dello grafico tramite ImageGraph.get. " +
      "Supporta tipi grafici diversi (curve evoluzionifiche, barre verticali/orizzontali, torta). " +
      "Ideale per visualizzazioni su report dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        idSite: {
          type: "integer",
          description: "ID Matomo del sito",
        },
        apiModule: {
          type: "string",
          description: "Modulo Matomo API",
        },
        apiAction: {
          type: "string",
          description: "Azione Matomo API",
        },
        period: {
          type: "string",
          default: "day",
        },
        date: {
          type: "string",
          default: "today",
        },
        graphType: {
          type: "string",
          enum: ["evolution", "horizontalBar", "verticalBar", "pie"],
          description: "Tipo grafico",
        },
        width: {
          type: "integer",
          description: "Larghezza immagine in pixel",
        },
        height: {
          type: "integer",
          description: "Altezza immagine in pixel",
        },
        columns: {
          type: "string",
          description: "Colonne restituire",
        },
        labels: {
          type: "string",
          description: "Label specifiche",
        },
        segment: {
          type: "string",
          description: "Filtro segmento",
        },
        idGoal: {
          type: "string",
          description: "ID obiettivo",
        },
        idSubtable: {
          type: "string",
          description: "ID sottotabella",
        },
      },
      required: ["idSite", "apiModule", "apiAction"],
      additionalProperties: false,
    },
  },
];

// ===== MCP Request Handlers =====

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

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
        content: formatResult(
          await callMatomoApi(method, params, { format }),
          format
        ),
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
      const {
        idSite,
        apiModule,
        apiAction,
        period = "day",
        date = "today",
        language,
        hideMetricsDoc = false,
        showSubtableReports = true,
      } = toolArgs;

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
      const {
        idSite,
        apiModule,
        apiAction,
        period = "day",
        date = "today",
        language,
        idGoal,
        idSubtable,
        segment,
        flat,
        expanded,
        filter_truncate,
        filter_limit,
        showMetadata,
      } = toolArgs;

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
      const {
        idSite,
        apiModule,
        apiAction,
        label,
        period = "day",
        date = "today",
        segment,
        idGoal,
        idSubtable,
      } = toolArgs;

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
      const {
        idSite,
        apiModule,
        apiAction,
        period = "day",
        date = "today",
        graphType,
        width,
        height,
        columns,
        labels,
        segment,
        idGoal,
        idSubtable,
      } = toolArgs;

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
          }, { format: "png" }),
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

// ===== Main Entry =====

async function showHelp() {
  console.error(`
@alexgenovese/matomo-mcp - Matomo Direct MCP Server

Usage: node src/index.ts [options]

Required:
  --matomo-host=URL        Base URL dell'istancia Matomo (es. https://analytics.example.com)
  --matomo-token=TOKEN     Auth token Matomo (token_auth)

Options:
  --timeout=MS             Timeout richieste (default: 30000)
  --retry=COUNT            Tentativi retry (default: 3)
  --retry-delay=MS         Ritiro retry iniziali (default: 1000)
  --format=FORMAT          Format di default per matomo_call (default: json)
  --help                   Mostra questa aiut

Environment variables:
  MATOMO_HOST              Base URL delta istanza Matomo
  MATOMO_TOKEN_AUTH        Matomo auth token
  REQUEST_TIMEOUT          Request timeout
  RETRY_COUNT              Retry count
  RETRY_DELAY              Retry delay
  MATOMO_DEFAULT_FORMAT    Default format

Tools exposed:
  - matomo_call
  - matomo_list_report_metadata
  - matomo_get_metadata
  - matomo_get_processed_report
  - matomo_get_row_evolution
  - matomo_get_image_graph

Examples:
  node src/index.ts --matomo-host=https://analytics.example.com --matomo-token=abc123
  MATOMO_HOST=https://analytics.example.com MATOMO_TOKEN_AUTH=abc123 node src/index.ts
`);
}

async function verifyConnection() {
  try {
    const result = await callMatomoApi("API.getMatomoVersion", {}, { format: "json" });
    console.error("✅ Matomo reachable, version response received");
    return result;
  } catch (error) {
    console.error(`⚠️ Matomo connection check failed: ${error}`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // Parse config
  config = {
    matomoHost: getArgValue("matomo-host") || getEnvValue("matomo-host", "MATOMO_HOST"),
    tokenAuth: getArgValue("matomo-token") || getEnvValue("matomo-token", "MATOMO_TOKEN_AUTH", getEnvValue("matomo-token", "MATOMO_TOKEN")),
    timeout: parseInt(getArgValue("timeout") || process.env.REQUEST_TIMEOUT || "30000", 10),
    retryCount: parseInt(getArgValue("retry") || process.env.RETRY_COUNT || "3", 10),
    retryDelay: parseInt(getArgValue("retry-delay") || process.env.RETRY_DELAY || "1000", 10),
    defaultFormat:
      (getArgValue("format") || process.env.MATOMO_DEFAULT_FORMAT || "json").toLowerCase(),
  };

  // Validate config
  const errors = validateConfiguration();
  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.error("🔧 Matomo MCP Server configuration:");
  console.error(`   Host: ${config.matomoHost}`);
  console.error(`   Timeout: ${config.timeout}ms`);
  console.error(`   Retry: ${config.retryCount} attempts`);
  console.error(`   Format: ${config.defaultFormat}`);
  console.error(`   Token: ${config.tokenAuth ? "***" : "NOT SET"}`);

  // Optional connection test
  if (process.env.NODE_ENV !== "production") {
    await verifyConnection();
  }

  // Connect and start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("✅ Matomo direct MCP server ready");
}

main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.error("🛑 Shutdown...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("🛑 Terminated...");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught exception:", error);
  process.exit(1);
});