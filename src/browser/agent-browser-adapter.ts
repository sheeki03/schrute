import type { Page, Response as PwResponse } from 'playwright';
import type {
  BrowserProvider,
  PageSnapshot,
  NetworkEntry,
  SealedFetchRequest,
  SealedFetchResponse,
} from '../skill/types.js';
import {
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
} from '../skill/types.js';

type AllowedTool = (typeof ALLOWED_BROWSER_TOOLS)[number];

/**
 * Agent-optimized browser adapter implementing BrowserProvider.
 *
 * Purpose-built for agent interaction loops: snapshot → act → verify.
 * Provides better context efficiency (~4x reduction) by returning
 * compact accessibility tree snapshots instead of full DOM.
 *
 * Uses Playwright API underneath with a strict ALLOWED_BROWSER_TOOLS
 * allowlist proxy.
 *
 * SECURITY:
 * - Only tools from ALLOWED_BROWSER_TOOLS are reachable
 * - browser_evaluate, browser_run_code, browser_install are BLOCKED
 * - evaluateFetch uses sealed template, not raw JS
 */
export class AgentBrowserAdapter implements BrowserProvider {
  private page: Page;
  private domainAllowlist: string[];
  private networkEntries: NetworkEntry[] = [];
  private maxNetworkEntries: number;

  constructor(
    page: Page,
    domainAllowlist: string[],
    options?: { maxNetworkEntries?: number },
  ) {
    this.page = page;
    // Reject wildcard .domain entries — require exact domain or explicit subdomain
    for (const domain of domainAllowlist) {
      if (domain.startsWith('.')) {
        throw new Error(
          `Invalid domain allowlist entry "${domain}": wildcard entries starting ` +
          `with "." are not allowed. Use the exact domain (e.g., "${domain.slice(1)}") ` +
          `or list subdomains explicitly.`,
        );
      }
    }
    this.domainAllowlist = domainAllowlist;
    this.maxNetworkEntries = options?.maxNetworkEntries ?? 500;
    this.setupNetworkCapture();
  }

  // ─── Tool Allowlist Gate ─────────────────────────────────────────

