import { getLogger } from '../core/logger.js';
import type {
  BrowserProvider,
  PageSnapshot,
  NetworkEntry,
  SealedFetchRequest,
  SealedFetchResponse,
  SealedModelContextRequest,
  SealedModelContextResponse,
} from '../skill/types.js';
import type { CookieEntry } from './backend.js';
import type { AgentBrowserIpcClient } from './agent-browser-ipc.js';

const log = getLogger();

/**
 * BrowserProvider implementation using agent-browser IPC socket.
 * Each instance maps to a named agent-browser session via an IPC client.
 */
export class AgentBrowserProvider implements BrowserProvider {
  private currentUrl: string = 'about:blank';

  constructor(
    private ipc: AgentBrowserIpcClient,
    private allowedDomains: string[],
  ) {}

  async navigate(url: string): Promise<void> {
    await this.ipc.send({ action: 'navigate', url });
    // Refresh cached URL from daemon
    const urlResp = await this.ipc.send({ action: 'url' }) as { url?: string } | string;
    this.currentUrl = typeof urlResp === 'string' ? urlResp : (urlResp?.url ?? url);
  }

  async snapshot(): Promise<PageSnapshot> {
    const result = await this.ipc.send({ action: 'snapshot', interactive: true }) as {
      snapshot?: string;
      refs?: object;
    };
    // Refresh cached URL
    const urlResp = await this.ipc.send({ action: 'url' }) as { url?: string } | string;
    this.currentUrl = typeof urlResp === 'string' ? urlResp : (urlResp?.url ?? this.currentUrl);

    return {
      url: this.currentUrl,
      title: '',
      content: result?.snapshot ?? '',
    };
  }

  async click(ref: string): Promise<void> {
    await this.ipc.send({ action: 'click', selector: ref });
    // Refresh cached URL (navigation may have occurred)
    const urlResp = await this.ipc.send({ action: 'url' }) as { url?: string } | string;
    this.currentUrl = typeof urlResp === 'string' ? urlResp : (urlResp?.url ?? this.currentUrl);
  }

  async type(ref: string, text: string): Promise<void> {
    await this.ipc.send({ action: 'fill', selector: ref, value: text });
  }

  async evaluateFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
    // Domain check before executing in browser
    try {
      const url = new URL(req.url);
      if (!this.allowedDomains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) {
        return { status: 0, headers: {}, body: `Domain ${url.hostname} not in allowed list: [${this.allowedDomains.join(', ')}]` };
      }
    } catch {
      return { status: 0, headers: {}, body: `Invalid URL: ${req.url}` };
    }

    const fetchScript = `await (async () => {
      const r = await fetch(${JSON.stringify(req.url)}, {
        method: ${JSON.stringify(req.method)},
        headers: ${JSON.stringify(req.headers)},
        body: ${req.body ? JSON.stringify(req.body) : 'undefined'},
        redirect: "manual"
      });
      const body = await r.text();
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      return JSON.stringify({ status: r.status, headers, body });
    })()`;

    let result: unknown;
    try {
      result = await this.ipc.send({ action: 'evaluate', script: fetchScript });
    } catch (err) {
      return { status: 0, headers: {}, body: `agent-browser IPC failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      return JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
    } catch {
      return { status: 0, headers: {}, body: `Failed to parse IPC response: ${String(result).slice(0, 500)}` };
    }
  }

  async evaluateModelContext(req: SealedModelContextRequest): Promise<SealedModelContextResponse> {
    const script = `await (async () => {
      const mc = navigator.modelContext;
      if (!mc || typeof mc.callTool !== 'function') {
        return JSON.stringify({ result: null, error: 'WebMCP not available' });
      }
      try {
        const r = await mc.callTool(${JSON.stringify(req.toolName)}, ${JSON.stringify(req.args)});
        return JSON.stringify({ result: r, error: null });
      } catch (e) {
        return JSON.stringify({ result: null, error: e?.message ?? String(e) });
      }
    })()`;

    try {
      const result = await this.ipc.send({ action: 'evaluate', script });
      return JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
    } catch (err) {
      return { result: null, error: `agent-browser IPC failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async listModelContextTools(): Promise<SealedModelContextResponse> {
    const script = `await (async () => {
      const mc = navigator.modelContext;
      if (!mc) return JSON.stringify({ result: null, error: 'WebMCP not available' });

      if (typeof mc.listTools === 'function') {
        try {
          const tools = await mc.listTools();
          const testing = navigator.modelContextTesting;
          let testingTools = null;
          if (testing && typeof testing.listTools === 'function') {
            try { testingTools = await testing.listTools(); } catch {}
          }
          return JSON.stringify({ result: { tools, testingTools }, error: null });
        } catch (e) {
          return JSON.stringify({ result: null, error: e?.message ?? String(e) });
        }
      }

      const testing = navigator.modelContextTesting;
      if (testing && typeof testing.listTools === 'function') {
        try {
          return JSON.stringify({ result: { tools: await testing.listTools() }, error: null });
        } catch (e) {
          return JSON.stringify({ result: null, error: e?.message ?? String(e) });
        }
      }

      if (typeof mc.callTool === 'function') {
        try {
          const r = await mc.callTool('__webmcp_probe__', { action: 'listTools' });
          return JSON.stringify({ result: { tools: r }, error: null });
        } catch (e) {
          return JSON.stringify({ result: null, error: e?.message ?? String(e) });
        }
      }

      return JSON.stringify({ result: null, error: 'No tool enumeration API found' });
    })()`;

    try {
      const result = await this.ipc.send({ action: 'evaluate', script });
      return JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
    } catch (err) {
      return { result: null, error: `agent-browser IPC failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.ipc.send({ action: 'screenshot', format: 'png' }) as {
      base64?: string;
    };
    return Buffer.from(result?.base64 ?? '', 'base64');
  }

  async networkRequests(): Promise<NetworkEntry[]> {
    const result = await this.ipc.send({ action: 'network_requests' });
    if (Array.isArray(result)) return result;
    return [];
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  async getCookies(): Promise<CookieEntry[]> {
    // Let IPC failures propagate — callers must distinguish read-failure
    // from genuine empty cookie jar to avoid wiping canonical auth state.
    const result = await this.ipc.send({ action: 'cookies_get' });
    if (Array.isArray(result)) return result;
    return [];
  }

  async hydrateCookies(cookies: CookieEntry[]): Promise<void> {
    // Batch entire array in ONE command
    await this.ipc.send({ action: 'cookies_set', cookies });
  }

  async hydrateLocalStorage(
    _origin: string,
    _items: Array<{ name: string; value: string }>,
  ): Promise<void> {
    // Agent-browser = cookies only. localStorage hydration is not supported.
    log.debug('hydrateLocalStorage is a no-op for agent-browser');
  }

  async extractLocalStorage(): Promise<Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>> {
    return [];
  }

  async close(): Promise<void> {
    try {
      await this.ipc.send({ action: 'close' });
    } catch {
      // Best effort
    }
  }
}
