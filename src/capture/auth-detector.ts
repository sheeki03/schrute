import type { AuthRecipe, AuthType, RefreshTrigger, RefreshMethod } from '../skill/types.js';
import type { StructuredRecord } from './har-extractor.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Public API ──────────────────────────────────────────────────────

export function detectAuth(requests: StructuredRecord[]): AuthRecipe | null {
  if (requests.length === 0) return null;

  // Try detectors in priority order
  const detectors: Array<() => AuthRecipe | null> = [
    () => detectOAuth2(requests),
    () => detectBearer(requests),
    () => detectApiKey(requests),
    () => detectCookieAuth(requests),
  ];

  for (const detect of detectors) {
    const recipe = detect();
    if (recipe) {
      log.info({ type: recipe.type }, 'Detected auth pattern');
      return recipe;
    }
  }

  return null;
}

// ─── Bearer Token Detection ──────────────────────────────────────────

function detectBearer(requests: StructuredRecord[]): AuthRecipe | null {
  const withBearer = requests.filter(r => {
    const auth = r.request.headers['authorization'];
    return auth && auth.toLowerCase().startsWith('bearer ');
  });

  if (withBearer.length === 0) return null;

  // Extract the token to check for JWT
  const firstToken = withBearer[0].request.headers['authorization'].slice(7);
  const ttl = extractJwtTtl(firstToken);

  const refreshTriggers = detectRefreshTriggers(requests);

  return {
    type: 'bearer',
    injection: {
      location: 'header',
      key: 'Authorization',
      prefix: 'Bearer ',
    },
    refreshTriggers,
    refreshMethod: 'browser_relogin',
    tokenTtlSeconds: ttl ?? undefined,
  };
}

// ─── API Key Detection ───────────────────────────────────────────────

const API_KEY_HEADERS = [
  'x-api-key', 'x-apikey', 'api-key', 'apikey',
  'x-auth-token', 'x-access-token',
];

const API_KEY_QUERY_PARAMS = [
  'api_key', 'apikey', 'api-key',
  'access_token', 'key', 'token',
];

function detectApiKey(requests: StructuredRecord[]): AuthRecipe | null {
  // Check headers
  for (const headerName of API_KEY_HEADERS) {
    const withHeader = requests.filter(r => r.request.headers[headerName]);
    if (withHeader.length > requests.length * 0.5) {
      return {
        type: 'api_key',
        injection: {
          location: 'header',
          key: headerName,
        },
        refreshTriggers: detectRefreshTriggers(requests),
        refreshMethod: 'manual_user_login',
      };
    }
  }

  // Check query params
  for (const paramName of API_KEY_QUERY_PARAMS) {
    const withParam = requests.filter(r => r.request.queryParams[paramName]);
    if (withParam.length > requests.length * 0.5) {
      return {
        type: 'api_key',
        injection: {
          location: 'query',
          key: paramName,
        },
        refreshTriggers: detectRefreshTriggers(requests),
        refreshMethod: 'manual_user_login',
      };
    }
  }

  return null;
}

// ─── Cookie Auth Detection ───────────────────────────────────────────

const SESSION_COOKIE_PATTERNS = [
  /^sess/i, /session/i, /^sid$/i, /^connect\.sid$/i,
  /^_session/i, /^auth/i, /^token/i, /^jwt/i,
  /^PHPSESSID$/i, /^JSESSIONID$/i, /^ASP\.NET_SessionId$/i,
];

function detectCookieAuth(requests: StructuredRecord[]): AuthRecipe | null {
  const withCookies = requests.filter(r => r.request.headers['cookie']);
  if (withCookies.length < requests.length * 0.3) return null;

  // Parse cookies and look for session cookies
  for (const req of withCookies) {
    const cookieHeader = req.request.headers['cookie'];
    const cookies = parseCookieHeader(cookieHeader);

    for (const [name] of cookies) {
      if (SESSION_COOKIE_PATTERNS.some(p => p.test(name))) {
        return {
          type: 'cookie',
          injection: {
            location: 'cookie',
            key: name,
          },
          refreshTriggers: detectRefreshTriggers(requests),
          refreshMethod: 'browser_relogin',
        };
      }
    }
  }

  // Fallback: if most requests have cookies, treat as cookie auth even without
  // recognizable session cookie names
  if (withCookies.length > requests.length * 0.8) {
    return {
      type: 'cookie',
      injection: {
        location: 'cookie',
        key: '_session',
      },
      refreshTriggers: detectRefreshTriggers(requests),
      refreshMethod: 'browser_relogin',
    };
  }

  return null;
}

