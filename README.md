# onlinecybertools-mcp-server

MCP (Model Context Protocol) server that lets AI agents — Claude Code, Codex,
Cursor, Continue, etc. — use the
[Online Cyber Tools](https://onlinecybertools.com) catalogue as a set of
native MCP tools.

## What it exposes

- One MCP tool per documented `POST /api/tools/{category}/{tool}` endpoint —
  the input schema is taken straight from the site's OpenAPI 3.1 spec at
  `/api/openapi.json`, so agents get per-tool argument validation.
- A `search` meta-tool that performs the same keyword search humans use,
  backed by `GET /api/tools/search?q=...`.
- A `report_bug` meta-tool that files a structured bug report against
  `POST /api/agent/bug-report` (hard rate-limited).

Calls are proxied to the live HTTP API — no algorithm is re-implemented here.
That guarantees agents see whatever the deployed site does.

## Quick start

The easiest way to install this server is to generate a Claude Code plugin
or Codex config block from the website's interactive builder:

  **<https://onlinecybertools.com/integrations/mcp-plugin-builder>**

The builder lets you pick the exact tools you want, then downloads a plugin
that calls this server with the right `OCTOOLS_TOOLS` filter.

## Configuration

Configure via environment variables. All are optional.

| Variable                        | Default                                 | Purpose |
|---------------------------------|-----------------------------------------|---------|
| `OCTOOLS_BASE_URL`              | `https://onlinecybertools.com`          | Site to proxy requests to. |
| `OCTOOLS_TOOLS`                 | _(unset → all tools)_                   | Comma-separated menu IDs (`base64_encode,sha256,hash`) to restrict the exposed surface. |
| `OCTOOLS_STREAM_BYTE_CAP`       | `262144` (256 KiB)                      | Max bytes accumulated from a streamed (`x-mcp-compatible: stream-buffered`) endpoint. |
| `OCTOOLS_STREAM_TIME_CAP_MS`    | `30000` (30 s)                          | Max wall-clock time spent buffering a streamed endpoint. |

When `OCTOOLS_TOOLS` is set, the server appends `?tools=...` to the spec
fetch so the site returns a pre-filtered spec; the client also enforces the
filter as defense-in-depth.

## Running

### Inspector (manual smoke test)

```bash
git clone https://github.com/Jambozx/onlinecybertools-mcp-server.git
cd onlinecybertools-mcp-server
npm install
OCTOOLS_BASE_URL=https://onlinecybertools.com \
  npx @modelcontextprotocol/inspector node index.mjs
```

Open the inspector URL, click **List Tools** — you should see `search`,
`report_bug`, plus one entry per Symfony API endpoint.

### Claude Code

Add to `~/.claude.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "octools": {
      "command": "npx",
      "args": ["-y", "github:Jambozx/onlinecybertools-mcp-server"],
      "env": {
        "OCTOOLS_BASE_URL": "https://onlinecybertools.com",
        "OCTOOLS_TOOLS": "base64_encode,sha256,hash"
      }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.octools]
command = "npx"
args = ["-y", "github:Jambozx/onlinecybertools-mcp-server"]
env = { OCTOOLS_BASE_URL = "https://onlinecybertools.com", OCTOOLS_TOOLS = "base64_encode,sha256,hash" }
```

### Cursor / Continue / generic MCP client

Most clients accept the same `command`/`args`/`env` shape. Point them at
this package via `npx -y github:Jambozx/onlinecybertools-mcp-server`.

## Streaming endpoints

Endpoints tagged `x-mcp-compatible: stream-buffered` in the spec (currently
traceroute and proxy-test streams) are read to completion and returned as a
single JSON envelope of accumulated SSE events. Hard caps:

- 256 KiB of buffered output (`OCTOOLS_STREAM_BYTE_CAP`)
- 30 s of wall-clock time (`OCTOOLS_STREAM_TIME_CAP_MS`)

Whichever cap fires first, the response envelope contains
`{ "truncated": true }` so the agent knows the output is partial.

Endpoints tagged `x-mcp-compatible: none` (multipart file uploads, etc.) are
**skipped at registration** — they will not appear in `tools/list`.

## Limitations

- Spec is fetched **once at startup**. If the site adds new endpoints, restart
  the server.
- stdio transport only; no HTTP server (avoids needing auth in front of a
  privileged endpoint).
- Distributed via GitHub (`npx -y github:Jambozx/onlinecybertools-mcp-server`);
  npm-registry publication is a follow-up.

## License

MIT.
