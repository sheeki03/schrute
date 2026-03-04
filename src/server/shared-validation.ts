import { setSitePolicy, sanitizeImplicitAllowlist } from '../core/policy.js';
import { V01_DEFAULT_CAPABILITIES } from '../skill/types.js';
import type { OneAgentConfig, GeoEmulationConfig } from '../skill/types.js';

// ─── Domain Entry Parser ────────────────────────────────────────

/** Moved from tool-dispatch.ts — parses domain entries with IPv6 normalization */
export function parseDomainEntries(entries: string[]): string[] {
  const result: string[] = [];
  for (let entry of entries) {
    if (/[/?#@\s]/.test(entry)) {
      throw new Error(`Invalid domain entry '${entry}': must be a host, not a URL (no path, query, fragment, credentials, or whitespace).`);
    }
    if ((entry.match(/:/g) || []).length >= 2 && !entry.startsWith('[')) {
      entry = `[${entry}]`;
    }
    try {
      const url = new URL(`http://${entry}`);
      result.push(url.hostname);
    } catch {
      throw new Error(`Invalid domain entry '${entry}': could not parse as a host.`);
    }
  }
  return result;
}

// ─── CDP Site Policy Setup ──────────────────────────────────────

export function setupCdpSitePolicy(siteId: string, userDomains?: string[], config?: OneAgentConfig): void {
  const localDomains = ['127.0.0.1', 'localhost', '[::1]'];
  let allDomains = [...localDomains];
  if (userDomains && Array.isArray(userDomains)) {
    const sanitized = parseDomainEntries(userDomains);
    allDomains = [...localDomains, ...sanitizeImplicitAllowlist(sanitized)];
  }
  setSitePolicy({
    siteId,
    allowedMethods: ['GET', 'HEAD'],
    maxQps: 10, maxConcurrent: 3,
    readOnlyDefault: true, requireConfirmation: [],
    domainAllowlist: allDomains, redactionRules: [],
    capabilities: [...V01_DEFAULT_CAPABILITIES],
  }, config);
}

// ─── Proxy Validation ───────────────────────────────────────────

export interface ValidatedProxy {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export function validateProxyConfig(proxy: unknown): ValidatedProxy {
  const p = proxy as Record<string, unknown>;
  if (typeof p.server !== 'string' || !p.server) {
    throw new Error('proxy.server is required and must be a string');
  }
  try {
    const u = new URL(p.server);
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(u.protocol)) {
      throw new Error('proxy.server must use http://, https://, socks4://, or socks5://');
    }
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
      throw new Error('proxy.server must be host-only (no path, query, fragment, or credentials)');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('proxy.server')) throw err;
    throw new Error('proxy.server is not a valid URL');
  }
  if (p.bypass !== undefined && typeof p.bypass !== 'string') {
    throw new Error('proxy.bypass must be a string');
  }
  if (p.username !== undefined && typeof p.username !== 'string') {
    throw new Error('proxy.username must be a string');
  }
  if (p.password !== undefined && typeof p.password !== 'string') {
    throw new Error('proxy.password must be a string');
  }
  return {
    server: p.server as string,
    bypass: p.bypass as string | undefined,
    username: p.username as string | undefined,
    password: p.password as string | undefined,
  };
}

// ─── Geo Validation ─────────────────────────────────────────────

export function validateGeoConfig(geo: unknown): GeoEmulationConfig | undefined {
  const g = geo as Record<string, unknown>;
  const result: GeoEmulationConfig = {};

  const rawGeoloc = g.geolocation;
  if (rawGeoloc !== undefined && rawGeoloc !== null) {
    if (typeof rawGeoloc !== 'object' || Array.isArray(rawGeoloc)) {
      throw new Error('geo.geolocation must be an object');
    }
    const gl = rawGeoloc as Record<string, unknown>;
    if (typeof gl.latitude !== 'number' || typeof gl.longitude !== 'number') {
      throw new Error('geolocation requires numeric latitude and longitude');
    }
    if (gl.latitude < -90 || gl.latitude > 90) {
      throw new Error('latitude must be between -90 and 90');
    }
    if (gl.longitude < -180 || gl.longitude > 180) {
      throw new Error('longitude must be between -180 and 180');
    }
    if (gl.accuracy !== undefined && typeof gl.accuracy !== 'number') {
      throw new Error('geolocation.accuracy must be a number');
    }
    result.geolocation = {
      latitude: gl.latitude,
      longitude: gl.longitude,
      ...(gl.accuracy !== undefined ? { accuracy: gl.accuracy as number } : {}),
    };
  }
  if (g.timezoneId !== undefined && g.timezoneId !== null) {
    if (typeof g.timezoneId !== 'string') {
      throw new Error('geo.timezoneId must be a string');
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: g.timezoneId }); }
    catch { throw new Error(`invalid timezoneId "${g.timezoneId}"`); }
    result.timezoneId = g.timezoneId;
  }
  if (g.locale !== undefined && g.locale !== null) {
    if (typeof g.locale !== 'string') {
      throw new Error('geo.locale must be a string');
    }
    try { Intl.getCanonicalLocales(g.locale); }
    catch { throw new Error(`invalid locale "${g.locale}"`); }
    result.locale = g.locale;
  }
  if (!result.geolocation && !result.timezoneId && !result.locale) return undefined;
  return result;
}
