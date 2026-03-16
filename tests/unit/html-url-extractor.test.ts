import { describe, it, expect } from 'vitest';
import { extractUrlsFromHtml, type ExtractedUrl } from '../../src/discovery/html-url-extractor.js';

const BASE = 'https://example.com/page';

function urls(result: ExtractedUrl[]): string[] {
  return result.map(r => r.url);
}

describe('extractUrlsFromHtml', () => {
  // ─── Standard Attributes ──────────────────────────────────────────

  describe('standard attributes', () => {
    it('extracts href links', () => {
      const html = '<a href="/about">About</a><a href="/contact">Contact</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/about');
      expect(urls(result)).toContain('https://example.com/contact');
      expect(result.find(r => r.url.endsWith('/about'))?.context).toBe('link');
      expect(result.find(r => r.url.endsWith('/about'))?.attribute).toBe('href');
    });

    it('extracts src attributes', () => {
      const html = '<img src="/logo.png"><script src="/app.js"></script>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/logo.png');
      expect(urls(result)).toContain('https://example.com/app.js');
      expect(result[0]?.context).toBe('asset');
    });

    it('extracts action and formaction', () => {
      const html = '<form action="/submit"><button formaction="/alt-submit">Go</button></form>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/submit');
      expect(urls(result)).toContain('https://example.com/alt-submit');
      expect(result.find(r => r.url.endsWith('/submit'))?.context).toBe('api');
      expect(result.find(r => r.url.endsWith('/submit'))?.attribute).toBe('action');
    });

    it('extracts cite attribute', () => {
      const html = '<blockquote cite="/source">text</blockquote>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/source');
      expect(result[0]?.context).toBe('link');
    });

    it('extracts longdesc attribute', () => {
      const html = '<img longdesc="/description" src="/img.png">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/description');
    });

    it('extracts ping attribute', () => {
      const html = '<a href="/page" ping="/track">link</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/track');
      expect(result.find(r => r.url.endsWith('/track'))?.context).toBe('api');
    });

    it('extracts background attribute', () => {
      const html = '<td background="/bg.jpg">cell</td>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/bg.jpg');
      expect(result[0]?.context).toBe('asset');
    });

    it('extracts poster attribute', () => {
      const html = '<video poster="/thumb.jpg" src="/video.mp4"></video>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/thumb.jpg');
      expect(result.find(r => r.url.endsWith('/thumb.jpg'))?.context).toBe('asset');
    });
  });

  // ─── Data Attributes ──────────────────────────────────────────────

  describe('data-* attributes', () => {
    it('extracts data-url', () => {
      const html = '<div data-url="/api/data">content</div>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/api/data');
      expect(result[0]?.context).toBe('api');
      expect(result[0]?.attribute).toBe('data-url');
    });

    it('extracts data-src', () => {
      const html = '<img data-src="/lazy-image.png">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/lazy-image.png');
    });

    it('extracts data-href', () => {
      const html = '<div data-href="/dynamic-page">nav</div>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/dynamic-page');
    });

    it('extracts data-action', () => {
      const html = '<button data-action="/api/action">Do it</button>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/api/action');
    });

    it('extracts data-endpoint', () => {
      const html = '<div data-endpoint="/api/v2/users">widget</div>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/api/v2/users');
    });
  });

  // ─── HTMX Attributes ─────────────────────────────────────────────

  describe('HTMX attributes', () => {
    it('extracts hx-get with GET method', () => {
      const html = '<div hx-get="/api/items">Load</div>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/api/items');
      expect(result[0]?.context).toBe('htmx');
      expect(result[0]?.method).toBe('GET');
    });

    it('extracts hx-post with POST method', () => {
      const html = '<form hx-post="/api/submit">Submit</form>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result[0]?.method).toBe('POST');
    });

    it('extracts hx-put with PUT method', () => {
      const html = '<div hx-put="/api/update">Update</div>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result[0]?.method).toBe('PUT');
    });

    it('extracts hx-patch with PATCH method', () => {
      const html = '<div hx-patch="/api/patch">Patch</div>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result[0]?.method).toBe('PATCH');
    });

    it('extracts hx-delete with DELETE method', () => {
      const html = '<button hx-delete="/api/items/1">Delete</button>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result[0]?.method).toBe('DELETE');
    });

    it('extracts multiple HTMX attributes from same page', () => {
      const html = `
        <div hx-get="/api/list">List</div>
        <form hx-post="/api/create">Create</form>
        <button hx-delete="/api/items/99">Remove</button>
      `;
      const result = extractUrlsFromHtml(html, BASE);
      const htmxResults = result.filter(r => r.context === 'htmx');
      expect(htmxResults).toHaveLength(3);
      expect(htmxResults.map(r => r.method)).toEqual(['GET', 'POST', 'DELETE']);
    });
  });

  // ─── Srcset ───────────────────────────────────────────────────────

  describe('srcset parsing', () => {
    it('extracts multiple URLs from srcset', () => {
      const html = '<img srcset="/small.jpg 480w, /medium.jpg 800w, /large.jpg 1200w">';
      const result = extractUrlsFromHtml(html, BASE);
      const srcsetUrls = result.filter(r => r.attribute === 'srcset');
      expect(srcsetUrls).toHaveLength(3);
      expect(urls(srcsetUrls)).toContain('https://example.com/small.jpg');
      expect(urls(srcsetUrls)).toContain('https://example.com/medium.jpg');
      expect(urls(srcsetUrls)).toContain('https://example.com/large.jpg');
      expect(srcsetUrls[0]?.context).toBe('asset');
    });

    it('handles srcset with x descriptors', () => {
      const html = '<img srcset="/logo.png 1x, /logo@2x.png 2x">';
      const result = extractUrlsFromHtml(html, BASE);
      const srcsetUrls = result.filter(r => r.attribute === 'srcset');
      expect(srcsetUrls).toHaveLength(2);
    });

    it('handles srcset with no descriptor', () => {
      const html = '<img srcset="/only.jpg">';
      const result = extractUrlsFromHtml(html, BASE);
      const srcsetUrls = result.filter(r => r.attribute === 'srcset');
      expect(srcsetUrls).toHaveLength(1);
      expect(srcsetUrls[0]?.url).toBe('https://example.com/only.jpg');
    });
  });

  // ─── Meta Refresh ─────────────────────────────────────────────────

  describe('meta refresh', () => {
    it('extracts URL from meta refresh with http-equiv first', () => {
      const html = '<meta http-equiv="refresh" content="5;url=/redirected">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/redirected');
      expect(result.find(r => r.attribute === 'meta-refresh')?.context).toBe('link');
    });

    it('extracts URL from meta refresh with content first', () => {
      const html = '<meta content="0;url=/other" http-equiv="refresh">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/other');
    });

    it('handles meta refresh with space after semicolon', () => {
      const html = '<meta http-equiv="refresh" content="3; url=/delayed">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/delayed');
    });

    it('handles meta refresh with URL= (uppercase)', () => {
      const html = '<meta http-equiv="refresh" content="0;URL=/upper">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/upper');
    });
  });

  // ─── SVG xlink:href ───────────────────────────────────────────────

  describe('SVG xlink:href', () => {
    it('extracts xlink:href from SVG elements', () => {
      const html = '<svg><use xlink:href="/icons.svg#arrow"></use></svg>';
      const result = extractUrlsFromHtml(html, BASE);
      // The fragment #arrow is preserved in the resolved URL
      const xlinkResults = result.filter(r => r.attribute === 'xlink:href');
      expect(xlinkResults.length).toBeGreaterThanOrEqual(1);
      expect(xlinkResults[0]?.context).toBe('link');
    });

    it('extracts xlink:href with path only', () => {
      const html = '<svg><image xlink:href="/sprite.svg"></image></svg>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/sprite.svg');
    });
  });

  // ─── Manifest ─────────────────────────────────────────────────────

  describe('manifest', () => {
    it('extracts manifest link with rel first', () => {
      const html = '<link rel="manifest" href="/manifest.json">';
      const result = extractUrlsFromHtml(html, BASE);
      const manifest = result.filter(r => r.attribute === 'manifest');
      expect(manifest).toHaveLength(1);
      expect(manifest[0]?.url).toBe('https://example.com/manifest.json');
      expect(manifest[0]?.context).toBe('asset');
    });

    it('extracts manifest link with href first', () => {
      const html = '<link href="/app.webmanifest" rel="manifest">';
      const result = extractUrlsFromHtml(html, BASE);
      const manifest = result.filter(r => r.attribute === 'manifest');
      expect(manifest).toHaveLength(1);
      expect(manifest[0]?.url).toBe('https://example.com/app.webmanifest');
    });
  });

  // ─── URL Resolution ───────────────────────────────────────────────

  describe('URL resolution', () => {
    it('resolves relative URLs against pageUrl', () => {
      const html = '<a href="subpage">link</a>';
      const result = extractUrlsFromHtml(html, 'https://example.com/docs/');
      expect(urls(result)).toContain('https://example.com/docs/subpage');
    });

    it('resolves parent-relative URLs', () => {
      const html = '<a href="../other">link</a>';
      const result = extractUrlsFromHtml(html, 'https://example.com/docs/page');
      expect(urls(result)).toContain('https://example.com/other');
    });

    it('resolves absolute-path URLs', () => {
      const html = '<a href="/root-page">link</a>';
      const result = extractUrlsFromHtml(html, 'https://example.com/deep/nested/page');
      expect(urls(result)).toContain('https://example.com/root-page');
    });

    it('preserves fully qualified same-origin URLs', () => {
      const html = '<a href="https://example.com/full">link</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/full');
    });
  });

  // ─── Same-Origin Filtering ────────────────────────────────────────

  describe('same-origin filtering', () => {
    it('excludes cross-origin URLs', () => {
      const html = `
        <a href="https://other.com/page">external</a>
        <a href="/local">local</a>
        <img src="https://cdn.other.com/image.png">
      `;
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/local');
      expect(urls(result)).not.toContain('https://other.com/page');
      expect(urls(result)).not.toContain('https://cdn.other.com/image.png');
    });

    it('excludes URLs with different port', () => {
      const html = '<a href="https://example.com:8443/page">link</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).not.toContain('https://example.com:8443/page');
    });

    it('excludes URLs with different protocol', () => {
      const html = '<a href="http://example.com/insecure">link</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).not.toContain('http://example.com/insecure');
    });
  });

  // ─── Filtering ────────────────────────────────────────────────────

  describe('filtering', () => {
    it('skips javascript: URLs', () => {
      const html = '<a href="javascript:void(0)">click</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(0);
    });

    it('skips mailto: URLs', () => {
      const html = '<a href="mailto:test@example.com">email</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(0);
    });

    it('skips data: URLs', () => {
      const html = '<img src="data:image/png;base64,abc">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(0);
    });

    it('skips tel: URLs', () => {
      const html = '<a href="tel:+1234567890">call</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(0);
    });

    it('skips fragment-only URLs', () => {
      const html = '<a href="#section">jump</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(0);
    });

    it('skips empty href', () => {
      const html = '<a href="">empty</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(0);
    });
  });

  // ─── 10k Cap ──────────────────────────────────────────────────────

  describe('URL cap', () => {
    it('caps results at 10,000 URLs', () => {
      // Generate 11,000 unique links
      const links = Array.from({ length: 11_000 }, (_, i) => `<a href="/page-${i}">link</a>`);
      const html = links.join('');
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(10_000);
    });
  });

  // ─── Quote Handling ───────────────────────────────────────────────

  describe('quote handling', () => {
    it('handles single-quoted attributes', () => {
      const html = "<a href='/single-quoted'>link</a>";
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/single-quoted');
    });

    it('handles double-quoted attributes', () => {
      const html = '<a href="/double-quoted">link</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(urls(result)).toContain('https://example.com/double-quoted');
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty array for invalid pageUrl', () => {
      const html = '<a href="/page">link</a>';
      const result = extractUrlsFromHtml(html, 'not-a-url');
      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty HTML', () => {
      const result = extractUrlsFromHtml('', BASE);
      expect(result).toHaveLength(0);
    });

    it('deduplicates same URL from same attribute', () => {
      const html = '<a href="/dup">1</a><a href="/dup">2</a>';
      const result = extractUrlsFromHtml(html, BASE);
      const hrefResults = result.filter(r => r.attribute === 'href');
      expect(hrefResults).toHaveLength(1);
    });

    it('allows same URL from different attributes', () => {
      const html = '<a href="/shared">link</a><img src="/shared">';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.attribute)).toContain('href');
      expect(result.map(r => r.attribute)).toContain('src');
    });

    it('handles mixed attribute types in complex HTML', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta http-equiv="refresh" content="5;url=/new-home">
          <link rel="manifest" href="/manifest.json">
        </head>
        <body>
          <a href="/about">About</a>
          <img src="/hero.jpg" srcset="/hero-small.jpg 480w, /hero-large.jpg 1200w">
          <form action="/api/login" hx-post="/api/auth">
            <button formaction="/api/register">Register</button>
          </form>
          <div data-endpoint="/api/v2/users" data-src="/lazy.jpg">
            <svg><use xlink:href="/icons.svg#menu"></use></svg>
          </div>
        </body>
        </html>
      `;
      const result = extractUrlsFromHtml(html, BASE);

      // Check various attribute types are represented
      const attributes = new Set(result.map(r => r.attribute));
      expect(attributes).toContain('href');
      expect(attributes).toContain('src');
      expect(attributes).toContain('action');
      expect(attributes).toContain('formaction');
      expect(attributes).toContain('srcset');
      expect(attributes).toContain('hx-post');
      expect(attributes).toContain('data-endpoint');
      expect(attributes).toContain('data-src');
      expect(attributes).toContain('meta-refresh');
      expect(attributes).toContain('manifest');
      expect(attributes).toContain('xlink:href');
    });

    it('does not set method on non-htmx URLs', () => {
      const html = '<a href="/page">link</a>';
      const result = extractUrlsFromHtml(html, BASE);
      expect(result[0]?.method).toBeUndefined();
    });
  });
});
