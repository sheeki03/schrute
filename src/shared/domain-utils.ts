/**
 * Normalize a domain string for comparison:
 *  - Lowercase
 *  - Strip trailing dots
 *  - Bracket bare IPv6 literals
 *  - Convert IDN/punycode to ASCII via URL parser
 */
export function normalizeDomain(domain: string): string {
  let d = domain.toLowerCase();
  // Strip trailing dots
  while (d.endsWith('.')) {
    d = d.slice(0, -1);
  }
  // Detect bare IPv6 literals (contain 2+ colons, not already bracketed)
  if ((d.match(/:/g) || []).length >= 2 && !d.startsWith('[')) {
    d = `[${d}]`;
  }
  // IDN/punycode: convert to ASCII form if needed
  try {
    const url = new URL(`http://${d}`);
    d = url.hostname;
  } catch {
    // URL parse failed — use lowercase form as-is
  }
  return d;
}

/**
 * Check if a target domain matches any domain in an allowlist.
 * Matches exact domain or is a subdomain of an allowed domain.
 * Both target and allowed domains are normalized before comparison.
 *
 * @param target - The domain to check
 * @param allowedDomains - List of allowed domains
 * @returns true if the target domain matches any allowed domain
 */
export function isDomainMatch(target: string, allowedDomains: Iterable<string>): boolean {
  const normalizedTarget = normalizeDomain(target);
  for (const allowed of allowedDomains) {
    const normalizedAllowed = normalizeDomain(allowed);
    if (
      normalizedTarget === normalizedAllowed ||
      normalizedTarget.endsWith('.' + normalizedAllowed)
    ) {
      return true;
    }
  }
  return false;
}
