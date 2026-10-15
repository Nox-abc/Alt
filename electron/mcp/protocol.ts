/**
 * Minimal, dependency-free MCP (Model Context Protocol) server core:
 * JSON-RPC 2.0 message handling for the tools capability.
 *
 * Transport-agnostic and pure — used by the Streamable-HTTP server in the
 * Electron main process and unit-tested in plain node.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  annotations?: object;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface McpHandlerOptions {
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string | (() => string | undefined);
  listTools(): McpTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /**
   * Called for a tools/call with a name that is not listed. Return a message to
   * answer with an `isError` tool result (e.g. "this tool is disabled in
   * settings") instead of the default JSON-RPC -32602 error.
   */
  unavailableToolMessage?(name: string): string | undefined;
  /** Validate required / typed top-level arguments against the input schema (default true). */
  validateArguments?: boolean;
}

export interface McpHandler {
  /** Handle one parsed message or a batch. Returns null when nothing must be sent back (notifications only). */
  handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
  /** Parse raw JSON text and handle it (parse errors become a -32700 response). */
  handleText(text: string): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
}

/* ---------------------------------------------------------------- helpers */

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error: JsonRpcFailure['error'] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || v === null;
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function toolError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function typeMatches(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return isObject(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  });
}

/** Shallow validation of tool arguments: required keys, top-level types and enums. Returns problems. */
export function validateToolArguments(tool: McpTool, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const schema = tool.inputSchema ?? { type: 'object' };
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) problems.push(`missing required argument "${key}"`);
  }
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p || value === undefined) continue;
    if (p.type !== undefined && !typeMatches(value, p.type)) {
      problems.push(`argument "${key}" must be of type ${Array.isArray(p.type) ? p.type.join(' | ') : String(p.type)}`);
      continue;
    }
    if (Array.isArray(p.anyOf) && !p.anyOf.some((alt) => !isObject(alt) || alt.type === undefined || typeMatches(value, alt.type))) {
      const ts = p.anyOf.map((alt) => (isObject(alt) ? String(alt.type) : '?')).join(' | ');
      problems.push(`argument "${key}" must be of type ${ts}`);
      continue;
    }
    if (Array.isArray(p.enum) && !p.enum.includes(value as never)) {
      problems.push(`argument "${key}" must be one of ${p.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }
  return problems;
}

function normalizeToolResult(r: unknown): McpToolResult {
  if (isObject(r) && Array.isArray(r.content)) {
    const content = (r.content as unknown[]).filter(isObject) as McpContent[];
    const out: McpToolResult = { content };
    if (r.isError === true) out.isError = true;
    if (isObject(r.structuredContent)) out.structuredContent = r.structuredContent;
    return out;
  }
  if (typeof r === 'string') return { content: [{ type: 'text', text: r }] };
  if (r === undefined || r === null) return { content: [{ type: 'text', text: 'OK' }] };
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
}

/* ---------------------------------------------------------------- handler */

export function createMcpHandler(opts: McpHandlerOptions): McpHandler {
  const validate = opts.validateArguments !== false;

  async function handleOne(msg: unknown): Promise<JsonRpcResponse | null> {
    if (!isObject(msg)) return rpcError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 object');
    const hasId = 'id' in msg;
    const id: JsonRpcId = hasId && isValidId(msg.id) ? (msg.id as JsonRpcId) : null;

    // A response (to a server→client request) — we never send requests, so just ignore it.
    if (!('method' in msg) && ('result' in msg || 'error' in msg)) return null;

    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (hasId && !isValidId(msg.id))) {
      return rpcError(id, JSONRPC_INVALID_REQUEST, 'Invalid Request: expected {"jsonrpc":"2.0","method":string,"id"?:string|number}');
    }
    if (msg.params !== undefined && !isObject(msg.params) && !Array.isArray(msg.params)) {
      return hasId ? rpcError(id, JSONRPC_INVALID_REQUEST, 'Invalid Request: params must be an object or array') : null;
    }

    const method = msg.method;
    const params = (isObject(msg.params) ? msg.params : {}) as Record<string, unknown>;

    // Notifications never get a response.
    if (!hasId) return null;

    try {
      switch (method) {
        case 'initialize': {
          const instructions = typeof opts.instructions === 'function' ? opts.instructions() : opts.instructions;
          const result: Record<string, unknown> = {
            protocolVersion: negotiateProtocolVersion(params.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { ...opts.serverInfo },
          };
          if (instructions) result.instructions = instructions;
          return rpcResult(id, result);
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: opts.listTools() });
        case 'tools/call': {
          const name = params.name;
          if (typeof name !== 'string' || !name) return rpcError(id, JSONRPC_INVALID_PARAMS, 'Invalid params: "name" must be a non-empty string');
          const rawArgs = params.arguments;
          if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
            return rpcError(id, JSONRPC_INVALID_PARAMS, 'Invalid params: "arguments" must be an object');
          }
          const args = (rawArgs ?? {}) as Record<string, unknown>;
          const tool = opts.listTools().find((t) => t.name === name);
          if (!tool) {
            const msgText = opts.unavailableToolMessage?.(name);
            if (msgText) return rpcResult(id, toolError(msgText));
            return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
          }
          if (validate) {
            const problems = validateToolArguments(tool, args);
            if (problems.length) return rpcResult(id, toolError(`Invalid arguments for ${name}: ${problems.join('; ')}.`));
          }
          try {
            return rpcResult(id, normalizeToolResult(await opts.callTool(name, args)));
          } catch (e) {
            return rpcResult(id, toolError(`Error: ${errorText(e)}`));
          }
        }
        case 'resources/list':
          return rpcResult(id, { resources: [] });
        case 'resources/templates/list':
          return rpcResult(id, { resourceTemplates: [] });
        case 'prompts/list':
          return rpcResult(id, { prompts: [] });
        case 'logging/setLevel':
          return rpcResult(id, {});
        default:
          return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (e) {
      return rpcError(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${errorText(e)}`);
    }
  }

  async function handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      if (message.length === 0) return rpcError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request: empty batch');
      const out = (await Promise.all(message.map(handleOne))).filter((r): r is JsonRpcResponse => r !== null);
      return out.length ? out : null;
    }
    return handleOne(message);
  }

  async function handleText(text: string): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return rpcError(null, JSONRPC_PARSE_ERROR, `Parse error: ${errorText(e)}`);
    }
    return handle(parsed);
  }

  return { handle, handleText };
}
