import { createHash } from 'node:crypto';

// ─── Snapshot Refs ──────────────────────────────────────────────
// YAML accessibility tree → @ref annotation, disambiguation, stable IDs,
// tree-based incremental diffing, snapshot filtering, locator resolution.

// ─── Error Types ────────────────────────────────────────────────

export class StaleRefError extends Error {
  constructor(public readonly ref: string, public readonly snapshotVersion?: number) {
    super(
      `Stale ref "${ref}"${snapshotVersion !== undefined ? ` (snapshot v${snapshotVersion})` : ''}. ` +
      `The element may have been removed or the page has changed. Take a new snapshot.`,
    );
    this.name = 'StaleRefError';
  }
}

// ─── Interfaces ─────────────────────────────────────────────────

interface LocatorStrategy {
  method: 'scopedRole' | 'globalRole' | 'locator';
  scopeChain?: Array<{ role: string; name?: string }>;
  role?: string;
  name?: string;
  nth?: number;
  selector?: string;
}

export interface RefEntry {
  ref: string;
  role: string;
  name: string;
  ordinal: number;
  framePath: string;
  parentContext: string;
  identityHash: string;
  domOrdinal: number;
  locatorStrategy: LocatorStrategy;
}

export interface AnnotatedSnapshot {
  version: number;
  yamlContent: string;
  annotatedContent: string;
  refs: Map<string, RefEntry>;
  refsByHash: Map<string, string>;
  interactiveCount: number;
  wasFiltered?: boolean;
  identityHashCounts?: Map<string, number>;
}

export interface SnapshotNode {
  role: string;
  name?: string;
  ref?: string;
  children: SnapshotNode[];
  identityHash?: string;
  depth: number;
  framePath?: string;
}

interface TreeDiff {
  added: SnapshotNode[];
  removed: SnapshotNode[];
  modified: Array<{ ref: string; changes: string }>;
  confidence: number;
  fullFallback: boolean;
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  maxDepth?: number;
  selector?: string;
  compact?: boolean;
  maxChars?: number;
  offset?: number;
}

export interface FrameSnapshot {
  framePath: string;
  yaml: string;
  error?: string;
  timedOut?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'treeitem', 'gridcell', 'columnheader', 'rowheader',
  'scrollbar',
]);

const LANDMARK_ROLES = new Set([
  'navigation', 'banner', 'main', 'contentinfo', 'complementary',
  'form', 'region', 'search',
]);

const SEMANTIC_ROLES = new Set([...LANDMARK_ROLES, 'heading']);

const MAX_SEMANTIC_ANCESTORS = 4;

// ─── YAML Parsing ───────────────────────────────────────────────

/**
 * Parse Playwright's ariaSnapshot() YAML output into a tree structure.
 * Format: indentation-based nesting, each line is `- role "name"` or `- role "name":`.
 */
export function parseYamlToTree(yaml: string, framePath = 'main'): SnapshotNode[] {
  if (!yaml || !yaml.trim()) return [];

  const lines = yaml.split('\n');
  const root: SnapshotNode[] = [];
  const stack: Array<{ node: SnapshotNode; indent: number }> = [];

  for (const line of lines) {
    if (!line.trim() || !line.trim().startsWith('-')) continue;

    const indentMatch = line.match(/^(\s*)-\s*/);
    if (!indentMatch) continue;

    const indent = indentMatch[1].length;
    const content = line.slice(indentMatch[0].length).replace(/:$/, '').trim();

    const { role, name } = parseRoleAndName(content);

    const node: SnapshotNode = {
      role,
      name: name || undefined,
      children: [],
      depth: 0,
      framePath,
    };

    // Find parent based on indentation
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      node.depth = 0;
      root.push(node);
    } else {
      const parent = stack[stack.length - 1].node;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    }

    stack.push({ node, indent });
  }

  return root;
}

/**
 * Parse role and name from a YAML line content.
 * Handles: `button "Submit"`, `heading "Title" [level=2]`, `textbox`, `text "some text"`
 */
function parseRoleAndName(content: string): { role: string; name: string } {
  // Match: role "name" or role "name" [attrs]
  const match = content.match(/^(\w+)(?:\s+"([^"]*)")?/);
  if (!match) return { role: content, name: '' };

  const role = match[1];
  const name = match[2] ?? '';
  return { role, name };
}

// ─── Name Normalization ─────────────────────────────────────────

/**
 * Normalize accessible name for identity computation.
 * (1) Trim, (2) collapse internal whitespace, (3) lowercase, (4) empty if no name.
 */
