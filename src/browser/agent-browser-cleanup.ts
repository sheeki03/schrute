import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserDataDir } from '../core/config.js';
import type { SchruteConfig } from '../skill/types.js';

const AGENT_BROWSER_SESSION_DIR = 'agent-browser-sessions';
const AGENT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;

export interface AgentBrowserSessionMetadata {
  sessionName: string;
  createdAt: number;
  siteId?: string;
  purpose?: 'exec' | 'prefetch' | 'probe';
}

export function getAgentBrowserSessionRoot(config: SchruteConfig): string {
  return path.join(getBrowserDataDir(config), AGENT_BROWSER_SESSION_DIR);
}

function getAgentBrowserSessionPath(config: SchruteConfig, sessionName: string): string {
  return path.join(getAgentBrowserSessionRoot(config), `${encodeURIComponent(sessionName)}.json`);
}

export function writeAgentBrowserSessionMetadata(
  config: SchruteConfig,
  metadata: AgentBrowserSessionMetadata,
): void {
  const root = getAgentBrowserSessionRoot(config);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getAgentBrowserSessionPath(config, metadata.sessionName), JSON.stringify(metadata), {
    mode: 0o600,
  });
}

export function removeAgentBrowserSessionMetadata(config: SchruteConfig, sessionName: string): void {
  try {
    fs.rmSync(getAgentBrowserSessionPath(config, sessionName), { force: true });
  } catch {
    // Best effort.
  }
}

export function listAgentBrowserSessionMetadata(config: SchruteConfig): AgentBrowserSessionMetadata[] {
  const root = getAgentBrowserSessionRoot(config);
  if (!fs.existsSync(root)) return [];

  const entries: AgentBrowserSessionMetadata[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf-8')) as Partial<AgentBrowserSessionMetadata>;
      if (typeof raw.sessionName !== 'string' || !raw.sessionName) continue;
      entries.push({
        sessionName: raw.sessionName,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        ...(typeof raw.siteId === 'string' ? { siteId: raw.siteId } : {}),
        ...(raw.purpose === 'exec' || raw.purpose === 'prefetch' || raw.purpose === 'probe'
          ? { purpose: raw.purpose }
          : {}),
      });
    } catch {
      // Skip malformed metadata.
    }
  }
  return entries;
}

export async function closeAgentBrowserSession(sessionName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'agent-browser',
      ['--session', sessionName, '--json', 'close'],
      { timeout: AGENT_BROWSER_CLOSE_TIMEOUT_MS },
      (err) => {
        if (err) {
          reject(new Error(`Failed to close agent-browser session '${sessionName}': ${err.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}

export function closeAgentBrowserSessionSync(sessionName: string): void {
  execFileSync(
    'agent-browser',
    ['--session', sessionName, '--json', 'close'],
    { timeout: AGENT_BROWSER_CLOSE_TIMEOUT_MS, stdio: 'ignore' },
  );
}

export async function cleanupAgentBrowserSessions(config: SchruteConfig): Promise<void> {
  for (const metadata of listAgentBrowserSessionMetadata(config)) {
    try {
      await closeAgentBrowserSession(metadata.sessionName);
    } catch {
      // Best effort. Stale metadata should still be removed.
    }
    removeAgentBrowserSessionMetadata(config, metadata.sessionName);
  }
}

export function cleanupAgentBrowserSessionsSync(config: SchruteConfig): void {
  for (const metadata of listAgentBrowserSessionMetadata(config)) {
    try {
      closeAgentBrowserSessionSync(metadata.sessionName);
    } catch {
      // Best effort.
    }
    removeAgentBrowserSessionMetadata(config, metadata.sessionName);
  }
}
