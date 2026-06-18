# Cursor Relay Inspector MCP

This folder contains a lightweight local MCP server for this project.

It is meant to help future agents quickly recover:

- the Cursor reverse-engineering workflow
- the current hybrid Relay architecture
- the installed Cursor patch status
- source anchors in this repo and the installed Cursor bundle
- whether a request should stay in Relay or fall back to Cursor native mutation execution

## Start

```powershell
npm run mcp:cursor-relay-inspector
```

## Suggested MCP Registration

Use the command below as the server entry:

```json
{
  "mcpServers": {
    "cursor-relay-inspector": {
      "command": "node",
      "args": ["/desktop/mcp/cursor-relay-inspector/server.cjs"]
    }
  }
}
```

## Exposed Resources

- `relay://skill/cursor-reverse`
- `relay://skill/cursor-review-bridge`
- `relay://skill/project-proxy`

## Exposed Tools

- `search_project_knowledge`
- `read_project_knowledge`
- `find_source_anchor`
- `scan_cursor_patch_status`

The MCP server only reads local files. It does not patch Cursor by itself.

Use it to verify the current split of responsibilities:

- Relay intercepts Cursor traffic first.
- Non-edit requests can continue through our Relay prompt and upstream path.
- File mutation requests are expected to fall back to Cursor native edit execution so official `Undo / Keep / Review` stays available.
