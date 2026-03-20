import type { SchruteConfig } from '../skill/types.js';

/**
 * Determine if a caller has admin privileges.
 *
 * In multi-user mode (server.network=true), only local/trusted transports
 * can perform admin operations (explore/record/stop/browser tools).
 * - 'stdio' = local CLI
 * - 'daemon' = local daemon socket (UDS auth)
 *
 * MCP HTTP sessions and REST clients cannot mutate shared engine state.
 * When server.network is false (localhost-only), all callers are trusted.
 */
export function isAdminCaller(callerId: string | undefined, config: SchruteConfig): boolean {
  if (!config.server.network) return true;  // localhost-only: everyone is admin
  if (!callerId) return true;               // no callerId = legacy/CLI = trusted
  if (callerId === 'stdio' || callerId === 'daemon') return true;
  if (config.server.mcpHttpAdmin && callerId.startsWith('mcp-http:')) return true;
  return false;
}
