import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveToolIdForDescribe,
  toolsFromOpenApiSpec,
} from "./metadata.mjs";

test("OpenAPI metadata becomes precise MCP tools", async () => {
  const spec = {
    paths: {
      "/api/tools/network/ping": {
        post: {
          summary: "Ping Tool",
          description: "Test network connectivity.",
          "x-tool-id": "ping",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["target"],
                  properties: {
                    target: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tools/network/traceroute/stream": {
        get: {
          summary: "Traceroute event stream",
          description: "Stream traceroute hop events.",
          "x-tool-id": "traceroute",
          "x-mcp-compatible": "stream-buffered",
          parameters: [
            {
              name: "target",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
        },
      },
    },
  };

  const tools = toolsFromOpenApiSpec(spec);

  const ping = tools.find((tool) => tool.name === "network_ping");
  assert.ok(ping);
  assert.equal(ping._toolId, "ping");
  assert.deepEqual(ping.inputSchema.required, ["target"]);
  assert.equal(ping.inputSchema.properties.target.type, "string");
  assert.match(ping.description, /Menu ID: ping/);
  assert.equal(resolveToolIdForDescribe("network_ping", tools), "ping");
  assert.equal(resolveToolIdForDescribe("ping", tools), "ping");

  const traceroute = tools.find((tool) => tool.name === "network_traceroute_stream");
  assert.ok(traceroute);
  assert.equal(traceroute._method, "GET");
  assert.equal(traceroute._toolId, "traceroute");
  assert.equal(traceroute._mcpCompat, "stream-buffered");
  assert.deepEqual(traceroute.inputSchema.required, ["target"]);
  assert.equal(traceroute.inputSchema.additionalProperties, false);
});
