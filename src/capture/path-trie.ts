import { BoundedMap } from '../shared/bounded-map.js';

// ─── Trie Node ──────────────────────────────────────────────────────

class TrieNode {
  children = new Map<string, TrieNode>();
  isParam = false;
  /** Tracks distinct child segment values; set to null after promotion to free memory. */
  uniqueValues: Set<string> | null = new Set<string>();
}

// ─── Adaptive Path Trie ─────────────────────────────────────────────

/**
 * Per-host trie that learns variable path segments from cardinality.
 *
 * The trie trains on post-`parameterizePath()` canonical segments,
 * NOT raw paths. This prevents already-handled patterns (UUIDs,
 * numerics, hashes) from inflating cardinality and causing false
 * promotions.
 *
 * Promotion: when a node accumulates > threshold distinct child
 * segment values, it is marked as `isParam = true` and its children
 * and uniqueValues are cleared to free memory. All subsequent
 * insertions/parameterizations at that depth use `{param}`.
 */
export class PathTrie {
  private roots: BoundedMap<string, TrieNode>;
  private threshold: number;

  constructor(opts?: { maxHosts?: number; threshold?: number }) {
    this.roots = new BoundedMap<string, TrieNode>({ maxSize: opts?.maxHosts ?? 10_000 });
    this.threshold = opts?.threshold ?? 10;
  }

  /** Insert a CANONICAL path (already through parameterizePath()). */
  insert(host: string, canonicalPath: string): void {
    let root = this.roots.get(host);
    if (!root) {
      root = new TrieNode();
      this.roots.set(host, root);
    }

    const segments = canonicalPath.split('/').filter(Boolean);
    let node = root;

    for (const seg of segments) {
      if (node.isParam) {
        // Already promoted — skip deeper traversal at this depth.
        // Walk into a single sentinel child to continue building the
        // trie for deeper segments.
        let child = node.children.get('{param}');
        if (!child) {
          child = new TrieNode();
          node.children.set('{param}', child);
        }
        node = child;
        continue;
      }

      // Track distinct values at this depth.
      if (node.uniqueValues) {
        node.uniqueValues.add(seg);

        // Check promotion threshold.
        if (node.uniqueValues.size > this.threshold) {
          node.isParam = true;
          node.uniqueValues = null; // free memory
          node.children.clear();
          // Create sentinel child for deeper segments.
          const child = new TrieNode();
          node.children.set('{param}', child);
          node = child;
          continue;
        }
      }

      let child = node.children.get(seg);
      if (!child) {
        child = new TrieNode();
        node.children.set(seg, child);
      }
      node = child;
    }
  }

  /** Parameterize using learned patterns. */
  parameterize(host: string, canonicalPath: string): string {
    const root = this.roots.get(host);
    if (!root) return canonicalPath;

    const segments = canonicalPath.split('/').filter(Boolean);
    const result: string[] = [];
    let node = root;

    for (const seg of segments) {
      if (node.isParam) {
        result.push('{param}');
        // Walk into sentinel child for deeper segments.
        const child = node.children.get('{param}');
        if (!child) {
          // No deeper trie data — push remaining segments as-is.
          result.push(...segments.slice(result.length));
          break;
        }
        node = child;
        continue;
      }

      // Not promoted — pass through unchanged.
      result.push(seg);
      const child = node.children.get(seg);
      if (!child) {
        // No deeper trie data — push remaining segments as-is.
        result.push(...segments.slice(result.length));
        break;
      }
      node = child;
    }

    // Reconstruct path preserving leading slash.
    const prefix = canonicalPath.startsWith('/') ? '/' : '';
    return prefix + result.join('/');
  }
}
