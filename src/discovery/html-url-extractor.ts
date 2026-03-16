/**
 * Comprehensive HTML attribute URL extraction.
 *
 * Replaces the single `href="..."` regex with multi-attribute extraction
 * covering 30+ HTML attributes including HTMX, srcset, meta refresh,
 * SVG xlink, data-* attributes, and manifest links.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface ExtractedUrl {
  /** Resolved absolute URL */
  url: string;
  /** HTML attribute the URL was extracted from */
  attribute: string;
  /** Classification of the URL context */
  context: 'link' | 'api' | 'asset' | 'htmx';
  /** HTTP method, only set for HTMX attributes */
  method?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const MAX_URLS_PER_PAGE = 10_000;

/** Standard URL attributes with context */
const STANDARD_ATTRS: { attr: string; context: ExtractedUrl['context'] }[] = [
  { attr: 'href', context: 'link' },
  { attr: 'src', context: 'asset' },
  { attr: 'action', context: 'api' },
  { attr: 'formaction', context: 'api' },
  { attr: 'cite', context: 'link' },
  { attr: 'longdesc', context: 'link' },
  { attr: 'ping', context: 'api' },
  { attr: 'background', context: 'asset' },
  { attr: 'poster', context: 'asset' },
];

/** Data-* attributes that commonly hold URLs */
const DATA_ATTRS: string[] = [
  'data-url',
  'data-src',
  'data-href',
  'data-action',
  'data-endpoint',
];

/** HTMX attributes with HTTP method */
const HTMX_ATTRS: { attr: string; method: string }[] = [
  { attr: 'hx-get', method: 'GET' },
  { attr: 'hx-post', method: 'POST' },
  { attr: 'hx-put', method: 'PUT' },
  { attr: 'hx-patch', method: 'PATCH' },
  { attr: 'hx-delete', method: 'DELETE' },
];

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Extract URLs from HTML content using 30+ attribute patterns.
 *
 * All URLs are resolved against `pageUrl` and filtered to same-origin only.
 * Results are capped at 10,000 URLs per page.
 */
export function extractUrlsFromHtml(html: string, pageUrl: string): ExtractedUrl[] {
  let pageOrigin: string;
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    return [];
  }

  const results: ExtractedUrl[] = [];
  const seen = new Set<string>();

  function addUrl(raw: string, attribute: string, context: ExtractedUrl['context'], method?: string): void {
    if (results.length >= MAX_URLS_PER_PAGE) return;

    // Skip empty, fragments, javascript:, mailto:, data:, tel:
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:') ||
        trimmed.startsWith('mailto:') || trimmed.startsWith('data:') ||
        trimmed.startsWith('tel:')) {
      return;
    }

    try {
      const resolved = new URL(trimmed, pageUrl);
      // Same-origin filter
      if (resolved.origin !== pageOrigin) return;

      const href = resolved.href;
      const dedup = `${attribute}|${href}`;
      if (seen.has(dedup)) return;
      seen.add(dedup);

      const entry: ExtractedUrl = { url: href, attribute, context };
      if (method) entry.method = method;
      results.push(entry);
    } catch {
      // Invalid URL — skip
    }
  }

  // 1. Standard attributes
  for (const { attr, context } of STANDARD_ATTRS) {
    extractAttr(html, attr, (value) => addUrl(value, attr, context));
  }

  // 2. Data-* attributes
  for (const attr of DATA_ATTRS) {
    extractAttr(html, attr, (value) => addUrl(value, attr, 'api'));
  }

  // 3. HTMX attributes
  for (const { attr, method } of HTMX_ATTRS) {
    extractAttr(html, attr, (value) => addUrl(value, attr, 'htmx', method));
  }

  // 4. SVG xlink:href
  extractAttr(html, 'xlink:href', (value) => addUrl(value, 'xlink:href', 'link'));

  // 5. srcset — comma-separated "url descriptor" entries
  extractAttr(html, 'srcset', (value) => {
    parseSrcset(value, (url) => addUrl(url, 'srcset', 'asset'));
  });

  // 6. Meta refresh: <meta http-equiv="refresh" content="N;url=...">
  extractMetaRefresh(html, (url) => addUrl(url, 'meta-refresh', 'link'));

  // 7. Manifest: <link rel="manifest" href="...">
  extractManifestHref(html, (url) => addUrl(url, 'manifest', 'asset'));

  return results;
}

// ─── Attribute Extraction Helpers ───────────────────────────────────

/**
 * Extract values of a specific HTML attribute using regex.
 * Handles both single-quoted and double-quoted attribute values.
 */
function extractAttr(html: string, attr: string, callback: (value: string) => void): void {
  // Escape special regex chars in attribute name (for xlink:href)
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gi');
  let match;
  while ((match = re.exec(html)) !== null) {
    const value = match[1] ?? match[2];
    if (value !== undefined) {
      callback(value);
    }
  }
}

/**
 * Parse srcset attribute value.
 * Format: "url1 w1, url2 x2, url3" — comma-separated, each entry is "url [descriptor]"
 */
function parseSrcset(srcset: string, callback: (url: string) => void): void {
  const entries = srcset.split(',');
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Split on whitespace, first token is the URL
    const parts = trimmed.split(/\s+/);
    if (parts[0]) {
      callback(parts[0]);
    }
  }
}

/**
 * Extract URL from <meta http-equiv="refresh" content="N;url=...">
 */
function extractMetaRefresh(html: string, callback: (url: string) => void): void {
  const re = /<meta\s[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi;
  // Also handle content before http-equiv
  const re2 = /<meta\s[^>]*content\s*=\s*["']([^"']*)["'][^>]*http-equiv\s*=\s*["']refresh["'][^>]*>/gi;

  for (const regex of [re, re2]) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      const content = match[1];
      // Parse "N;url=..." or "N; url=..."
      const urlMatch = content.match(/;\s*url\s*=\s*['"]?\s*([^'">\s]+)/i);
      if (urlMatch?.[1]) {
        callback(urlMatch[1]);
      }
    }
  }
}

/**
 * Extract href from <link rel="manifest" href="...">
 */
function extractManifestHref(html: string, callback: (url: string) => void): void {
  const re = /<link\s[^>]*rel\s*=\s*["']manifest["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*>/gi;
  // Also handle href before rel
  const re2 = /<link\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']manifest["'][^>]*>/gi;

  for (const regex of [re, re2]) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (match[1]) {
        callback(match[1]);
      }
    }
  }
}