export function normalizedName(name: string | undefined): string {
  if (!name) return '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ─── Semantic Path ──────────────────────────────────────────────

/**
 * Build parent semantic path from tree ancestors.
 * Walks up from the element, collecting landmark/heading ancestors.
 * Capped at MAX_SEMANTIC_ANCESTORS levels.
 */
function buildSemanticPath(ancestors: SnapshotNode[]): string {
  const parts: string[] = [];

  for (const ancestor of ancestors) {
    if (!SEMANTIC_ROLES.has(ancestor.role)) continue;

    let segment = ancestor.role;
    if (ancestor.role === 'heading') {
      // Extract level from the YAML line if present
      segment = `heading`;
    }
    if (ancestor.name) {
      segment += `:${normalizedName(ancestor.name)}`;
    }
    parts.push(segment);

    if (parts.length >= MAX_SEMANTIC_ANCESTORS) break;
  }

  return parts.join(' > ');
}

// ─── Identity Hash ──────────────────────────────────────────────

/**
 * Compute identity hash for an element.
 * SHA-256(framePath|role|normalizedName|parentSemanticPath) truncated to 16 hex chars.
 */
function computeIdentityHash(
  framePath: string,
  role: string,
  name: string,
  semanticPath: string,
): string {
  const input = `${framePath}|${role}|${name}|${semanticPath}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ─── Ref Assignment ─────────────────────────────────────────────

export interface RefState {
  hashToRef: Map<string, string>;
  nextRef: number;
  previousTrees: Map<string, SnapshotNode[]>; // per-frame
  version: number;
}

export function createRefState(preserveHashMap?: Map<string, string>): RefState {
  const hashToRef = preserveHashMap ? new Map(preserveHashMap) : new Map();
  let nextRef = 1;
  if (preserveHashMap && preserveHashMap.size > 0) {
    for (const ref of preserveHashMap.values()) {
      const match = ref.match(/^@e(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n >= nextRef) nextRef = n + 1;
      }
    }
  }
  return {
    hashToRef,
    nextRef,
    previousTrees: new Map(),
    version: 0,
  };
}

/**
 * Annotate a parsed tree with @eN refs for all interactive elements.
 * Maintains stable ref IDs across snapshots using identity hashes.
 */
export function annotateSnapshot(
  trees: SnapshotNode[],
  framePath: string,
  state: RefState,
): { refs: Map<string, RefEntry>; annotatedContent: string; identityHashCounts: Map<string, number> } {
  const refs = new Map<string, RefEntry>();

  // First pass: collect all interactive elements with their identity info
  const interactiveElements: Array<{
    node: SnapshotNode;
    ancestors: SnapshotNode[];
    identityHash: string;
    semanticPath: string;
  }> = [];

  function walkTree(node: SnapshotNode, ancestors: SnapshotNode[]) {
    if (INTERACTIVE_ROLES.has(node.role)) {
      const normName = normalizedName(node.name);
      const semanticPath = buildSemanticPath([...ancestors].reverse());
      const identityHash = computeIdentityHash(framePath, node.role, normName, semanticPath);

      interactiveElements.push({
        node,
        ancestors: [...ancestors],
        identityHash,
        semanticPath,
      });
    }

    for (const child of node.children) {
      walkTree(child, [...ancestors, node]);
    }
  }

  for (const tree of trees) {
    walkTree(tree, []);
  }

  // Second pass: assign ordinals for hash collisions and compute domOrdinals
  const hashOccurrences = new Map<string, number>();
  const roleNameCounts = new Map<string, number>();

  for (const elem of interactiveElements) {
    const { identityHash, node } = elem;

    // Ordinal: tie-breaker for hash collisions
    const ordinal = hashOccurrences.get(identityHash) ?? 0;
    hashOccurrences.set(identityHash, ordinal + 1);

    // domOrdinal: position among all same-role-same-name matches
    const roleNameKey = `${node.role}|${normalizedName(node.name)}`;
    const domOrdinal = roleNameCounts.get(roleNameKey) ?? 0;
    roleNameCounts.set(roleNameKey, domOrdinal + 1);

    // Stable ref ID via identity hash lookup
    const hashKey = `${identityHash}:${ordinal}`;
    let refId = state.hashToRef.get(hashKey);
    if (refId) {
      // LRU touch: refresh insertion order for pruning
      state.hashToRef.delete(hashKey);
      state.hashToRef.set(hashKey, refId);
    } else {
      refId = `@e${state.nextRef++}`;
      state.hashToRef.set(hashKey, refId);
    }

    node.ref = refId;
    node.identityHash = identityHash;

    // Build locator strategy
    const locatorStrategy = buildLocatorStrategy(
      elem.semanticPath,
      node.role,
      normalizedName(node.name),
      ordinal,
      domOrdinal,
    );

    refs.set(refId, {
      ref: refId,
      role: node.role,
      name: node.name ?? '',
      ordinal,
      framePath,
      parentContext: elem.semanticPath,
      identityHash,
      domOrdinal,
      locatorStrategy,
    });
  }

  // Render annotated content
  const annotatedContent = renderAnnotatedTree(trees);

  return { refs, annotatedContent, identityHashCounts: new Map(hashOccurrences) };
}

/**
 * Build locator strategy for an element based on its semantic context.
 */
function buildLocatorStrategy(
  semanticPath: string,
  role: string,
  name: string,
  ordinal: number,
  domOrdinal: number,
): LocatorStrategy {
  if (semanticPath) {
    // Scoped locator — use semantic ancestor
    const ancestors = semanticPath.split(' > ');
    const scopeChain = ancestors.map(a => {
      const parts = a.split(':');
      return { role: parts[0], name: parts.length > 1 ? parts.slice(1).join(':') : undefined };
    });

    return {
      method: 'scopedRole',
      scopeChain,
      role,
      name,
      nth: ordinal > 0 ? ordinal : undefined,
    };
  }

  // Global locator — no semantic context
  return {
    method: 'globalRole',
    role,
    name,
    nth: domOrdinal,
  };
}

/**
 * Render an annotated tree back to readable format with @ref tags.
 */
function renderAnnotatedTree(trees: SnapshotNode[], indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (const node of trees) {
    let line = `${prefix}- ${node.role}`;
    if (node.name) line += ` "${node.name}"`;
    if (node.ref) line += ` [${node.ref}]`;

    if (node.children.length > 0) {
      line += ':';
      lines.push(line);
      lines.push(renderAnnotatedTree(node.children, indent + 1));
    } else {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

// ─── Ref Resolution ─────────────────────────────────────────────

/**
 * Resolve a ref string to its RefEntry.
 * Throws StaleRefError if ref is not found.
 */
export function resolveRef(
  ref: string,
  snapshot: AnnotatedSnapshot | undefined,
): RefEntry {
  if (!snapshot) {
    throw new StaleRefError(ref);
  }

  const entry = snapshot.refs.get(ref);
  if (!entry) {
    throw new StaleRefError(ref, snapshot.version);
  }

  return entry;
}

/**
 * Full CSS string escape for values inside [attr="value"] selectors.
 * Escapes: null → U+FFFD, control chars → \HEX , structural chars (" \ ]) → backslash-escaped.
 * Order matters: null bytes first, then control chars (hex escape with trailing space per CSS spec),
 * then structural chars (simple backslash escape).
 */
export function cssEscapeAttr(value: string): string {
  return value
    .replace(/\0/g, '\uFFFD')
    .replace(/[\x01-\x1f\x7f]/g, ch => '\\' + ch.charCodeAt(0).toString(16) + ' ')
    .replace(/["\\\]]/g, '\\$&');
}

/**
 * Build a CSS selector as last-resort fallback.
 * Avoids :has-text() as primary — uses role attribute selectors only.
 * Throws StaleRefError on ambiguity rather than guessing.
 */
export function buildCssFallback(entry: RefEntry): string {
  // Use role attribute selector — most reliable CSS path
  let selector = `[role="${cssEscapeAttr(entry.role)}"]`;

  // Add aria-label for disambiguation when name is present
  if (entry.name) {
    selector += `[aria-label="${cssEscapeAttr(entry.name)}"]`;
  }

  // Note: :has-text() is NOT used here — it's unreliable and can match
  // parent elements. If the role+aria-label selector is ambiguous, we
  // throw StaleRefError rather than guessing with text matchers.

  return selector;
}

// ─── Tree Diffing ───────────────────────────────────────────────

/**
 * Compute a tree-based incremental diff between two snapshot versions.
 * Matches nodes by identityHash for stable identity.
 */
export function diffTrees(
  previous: SnapshotNode[],
  current: SnapshotNode[],
): TreeDiff {
  if (previous.length === 0 && current.length === 0) {
    return { added: [], removed: [], modified: [], confidence: 1.0, fullFallback: false };
  }

  const prevHashes = collectHashes(previous);
  const currHashes = collectHashes(current);

  const added: SnapshotNode[] = [];
  const removed: SnapshotNode[] = [];
  const modified: Array<{ ref: string; changes: string }> = [];

  // Find added nodes (in current but not previous)
  for (const [hash, node] of currHashes) {
    if (!prevHashes.has(hash)) {
      added.push(node);
    } else {
      // Check for modifications (name changed, children changed)
      const prevNode = prevHashes.get(hash)!;
      if (node.ref && prevNode.name !== node.name) {
        modified.push({
          ref: node.ref,
          changes: `name: "${prevNode.name ?? ''}" → "${node.name ?? ''}"`,
        });
      }
    }
  }

  // Find removed nodes (in previous but not current)
  for (const [hash, node] of prevHashes) {
    if (!currHashes.has(hash)) {
      removed.push(node);
    }
  }

  // Confidence: ratio of matched nodes
  const totalNodes = Math.max(prevHashes.size, currHashes.size);
  const matchedNodes = totalNodes === 0 ? 0 :
    [...currHashes.keys()].filter(h => prevHashes.has(h)).length;
  const confidence = totalNodes === 0 ? 1.0 : matchedNodes / totalNodes;

  return {
    added,
    removed,
    modified,
    confidence,
    fullFallback: confidence < 0.5,
  };
}

function collectHashes(trees: SnapshotNode[]): Map<string, SnapshotNode> {
  const map = new Map<string, SnapshotNode>();

  function walk(node: SnapshotNode) {
    if (node.identityHash) {
      map.set(node.identityHash, node);
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const tree of trees) {
    walk(tree);
  }

  return map;
}

/**
 * Render a tree diff as compact text output.
 */
export function renderDiff(diff: TreeDiff, version: number): string {
  if (diff.fullFallback) {
    return `[Diff confidence too low (${(diff.confidence * 100).toFixed(0)}%), showing full snapshot]`;
  }

  const lines: string[] = [`--- Snapshot diff (v${version}) ---`];

  if (diff.added.length > 0) {
    lines.push('Added:');
    for (const node of diff.added) {
      const refTag = node.ref ? ` [${node.ref}]` : '';
      lines.push(`  + ${node.role}${node.name ? ` "${node.name}"` : ''}${refTag}`);
    }
  }

  if (diff.removed.length > 0) {
    lines.push('Removed:');
    for (const node of diff.removed) {
      const refTag = node.ref ? ` [${node.ref}]` : '';
      lines.push(`  - ${node.role}${node.name ? ` "${node.name}"` : ''}${refTag}`);
    }
  }

  if (diff.modified.length > 0) {
    lines.push('Modified:');
    for (const mod of diff.modified) {
      lines.push(`  ~ ${mod.ref}: ${mod.changes}`);
    }
  }

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    lines.push('  (no changes)');
  }

  return lines.join('\n');
}

// ─── Jaccard Similarity ─────────────────────────────────────────

/**
 * Compute Jaccard similarity between two sets of identity hashes.
 * Used to detect SPA route changes that warrant a ref reset.
 */
export function jaccardSimilarity(
  prevHashes: Set<string>,
  currHashes: Set<string>,
): number {
  if (prevHashes.size === 0 && currHashes.size === 0) return 1.0;

  let intersection = 0;
  for (const h of currHashes) {
    if (prevHashes.has(h)) intersection++;
  }

  const union = prevHashes.size + currHashes.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// ─── Snapshot Filtering ─────────────────────────────────────────

/**
 * Filter a snapshot tree for output (does not affect identity/ref computation).
 */
export function filterTree(
  trees: SnapshotNode[],
  options: SnapshotOptions,
): SnapshotNode[] {
  let result = trees;

  if (options.interactiveOnly) {
    result = filterInteractiveOnly(result);
  }

  if (options.maxDepth !== undefined) {
    result = filterByDepth(result, options.maxDepth);
  }

  if (options.compact) {
    result = compactTree(result);
  }

  return result;
}

function filterInteractiveOnly(trees: SnapshotNode[]): SnapshotNode[] {
  const result: SnapshotNode[] = [];

  for (const node of trees) {
    const filteredChildren = filterInteractiveOnly(node.children);

    if (INTERACTIVE_ROLES.has(node.role) || filteredChildren.length > 0) {
      result.push({
        ...node,
        children: filteredChildren,
      });
    }
  }

  return result;
}

function filterByDepth(trees: SnapshotNode[], maxDepth: number, currentDepth = 0): SnapshotNode[] {
  if (currentDepth > maxDepth) return [];

  return trees.map(node => ({
    ...node,
    children: filterByDepth(node.children, maxDepth, currentDepth + 1),
  }));
}

function compactTree(trees: SnapshotNode[]): SnapshotNode[] {
  return trees.map(node => ({
    ...node,
    name: node.name ? truncateText(node.name, 50) : undefined,
    children: compactTree(node.children),
  }));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ─── Network Filtering ──────────────────────────────────────────

export const STATIC_RESOURCE_TYPES = new Set([
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'manifest',
]);
