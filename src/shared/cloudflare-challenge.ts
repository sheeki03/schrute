export interface CloudflareChallengeSignals {
  url?: string;
  headers?: Record<string, string | undefined>;
  content?: string;
}

function getHeader(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function isCloudflareChallengeSignal(signals: CloudflareChallengeSignals): boolean {
  const url = signals.url ?? '';
  const content = signals.content ?? '';
  const cfMitigated = getHeader(signals.headers, 'cf-mitigated')?.toLowerCase();
  if (cfMitigated === 'challenge') {
    return true;
  }

  // Direct challenge headers — definitive CF signals
  const cfChallenge = getHeader(signals.headers, 'cf-challenge');
  if (cfChallenge !== undefined) {
    return true;
  }

  const cfChlBypass = getHeader(signals.headers, 'cf-chl-bypass');
  if (cfChlBypass !== undefined) {
    return true;
  }

  const location = getHeader(signals.headers, 'location') ?? '';
  const hasCdnCgiPath = /\/cdn-cgi\/challenge-platform|\/cdn-cgi\//i.test(url)
    || /\/cdn-cgi\/challenge-platform|\/cdn-cgi\//i.test(location)
    || /\/cdn-cgi\/challenge-platform/i.test(content);
  if (hasCdnCgiPath) {
    return true;
  }

  if (/__cf_chl_/i.test(content)) {
    return true;
  }

  const hasGenericChallengeText = /Just a moment|Verify(?:ing)? you are human|Checking your browser/i.test(content);
  if (!hasGenericChallengeText) {
    return false;
  }

  const server = getHeader(signals.headers, 'server') ?? '';
  const hasCloudflareSupport = /cloudflare/i.test(server) || typeof getHeader(signals.headers, 'cf-ray') === 'string';
  return hasCloudflareSupport;
}
