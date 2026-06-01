const OPENAPI_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function slug(path) {
  return path
    .replace(/^\/api\/tools\//, "")
    .replace(/^\/api\//, "")
    .replace(/[/-]/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function toolsFromOpenApiSpec(spec, toolFilter = []) {
  const filterSet = new Set(toolFilter);
  const tools = [];

  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    if (!ops || typeof ops !== "object") continue;

    for (const [method, op] of Object.entries(ops)) {
      if (!OPENAPI_HTTP_METHODS.has(method) || !op || typeof op !== "object") continue;

      const toolId = op["x-tool-id"] ?? null;
      const mcpCompat = op["x-mcp-compatible"] ?? "native";
      if (mcpCompat === "none") continue;
      if (filterSet.size > 0 && toolId !== null && !filterSet.has(toolId)) continue;

      const baseName = slug(path);
      let name = baseName;
      if (tools.some((tool) => tool.name === name)) {
        name = `${baseName}_${method}`;
      }

      const annotations = annotationsForOperation(op);
      const outputSchema = outputSchemaForOperation(op);

      tools.push({
        name,
        description: buildToolDescription(op, path, toolId),
        inputSchema: inputSchemaForOperation(op),
        ...(annotations ? { annotations } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        _path: path,
        _method: method.toUpperCase(),
        _toolId: toolId,
        _mcpCompat: mcpCompat,
      });
    }
  }

  return tools;
}

export function buildToolDescription(op, path, toolId) {
  // The description is what an agent reads to choose and call the tool. Keep it
  // to the operation's own summary + description — no "Menu ID:" prefix (redundant
  // with the tool name) and no "Use describe_tool …" suffix (a pointer to another
  // tool reads as missing context). The describe_tool meta-tool still exists for
  // agents that want the full page guidance; it just isn't advertised in every line.
  const parts = [];
  const summary = typeof op.summary === "string" ? op.summary.trim() : "";
  const description = typeof op.description === "string" ? op.description.trim() : "";
  if (summary) parts.push(summary.endsWith(".") ? summary : `${summary}.`);
  if (description && description !== summary) {
    parts.push(description.endsWith(".") ? description : `${description}.`);
  }
  return (parts.join(" ") || path).slice(0, 1024);
}

/**
 * MCP tool annotations (behaviour hints). `title` always mirrors the human
 * summary. The boolean hints are only emitted when the operation declares them
 * via `x-mcp-annotations`, so we never assert a side-effect profile we haven't
 * verified. Returns null when there is nothing to annotate.
 */
export function annotationsForOperation(op) {
  const annotations = {};

  const title = typeof op.summary === "string" ? op.summary.trim() : "";
  if (title) annotations.title = title;

  const declared = op["x-mcp-annotations"];
  if (declared && typeof declared === "object") {
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      if (typeof declared[hint] === "boolean") {
        annotations[hint] = declared[hint];
      }
    }
    if (typeof declared.title === "string" && declared.title.trim() !== "") {
      annotations.title = declared.title.trim();
    }
  }

  return Object.keys(annotations).length > 0 ? annotations : null;
}

/**
 * MCP outputSchema, taken from the operation's inline 200 response object
 * schema. Skipped when the response is a $ref (e.g. the shared
 * GenericSuccessResponse) or not an object schema, so we only surface a real,
 * tool-specific shape. Returns null when unavailable.
 */
export function outputSchemaForOperation(op) {
  const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema || typeof schema !== "object") return null;
  if (typeof schema.$ref === "string") return null;
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    return null;
  }
  return schema;
}

export function inputSchemaForOperation(op) {
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema && typeof bodySchema === "object") {
    return bodySchema;
  }

  const parameters = Array.isArray(op.parameters) ? op.parameters : [];
  if (parameters.length === 0) {
    return { type: "object", additionalProperties: true };
  }

  const properties = {};
  const required = [];
  for (const param of parameters) {
    if (!param || typeof param !== "object" || typeof param.name !== "string") continue;
    if (!["query", "path"].includes(param.in)) continue;

    const schema = param.schema && typeof param.schema === "object"
      ? { ...param.schema }
      : { type: "string" };
    if (typeof param.description === "string" && !schema.description) {
      schema.description = param.description;
    }
    properties[param.name] = schema;
    if (param.required === true) {
      required.push(param.name);
    }
  }

  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

export function resolveToolIdForDescribe(raw, apiTools) {
  const found = apiTools.find((tool) => tool.name === raw || tool._toolId === raw);
  return found?._toolId || raw;
}
