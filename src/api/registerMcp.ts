/**
 * Wire the renderer-side MCP tool executor to the desktop shell.
 * Call once at startup; returns an unsubscribe function (no-op on the web).
 *
 * The executor module is loaded lazily on the first tool call so it does not
 * weigh on startup.
 */
import { native } from '../platform/native';
import type { McpToolRequest, McpToolResult } from '../platform/native';

let unsubscribe: (() => void) | null = null;

export function registerMcp(): () => void {
  if (!native?.mcp) return () => undefined;
  unsubscribe?.();
  const off = native.mcp.onToolCall(async (req: McpToolRequest): Promise<McpToolResult> => {
    try {
      const { executeTool } = await import('./mcpHandlers');
      return await executeTool(req);
    } catch (e) {
      return { content: [{ type: 'text', text: `Alt could not run ${req?.tool}: ${(e as Error)?.message ?? String(e)}` }], isError: true };
    }
  });
  unsubscribe = off;
  return () => {
    off();
    if (unsubscribe === off) unsubscribe = null;
  };
}
