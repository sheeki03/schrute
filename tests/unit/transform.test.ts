import { describe, expect, it } from 'vitest';
import { applyTransform } from '../../src/replay/transform.js';

describe('applyTransform', () => {
  it('returns input unchanged when no transform is configured', async () => {
    const result = await applyTransform({ ok: true });
    expect(result).toEqual({
      data: { ok: true },
      transformApplied: false,
    });
  });

  it('applies a jsonpath transform and unwraps a single match', async () => {
    const result = await applyTransform(
      { stats: [{ price: 10 }, { price: 20 }] },
      { type: 'jsonpath', expression: '$.stats[1].price', label: 'current_price' },
    );

    expect(result.data).toBe(20);
    expect(result.rawData).toBeUndefined();
    expect(result.transformApplied).toBe(true);
    expect(result.label).toBe('current_price');
  });

  it('returns an array for multi-match jsonpath expressions', async () => {
    const result = await applyTransform(
      { stats: [{ price: 10 }, { price: 20 }] },
      { type: 'jsonpath', expression: '$.stats[*].price' },
    );

    expect(result.data).toEqual([10, 20]);
  });

  it('applies regex transforms with capture groups', async () => {
    const result = await applyTransform(
      'price=123.45 currency=USD',
      { type: 'regex', expression: 'price=(\\d+\\.\\d+) currency=(\\w+)' },
    );

    expect(result.data).toEqual(['123.45', 'USD']);
  });

  it('applies regex transforms with global flags', async () => {
    const result = await applyTransform(
      'BTC ETH SOL',
      { type: 'regex', expression: '([A-Z]{3})', flags: 'g' },
    );

    expect(result.data).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('applies regex transforms with named capture groups', async () => {
    const result = await applyTransform(
      'price=123.45 currency=USD',
      { type: 'regex', expression: 'price=(?<price>\\d+\\.\\d+) currency=(?<currency>\\w+)' },
    );

    expect(result.data).toEqual({ price: '123.45', currency: 'USD' });
  });

  it('rejects invalid regex flags before execution', async () => {
    await expect(applyTransform(
      'price=123.45 currency=USD',
      { type: 'regex', expression: 'price=(\\d+\\.\\d+)', flags: 'z' },
    )).rejects.toThrow("Invalid regex flag 'z'");
  });

  it('rejects oversized regex inputs', async () => {
    await expect(applyTransform(
      'a'.repeat(100_001),
      { type: 'regex', expression: 'a+' },
    )).rejects.toThrow('Regex transform input exceeds 100000 characters');
  });

  it('extracts text with a css transform', async () => {
    const result = await applyTransform(
      '<main><h1>Top Story</h1></main>',
      { type: 'css', selector: 'h1', mode: 'text' },
    );

    expect(result.data).toBe('Top Story');
  });

  it('extracts html with a css transform', async () => {
    const result = await applyTransform(
      '<main><article><strong>Hot</strong></article></main>',
      { type: 'css', selector: 'article', mode: 'html' },
    );

    expect(result.data).toBe('<strong>Hot</strong>');
  });

  it('extracts attributes with a css transform', async () => {
    const result = await applyTransform(
      '<a href="/item/1">Item</a>',
      { type: 'css', selector: 'a', mode: 'attr', attr: 'href' },
    );

    expect(result.data).toBe('/item/1');
  });

  it('extracts structured lists with css fields', async () => {
    const html = `
      <ul>
        <li class="story"><a class="title" href="/a">Alpha</a><span class="score">10</span></li>
        <li class="story"><a class="title" href="/b">Beta</a><span class="score">20</span></li>
      </ul>
    `;

    const result = await applyTransform(html, {
      type: 'css',
      selector: '.story',
      mode: 'list',
      fields: {
        title: { selector: '.title', mode: 'text' },
        href: { selector: '.title', mode: 'attr', attr: 'href' },
        score: { selector: '.score', mode: 'text' },
      },
    });

    expect(result.data).toEqual([
      { title: 'Alpha', href: '/a', score: '10' },
      { title: 'Beta', href: '/b', score: '20' },
    ]);
  });
});
