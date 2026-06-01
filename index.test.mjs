import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationsForOperation,
  buildToolDescription,
  outputSchemaForOperation,
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
  // Description is the operation's own summary + description, with no
  // "Menu ID:" prefix and no "Use describe_tool" pointer.
  assert.equal(ping.description, "Ping Tool. Test network connectivity.");
  assert.doesNotMatch(ping.description, /Menu ID/);
  assert.doesNotMatch(ping.description, /describe_tool/);
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

test("buildToolDescription drops the Menu ID prefix and describe_tool suffix", () => {
  const desc = buildToolDescription(
    { summary: "Hash Cracker", description: "Crack password hashes using dictionary attacks." },
    "/api/tools/crypto/hash-cracker",
    "hash_cracker",
  );
  assert.equal(desc, "Hash Cracker. Crack password hashes using dictionary attacks.");
  assert.doesNotMatch(desc, /Menu ID/);
  assert.doesNotMatch(desc, /describe_tool/);
});

test("annotations are emitted only from x-mcp-annotations (plus title)", () => {
  // No x-mcp-annotations: title only.
  const titleOnly = annotationsForOperation({ summary: "Hash Cracker" });
  assert.deepEqual(titleOnly, { title: "Hash Cracker" });

  // Nothing at all: null.
  assert.equal(annotationsForOperation({}), null);

  // Declared hints pass through; non-boolean values are ignored.
  const full = annotationsForOperation({
    summary: "Hash Cracker",
    "x-mcp-annotations": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, bogus: "x" },
  });
  assert.deepEqual(full, {
    title: "Hash Cracker",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  });
});

test("outputSchema is taken only from an inline 200 object schema", () => {
  const inline = outputSchemaForOperation({
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { type: "object", properties: { found: { type: "boolean" } } },
          },
        },
      },
    },
  });
  assert.deepEqual(inline, { type: "object", properties: { found: { type: "boolean" } } });

  // $ref / generic response -> skipped.
  assert.equal(
    outputSchemaForOperation({
      responses: { "200": { content: { "application/json": { schema: { $ref: "#/x" } } } } },
    }),
    null,
  );
  assert.equal(outputSchemaForOperation({}), null);
});

test("tool object surfaces annotations and outputSchema when present", () => {
  const spec = {
    paths: {
      "/api/tools/crypto/hash-cracker": {
        post: {
          summary: "Hash Cracker",
          description: "Crack password hashes using dictionary attacks.",
          "x-tool-id": "hash_cracker",
          "x-mcp-annotations": { readOnlyHint: true, destructiveHint: false },
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { hash: { type: "string" } } } } },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { found: { type: "boolean" }, password: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  };

  const [tool] = toolsFromOpenApiSpec(spec);
  assert.equal(tool.name, "crypto_hash_cracker");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.title, "Hash Cracker");
  assert.equal(tool.outputSchema.properties.found.type, "boolean");
});
