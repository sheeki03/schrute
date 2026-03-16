import { getLogger } from '../core/logger.js';
import type { DiscoveredEndpoint } from './types.js';

const log = getLogger();

export async function scanDevToolsMcp(
  options?: { endpoint?: string; probeTimeoutMs?: number },
): Promise<{ found: boolean; tools: DiscoveredEndpoint[] }> {
  const endpoint = options?.endpoint ?? 'http://localhost:3000/mcp';
  const timeout = options?.probeTimeoutMs ?? 2000;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      log.debug({ status: res.status }, 'DevTools MCP server not available');
      return { found: false, tools: [] };
    }

    const data = await res.json() as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } };
    const tools = data?.result?.tools ?? [];

    return {
      found: true,
      tools: tools.map(t => ({
        method: 'DEVTOOLS_MCP',
        path: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        source: 'devtools-mcp' as const,
        trustLevel: 3 as const,
      })),
    };
  } catch {
    log.debug('DevTools MCP server not found (expected if not installed)');
    return { found: false, tools: [] };
  }
}
