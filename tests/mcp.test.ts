import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import {
  createMcpHandler,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
  type McpTool,
} from '../electron/mcp/protocol';
import { isAllowedHost, isAllowedOrigin, McpHttpServer } from '../electron/mcp/server';
import { resolveImageSources, sniffImageMime, type ImageIO } from '../electron/mcp/images';
import { getMcpTools, MCP_INSTRUCTIONS, MCP_TOOLS, type JsonSchema } from '../src/api/mcpTools';

/* ------------------------------------------------------------------ helpers */

const echoTool: McpTool = {
  name: 'echo',
  description: 'Echo the message',
  inputSchema: { type: 'object', properties: { message: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['message'] },
};
const boomTool: McpTool = { name: 'boom', description: 'Always throws', inputSchema: { type: 'object', properties: {} } };

function makeHandler() {
  return createMcpHandler({
    serverInfo: { name: 'alt-test', version: '1.2.3' },
    instructions: 'Test instructions',
    listTools: () => [echoTool, boomTool],
    callTool: async (name, args) => {
      if (name === 'boom') throw new Error('kaboom');
      return { content: [{ type: 'text', text: `echo:${String(args.message)}` }] };
    },
    unavailableToolMessage: (name) => (name === 'run_script' ? 'run_script is disabled' : undefined),
  });
}

const rpc = (id: number | string | null, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

/* ================================================================ protocol */

describe('MCP protocol handler', () => {
  const h = makeHandler();

  it('negotiates the protocol version on initialize', async () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const r = (await h.handle(rpc(1, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } }))) as JsonRpcResponse;
      expect('result' in r && (r.result as { protocolVersion: string }).protocolVersion).toBe(v);
    }
    const r = (await h.handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }))) as { result: Record<string, unknown> };
    expect(r.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(r.result.serverInfo).toEqual({ name: 'alt-test', version: '1.2.3' });
    expect(r.result.capabilities).toHaveProperty('tools');
    expect(r.result.instructions).toBe('Test instructions');
  });

  it('does not answer notifications', async () => {
    expect(await h.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await h.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeNull();
    // even unknown methods sent as notifications stay silent
    expect(await h.handle({ jsonrpc: '2.0', method: 'whatever' })).toBeNull();
  });

  it('answers ping, tools/list and empty resources / prompts', async () => {
    expect(await h.handle(rpc(3, 'ping'))).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    const list = (await h.handle(rpc('a', 'tools/list'))) as { id: string; result: { tools: McpTool[] } };
    expect(list.id).toBe('a');
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo', 'boom']);
    expect(await h.handle(rpc(4, 'resources/list'))).toEqual({ jsonrpc: '2.0', id: 4, result: { resources: [] } });
    expect(await h.handle(rpc(5, 'prompts/list'))).toEqual({ jsonrpc: '2.0', id: 5, result: { prompts: [] } });
  });

  it('calls tools and reports results', async () => {
    const r = (await h.handle(rpc(6, 'tools/call', { name: 'echo', arguments: { message: 'hi' } }))) as { result: unknown };
    expect(r.result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }] });
  });

  it('turns tool exceptions into isError results', async () => {
    const r = (await h.handle(rpc(7, 'tools/call', { name: 'boom', arguments: {} }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('kaboom');
  });

  it('validates tool arguments against the schema (as a tool error)', async () => {
    const missing = (await h.handle(rpc(8, 'tools/call', { name: 'echo', arguments: {} }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain('message');
    const wrongType = (await h.handle(rpc(9, 'tools/call', { name: 'echo', arguments: { message: 5 } }))) as { result: { isError: boolean } };
    expect(wrongType.result.isError).toBe(true);
    const badEnum = (await h.handle(rpc(10, 'tools/call', { name: 'echo', arguments: { message: 'x', mode: 'z' } }))) as { result: { isError: boolean } };
    expect(badEnum.result.isError).toBe(true);
  });

  it('rejects unknown tools with -32602, but explains disabled ones', async () => {
    const r = (await h.handle(rpc(11, 'tools/call', { name: 'nope', arguments: {} }))) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
    const bad = (await h.handle(rpc(12, 'tools/call', { arguments: {} }))) as { error: { code: number } };
    expect(bad.error.code).toBe(-32602);
    const badArgs = (await h.handle(rpc(13, 'tools/call', { name: 'echo', arguments: 'x' }))) as { error: { code: number } };
    expect(badArgs.error.code).toBe(-32602);
    const disabled = (await h.handle(rpc(14, 'tools/call', { name: 'run_script', arguments: {} }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(disabled.result.isError).toBe(true);
    expect(disabled.result.content[0].text).toContain('disabled');
  });

  it('returns -32601 for unknown methods and -32600 for invalid requests', async () => {
    expect(((await h.handle(rpc(15, 'foo/bar'))) as { error: { code: number } }).error.code).toBe(-32601);
    expect(((await h.handle({ id: 16, method: 'ping' })) as { error: { code: number } }).error.code).toBe(-32600);
    expect(((await h.handle({ jsonrpc: '2.0', id: 17 })) as { error: { code: number } }).error.code).toBe(-32600);
    expect(((await h.handle(42)) as { error: { code: number } }).error.code).toBe(-32600);
    expect(((await h.handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })) as { id: unknown; error: { code: number } }).error.code).toBe(-32600);
    expect(((await h.handle(rpc(18, 'ping', 'oops'))) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('handles batches', async () => {
    const r = (await h.handle([rpc(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'tools/call', { name: 'echo', arguments: { message: 'b' } })])) as JsonRpcResponse[];
    expect(Array.isArray(r)).toBe(true);
    expect(r.map((x) => x.id)).toEqual([1, 2]);
    expect(await h.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).toBeNull();
    expect(((await h.handle([])) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('reports parse errors for bad JSON and ignores client responses', async () => {
    const r = (await h.handleText('{not json')) as { id: null; error: { code: number } };
    expect(r.error.code).toBe(-32700);
    expect(r.id).toBeNull();
    expect(await h.handle({ jsonrpc: '2.0', id: 5, result: {} })).toBeNull();
  });
});

/* ============================================================ tool schemas */

function checkSchema(s: JsonSchema, where: string, problems: string[]) {
  if (s.type === 'array' && !s.items) problems.push(`${where}: array without items`);
  if (s.type === 'object' && s.properties !== undefined && (typeof s.properties !== 'object' || Array.isArray(s.properties))) problems.push(`${where}: properties must be an object`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) problems.push(`${where}: empty enum`);
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) problems.push(`${where}: required must be an array`);
    else for (const r of s.required) if (!(s.properties as Record<string, unknown> | undefined)?.[r as string]) problems.push(`${where}: required "${r}" not in properties`);
  }
  const visit = (sub: unknown, path: string) => {
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) checkSchema(sub as JsonSchema, path, problems);
  };
  if (s.properties && typeof s.properties === 'object') for (const [k, v] of Object.entries(s.properties)) visit(v, `${where}.${k}`);
  if (s.items) visit(s.items, `${where}[]`);
  for (const key of ['anyOf', 'oneOf']) if (Array.isArray(s[key])) (s[key] as unknown[]).forEach((x, i) => visit(x, `${where}.${key}[${i}]`));
}

describe('MCP tool definitions', () => {
  it('have unique, well-formed names and descriptions', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of MCP_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(t.description.length).toBeGreaterThan(30);
    }
    expect(MCP_INSTRUCTIONS.length).toBeGreaterThan(500);
  });

  it('have valid-ish JSON Schemas', () => {
    const problems: string[] = [];
    for (const t of MCP_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.inputSchema.properties).toBe('object');
      checkSchema(t.inputSchema as JsonSchema, t.name, problems);
      expect(() => JSON.stringify(t)).not.toThrow();
    }
    expect(problems).toEqual([]);
  });

  it('hide run_script unless scripts are allowed', () => {
    expect(getMcpTools({ allowScripts: false }).some((t) => t.name === 'run_script')).toBe(false);
    expect(getMcpTools({ allowScripts: true }).some((t) => t.name === 'run_script')).toBe(true);
  });

  it('includes the documented tool set', () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    for (const n of [
      'get_document',
      'get_tree',
      'get_nodes',
      'find_nodes',
      'get_selection',
      'set_selection',
      'create_nodes',
      'update_nodes',
      'delete_nodes',
      'move_nodes',
      'duplicate_nodes',
      'group_nodes',
      'ungroup_nodes',
      'align_nodes',
      'distribute_nodes',
      'set_auto_layout',
      'import_svg',
      'list_exporters',
      'export',
      'screenshot',
      'manage_pages',
      'undo',
      'redo',
      'zoom_to',
      'run_script',
    ])
      expect(names.has(n)).toBe(true);
  });
});

/* ============================================================ HTTP server */

function httpRequest(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/mcp', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('MCP HTTP server', () => {
  const handler = makeHandler();
  const server = new McpHttpServer({ handleText: (t) => handler.handleText(t), health: () => ({ ready: true }), maxBodyBytes: 4096 });
  let port = 0;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    httpRequest(port, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

  beforeAll(async () => {
    port = await server.start(0);
  });
  afterAll(async () => {
    await server.stop();
  });

  it('serves initialize and tools/list over POST /mcp', async () => {
    const init = await post(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } }));
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toContain('application/json');
    expect(JSON.parse(init.text).result.protocolVersion).toBe('2025-06-18');
    const list = await post(rpc(2, 'tools/list'));
    expect(JSON.parse(list.text).result.tools).toHaveLength(2);
    const call = await post(rpc(3, 'tools/call', { name: 'echo', arguments: { message: 'over http' } }));
    expect(JSON.parse(call.text).result.content[0].text).toBe('echo:over http');
  });

  it('answers 202 for notifications, 400 for bad JSON, 405 for GET, 200 for DELETE', async () => {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const bad = await post('{nope');
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).error.code).toBe(-32700);
    expect((await httpRequest(port, { method: 'GET', headers: { Accept: 'text/event-stream' } })).status).toBe(405);
    expect((await httpRequest(port, { method: 'DELETE' })).status).toBe(200);
    const health = await httpRequest(port, { path: '/health' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ ok: true, ready: true });
    expect((await httpRequest(port, { path: '/elsewhere' })).status).toBe(404);
  });

  it('accepts batches', async () => {
    const r = await post([rpc(1, 'ping'), rpc(2, 'ping')]);
    expect(JSON.parse(r.text)).toHaveLength(2);
  });

  it('protects against DNS rebinding and foreign origins', async () => {
    expect((await post(rpc(1, 'ping'), { Host: 'evil.example:7331' })).status).toBe(403);
    expect((await post(rpc(1, 'ping'), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(rpc(1, 'ping'), { Origin: 'null' })).status).toBe(403);
    const local = await post(rpc(1, 'ping'), { Origin: 'http://localhost:6274' });
    expect(local.status).toBe(200);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:6274');
    // browsers may not smuggle non-JSON bodies past CORS
    const form = await httpRequest(port, { method: 'POST', body: JSON.stringify(rpc(1, 'ping')), headers: { Origin: 'http://localhost:3000', 'Content-Type': 'text/plain' } });
    expect(form.status).toBe(415);
    const preflight = await httpRequest(port, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST' } });
    expect(preflight.status).toBe(204);
  });

  it('limits the body size', async () => {
    const r = await post(JSON.stringify(rpc(1, 'tools/call', { name: 'echo', arguments: { message: 'x'.repeat(10_000) } })));
    expect(r.status).toBe(413);
  });

  it('reports EADDRINUSE when the port is taken', async () => {
    const other = new McpHttpServer({ handleText: async () => null });
    await expect(other.start(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('validates hosts and origins', () => {
    expect(isAllowedHost('127.0.0.1:7331')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('[::1]:7331')).toBe(true);
    expect(isAllowedHost('alt.attacker.com:7331')).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('app://alt')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:9999')).toBe(true);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('https://localhost.evil.com')).toBe(false);
  });
});

/* ========================================================= image sources */

describe('image source resolution', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const io: ImageIO = {
    fetchUrl: async (url) => (url.includes('missing') ? { ok: false, status: 404, contentType: null, body: new Uint8Array() } : { ok: true, status: 200, contentType: 'image/png', body: png }),
    readFile: async () => png,
    fileSize: async () => png.length,
  };

  it('sniffs image types', () => {
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffImageMime(new TextEncoder().encode('hello'))).toBeNull();
  });

  it('replaces URLs and local paths with data URLs without touching other strings', async () => {
    const args = {
      nodes: [
        { type: 'image', image: 'https://example.com/a.png', name: 'https://not-an-image-field' },
        { type: 'rect', fills: [{ type: 'image', src: '/tmp/pic.png' }], children: [{ type: 'image', image: 'data:image/png;base64,AAAA' }] },
      ],
    };
    const out = await resolveImageSources(args, io, '/home/u');
    expect(out.nodes[0].image).toMatch(/^data:image\/png;base64,/);
    expect(out.nodes[0].name).toBe('https://not-an-image-field');
    expect((out.nodes[1].fills as { src: string }[])[0].src).toMatch(/^data:image\/png;base64,/);
    expect((out.nodes[1].children as { image: string }[])[0].image).toBe('data:image/png;base64,AAAA');
    expect(args.nodes[0].image).toBe('https://example.com/a.png'); // input untouched
  });

  it('fails clearly for unreachable images and unsupported files', async () => {
    await expect(resolveImageSources({ image: 'https://example.com/missing.png' }, io)).rejects.toThrow(/HTTP 404/);
    await expect(resolveImageSources({ image: '/etc/passwd' }, io)).rejects.toThrow(/unsupported file type/);
  });
});

/* ============================================================== stdio shim */

function runShim(port: number, lines: unknown[], waitMs = 0): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'alt-mcp.mjs')], { env: { ...process.env, ALT_MCP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('exit', () => resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    for (const l of lines) child.stdin.write(JSON.stringify(l) + '\n');
    setTimeout(() => child.stdin.end(), waitMs);
  });
}

describe('stdio shim (mcp/alt-mcp.mjs)', () => {
  const handler = makeHandler();
  const server = new McpHttpServer({ handleText: (t) => handler.handleText(t) });
  let port = 0;
  beforeAll(async () => {
    port = await server.start(0);
  });
  afterAll(async () => {
    await server.stop();
  });

  it('bridges stdio to the HTTP endpoint', async () => {
    const out = (await runShim(port, [
      rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      rpc(2, 'tools/list'),
      rpc(3, 'tools/call', { name: 'echo', arguments: { message: 'stdio' } }),
    ])) as { id: number; result: Record<string, unknown> }[];
    const byId = new Map(out.map((m) => [m.id, m]));
    expect(byId.get(1)!.result.protocolVersion).toBe('2025-03-26');
    expect((byId.get(1)!.result.capabilities as { tools: { listChanged: boolean } }).tools.listChanged).toBe(true);
    expect((byId.get(2)!.result.tools as unknown[]).length).toBe(2);
    expect(byId.get(3)!.result).toEqual({ content: [{ type: 'text', text: 'echo:stdio' }] });
    expect(out).toHaveLength(3);
  });

  it('answers gracefully when Alt is not running', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const out = (await runShim(free, [rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'get_document', arguments: {} }), rpc(4, 'foo')])) as {
      id: number;
      result?: Record<string, unknown>;
      error?: { message: string };
    }[];
    const byId = new Map(out.map((m) => [m.id, m]));
    expect(byId.get(1)!.result!.instructions).toMatch(/not running/);
    expect((byId.get(2)!.result!.tools as { name: string }[])[0].name).toBe('alt_status');
    expect(byId.get(3)!.result!.isError).toBe(true);
    expect(byId.get(4)!.error!.message).toMatch(/not running/);
  });
});

