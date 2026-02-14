/**
 * Check if a target domain matches any domain in an allowlist.
 * Matches exact domain or is a subdomain of an allowed domain.
 *
 * @param target - The domain to check (will be lowercased)
 * @param allowedDomains - List of allowed domains
 * @returns true if the target domain matches any allowed domain
 */
export function isDomainMatch(target: string, allowedDomains: Iterable<string>): boolean {
  const normalizedTarget = target.toLowerCase();
  for (const allowed of allowedDomains) {
    const normalizedAllowed = allowed.toLowerCase();
    if (
      normalizedTarget === normalizedAllowed ||
      normalizedTarget.endsWith('.' + normalizedAllowed)
    ) {
      return true;
    }
  }
  return false;
}
