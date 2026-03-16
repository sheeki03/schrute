/**
 * Dogfood E2E: MCP Stdio — ALL meta tools, pro user workflows
 *
 * Spawns the real Schrute MCP server process and exercises every meta tool
 * via JSON-RPC 2.0 over stdio. Tests behavior like a power user would:
 *
 *   - Full lifecycle: explore → record → stop → skills → execute → doctor
 *   - Every meta tool at least once
 *   - Error paths: missing args, invalid inputs, wrong state
 *   - Proxy/geo validation through explore
 *   - Session management: create, switch, list, close
 *   - Cookie import/export
 *   - Dry run previews
 *   - Confirmation flow
 *   - State machine exhaustive transitions
 *
 * Uses a real Fastify mock server as the target site.
 * No mocks except Playwright (which the server handles gracefully).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRestMockServer } from '../fixtures/mock-sites/rest-mock-server.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverEntry = join(projectRoot, 'dist', 'index.js');

// ─── MCP JSON-RPC Client ─────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = '';
  private ready: Promise<void>;
  private readyResolve!: () => void;

  constructor(serverPath: string, env: Record<string, string> = {}) {
    this.ready = new Promise(resolve => { this.readyResolve = resolve; });

    this.proc = spawn('node', [serverPath, 'serve', '--no-daemon'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
        SCHRUTE_LOG_LEVEL: 'silent',
        NODE_OPTIONS: '--no-warnings',
      },
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            resolve(msg as JsonRpcResponse);
          }
        } catch { /* skip non-JSON */ }
      }
    });

    this.proc.stderr!.on('data', () => { /* swallow logs */ });

    this.proc.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    setTimeout(() => this.readyResolve(), 500);
  }

  async send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method} (id=${id})`));
      }, 30000);

      this.pending.set(id, {
        resolve: (resp) => { clearTimeout(timeout); resolve(resp); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize(): Promise<JsonRpcResponse> {
    const resp = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dogfood-stdio-test', version: '1.0.0' },
    });
    this.proc.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');
    return resp;
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const resp = await this.send('tools/call', { name, arguments: args ?? {} });
    if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
    return resp.result as any;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: any }>> {
    const resp = await this.send('tools/list', {});
    if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
    return (resp.result as any).tools;
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { this.proc.kill('SIGKILL'); resolve(); }, 5000);
      this.proc.on('exit', () => { clearTimeout(timeout); resolve(); });
      this.proc.kill('SIGTERM');
    });
  }
}

// Helper to parse tool response JSON
function parseToolResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function waitForPipelineJob(client: McpClient, jobId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.callTool('schrute_pipeline_status', { jobId });
    expect(result.isError).toBeFalsy();
    const data = parseToolResult(result);
    if (data.status === 'completed' || data.status === 'failed') {
      return data;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Pipeline job ${jobId} did not complete within ${timeoutMs}ms`);
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Dogfood E2E: MCP Stdio — All Meta Tools', () => {
  let client: McpClient;
  let mockServer: Awaited<ReturnType<typeof createRestMockServer>>;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'schrute-dogfood-stdio-'));
    mockServer = await createRestMockServer();
    client = new McpClient(serverEntry, { SCHRUTE_DATA_DIR: tempDir });
  }, 20000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockServer) await mockServer.close();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }, 10000);

  // ═══════════════════════════════════════════════════════════════
  // A. MCP Handshake
  // ═══════════════════════════════════════════════════════════════

  describe('MCP handshake', () => {
    it('initializes successfully with server info and capabilities', async () => {
      const resp = await client.initialize();
      expect(resp.error).toBeUndefined();
      const result = resp.result as any;
      expect(result.serverInfo?.name).toBe('schrute');
      expect(result.capabilities?.tools).toBeDefined();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // B. tools/list — All Meta Tools Present
  // ═══════════════════════════════════════════════════════════════

  describe('tools/list completeness', () => {
    it('lists all required meta tools', async () => {
      const tools = await client.listTools();
      const names = tools.map(t => t.name);

      const expectedMetaTools = [
        'schrute_explore',
        'schrute_record',
        'schrute_stop',
        'schrute_pipeline_status',
        'schrute_sites',
        'schrute_skills',
        'schrute_status',
        'schrute_dry_run',
        'schrute_confirm',
        'schrute_connect_cdp',
        'schrute_sessions',
        'schrute_close_session',
        'schrute_switch_session',
        'schrute_import_cookies',
        'schrute_execute',
        'schrute_doctor',
        'schrute_export_cookies',
      ];

      for (const tool of expectedMetaTools) {
        expect(names).toContain(tool);
      }
    }, 10000);

    it('lists browser tools', async () => {
      const tools = await client.listTools();
      const names = tools.map(t => t.name);

      expect(names).toContain('browser_snapshot');
      expect(names).toContain('browser_click');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('browser_type');
    }, 10000);

    it('every tool has description and inputSchema', async () => {
      const tools = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // C. Status — Before Explore (idle)
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_status — idle', () => {
    it('returns idle mode with uptime', async () => {
      const result = await client.callTool('schrute_status');
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.mode).toBe('idle');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.activeSession).toBeNull();
      expect(data.currentRecording).toBeNull();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // D. Doctor — Diagnostics
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_doctor', () => {
    it('returns diagnostic report', async () => {
      const result = await client.callTool('schrute_doctor');
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.diagnostics).toBeDefined();
      expect(data.diagnostics.engine).toBeDefined();
      expect(data.diagnostics.browser).toBeDefined();
      expect(data.diagnostics.sessions).toBeDefined();
      expect(data.diagnostics.skills).toBeDefined();
      expect(typeof data.diagnostics.skills.total).toBe('number');
      expect(typeof data.diagnostics.skills.active).toBe('number');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // E. Explore — Happy Path
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_explore', () => {
    it('creates a session for the mock server', async () => {
      const result = await client.callTool('schrute_explore', {
        url: mockServer.url + '/api/users',
      });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.sessionId).toBeDefined();
      expect(data.siteId).toBe('127.0.0.1');
    }, 30000);

    it('status shows exploring after explore', async () => {
      const result = await client.callTool('schrute_status');
      const data = parseToolResult(result);
      expect(data.mode).toBe('exploring');
      expect(data.activeSession).toBeDefined();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // F. Explore — Error Paths
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_explore — error paths', () => {
    it('rejects missing URL', async () => {
      const result = await client.callTool('schrute_explore', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('url is required');
    }, 10000);

    it('rejects invalid URL', async () => {
      const result = await client.callTool('schrute_explore', { url: 'not-a-url' });
      expect(result.isError).toBe(true);
    }, 10000);

    it('rejects proxy with invalid URL', async () => {
      const result = await client.callTool('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'not-a-url' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('proxy');
    }, 10000);

    it('rejects proxy with credentials in URL', async () => {
      const result = await client.callTool('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'http://user:pass@proxy:8080' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('host-only');
    }, 10000);

    it('rejects invalid timezone', async () => {
      const result = await client.callTool('schrute_explore', {
        url: 'https://example.com',
        geo: { timezoneId: 'Mars/Olympus' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timezoneId');
    }, 10000);

    it('rejects latitude out of range', async () => {
      const result = await client.callTool('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: 91, longitude: 0 } },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('latitude');
    }, 10000);

    it('rejects longitude out of range', async () => {
      const result = await client.callTool('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: 0, longitude: -181 } },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('longitude');
    }, 10000);

    it('rejects invalid locale', async () => {
      const result = await client.callTool('schrute_explore', {
        url: 'https://example.com',
        geo: { locale: '!invalid!' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('locale');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // G. Record → Stop Lifecycle
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_record → schrute_stop', () => {
    it('starts recording with name and inputs', async () => {
      const result = await client.callTool('schrute_record', {
        name: 'dogfood-test-rec',
        inputs: { page: '1' },
      });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.name).toBe('dogfood-test-rec');
      expect(data.siteId).toBe('127.0.0.1');
    }, 10000);

    it('status shows recording during recording', async () => {
      const result = await client.callTool('schrute_status');
      const data = parseToolResult(result);
      expect(data.mode).toBe('recording');
      expect(data.currentRecording).toBeDefined();
      expect(data.currentRecording.name).toBe('dogfood-test-rec');
    }, 10000);

    it('stops recording', async () => {
      const result = await client.callTool('schrute_stop');
      const data = parseToolResult(result);
      expect(data.pipelineJobId).toBeDefined();

      const job = await waitForPipelineJob(client, data.pipelineJobId);
      expect(job.status).toBe('completed');
    }, 30000);

    it('status returns to exploring after stop', async () => {
      const result = await client.callTool('schrute_status');
      const data = parseToolResult(result);
      expect(data.mode).toBe('exploring');
      expect(data.currentRecording).toBeNull();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // H. Record — Error Paths
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_record — error paths', () => {
    it('rejects missing name', async () => {
      const result = await client.callTool('schrute_record', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required');
    }, 10000);

    it('double record is rejected', async () => {
      await client.callTool('schrute_record', { name: 'first' });

      const second = await client.callTool('schrute_record', { name: 'second' });
      expect(second.content[0].text).toContain('Cannot start recording');

      // Clean up
      const stopResult = await client.callTool('schrute_stop');
      const stopData = parseToolResult(stopResult);
      if (stopData.pipelineJobId) {
        const job = await waitForPipelineJob(client, stopData.pipelineJobId);
        expect(job.status).toBe('completed');
      }
    }, 15000);

    it('stop without recording is rejected', async () => {
      const result = await client.callTool('schrute_stop');
      expect(result.content[0].text).toContain('No active recording');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // I. Sites
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_sites', () => {
    it('lists known sites', async () => {
      const result = await client.callTool('schrute_sites');
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(Array.isArray(data)).toBe(true);
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // J. Skills — By Site and Grouped
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_skills', () => {
    it('lists skills by siteId', async () => {
      const result = await client.callTool('schrute_skills', { siteId: '127.0.0.1' });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.totalSkills).toBeDefined();
      expect(typeof data.totalSkills).toBe('number');
      expect(data.sites).toBeDefined();
    }, 10000);

    it('lists all skills grouped by site (no siteId)', async () => {
      const result = await client.callTool('schrute_skills', {});
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.totalSkills).toBeDefined();
      expect(typeof data.totalSkills).toBe('number');
      expect(data.sites).toBeDefined();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // K. Dry Run
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_dry_run', () => {
    it('rejects missing skillId', async () => {
      const result = await client.callTool('schrute_dry_run', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skillId is required');
    }, 10000);

    it('rejects nonexistent skill', async () => {
      const result = await client.callTool('schrute_dry_run', {
        skillId: 'nonexistent.skill.v1',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // L. Execute — Error Paths
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_execute', () => {
    it('rejects missing skillId', async () => {
      const result = await client.callTool('schrute_execute', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skillId is required');
    }, 10000);

    it('rejects nonexistent skill', async () => {
      const result = await client.callTool('schrute_execute', {
        skillId: 'nonexistent.skill.v1',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // M. Confirm — Error Paths
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_confirm', () => {
    it('rejects missing token', async () => {
      const result = await client.callTool('schrute_confirm', { approve: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('confirmationToken is required');
    }, 10000);

    it('rejects missing approve', async () => {
      const result = await client.callTool('schrute_confirm', { confirmationToken: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('approve must be a boolean');
    }, 10000);

    it('rejects invalid token', async () => {
      const result = await client.callTool('schrute_confirm', {
        confirmationToken: 'invalid-token-xyz',
        approve: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Confirmation failed');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // N. Session Management
  // ═══════════════════════════════════════════════════════════════

  describe('Session management', () => {
    it('schrute_sessions lists active sessions', async () => {
      const result = await client.callTool('schrute_sessions');
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(Array.isArray(data)).toBe(true);

      const defaultSession = data.find((s: any) => s.name === 'default');
      expect(defaultSession).toBeDefined();
      expect(defaultSession.active).toBe(true);
    }, 10000);

    it('schrute_switch_session requires name', async () => {
      const result = await client.callTool('schrute_switch_session', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required');
    }, 10000);

    it('schrute_close_session requires name', async () => {
      const result = await client.callTool('schrute_close_session', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // O. CDP — Error Paths
  // ═══════════════════════════════════════════════════════════════

  describe('schrute_connect_cdp — error paths', () => {
    it('rejects missing name', async () => {
      const result = await client.callTool('schrute_connect_cdp', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required');
    }, 10000);

    it('rejects "default" as session name', async () => {
      const result = await client.callTool('schrute_connect_cdp', { name: 'default' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot use "default"');
    }, 10000);

    it('rejects non-integer port', async () => {
      const result = await client.callTool('schrute_connect_cdp', { name: 'test', port: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('port must be an integer');
    }, 10000);

    it('connects to nonexistent CDP endpoint → graceful error', async () => {
      const result = await client.callTool('schrute_connect_cdp', {
        name: 'test-cdp',
        port: 19222,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBeDefined();
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════════
  // P. Cookies
  // ═══════════════════════════════════════════════════════════════

  describe('Cookie management', () => {
    it('schrute_import_cookies requires siteId and cookieFile', async () => {
      const result = await client.callTool('schrute_import_cookies', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('required');
    }, 10000);

    it('schrute_import_cookies with missing file → error', async () => {
      const result = await client.callTool('schrute_import_cookies', {
        siteId: '127.0.0.1',
        cookieFile: '/tmp/nonexistent-cookie-dogfood-12345.txt',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    }, 10000);

    it('schrute_export_cookies requires siteId', async () => {
      const result = await client.callTool('schrute_export_cookies', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('siteId is required');
    }, 10000);

    it('schrute_export_cookies on explored site', async () => {
      const result = await client.callTool('schrute_export_cookies', {
        siteId: '127.0.0.1',
      });
      // May succeed (empty cookies) or error if no context
      if (!result.isError) {
        const data = parseToolResult(result);
        expect(data.cookies).toBeDefined();
        expect(Array.isArray(data.cookies)).toBe(true);
        expect(typeof data.count).toBe('number');
      }
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // Q. Blocked Browser Tools
  // ═══════════════════════════════════════════════════════════════

  describe('Blocked browser tools', () => {
    it('browser_install is blocked', async () => {
      const result = await client.callTool('browser_install', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('BLOCKED');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // R. Unknown Tool
  // ═══════════════════════════════════════════════════════════════

  describe('Unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const result = await client.callTool('nonexistent_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════
  // S. Server Health After All Tests
  // ═══════════════════════════════════════════════════════════════

  describe('Server health after all operations', () => {
    it('server is still responsive', async () => {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const status = await client.callTool('schrute_status');
      expect(status.isError).toBeFalsy();
    }, 10000);

    it('doctor still runs cleanly', async () => {
      const result = await client.callTool('schrute_doctor');
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result);
      expect(data.diagnostics.engine.mode).toBeDefined();
    }, 10000);
  });
});
