import { getLogger } from '../core/logger.js';
import type { PlatformResult } from './types.js';

const log = getLogger();

// ─── Platform Templates ──────────────────────────────────────────────

interface PlatformTemplate {
  name: string;
  signals: PlatformSignal[];
  knownEndpoints: string[];
}

interface PlatformSignal {
  type: 'meta' | 'script' | 'header' | 'cookie' | 'html' | 'url';
  pattern: RegExp;
  weight: number; // 0.0-1.0 contribution to confidence
}

const PLATFORM_TEMPLATES: PlatformTemplate[] = [
  {
    name: 'shopify',
    signals: [
      { type: 'meta', pattern: /name=["']shopify/i, weight: 0.9 },
      { type: 'script', pattern: /cdn\.shopify\.com/i, weight: 0.8 },
      { type: 'header', pattern: /x-shopid/i, weight: 0.9 },
      { type: 'cookie', pattern: /_shopify_s/i, weight: 0.7 },
      { type: 'html', pattern: /Shopify\.theme/i, weight: 0.8 },
    ],
    knownEndpoints: [
      '/admin/api/2024-01/products.json',
      '/admin/api/2024-01/orders.json',
      '/admin/api/2024-01/customers.json',
      '/cart.json',
      '/products.json',
      '/collections.json',
    ],
  },
  {
    name: 'wordpress',
    signals: [
      { type: 'meta', pattern: /name=["']generator["'][^>]*WordPress/i, weight: 0.9 },
      { type: 'html', pattern: /wp-content\//i, weight: 0.7 },
      { type: 'html', pattern: /wp-includes\//i, weight: 0.7 },
      { type: 'url', pattern: /\/wp-json\//i, weight: 0.9 },
      { type: 'header', pattern: /x-powered-by:\s*WordPress/i, weight: 0.8 },
    ],
    knownEndpoints: [
      '/wp-json/wp/v2/posts',
      '/wp-json/wp/v2/pages',
      '/wp-json/wp/v2/categories',
      '/wp-json/wp/v2/users',
      '/wp-json/wp/v2/media',
      '/wp-json/wp/v2/comments',
    ],
  },
  {
    name: 'stripe',
    signals: [
      { type: 'script', pattern: /js\.stripe\.com/i, weight: 0.9 },
      { type: 'html', pattern: /Stripe\(/i, weight: 0.6 },
      { type: 'meta', pattern: /stripe-publishable-key/i, weight: 0.8 },
    ],
    knownEndpoints: [
      '/v1/charges',
      '/v1/customers',
      '/v1/payment_intents',
      '/v1/subscriptions',
      '/v1/invoices',
    ],
  },
  {
    name: 'firebase',
    signals: [
      { type: 'script', pattern: /firebase[-.]?(?:app)?\.js/i, weight: 0.8 },
      { type: 'script', pattern: /firebaseio\.com/i, weight: 0.9 },
      { type: 'html', pattern: /firebaseConfig/i, weight: 0.7 },
      { type: 'script', pattern: /googleapis\.com\/firebase/i, weight: 0.8 },
    ],
    knownEndpoints: [
      '/identitytoolkit/v3/relyingparty/signupNewUser',
      '/identitytoolkit/v3/relyingparty/verifyPassword',
      '/identitytoolkit/v3/relyingparty/getAccountInfo',
    ],
  },
  {
    name: 'supabase',
    signals: [
      { type: 'script', pattern: /supabase/i, weight: 0.7 },
      { type: 'url', pattern: /\.supabase\.co/i, weight: 0.9 },
      { type: 'header', pattern: /x-supabase/i, weight: 0.9 },
    ],
    knownEndpoints: [
      '/rest/v1/',
      '/auth/v1/signup',
      '/auth/v1/token',
      '/storage/v1/object',
      '/realtime/v1/',
    ],
  },
  {
    name: 'nextjs',
    signals: [
      { type: 'html', pattern: /__NEXT_DATA__/i, weight: 0.9 },
      { type: 'html', pattern: /_next\/static/i, weight: 0.8 },
      { type: 'header', pattern: /x-powered-by:\s*Next\.js/i, weight: 0.9 },
      { type: 'script', pattern: /_next\/static\/chunks/i, weight: 0.7 },
    ],
    knownEndpoints: [
      '/api/',
      '/_next/data/',
    ],
  },
  {
    name: 'vercel',
    signals: [
      { type: 'header', pattern: /x-vercel-id/i, weight: 0.9 },
      { type: 'header', pattern: /server:\s*Vercel/i, weight: 0.9 },
      { type: 'header', pattern: /x-vercel-cache/i, weight: 0.8 },
    ],
    knownEndpoints: [
      '/api/',
    ],
  },
];

// ─── Public API ──────────────────────────────────────────────────────

export function detectPlatform(
  url: string,
  html: string,
  headers: Record<string, string>,
): PlatformResult {
  let bestMatch: { platform: string; confidence: number; knownEndpoints: string[] } | null = null;

  const headerStr = formatHeaders(headers);

  for (const template of PLATFORM_TEMPLATES) {
    let totalWeight = 0;
    let matchedWeight = 0;

    for (const signal of template.signals) {
      totalWeight += signal.weight;

      const text = getSignalText(signal.type, url, html, headerStr);
      if (signal.pattern.test(text)) {
        matchedWeight += signal.weight;
      }
    }

    if (matchedWeight === 0) continue;

    const confidence = matchedWeight / totalWeight;

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        platform: template.name,
        confidence: Math.round(confidence * 100) / 100,
        knownEndpoints: template.knownEndpoints,
      };
    }
  }

  if (bestMatch) {
    log.debug(
      { platform: bestMatch.platform, confidence: bestMatch.confidence },
      'Platform detected',
    );
    return bestMatch;
  }

  return { platform: null, confidence: 0, knownEndpoints: [] };
}

/**
 * Convert platform detection results to DiscoveredEndpoints.
 */
export function platformToEndpoints(result: PlatformResult): import('./types.js').DiscoveredEndpoint[] {
  if (!result.platform) return [];

  return result.knownEndpoints.map(ep => ({
    method: 'GET',
    path: ep,
    description: `${result.platform} known endpoint`,
    source: 'platform' as const,
    trustLevel: 3,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getSignalText(
  type: PlatformSignal['type'],
  url: string,
  html: string,
  headerStr: string,
): string {
  switch (type) {
    case 'meta':
    case 'script':
    case 'html':
      return html;
    case 'header':
    case 'cookie':
      return headerStr;
    case 'url':
      return url;
    default:
      return '';
  }
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