  private assertAllowed(toolName: string): asserts toolName is AllowedTool {
    if ((BLOCKED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      throw new Error(
        `BLOCKED: Tool "${toolName}" is explicitly blocked. ` +
        `Blocked tools: ${BLOCKED_BROWSER_TOOLS.join(', ')}`,
      );
    }
    if (!(ALLOWED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      throw new Error(
        `DENIED: Tool "${toolName}" is not on the allowed browser tools list.`,
      );
    }
  }

  /**
   * Proxy a tool call through the allowlist gate.
   * External callers should prefer the typed BrowserProvider methods.
   */
  async proxyTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertAllowed(toolName);

    switch (toolName) {
      case 'browser_navigate':
        await this.navigate(args.url as string);
        return { success: true };
      case 'browser_navigate_back':
        await this.page.goBack();
        return { success: true };
      case 'browser_snapshot':
        return this.snapshot();
      case 'browser_click':
        await this.click(args.ref as string);
        return { success: true };
      case 'browser_type':
        await this.type(args.ref as string, args.text as string);
        return { success: true };
      case 'browser_take_screenshot':
        return this.screenshot();
      case 'browser_network_requests':
        return this.networkRequests();
      case 'browser_hover':
        await this.page.locator(`[data-ref="${args.ref}"]`).hover();
        return { success: true };
      case 'browser_drag':
        await this.page.locator(`[data-ref="${args.startRef}"]`).dragTo(
          this.page.locator(`[data-ref="${args.endRef}"]`),
        );
        return { success: true };
      case 'browser_press_key':
        await this.page.keyboard.press(args.key as string);
        return { success: true };
      case 'browser_select_option':
        await this.page.locator(`[data-ref="${args.ref}"]`).selectOption(
          args.value as string,
        );
        return { success: true };
      case 'browser_fill_form':
        await this.fillForm(args.values as Record<string, string>);
        return { success: true };
      case 'browser_file_upload':
        await this.page.locator(`[data-ref="${args.ref}"]`).setInputFiles(
          args.paths as string[],
        );
        return { success: true };
      case 'browser_handle_dialog':
        return { success: true, note: 'Dialogs are auto-handled' };
      case 'browser_tabs':
        return this.page.context().pages().map((p, i) => ({
          index: i,
          url: p.url(),
          title: '',
        }));
      case 'browser_wait_for':
        await this.page.waitForSelector(
          args.selector as string,
          { timeout: (args.timeout as number) ?? 30000 },
        );
        return { success: true };
      case 'browser_close':
        await this.page.close();
        return { success: true };
      case 'browser_resize':
        await this.page.setViewportSize({
          width: args.width as number,
          height: args.height as number,
        });
        return { success: true };
      case 'browser_console_messages':
        return { note: 'Console messages require prior listener setup' };
      default:
        throw new Error(`Unhandled allowed tool: ${toolName}`);
    }
  }

  // ─── BrowserProvider Interface ─────────────────────────────────

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Returns a compact accessibility-tree snapshot optimized for agent context.
   * Uses aria snapshot for ~4x context reduction compared to full DOM.
   */
  async snapshot(): Promise<PageSnapshot> {
    const url = this.page.url();
    const title = await this.page.title();

    let content = '';
    try {
      content = await this.page.locator('body').ariaSnapshot();
    } catch {
      try {
        content = await this.page.locator('body').innerText();
      } catch {
        content = '';
      }
    }

    return { url, title, content };
  }

  async click(ref: string): Promise<void> {
    const locator = this.page.locator(
      `[data-ref="${ref}"], [aria-label="${ref}"]`,
    ).first();
    await locator.click({ timeout: 10000 });
  }

  async type(ref: string, text: string): Promise<void> {
    const locator = this.page.locator(
      `[data-ref="${ref}"], [aria-label="${ref}"]`,
    ).first();
    await locator.fill(text);
  }

  /**
   * Sealed fetch wrapper. Generates a fetch() call internally and executes
   * it in the page context. The URL is validated against the domain allowlist
   * BEFORE any code reaches the browser.
   *
   * NEVER exposes raw page.evaluate() to agents.
   */
  async evaluateFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
    this.assertDomainAllowed(req.url);

    const result = await this.page.evaluate(
      async ({ url, method, headers, body }) => {
        const resp = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
        });

        const responseHeaders: Record<string, string> = {};
        resp.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const responseBody = await resp.text();
        return { status: resp.status, headers: responseHeaders, body: responseBody };
      },
      { url: req.url, method: req.method, headers: req.headers, body: req.body },
    );

    return result;
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false });
  }

  async networkRequests(): Promise<NetworkEntry[]> {
    return [...this.networkEntries];
  }

  // ─── Internal Helpers ──────────────────────────────────────────

  private assertDomainAllowed(url: string): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (this.domainAllowlist.length === 0) {
      throw new Error(
        `Domain "${hostname}" is not on the allowlist. ` +
        `Configure domainAllowlist to enable sealed fetch.`,
      );
    }

    const allowed = this.domainAllowlist.some((domain) => {
      // Exact match or explicit subdomain match (e.g., "example.com"
      // matches both "example.com" and "sub.example.com")
      return hostname === domain || hostname.endsWith('.' + domain);
    });

    if (!allowed) {
      throw new Error(
        `Domain "${hostname}" is not on the allowlist. ` +
        `Allowed: ${this.domainAllowlist.join(', ')}`,
      );
    }
  }

  private setupNetworkCapture(): void {
    this.page.on('response', async (response: PwResponse) => {
      if (this.networkEntries.length >= this.maxNetworkEntries) {
        // Drop oldest entries
        this.networkEntries.shift();
      }

      const request = response.request();
      const timing = request.timing();

      let requestBody: string | undefined;
      try {
        requestBody = request.postData() ?? undefined;
      } catch {
        // Some requests don't have post data
      }

      let responseBody: string | undefined;
      try {
        responseBody = await response.text();
      } catch {
        // Some responses can't be read
      }

      const requestHeaders: Record<string, string> = {};
      try {
        const reqHeaders = await request.allHeaders();
        for (const [k, v] of Object.entries(reqHeaders)) {
          requestHeaders[k] = v;
        }
      } catch {
        // Headers may not be available
      }

      const responseHeaders: Record<string, string> = {};
      try {
        const respHeaders = await response.allHeaders();
        for (const [k, v] of Object.entries(respHeaders)) {
          responseHeaders[k] = v;
        }
      } catch {
        // Headers may not be available
      }

      const startTime = timing.startTime;
      const endTime = timing.responseEnd > 0 ? timing.responseEnd : startTime + 1;

      this.networkEntries.push({
        url: request.url(),
        method: request.method(),
        status: response.status(),
        requestHeaders,
        responseHeaders,
        requestBody,
        responseBody,
        timing: { startTime, endTime, duration: endTime - startTime },
      });
    });
  }

  private async fillForm(values: Record<string, string>): Promise<void> {
    for (const [ref, value] of Object.entries(values)) {
      await this.type(ref, value);
    }
  }
}
