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

      tools.push({
        name,
        description: buildToolDescription(op, path, toolId),
        inputSchema: inputSchemaForOperation(op),
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
  const parts = [];
  if (toolId) {
    parts.push(`Menu ID: ${toolId}.`);
  }
  const summary = typeof op.summary === "string" ? op.summary.trim() : "";
  const description = typeof op.description === "string" ? op.description.trim() : "";
  if (summary) parts.push(summary.endsWith(".") ? summary : `${summary}.`);
  if (description && description !== summary) {
    parts.push(description.endsWith(".") ? description : `${description}.`);
  }
  if (toolId) {
    parts.push(`Use describe_tool with tool_id "${toolId}" for full page guidance.`);
  }
  return (parts.join(" ") || path).slice(0, 1024);
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
