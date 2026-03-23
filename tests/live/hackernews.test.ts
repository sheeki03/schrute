/**
 * Live integration tests against Hacker News (HTML-only site).
 *
 * Verifies that:
 * 1. HTML responses are fetchable and parseable
 * 2. CSS transforms extract structured data from HN HTML
 * 3. List extraction works on real HTML tables
 * 4. The noise filter classifies HN HTML as html_document (not noise)
 *
 * Run manually: npx vitest run tests/live/hackernews.test.ts --timeout 30000
 */

import { describe, it, expect } from 'vitest';
import { applyTransform } from '../../src/replay/transform.js';
import { filterRequests, type HarEntry } from '../../src/capture/noise-filter.js';

describe('news.ycombinator.com live integration', () => {
  it('fetches HN front page as HTML', async () => {
    const response = await fetch('https://news.ycombinator.com/', {
      headers: { accept: 'text/html' },
    });

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('<html');
    expect(html).toContain('Hacker News');
    expect(html.length).toBeGreaterThan(1000);
  });

  it('CSS text transform extracts page title from HN HTML', async () => {
    const response = await fetch('https://news.ycombinator.com/');
    const html = await response.text();

    const result = await applyTransform(html, {
      type: 'css',
      selector: 'title',
      mode: 'text',
      label: 'page_title',
    });

    expect(result.transformApplied).toBe(true);
    expect(result.label).toBe('page_title');
    expect(typeof result.data).toBe('string');
    expect(result.data).toContain('Hacker News');
  });

  it('CSS list transform extracts story titles from HN', async () => {
    const response = await fetch('https://news.ycombinator.com/');
    const html = await response.text();

    const result = await applyTransform(html, {
      type: 'css',
      selector: 'tr.athing',
      mode: 'list',
      fields: {
        title: { selector: '.titleline > a', mode: 'text' },
        link: { selector: '.titleline > a', mode: 'attr', attr: 'href' },
      },
      label: 'hn_stories',
    });

    expect(result.transformApplied).toBe(true);
    expect(result.label).toBe('hn_stories');
    expect(Array.isArray(result.data)).toBe(true);

    const stories = result.data as Array<{ title: string; link: string }>;
    expect(stories.length).toBeGreaterThan(10);
    expect(stories.length).toBeLessThanOrEqual(30);

    // Each story should have a non-empty title and link
    for (const story of stories.slice(0, 5)) {
      expect(story.title).toBeTruthy();
      expect(typeof story.title).toBe('string');
      expect(story.title.length).toBeGreaterThan(0);
      // Links can be relative (/item?id=...) or absolute
      expect(story.link).toBeTruthy();
    }
  });

  it('CSS attr transform extracts story links from HN', async () => {
    const response = await fetch('https://news.ycombinator.com/');
    const html = await response.text();

    const result = await applyTransform(html, {
      type: 'css',
      selector: '.titleline > a',
      mode: 'attr',
      attr: 'href',
      label: 'first_story_link',
    });

    expect(result.transformApplied).toBe(true);
    expect(typeof result.data).toBe('string');
    expect((result.data as string).length).toBeGreaterThan(0);
  });

  it('noise filter classifies HN GET 200 HTML as html_document', () => {
    // Build a synthetic HAR entry matching HN's response pattern
    const hnEntry: HarEntry = {
      request: {
        method: 'GET',
        url: 'https://news.ycombinator.com/',
        headers: [{ name: 'accept', value: 'text/html' }],
      },
      response: {
        status: 200,
        headers: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
        content: { size: 50000, mimeType: 'text/html' },
      },
      _resourceType: 'document',
    } as unknown as HarEntry;

    const result = filterRequests([hnEntry], [], 'news.ycombinator.com');

    expect(result.htmlDocument.length).toBe(1);
    expect(result.signal.length).toBe(0);
    expect(result.noise.length).toBe(0);
  });

  it('noise filter classifies HN POST as ambiguous (not html_document)', () => {
    const hnPostEntry: HarEntry = {
      request: {
        method: 'POST',
        url: 'https://news.ycombinator.com/vote',
        headers: [{ name: 'content-type', value: 'application/x-www-form-urlencoded' }],
      },
      response: {
        status: 200,
        headers: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
        content: { size: 1000, mimeType: 'text/html' },
      },
      _resourceType: 'document',
    } as unknown as HarEntry;

    const result = filterRequests([hnPostEntry], [], 'news.ycombinator.com');

    // POST HTML should NOT be classified as html_document
    expect(result.htmlDocument.length).toBe(0);
  });

  it('regex transform extracts score numbers from HN HTML', async () => {
    const response = await fetch('https://news.ycombinator.com/');
    const html = await response.text();

    const result = await applyTransform(html, {
      type: 'regex',
      expression: '(\\d+)\\s+points',
      flags: 'g',
      label: 'story_scores',
    });

    expect(result.transformApplied).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);

    const scores = result.data as string[];
    expect(scores.length).toBeGreaterThan(5);
  });
});
