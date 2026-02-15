import { describe, it, expect } from 'vitest';
import { detectPlatform, platformToEndpoints } from '../../src/discovery/platform-detector.js';

// ─── Tests ───────────────────────────────────────────────────────────

describe('platform-detector', () => {
  describe('detectPlatform', () => {
    it('detects Shopify from HTML meta tags', () => {
      const html = '<html><head><meta name="shopify-checkout-api-token" content="abc"></head></html>';
      const result = detectPlatform('https://mystore.com', html, {});

      expect(result.platform).toBe('shopify');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.knownEndpoints.length).toBeGreaterThan(0);
    });

    it('detects Shopify from CDN scripts', () => {
      const html = '<html><script src="https://cdn.shopify.com/s/files/1/shopify.js"></script></html>';
      const result = detectPlatform('https://mystore.com', html, {});

      expect(result.platform).toBe('shopify');
    });

    it('detects Shopify from response headers', () => {
      const result = detectPlatform('https://mystore.com', '', { 'x-shopid': '12345' });

      expect(result.platform).toBe('shopify');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('detects WordPress from generator meta tag', () => {
      const html = '<html><head><meta name="generator" content="WordPress 6.4"></head></html>';
      const result = detectPlatform('https://myblog.com', html, {});

      expect(result.platform).toBe('wordpress');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('detects WordPress from wp-content paths', () => {
      const html = '<html><link rel="stylesheet" href="/wp-content/themes/theme/style.css"></html>';
      const result = detectPlatform('https://myblog.com', html, {});

      expect(result.platform).toBe('wordpress');
    });

    it('detects Stripe from JS script', () => {
      const html = '<html><script src="https://js.stripe.com/v3/"></script></html>';
      const result = detectPlatform('https://checkout.example.com', html, {});

      expect(result.platform).toBe('stripe');
    });

    it('detects Firebase from script includes', () => {
      const html = '<html><script src="https://www.gstatic.com/firebasejs/9.0.0/firebase-app.js"></script></html>';
      const result = detectPlatform('https://myapp.com', html, {});

      expect(result.platform).toBe('firebase');
    });

    it('detects Supabase from URL pattern', () => {
      const result = detectPlatform('https://myproject.supabase.co', '', {});

      expect(result.platform).toBe('supabase');
    });

    it('detects Next.js from __NEXT_DATA__', () => {
      const html = '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>';
      const result = detectPlatform('https://myapp.com', html, {});

      expect(result.platform).toBe('nextjs');
    });

    it('detects Next.js from x-powered-by header', () => {
      const result = detectPlatform('https://myapp.com', '', { 'x-powered-by': 'Next.js' });

      expect(result.platform).toBe('nextjs');
    });

    it('detects Vercel from response headers', () => {
      const result = detectPlatform('https://myapp.com', '', { 'x-vercel-id': 'iad1::abc' });

      expect(result.platform).toBe('vercel');
    });

    it('returns null platform when no match found', () => {
      const html = '<html><body>Just a plain page</body></html>';
      const result = detectPlatform('https://plain.example.com', html, {});

      expect(result.platform).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.knownEndpoints).toEqual([]);
    });

    it('returns highest confidence when multiple platforms partially match', () => {
      // HTML has both Vercel headers and Next.js markers
      const html = '<html><script id="__NEXT_DATA__">{}</script><link href="/_next/static/css/main.css"></html>';
      const result = detectPlatform('https://myapp.com', html, { 'x-vercel-id': 'iad1::abc' });

      // Should pick the one with higher confidence
      expect(result.platform).not.toBeNull();
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('handles empty HTML and headers', () => {
      const result = detectPlatform('https://example.com', '', {});
      expect(result.platform).toBeNull();
    });
  });

  describe('platformToEndpoints', () => {
    it('converts platform result to DiscoveredEndpoints', () => {
      const result = detectPlatform('https://mystore.com', '', { 'x-shopid': '12345' });
      const endpoints = platformToEndpoints(result);

      expect(endpoints.length).toBeGreaterThan(0);
      for (const ep of endpoints) {
        expect(ep.source).toBe('platform');
        expect(ep.trustLevel).toBe(3);
        expect(ep.method).toBe('GET');
      }
    });

    it('returns empty array when no platform detected', () => {
      const result = detectPlatform('https://example.com', '', {});
      const endpoints = platformToEndpoints(result);

      expect(endpoints).toEqual([]);
    });
  });
});