/* ================================================== renderer tool handlers */

describe('renderer tool handlers (executeTool)', () => {
  let executeTool: typeof import('../src/api/mcpHandlers').executeTool;
  let IMPLEMENTED: string[];
  let useEditor: typeof import('../src/core/store').useEditor;

  beforeAll(async () => {
    ({ executeTool, IMPLEMENTED_TOOLS: IMPLEMENTED } = await import('../src/api/mcpHandlers'));
    ({ useEditor } = await import('../src/core/store'));
  });
  beforeEach(() => useEditor.getState().newDoc('Test'));

  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await executeTool({ tool, args });
    const text = r.content.find((c) => c.type === 'text') as { text: string } | undefined;
    return { r, json: text && !r.isError ? JSON.parse(text.text) : undefined, text: text?.text ?? '' };
  };

  it('implements every listed tool', () => {
    expect(new Set(IMPLEMENTED)).toEqual(new Set(MCP_TOOLS.map((t) => t.name)));
  });

  it('creates nested nodes in one undoable step and selects them', async () => {
    const { r, json } = await call('create_nodes', {
      nodes: [
        {
          type: 'frame',
          name: 'Card',
          x: 40,
          y: 60,
          width: 320,
          fill: '#FFFFFF',
          cornerRadius: 16,
          shadow: { y: 8, blur: 24, color: '#0000001F' },
          autoLayout: { mode: 'vertical', gap: 12, padding: 24 },
          children: [
            { type: 'text', name: 'Title', text: 'Hello', fontSize: 24, fontWeight: 'bold', fill: '#111111' },
            { type: 'rect', name: 'Bar', width: 100, height: 8, fill: { type: 'linear', angle: 90, colors: ['#6366F1', '#EC4899'] } },
            { type: 'path', name: 'Icon', d: 'M4 4 L20 4 L20 20 Z', fill: '#000' },
            { type: 'line', x1: 0, y1: 0, x2: 50, y2: 0, stroke: '#FF0000', strokeWidth: 2, endMarker: 'arrow' },
          ],
        },
      ],
    });
    expect(r.isError).toBeFalsy();
    const card = json.created[0];
    expect(card.children).toHaveLength(4);
    const s = useEditor.getState();
    expect(s.selection).toEqual([card.id]);
    expect(s.past).toHaveLength(1);
    const frame = s.doc.nodes[card.id] as import('../src/core/types').FrameNode;
    expect(frame.layout).toMatchObject({ mode: 'vertical', gap: 12, padding: [24, 24, 24, 24] });
    expect(frame.sizingH).toBe('fixed');
    expect(frame.sizingV).toBe('hug');
    expect(frame.effects[0]).toMatchObject({ type: 'drop-shadow', y: 8, blur: 24 });
    expect(frame.effects[0].type === 'drop-shadow' && frame.effects[0].opacity).toBeCloseTo(0x1f / 255, 2);
    const title = s.doc.nodes[card.children[0].id] as import('../src/core/types').TextNode;
    expect(title.fontWeight).toBe(700);
    expect(title.fills[0]).toMatchObject({ type: 'solid', color: '#111111' });
    expect(title.y).toBe(24); // positioned by auto layout
    const icon = s.doc.nodes[card.children[2].id] as import('../src/core/types').PathNode;
    expect(icon.width).toBe(16);
    expect(icon.strokes).toHaveLength(0);
    const bar = s.doc.nodes[card.children[1].id];
    expect(bar.fills[0].type).toBe('linear');
  });

  it('updates, finds, groups, reads trees and undoes', async () => {
    const { json } = await call('create_nodes', {
      nodes: [
        { type: 'rect', name: 'A', x: 0, y: 0, width: 50, height: 50 },
        { type: 'ellipse', name: 'B', x: 100, y: 0, width: 50, height: 50 },
        { type: 'text', name: 'Label', x: 0, y: 100, text: 'Some label' },
      ],
    });
    const [a, b, t] = json.created.map((c: { id: string }) => c.id);
    const upd = await call('update_nodes', { updates: [{ id: a, fill: 'rgb(255, 0, 0)', cornerRadius: [1, 2, 3, 4] }, { id: t, text: 'Changed', fontSize: 40 }] });
    expect(upd.r.isError).toBeFalsy();
    const doc = useEditor.getState().doc;
    expect(doc.nodes[a].fills[0]).toMatchObject({ color: '#FF0000' });
    expect((doc.nodes[a] as import('../src/core/types').RectNode).cornerRadii).toEqual([1, 2, 3, 4]);
    expect((doc.nodes[t] as import('../src/core/types').TextNode).text).toBe('Changed');

    const found = await call('find_nodes', { name: 'label' });
    expect(found.json.nodes.map((n: { id: string }) => n.id)).toEqual([t]);
    const byType = await call('find_nodes', { type: ['rect', 'ellipse'] });
    expect(byType.json.count).toBe(2);

    const g = await call('group_nodes', { ids: [a, b], name: 'Shapes' });
    expect(g.json.children).toEqual([a, b]);
    const tree = await call('get_tree', {});
    expect(tree.json.children.map((n: { name: string }) => n.name)).toEqual(['Shapes', 'Label']); // group takes its topmost member's slot

    const dup = await call('duplicate_nodes', { ids: [t], count: 2, offset: { x: 0, y: 60 } });
    expect(dup.json.copies).toHaveLength(2);

    const before = useEditor.getState().past.length;
    await call('undo', { steps: 2 });
    expect(useEditor.getState().past.length).toBe(before - 2);
    expect(useEditor.getState().doc.nodes[g.json.id]).toBeUndefined();
  });

  it('returns clear errors for bad input', async () => {
    const unknown = await call('update_nodes', { updates: [{ id: 'nope', fill: '#fff' }] });
    expect(unknown.r.isError).toBe(true);
    expect(unknown.text).toMatch(/Unknown node id/);
    const badColor = await call('create_nodes', { nodes: [{ type: 'rect', fill: '#zzzzzz' }] });
    expect(badColor.r.isError).toBe(true);
    expect(badColor.text).toMatch(/Invalid colour/);
    const badParent = await call('create_nodes', { nodes: [{ type: 'rect' }], parentId: 'missing' });
    expect(badParent.r.isError).toBe(true);
    expect(useEditor.getState().past).toHaveLength(0); // failed calls leave no history
    const noTool = await call('does_not_exist');
    expect(noTool.r.isError).toBe(true);
  });

  it('manages pages', async () => {
    const created = await call('manage_pages', { action: 'create', name: 'Screens' });
    expect(created.json.pages).toHaveLength(2);
    expect(useEditor.getState().pageId).toBe(created.json.created);
    const renamed = await call('manage_pages', { action: 'rename', name: 'Mobile' });
    expect(renamed.json.pages[1].name).toBe('Mobile');
    const del = await call('manage_pages', { action: 'delete' });
    expect(del.json.pages).toHaveLength(1);
  });

  it('describes the document', async () => {
    await call('create_nodes', { nodes: [{ type: 'frame', name: 'Screen', width: 390, height: 844 }] });
    const { json } = await call('get_document');
    expect(json.name).toBe('Test');
    expect(json.currentPage.topLevel[0]).toMatchObject({ name: 'Screen', w: 390, h: 844 });
    expect(json.selection).toHaveLength(1);
  });
});
