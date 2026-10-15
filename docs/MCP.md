# Connect AI agents to Alt (MCP)

Alt has a built-in [Model Context Protocol](https://modelcontextprotocol.io) server. While the Alt desktop app is open, any MCP client — Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed, Codex… — can **read and edit the open design live**: create screens, restyle layers, import SVG icons, take screenshots to check its work, and export to code. Every change an agent makes is a normal undoable step in Alt.

| | |
|---|---|
| Endpoint | `http://127.0.0.1:7331/mcp` (Streamable HTTP, JSON responses) |
| Health check | `http://127.0.0.1:7331/health` |
| stdio bridge | `alt-mcp.mjs` (for clients that only launch commands) |
| Settings | **Alt → Settings → MCP**: on/off, port, *Allow scripts* |

The server is on by default and only listens on the loopback interface. **Settings → MCP** in Alt shows the live status and ready-to-copy snippets with the exact paths for your machine.

---

## Quick start

### Claude Code

```sh
claude mcp add --transport http alt http://127.0.0.1:7331/mcp
```

Add `--scope user` to make Alt available in every project. Then ask, for example: *“Design a mobile onboarding screen in Alt — three steps, soft gradients, then screenshot it and polish the spacing.”*

### Claude Desktop

Claude Desktop launches MCP servers as commands, so use the stdio bridge that ships with Alt. You **don't need Node.js**: the Alt executable can run the bridge itself (`ELECTRON_RUN_AS_NODE=1`). Alt copies the bridge to a stable location on every start:

| OS | Bridge script | Alt executable |
|---|---|---|
| macOS | `~/Library/Application Support/Alt/mcp/alt-mcp.mjs` | `/Applications/Alt.app/Contents/MacOS/Alt` |
| Windows | `%APPDATA%\Alt\mcp\alt-mcp.mjs` | `%LOCALAPPDATA%\Programs\Alt\Alt.exe` |
| Linux (deb / rpm) | `~/.config/Alt/mcp/alt-mcp.mjs` | `/opt/Alt/alt` |
| Linux (AppImage) | `~/.config/Alt/mcp/alt-mcp.mjs` | the `.AppImage` file itself |

Edit `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config) and use **absolute paths** (JSON does not expand `~` or `%VARS%`):

```json
{
  "mcpServers": {
    "alt": {
      "command": "/Applications/Alt.app/Contents/MacOS/Alt",
      "args": ["/Users/you/Library/Application Support/Alt/mcp/alt-mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "alt": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Alt\\Alt.exe",
      "args": ["C:\\Users\\you\\AppData\\Roaming\\Alt\\mcp\\alt-mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

If you have Node.js ≥ 18 you can use it instead:

```json
{
  "mcpServers": {
    "alt": { "command": "node", "args": ["/Users/you/Library/Application Support/Alt/mcp/alt-mcp.mjs"] }
  }
}
```

Restart Claude Desktop afterwards. If Alt isn't running yet, the bridge still connects, exposes a single `alt_status` tool explaining what to do, and tells the client to refresh its tool list as soon as Alt starts.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "alt": { "url": "http://127.0.0.1:7331/mcp" }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in your workspace, or **MCP: Add Server… → HTTP**:

```json
{
  "servers": {
    "alt": { "type": "http", "url": "http://127.0.0.1:7331/mcp" }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "alt": { "serverUrl": "http://127.0.0.1:7331/mcp" }
  }
}
```

### Other clients

* **HTTP-capable clients** (Zed, Cline, Continue, Goose, LM Studio, …): point them at `http://127.0.0.1:7331/mcp` (transport “Streamable HTTP” / “http”).
* **stdio-only clients** (e.g. Codex CLI): run the bridge as above. Codex `~/.codex/config.toml`:

  ```toml
  [mcp_servers.alt]
  command = "node"
  args = ["/Users/you/Library/Application Support/Alt/mcp/alt-mcp.mjs"]
  ```
* **MCP Inspector**: `npx @modelcontextprotocol/inspector`, choose *Streamable HTTP* and enter the URL.

### Test with curl

```sh
curl -s http://127.0.0.1:7331/health
curl -s -X POST http://127.0.0.1:7331/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Custom port

Change the port in **Settings → MCP** (and update your client config). The bridge reads `ALT_MCP_PORT` (or a full `ALT_MCP_URL`) from its environment:

```json
"env": { "ELECTRON_RUN_AS_NODE": "1", "ALT_MCP_PORT": "7444" }
```

---

## How agents see a design

* A document has **pages**; each page holds a tree of **layers**. Containers: `frame` (screens, cards, buttons — clips content, supports auto layout), `group`, `boolean`. Leaves: `rect`, `ellipse`, `polygon`, `star`, `path`, `text`, `brush`, `bitmap`.
* `x` / `y` are **relative to the parent** and mark the top-left of the layer's *unrotated* box; `rotation` is in degrees, clockwise, around the box centre.
* Children are ordered back-to-front (last = on top).
* Colours are hex (`#RRGGBB`, `#RRGGBBAA`); inputs also accept `rgb()`, `hsl()` and CSS names.
* Auto-layout frames position their children (like flexbox) — `gap`, `padding`, `align`, `justify`, and `sizingH` / `sizingV` = `fixed | hug | fill`.

Recommended agent loop: `get_document` → one frame per screen → build it with **one nested `create_nodes` call** → `screenshot` → fix with `update_nodes` / `move_nodes` → screenshot again.

Example `create_nodes` call:

```json
{
  "nodes": [{
    "type": "frame", "name": "Card", "x": 80, "y": 80, "width": 360,
    "fill": "#FFFFFF", "cornerRadius": 20, "shadow": { "y": 12, "blur": 32, "color": "#0F172A1F" },
    "autoLayout": { "mode": "vertical", "gap": 12, "padding": 24 },
    "children": [
      { "type": "text", "text": "Weekly report", "fontSize": 22, "fontWeight": "semibold", "fill": "#0F172A" },
      { "type": "text", "text": "Revenue grew 12%.", "fontSize": 15, "fill": "#475569", "sizingH": "fill", "autoResize": "height" },
      { "type": "path", "name": "Check icon", "d": "M5 12l5 5L20 7", "stroke": "#16A34A", "strokeWidth": 2, "fill": "none" }
    ]
  }]
}
```

## Tools

| Tool | What it does |
|---|---|
| `get_document` | Document overview: pages, current page, selection, styles, top-level frames and their bounds. |
| `get_tree` | Compact layer tree of a page or subtree (depth-limited). |
| `get_nodes` | Full JSON of layers (+ absolute bounds; images and vector points elided). |
| `find_nodes` | Search by name (substring / regex), type, text content, page or subtree. |
| `get_selection` / `set_selection` | Read / change what the user has selected. |
| `create_nodes` | Create nested layers in one step: frames, shapes, lines, paths (SVG `d`), text, images, groups, booleans — with fills, gradients, strokes, corner radii, shadows, blurs, auto layout. |
| `update_nodes` | Partial updates with the same convenience props, per node or in bulk. |
| `delete_nodes` | Delete layers. |
| `move_nodes` | Re-parent (keeping on-screen position or placing at x/y) and re-stack. |
| `duplicate_nodes` | Duplicate with `count` and cumulative `offset` (rows / grids of cards). |
| `group_nodes` / `ungroup_nodes` | Group, frame or boolean-combine layers; dissolve containers. |
| `align_nodes` / `distribute_nodes` | Align edges / centres; distribute evenly or with exact spacing. |
| `set_auto_layout` | Add / tune / remove auto layout, or wrap layers in an auto-layout frame. |
| `import_svg` | Import SVG markup as editable vectors, positioned and scaled. |
| `list_exporters` / `export` | Export to PNG/JPG/WebP/SVG/PDF or generate code (HTML, React, Tailwind, SwiftUI, Flutter, Compose, Roblox, Godot, tokens, …). Returns text, images or base64 — never writes files. |
| `screenshot` | Render layers / a page to an image the agent can look at. |
| `manage_pages` | List, create, rename, delete, duplicate, switch pages. |
| `undo` / `redo` | Step through history. |
| `zoom_to` | Move the user's viewport to layers / selection / everything. |
| `run_script` | Run JavaScript inside Alt with an `alt` API (procedural art, bulk edits). **Only listed when *Allow scripts* is on.** |

Images can be given as `https://` URLs, `data:` URLs or **absolute local file paths** (`png`, `jpg`, `webp`, `gif`, `avif`, `bmp`, `svg`, `ico`, ≤ 30 MB); Alt fetches / reads them and embeds them in the document.

---

## Security

* **Local only.** The server binds `127.0.0.1` and rejects requests whose `Host` header isn't `localhost` / `127.0.0.1` (blocks DNS-rebinding attacks).
* **Web pages can't drive Alt.** Browser requests must come from a loopback origin (e.g. MCP Inspector on `localhost`) and use `Content-Type: application/json`; other origins — including the opaque `null` origin of sandboxed iframes — get `403`.
* **No auth token.** Like other local developer tools, any program running as your user on this machine can connect while the server is on. Turn it off in **Settings → MCP** when you don't need it.
* **Scripts are off by default.** `run_script` executes code inside the Alt window and is only exposed after you enable *Allow scripts*.
* **Files.** Agents can make Alt read *image* files they name (to place them in the design). Exports are returned to the agent; Alt never writes files on an agent's behalf.
* **Everything is undoable** and happens in front of you; request bodies are capped at 20 MB and each tool call times out after 120 s.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Client says it can't connect | Is Alt open? Check `http://127.0.0.1:7331/health` and **Settings → MCP** (enabled, port). |
| “Port 7331 is already in use” | Another program owns the port — pick a different one in Settings and update your client config / `ALT_MCP_PORT`. |
| Tools return “window is closed” (macOS) | Alt keeps running without windows; click the Dock icon to open a window. |
| Only an `alt_status` tool appears | The bridge started before Alt. Open Alt; the tool list refreshes automatically (or reconnect the server). |
| macOS: path to Alt changes / bridge fails | Move Alt.app into **/Applications** (apps launched from Downloads run from a randomized “translocated” path). |
| Linux AppImage | Use the path of the `.AppImage` file as `command` (it accepts `ELECTRON_RUN_AS_NODE=1`). |
| Windows: `ELECTRON_RUN_AS_NODE` ignored | Use the Node.js variant of the config. |
