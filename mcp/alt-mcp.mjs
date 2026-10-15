#!/usr/bin/env node
/**
 * Alt MCP stdio bridge — zero dependencies.
 *
 * For MCP clients that only speak stdio (e.g. Claude Desktop): reads
 * newline-delimited JSON-RPC from stdin, forwards every message to the Alt
 * desktop app's local MCP endpoint (Streamable HTTP) and writes the responses
 * to stdout.
 *
 * Runs on Node >= 18, or on the Alt executable itself:
 *   { "command": "/Applications/Alt.app/Contents/MacOS/Alt",
 *     "args": ["<path to alt-mcp.mjs>"],
 *     "env": { "ELECTRON_RUN_AS_NODE": "1" } }
 *
 * Env: ALT_MCP_PORT (default 7331), ALT_MCP_URL (full endpoint URL override),
 *      ALT_MCP_DEBUG=1 (log to stderr).
 *
 * When Alt is not running the bridge still answers initialize / tools/list
 * (with an `alt_status` tool explaining what to do) and notifies the client
 * with notifications/tools/list_changed as soon as Alt comes up.
 */
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

const BRIDGE_VERSION = '1.0.0';
const PORT = Number(process.env.ALT_MCP_PORT) || 7331;
const ENDPOINT = new URL(process.env.ALT_MCP_URL || `http://127.0.0.1:${PORT}/mcp`);
const HEALTH = new URL('/health', ENDPOINT);
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const REQUEST_TIMEOUT_MS = 130_000;
const POLL_MS = 3_000;
const DEBUG = process.env.ALT_MCP_DEBUG === '1';

const transport = ENDPOINT.protocol === 'https:' ? https : http;
const agent = new transport.Agent({ keepAlive: true, maxSockets: 8 });

const OFFLINE_TEXT =
  `Alt is not running, or its MCP server is turned off (nothing answered at ${ENDPOINT.href}). ` +
  'Ask the user to open the Alt desktop app and check Settings → MCP → "Enable MCP server" (and the port). ' +
  'Alt\'s design tools appear automatically as soon as it is running.';

const STATUS_TOOL = {
  name: 'alt_status',
  title: 'Alt connection status',
  description: 'Alt (the design app) is currently not reachable. Call this to re-check the connection; once Alt is running its full set of design tools becomes available.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

let protocolVersion = null;
let clientKnowsOfflineTools = false;
let pollTimer = null;
let pending = 0;
let stdinClosed = false;

const debug = (...a) => {
  if (DEBUG) process.stderr.write(`[alt-mcp] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
};

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/* ------------------------------------------------------------------ http */

function request(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json, text/event-stream' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    const req = transport.request(url, { method, headers, agent, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out waiting for Alt'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EADDRNOTAVAIL', 'EPIPE', 'ENETUNREACH']);
const isOfflineError = (e) => OFFLINE_CODES.has(e?.code) || OFFLINE_CODES.has(e?.cause?.code);

async function isAltUp() {
  try {
    const r = await request(HEALTH);
    return r.status === 200;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- offline answers */

const asList = (m) => (Array.isArray(m) ? m : [m]);
const isRequest = (m) => m && typeof m === 'object' && typeof m.method === 'string' && 'id' in m;

function offlineAnswer(m) {
  const id = m.id ?? null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (m.method) {
    case 'initialize': {
      const requested = m.params?.protocolVersion;
      protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'alt', title: 'Alt (not running)', version: BRIDGE_VERSION },
        instructions: OFFLINE_TEXT,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      clientKnowsOfflineTools = true;
      return ok({ tools: [STATUS_TOOL] });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: OFFLINE_TEXT }], isError: true });
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return { jsonrpc: '2.0', id, error: { code: -32000, message: OFFLINE_TEXT } };
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!(await isAltUp())) return;
    stopPolling();
    debug('Alt is up');
    if (clientKnowsOfflineTools) {
      clientKnowsOfflineTools = false;
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
  }, POLL_MS);
  pollTimer.unref?.();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* --------------------------------------------------------------- bridge */

function patchResponse(r) {
  // remember the negotiated version; advertise listChanged because this bridge can emit it
  if (r && r.result && typeof r.result.protocolVersion === 'string' && r.result.capabilities) {
    protocolVersion = r.result.protocolVersion;
    r.result.capabilities.tools = { ...(r.result.capabilities.tools ?? {}), listChanged: true };
  }
  return r;
}

function writeResponses(parsed) {
  for (const r of asList(parsed)) write(patchResponse(r));
}

function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.trim()) out.push(JSON.parse(data));
  }
  return out;
}

async function forward(raw, msg) {
  const requests = asList(msg).filter(isRequest);
  // short-circuit the status tool
  if (!Array.isArray(msg) && msg.method === 'tools/call' && msg.params?.name === STATUS_TOOL.name) {
    const up = await isAltUp();
    if (up) {
      stopPolling();
      write({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: { content: [{ type: 'text', text: 'Alt is running. Its design tools are now available — re-list the tools (or reconnect this MCP server) to use them.' }] },
      });
      if (clientKnowsOfflineTools) {
        clientKnowsOfflineTools = false;
        write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
    } else write({ jsonrpc: '2.0', id: msg.id ?? null, result: { content: [{ type: 'text', text: OFFLINE_TEXT }], isError: true } });
    return;
  }
  try {
    const res = await request(ENDPOINT, { method: 'POST', body: raw });
    debug('←', res.status, res.text.slice(0, 200));
    if (pollTimer) stopPolling();
    if (res.status === 202 || !res.text.trim()) {
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return;
    }
    let parsed;
    if (res.type.includes('text/event-stream')) parsed = parseSse(res.text);
    else parsed = JSON.parse(res.text);
    const looksRpc = asList(parsed).every((r) => r && r.jsonrpc === '2.0');
    if (looksRpc) return writeResponses(parsed);
    throw new Error(`HTTP ${res.status}: ${typeof parsed?.error === 'string' ? parsed.error : res.text.slice(0, 200)}`);
  } catch (e) {
    if (isOfflineError(e)) {
      debug('Alt unreachable:', e.code ?? e.message);
      for (const m of requests) write(offlineAnswer(m));
      startPolling();
      return;
    }
    const message = `Alt MCP bridge error: ${e?.message ?? String(e)}`;
    for (const m of requests) write({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32603, message } });
  }
}

async function onLine(line) {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } });
    return;
  }
  debug('→', raw.slice(0, 200));
  pending++;
  try {
    await forward(raw, msg);
  } finally {
    pending--;
    maybeExit();
  }
}

function maybeExit() {
  if (!stdinClosed || pending > 0) return;
  stopPolling();
  agent.destroy();
  process.stdout.write('', () => process.exit(0));
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
rl.on('line', (line) => void onLine(line));
rl.on('close', () => {
  stdinClosed = true;
  maybeExit();
});
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
debug(`bridge ${BRIDGE_VERSION} → ${ENDPOINT.href} (node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''})`);
