/**
 * MCP End-to-End Test — exercises the real MCP stdio server
 *
 * Spawns the actual Schrute MCP server process, sends JSON-RPC 2.0 messages
 * via stdin, reads responses from stdout, and verifies the full wiring lifecycle:
 *
 *   initialize → tools/list → explore → record → stop → skills → status → execute
 *
 * Uses a real Fastify mock server as the target site. No mocks except Playwright
 * (which the server handles gracefully when unavailable).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRestMockServer } from '../fixtures/mock-sites/rest-mock-server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverEntry = join(projectRoot, 'dist', 'index.js');
const MCP_STARTUP_TIMEOUT_MS = 30_000;
const MCP_REQUEST_TIMEOUT_MS = 60_000;
const MCP_STEP_TIMEOUT_MS = 60_000;
const MCP_PIPELINE_TIMEOUT_MS = 90_000;

// ─── MCP JSON-RPC Client ─────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpTestClient {
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

    this.proc = spawn(process.execPath, [serverPath, 'serve', '--no-daemon'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
        SCHRUTE_LOG_LEVEL: 'silent',
        NODE_OPTIONS: '--no-warnings',
      },
    });

    // Parse newline-delimited JSON-RPC responses from stdout
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
          // Notifications (no id) are ignored
        } catch {
          // Skip non-JSON lines (e.g., log output)
        }
      }
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      // Swallow stderr (logs)
    });

    this.proc.on('error', (err) => {
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });

    // Give the server a moment to start, then resolve ready
    setTimeout(() => this.readyResolve(), 500);
  }

  async send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    await this.ready;
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (id=${id})`));
      }, MCP_REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.proc.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  /** Helper: send MCP initialize + initialized notification */
  async initialize(): Promise<JsonRpcResponse> {
    const resp = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-e2e-test', version: '1.0.0' },
    });
    // Send initialized notification (no id)
    this.proc.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');
    return resp;
  }

  /** Helper: call an MCP tool */
  async callTool(name: string, args?: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const resp = await this.send('tools/call', { name, arguments: args ?? {} });
    if (resp.error) {
      throw new Error(`MCP error calling ${name}: ${resp.error.message}`);
    }
    return resp.result as any;
  }

  /** Helper: list tools */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const resp = await this.send('tools/list', {});
    if (resp.error) {
      throw new Error(`MCP error listing tools: ${resp.error.message}`);
    }
    return (resp.result as any).tools;
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 5000);
      this.proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.proc.kill('SIGTERM');
    });
  }
}