// ─── OAuth2 Detection ────────────────────────────────────────────────

function detectOAuth2(requests: StructuredRecord[]): AuthRecipe | null {
  // Look for OAuth2 token exchange requests
  const tokenRequests = requests.filter(r => {
    const url = r.request.url.toLowerCase();
    const body = r.request.body?.toLowerCase() ?? '';

    return (
      (url.includes('/oauth') || url.includes('/token')) &&
      (body.includes('grant_type=') ||
       body.includes('client_id=') ||
       body.includes('refresh_token='))
    );
  });

  if (tokenRequests.length === 0) return null;

  // Extract refresh flow details from token request
  const tokenReq = tokenRequests[0];
  let refreshUrl: string;
  try {
    refreshUrl = new URL(tokenReq.request.url).toString();
  } catch {
    return null;
  }

  // Check if bearer tokens are also present (typical OAuth2 pattern)
  const hasBearer = requests.some(r =>
    r.request.headers['authorization']?.toLowerCase().startsWith('bearer '),
  );

  if (!hasBearer) return null;

  const firstBearerReq = requests.find(r =>
    r.request.headers['authorization']?.toLowerCase().startsWith('bearer '),
  );
  const token = firstBearerReq?.request.headers['authorization']?.slice(7);
  const ttl = token ? extractJwtTtl(token) : undefined;

  return {
    type: 'oauth2',
    injection: {
      location: 'header',
      key: 'Authorization',
      prefix: 'Bearer ',
    },
    refreshTriggers: ['401', 'token_expired_field'],
    refreshMethod: 'oauth_refresh',
    refreshFlow: {
      url: refreshUrl,
      method: tokenReq.request.method,
      bodyTemplate: extractBodyTemplate(tokenReq.request.body),
    },
    tokenTtlSeconds: ttl ?? undefined,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function detectRefreshTriggers(requests: StructuredRecord[]): RefreshTrigger[] {
  const triggers: RefreshTrigger[] = [];

  const has401 = requests.some(r => r.response.status === 401);
  const has403 = requests.some(r => r.response.status === 403);
  const hasRedirectToLogin = requests.some(r => {
    if (r.response.status >= 300 && r.response.status < 400) {
      const location = r.response.headers['location'] ?? '';
      return /login|signin|auth/i.test(location);
    }
    return false;
  });

  if (has401) triggers.push('401');
  if (has403) triggers.push('403');
  if (hasRedirectToLogin) triggers.push('redirect_to_login');

  // Default trigger if none detected
  if (triggers.length === 0) {
    triggers.push('401');
  }

  return triggers;
}

function extractJwtTtl(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    let decoded: string;
    try {
      decoded = Buffer.from(parts[1], 'base64url').toString('utf-8');
    } catch {
      // Base64 decode error — not a valid JWT payload
      return null;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decoded);
    } catch {
      // JSON parse error — malformed JWT payload
      return null;
    }

    if (typeof payload.exp === 'number' && typeof payload.iat === 'number') {
      return payload.exp - payload.iat;
    }

    if (typeof payload.exp === 'number') {
      // Estimate TTL from exp - now
      const now = Math.floor(Date.now() / 1000);
      const ttl = payload.exp - now;
      return ttl > 0 ? ttl : null;
    }

    return null;
  } catch (err) {
    log.debug({ err }, 'Unexpected error in JWT TTL extraction');
    return null;
  }
}

function parseCookieHeader(header: string): Array<[string, string]> {
  return header.split(';').map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return [pair.trim(), ''] as [string, string];
    return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as [string, string];
  });
}

function extractBodyTemplate(body?: string): Record<string, string> {
  if (!body) return {};

  // Try JSON body
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const template: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        template[key] = typeof value === 'string' ? value : String(value);
      }
      return template;
    }
  } catch {
    // Try form-encoded body
    const params = new URLSearchParams(body);
    const template: Record<string, string> = {};
    for (const [key, value] of params) {
      template[key] = value;
    }
    return template;
  }

  return {};
}
