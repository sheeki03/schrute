import { describe, it, expect, vi } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { extractDocument } from '../../src/capture/document-extractor.js';

describe('extractDocument — HTML', () => {
  it('converts headings to markdown', async () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).toContain('# Title');
    expect(result.markdown).toContain('## Subtitle');
    expect(result.markdown).toContain('### Section');
    expect(result.metadata.format).toBe('html');
  });

  it('converts links to markdown format', async () => {
    const html = '<a href="https://example.com">Click here</a>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).toContain('[Click here](https://example.com)');
  });

  it('removes script tags', async () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).not.toContain('alert');
    expect(result.markdown).not.toContain('script');
    expect(result.markdown).toContain('Hello');
    expect(result.markdown).toContain('World');
  });

  it('removes style tags', async () => {
    const html = '<style>.red { color: red; }</style><p>Content</p>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).not.toContain('color');
    expect(result.markdown).toContain('Content');
  });

  it('extracts title from <title> tag', async () => {
    const html = '<html><head><title>My Page Title</title></head><body><p>Text</p></body></html>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.metadata.title).toBe('My Page Title');
  });

  it('returns undefined title when no <title> tag', async () => {
    const html = '<html><body><p>No title here</p></body></html>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.metadata.title).toBeUndefined();
  });

  it('handles empty input', async () => {
    const result = await extractDocument({ type: 'html', content: '' });

    expect(result.markdown).toBe('');
    expect(result.metadata.format).toBe('html');
    expect(result.metadata.title).toBeUndefined();
  });

  it('decodes HTML entities', async () => {
    const html = '<p>&amp; &lt; &gt; &quot; &#39;</p>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).toContain('& < > " \'');
  });

  it('converts list items', async () => {
    const html = '<ul><li>One</li><li>Two</li></ul>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).toContain('- One');
    expect(result.markdown).toContain('- Two');
  });

  it('converts inline code', async () => {
    const html = '<p>Use <code>npm install</code> to install</p>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).toContain('`npm install`');
  });

  it('preserves code block content', async () => {
    // The extractor strips tags and preserves text content from code blocks
    const html = '<pre><code>const x = 1;</code></pre>';
    const result = await extractDocument({ type: 'html', content: html });

    // Content should be preserved regardless of formatting approach
    expect(result.markdown).toContain('const x = 1;');
  });

  it('strips remaining HTML tags', async () => {
    const html = '<div class="container"><span>text</span></div>';
    const result = await extractDocument({ type: 'html', content: html });

    expect(result.markdown).not.toContain('<div');
    expect(result.markdown).not.toContain('<span');
    expect(result.markdown).toContain('text');
  });

  it('collapses excessive whitespace', async () => {
    const html = '<p>Line 1</p>\n\n\n\n\n<p>Line 2</p>';
    const result = await extractDocument({ type: 'html', content: html });

    // Should not have more than 2 consecutive newlines
    expect(result.markdown).not.toMatch(/\n{3,}/);
  });
});