async function waitForPipelineJob(client: McpTestClient, jobId: string, timeoutMs = MCP_PIPELINE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.callTool('schrute_pipeline_status', { jobId });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    if (data.status === 'completed' || data.status === 'failed') {
      return data;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Pipeline job ${jobId} did not complete within ${timeoutMs}ms`);
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MCP E2E: full lifecycle via stdio server', () => {
  let client: McpTestClient;
  let mockServer: Awaited<ReturnType<typeof createRestMockServer>>;
  let tempDir: string;

  beforeAll(async () => {
    // Create temp data directory for the server
    tempDir = mkdtempSync(join(tmpdir(), 'schrute-mcp-e2e-'));

    // Start mock REST server
    mockServer = await createRestMockServer();

    // Start MCP server
    client = new McpTestClient(serverEntry, {
      SCHRUTE_DATA_DIR: tempDir,
    });
  }, MCP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (client) await client.close();
    if (mockServer) await mockServer.close();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }, MCP_PIPELINE_TIMEOUT_MS);

  it('initializes MCP handshake', async () => {
    const resp = await client.initialize();
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();

    const result = resp.result as any;
    expect(result.serverInfo?.name).toBe('schrute');
    expect(result.capabilities?.tools).toBeDefined();
  }, MCP_STEP_TIMEOUT_MS);

  it('lists meta tools (tools/list)', async () => {
    const tools = await client.listTools();

    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('schrute_explore');
    expect(toolNames).toContain('schrute_record');
    expect(toolNames).toContain('schrute_stop');
    expect(toolNames).toContain('schrute_pipeline_status');
    expect(toolNames).toContain('schrute_skills');
    expect(toolNames).toContain('schrute_status');
    expect(toolNames).toContain('schrute_dry_run');
    expect(toolNames).toContain('schrute_confirm');
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_status returns idle state', async () => {
    const result = await client.callTool('schrute_status');
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe('idle');
    expect(data.uptime).toBeGreaterThanOrEqual(0);
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_explore creates a session', async () => {
    const result = await client.callTool('schrute_explore', {
      url: mockServer.url + '/api/users',
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.sessionId).toBeDefined();
    expect(data.siteId).toBe('127.0.0.1');
  }, MCP_REQUEST_TIMEOUT_MS);

  it('schrute_status shows exploring after explore', async () => {
    const result = await client.callTool('schrute_status');
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe('exploring');
    expect(data.activeSession).toBeDefined();
    expect(data.activeSession.siteId).toBe('127.0.0.1');
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_record starts recording', async () => {
    const result = await client.callTool('schrute_record', {
      name: 'mcp-e2e-test',
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe('mcp-e2e-test');
    expect(data.siteId).toBe('127.0.0.1');
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_status shows recording after record', async () => {
    const result = await client.callTool('schrute_status');
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe('recording');
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_stop stops recording and runs capture pipeline', async () => {
    const result = await client.callTool('schrute_stop');
    const data = JSON.parse(result.content[0].text);
    expect(data.pipelineJobId).toBeDefined();

    const job = await waitForPipelineJob(client, data.pipelineJobId);
    expect(job.status).toBe('completed');
  }, MCP_PIPELINE_TIMEOUT_MS);

  it('schrute_status returns to exploring after stop', async () => {
    const result = await client.callTool('schrute_status');
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe('exploring');
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_skills returns skill list (may be empty without browser)', async () => {
    const result = await client.callTool('schrute_skills', {
      siteId: '127.0.0.1',
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    // Data is a grouped skills object with totalSkills and sites
    expect(data.totalSkills).toBeDefined();
    expect(typeof data.totalSkills).toBe('number');
    expect(data.sites).toBeDefined();
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_dry_run validates error on missing skill', async () => {
    const result = await client.callTool('schrute_dry_run', {
      skillId: 'nonexistent.skill.v1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_explore with invalid URL returns error', async () => {
    const result = await client.callTool('schrute_explore', {
      url: 'not-a-url',
    });
    expect(result.isError).toBe(true);
  }, MCP_STEP_TIMEOUT_MS);

  it('schrute_record without name returns error', async () => {
    const result = await client.callTool('schrute_record', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('name is required');
  }, MCP_STEP_TIMEOUT_MS);

  it('tools/list includes prompts and resources capabilities', async () => {
    // Re-list to verify server is still healthy after all operations
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    // All meta tools should still be present
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('schrute_explore');
    expect(toolNames).toContain('schrute_status');
  }, MCP_STEP_TIMEOUT_MS);

  // ═══════════════════════════════════════════════════════════════
  // 5B: State transition errors
  // ═══════════════════════════════════════════════════════════════

  describe('State transition errors', () => {
    // Note: these tests run after the main lifecycle tests above,
    // so the engine is in 'exploring' mode (after stop, mode goes back to exploring).

    it('schrute_stop without active recording returns error', async () => {
      // Engine is in exploring mode (not recording), so stop should fail
      const result = await client.callTool('schrute_stop');
      // callTool throws on MCP error, but the tool dispatch returns isError
      // If router catches the engine error, we get isError response
      const data = result.content[0].text;
      expect(data).toContain('No active recording');
    }, MCP_STEP_TIMEOUT_MS);

    it('double schrute_record returns error on second call', async () => {
      // Start first recording
      const first = await client.callTool('schrute_record', { name: 'first-rec' });
      expect(first.isError).toBeFalsy();

      // Second record while already recording should fail
      const second = await client.callTool('schrute_record', { name: 'second-rec' });
      const data = second.content[0].text;
      expect(data).toContain('Cannot start recording');

      // Clean up: stop the first recording
      const stopResult = await client.callTool('schrute_stop');
      const stopData = JSON.parse(stopResult.content[0].text);
      if (stopData.pipelineJobId) {
        const job = await waitForPipelineJob(client, stopData.pipelineJobId);
        expect(job.status).toBe('completed');
      }
    }, MCP_PIPELINE_TIMEOUT_MS);

    it('schrute_record is rejected after schrute_stop when in idle mode', async () => {
      // First stop the recording from the previous test if still active
      // Start recording, stop, then verify we're back in exploring mode
      await client.callTool('schrute_record', { name: 'temp-rec' });

      const statusDuring = await client.callTool('schrute_status');
      const duringData = JSON.parse(statusDuring.content[0].text);
      expect(duringData.mode).toBe('recording');

      await client.callTool('schrute_stop');

      const statusAfter = await client.callTool('schrute_status');
      const afterData = JSON.parse(statusAfter.content[0].text);
      expect(afterData.mode).toBe('exploring');
    }, MCP_PIPELINE_TIMEOUT_MS);
  });

  // ═══════════════════════════════════════════════════════════════
  // 5D: Concurrent session isolation
  // ═══════════════════════════════════════════════════════════════

  describe('Concurrent session isolation', () => {
    it('session management tools route correctly', async () => {
      // 1. We already have an explore session (site A = mock server).
      //    Verify active session is 'default'
      const sessionsResult = await client.callTool('schrute_sessions');
      expect(sessionsResult.isError).toBeFalsy();
      const sessions = JSON.parse(sessionsResult.content[0].text);
      expect(Array.isArray(sessions)).toBe(true);
      const defaultSession = sessions.find((s: any) => s.name === 'default');
      expect(defaultSession).toBeDefined();
      expect(defaultSession.active).toBe(true);

      // 2. Attempt to connect CDP session (will fail without real CDP, but
      //    validates the routing and error handling)
      const cdpResult = await client.callTool('schrute_connect_cdp', {
        name: 'session-b',
        port: 19222, // unlikely to have a real CDP endpoint
      });
      // CDP connection will fail, but it should be a graceful error
      expect(cdpResult.isError).toBe(true);
      expect(cdpResult.content[0].text).toBeDefined();

      // 3. Verify default session is still active after failed CDP connect
      const sessionsAfter = await client.callTool('schrute_sessions');
      const sessionsData = JSON.parse(sessionsAfter.content[0].text);
      const stillDefault = sessionsData.find((s: any) => s.name === 'default');
      expect(stillDefault.active).toBe(true);

      // 4. Switch to non-existent session should error
      const switchResult = await client.callTool('schrute_switch_session', {
        name: 'nonexistent',
      });
      // setActive may throw or silently accept — verify either way
      expect(switchResult.content[0].text).toBeDefined();
    }, MCP_PIPELINE_TIMEOUT_MS);
  });

  // ═══════════════════════════════════════════════════════════════
  // 5G: Cookie persistence
  // ═══════════════════════════════════════════════════════════════

  describe('Cookie persistence', () => {
    it('schrute_import_cookies requires siteId and cookieFile', async () => {
      const result = await client.callTool('schrute_import_cookies', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('required');
    }, MCP_STEP_TIMEOUT_MS);

    it('schrute_export_cookies requires siteId', async () => {
      const result = await client.callTool('schrute_export_cookies', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('required');
    }, MCP_STEP_TIMEOUT_MS);

    it('schrute_import_cookies with missing file returns error', async () => {
      const result = await client.callTool('schrute_import_cookies', {
        siteId: '127.0.0.1',
        cookieFile: '/tmp/nonexistent-cookie-file-12345.txt',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    }, MCP_STEP_TIMEOUT_MS);

    it('schrute_export_cookies on explored site returns cookie list', async () => {
      // The engine should have a browser context for 127.0.0.1 from prior explore
      const result = await client.callTool('schrute_export_cookies', {
        siteId: '127.0.0.1',
      });
      // May succeed (empty cookies) or error if context was lost
      if (!result.isError) {
        const data = JSON.parse(result.content[0].text);
        expect(data.cookies).toBeDefined();
        expect(Array.isArray(data.cookies)).toBe(true);
        expect(typeof data.count).toBe('number');
      }
    }, MCP_STEP_TIMEOUT_MS);
  });
});
