#!/usr/bin/env node
/**
 * Online Cyber Tools — MCP server.
 *
 * On startup, fetches the OpenAPI spec from the configured base URL and
 * registers one MCP tool per documented POST endpoint. Two meta-tools are
 * always present: `search` (keyword lookup) and `report_bug` (file an
 * agent-flagged issue). Tool calls proxy to the live HTTP API so behaviour
 * always matches the deployed site.
 *
 * Usage:
 *   OCTOOLS_BASE_URL=https://onlinecybertools.com onlinecybertools-mcp
 *   # or, for local dev:
 *   OCTOOLS_BASE_URL=http://onlinecybertools.ddev.site:8000 node index.mjs
 *   # restrict to a specific subset of menu IDs:
 *   OCTOOLS_TOOLS=base64_encode,sha256,hash onlinecybertools-mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import {
  resolveToolIdForDescribe,
  toolsFromOpenApiSpec,
} from "./metadata.mjs";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.OCTOOLS_BASE_URL ?? "https://onlinecybertools.com").replace(/\/+$/, "");
const SERVER_NAME = "octools";
const SERVER_VERSION = "0.4.0";
const USER_AGENT = `octools-mcp/${SERVER_VERSION} (+${BASE_URL})`;

const TOOL_FILTER = (process.env.OCTOOLS_TOOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Stream buffering safety caps for SSE endpoints — protect agents from
// runaway output. Tunable via env vars for power users.
const STREAM_BYTE_CAP = parseInt(process.env.OCTOOLS_STREAM_BYTE_CAP ?? "262144", 10); // 256 KiB
const STREAM_TIME_CAP_MS = parseInt(process.env.OCTOOLS_STREAM_TIME_CAP_MS ?? "30000", 10); // 30 s

function logErr(msg, err) {
  // MCP stdio uses stdout for protocol — keep diagnostic output on stderr.
  console.error(`[${SERVER_NAME}] ${msg}${err ? ": " + (err.stack ?? err.message ?? err) : ""}`);
}

async function loadOpenApiTools() {
  let url = `${BASE_URL}/api/openapi.json`;
  if (TOOL_FILTER.length > 0) {
    url += `?tools=${encodeURIComponent(TOOL_FILTER.join(","))}`;
  }
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  }
  const spec = await res.json();
  return toolsFromOpenApiSpec(spec, TOOL_FILTER);
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "accept": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "user-agent": USER_AGENT, "accept": "application/json" },
  });
  const text = await res.text();
  return { status: res.status, text };
}

function withQuery(path, args) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const query = qs.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

/**
 * Proxy a streaming POST endpoint by reading the SSE body to completion
 * (or until safety caps are hit) and returning a single accumulated payload.
 *
 * Behavior:
 * - Tries POST first; if the endpoint requires GET (as /traceroute/stream does),
 *   the args are sent as query parameters and the method is switched.
 * - Aborts on STREAM_BYTE_CAP or STREAM_TIME_CAP_MS, returning a `truncated: true`
 *   marker so the agent knows the output is partial.
 * - Returns `{ status, text }` where `text` is a JSON envelope describing the
 *   collected SSE events.
 */
async function fetchStreamBuffered(path, args, prefersGet = false) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadline = startedAt + STREAM_TIME_CAP_MS;
  const timer = setTimeout(() => controller.abort(), STREAM_TIME_CAP_MS);

  let url = `${BASE_URL}${path}`;
  let method = prefersGet ? "GET" : "POST";
  let body;
  const headers = {
    "user-agent": USER_AGENT,
    "accept": "text/event-stream",
  };

  if (method === "GET" && args && typeof args === "object") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    if (qs.toString()) {
      url += (url.includes("?") ? "&" : "?") + qs.toString();
    }
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(args ?? {});
  }

  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    if (!res.body) {
      const text = await res.text();
      return { status: res.status, text };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    let truncated = false;
    const events = [];

    while (true) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }

      const { value, done } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > STREAM_BYTE_CAP) {
        truncated = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const parsed = parseSseEvent(raw);
        if (parsed) events.push(parsed);
      }
    }

    if (buffer.trim() !== "") {
      const parsed = parseSseEvent(buffer);
      if (parsed) events.push(parsed);
    }

    try { reader.cancel(); } catch { /* ignore */ }

    const envelope = {
      stream: true,
      truncated,
      bytes,
      duration_ms: Date.now() - startedAt,
      event_count: events.length,
      events,
    };
    return { status: res.status, text: JSON.stringify(envelope) };
  } finally {
    clearTimeout(timer);
  }
}

