/**
 * MCP Streamable-HTTP transport (JSON responses, no SSE stream) on loopback.
 *
 *   POST   /mcp     JSON-RPC message or batch  → 200 application/json | 202 (notifications only)
 *   GET    /mcp     → 405 (this server never pushes server→client messages)
 *   DELETE /mcp     → 200 (sessions are stateless; nothing to tear down)
 *   GET    /health  → JSON status
 *
 * Security: binds 127.0.0.1 only, validates Host (DNS-rebinding protection) and
 * Origin (blocks arbitrary web pages from driving the app), caps body size.
 * Depends only on node built-ins so it can be exercised from plain node.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const DEFAULT_MAX_BODY = 20 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface McpHttpServerOptions {
  /** Handle raw JSON text; resolve null when there is nothing to send back. */
  handleText(text: string): Promise<unknown | null>;
  /** Extra fields for GET /health. */
  health?(): Record<string, unknown>;
  maxBodyBytes?: number;
  /** Additional allowed Origin values (exact match), e.g. the app's own origin. */
  extraOrigins?: string[];
  log?(message: string): void;
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i >= 0 ? h.slice(0, i) : h;
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // HTTP/1.0 clients; rebinding attacks always carry a Host
  return LOOPBACK_HOSTS.has(hostnameOf(hostHeader));
}

/**
 * Browser requests always carry an Origin on POST. Only loopback pages, the app
 * itself and file:// documents may talk to the server. The opaque "null" origin
 * (sandboxed iframes, data: URLs, file pages in browsers) is rejected on purpose:
 * any website can produce it, so allowing it would let web pages drive Alt.
 */
export function isAllowedOrigin(origin: string | undefined, extra: string[] = []): boolean {
  if (origin === undefined || origin === '') return true; // non-browser clients
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:' || u.protocol === 'app:') return true;
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return true;
  } catch {
    /* malformed origin */
  }
  return false;
}

export class McpHttpServer {
  private server: http.Server | null = null;
  private opts: McpHttpServerOptions;
  port = 0;

  constructor(opts: McpHttpServerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return !!this.server?.listening;
  }

  /** Start listening; resolves with the bound port, rejects with the listen error (e.g. EADDRINUSE). */
  async start(port: number, host = '127.0.0.1'): Promise<number> {
    if (this.server) await this.stop();
    const server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((e) => {
        this.opts.log?.(`MCP request failed: ${e instanceof Error ? e.stack : String(e)}`);
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
        else res.end();
      });
    });
    server.keepAliveTimeout = 5_000;
    server.requestTimeout = 0; // tool calls may legitimately take up to the forwarder's own timeout
    server.headersTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host, exclusive: true });
    });
    server.on('error', (e) => this.opts.log?.(`MCP server error: ${e.message}`));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  private corsHeaders(origin: string | undefined): Record<string, string> {
    if (!origin) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
      'Access-Control-Max-Age': '600',
    };
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'Forbidden: invalid Host header' });
    }
    if (!isAllowedOrigin(origin, this.opts.extraOrigins)) {
      return sendJson(res, 403, { error: 'Forbidden: origin not allowed' });
    }
    const cors = this.corsHeaders(origin);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return sendJson(res, 200, { ok: true, name: 'alt', transport: 'streamable-http', endpoint: '/mcp', ...(this.opts.health?.() ?? {}) });
    }

    // Accept the endpoint at /mcp, and at / for clients configured with a bare origin.
    if (pathname !== '/mcp' && pathname !== '/') return sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp' });

    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/' && !String(req.headers.accept ?? '').includes('text/event-stream')) {
        return sendJson(res, 200, { name: 'alt', mcp: '/mcp', health: '/health' });
      }
      return sendJson(res, 405, { error: 'Method not allowed: this server does not offer an SSE stream; POST JSON-RPC messages to /mcp' }, { Allow: 'POST, DELETE' });
    }
    if (method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });

    // CSRF hardening: a browser can only send a JSON content type after a CORS preflight
    // (which is answered for allowed origins only), so demand it from browser callers.
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (origin && !contentType.includes('json')) {
      req.resume();
      return sendJson(res, 415, { error: 'Unsupported Media Type: use Content-Type: application/json' });
    }

    const max = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request body too large (max ${max} bytes)` } }, { Connection: 'close' });
    }
    let body: string;
    try {
      body = await readBody(req, max);
    } catch (e) {
      if ((e as { code?: string }).code === 'E_TOO_LARGE') {
        return sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request body too large (max ${max} bytes)` } }, { Connection: 'close' });
      }
      throw e;
    }

    const response = await this.opts.handleText(body);
    if (response === null || response === undefined) {
      res.writeHead(202);
      return res.end();
    }
    const isParseError = !Array.isArray(response) && (response as { error?: { code?: number } }).error?.code === -32700;
    return sendJson(res, isParseError ? 400 : 200, response);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        req.resume();
        reject(Object.assign(new Error('Body too large'), { code: 'E_TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}