function parseSseEvent(raw) {
  const event = { type: null, data: null };
  let dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event.type = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    } else if (line.startsWith(":")) {
      // SSE comment — ignore
    }
  }
  if (dataLines.length === 0 && event.type === null) return null;
  const dataStr = dataLines.join("\n");
  try {
    event.data = dataStr === "" ? null : JSON.parse(dataStr);
  } catch {
    event.data = dataStr;
  }
  return event;
}

function buildMetaTools(resolveToolId) {
  return [
    {
      name: "search",
      description: "Keyword search across the Online Cyber Tools catalogue. Returns up to 25 ranked matches with their URL, API URL, description, and category.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search query — substring or whitespace-separated tokens." },
        },
        required: ["q"],
      },
      handler: async (args) => {
        const q = encodeURIComponent(String(args?.q ?? ""));
        return getJson(`/api/tools/search?q=${q}`);
      },
    },
    {
      name: "describe_tool",
      description: "Fetch the full Online Cyber Tools page guidance for a tool. Accepts a menu ID such as `ping` or an MCP tool name such as `network_ping`.",
      inputSchema: {
        type: "object",
        properties: {
          tool_id: { type: "string", description: "Menu ID or MCP tool name to describe." },
        },
        required: ["tool_id"],
      },
      handler: async (args) => {
        const requested = String(args?.tool_id ?? "").trim();
        if (!requested) {
          return { status: 400, text: JSON.stringify({ error: "Missing required parameter: tool_id" }) };
        }
        return getJson(`/api/mcp/tool-docs/${encodeURIComponent(resolveToolId(requested))}`);
      },
    },
    {
      name: "report_bug",
      description: "File a bug report against one of the tools. Use this only when you have concrete reproduction details — endpoint is hard-rate-limited.",
      inputSchema: {
        type: "object",
        properties: {
          tool_id: { type: "string", description: "Menu id of the affected tool (e.g. `base64_encode`)." },
          url: { type: "string", format: "uri", description: "URL where the bug was observed." },
          expected: { type: "string", description: "What you expected to happen." },
          actual: { type: "string", description: "What actually happened." },
          repro_steps: { type: "array", items: { type: "string" }, description: "Ordered steps to reproduce." },
          agent_id: { type: "string", description: "Optional self-identification (e.g. model name)." },
        },
        required: ["tool_id", "url", "expected", "actual"],
      },
      handler: async (args) => postJson("/api/agent/bug-report", args ?? {}),
    },
  ];
}

async function main() {
  let apiTools = [];
  try {
    apiTools = await loadOpenApiTools();
    logErr(`loaded ${apiTools.length} API tools from ${BASE_URL}/api/openapi.json (filter=${TOOL_FILTER.length || "none"})`);
  } catch (e) {
    logErr("could not load OpenAPI spec — only meta-tools will be exposed", e);
  }

  const resolveToolId = (raw) => resolveToolIdForDescribe(raw, apiTools);
  const metaTools = buildMetaTools(resolveToolId);

  // Dedup meta tools vs OpenAPI-derived names just in case the API adds matching endpoints.
  const apiNames = new Set(apiTools.map((t) => t.name));
  const allTools = [
    ...metaTools.filter((t) => !apiNames.has(t.name)),
    ...apiTools,
  ];

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = allTools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      let result;
      if (tool.handler) {
        result = await tool.handler(args ?? {});
      } else if (tool._mcpCompat === "stream-buffered") {
        const prefersGet = tool._method === "GET";
        result = await fetchStreamBuffered(tool._path, args ?? {}, prefersGet);
      } else if (tool._method === "GET") {
        result = await getJson(withQuery(tool._path, args ?? {}));
      } else {
        result = await postJson(tool._path, args ?? {});
      }
      const isError = result.status < 200 || result.status >= 300;
      return {
        content: [
          { type: "text", text: result.text || `(empty body, HTTP ${result.status})` },
        ],
        isError,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error calling ${name}: ${e.message ?? String(e)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr(`MCP server ready over stdio (base=${BASE_URL}, tools=${allTools.length})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    logErr("fatal", e);
    process.exit(1);
  });
}

export {
  loadOpenApiTools,
};
