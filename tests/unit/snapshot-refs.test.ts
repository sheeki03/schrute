import { describe, it, expect } from 'vitest';
import {
  parseYamlToTree,
  normalizedName,
  annotateSnapshot,
  createRefState,
  resolveRef,
  buildCssFallback,
  diffTrees,
  renderDiff,
  jaccardSimilarity,
  filterTree,
  StaleRefError,
  STATIC_RESOURCE_TYPES,
} from '../../src/browser/snapshot-refs.js';

describe('parseYamlToTree', () => {
  it('parses simple YAML into tree nodes', () => {
    const yaml = `- heading "Title"\n- button "Submit"`;
    const trees = parseYamlToTree(yaml);

    expect(trees).toHaveLength(2);
    expect(trees[0].role).toBe('heading');
    expect(trees[0].name).toBe('Title');
    expect(trees[1].role).toBe('button');
    expect(trees[1].name).toBe('Submit');
  });

  it('parses nested YAML with indentation', () => {
    const yaml = [
      '- navigation "Main":',
      '  - link "Home"',
      '  - link "About"',
      '- main:',
      '  - heading "Welcome"',
    ].join('\n');

    const trees = parseYamlToTree(yaml);
    expect(trees).toHaveLength(2);
    expect(trees[0].role).toBe('navigation');
    expect(trees[0].children).toHaveLength(2);
    expect(trees[0].children[0].role).toBe('link');
    expect(trees[1].children[0].role).toBe('heading');
  });

  it('returns empty array for empty/blank YAML', () => {
    expect(parseYamlToTree('')).toHaveLength(0);
    expect(parseYamlToTree('   ')).toHaveLength(0);
  });

  it('sets framePath on all nodes', () => {
    const trees = parseYamlToTree('- button "OK"', 'main>iframe[0]');
    expect(trees[0].framePath).toBe('main>iframe[0]');
  });
});

describe('normalizedName', () => {
  it('trims whitespace', () => {
    expect(normalizedName('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace', () => {
    expect(normalizedName('hello   world')).toBe('hello world');
  });

  it('lowercases', () => {
    expect(normalizedName('Hello World')).toBe('hello world');
  });

  it('returns empty for undefined/empty', () => {
    expect(normalizedName(undefined)).toBe('');
    expect(normalizedName('')).toBe('');
  });
});

describe('annotateSnapshot', () => {
  it('assigns @eN refs to interactive elements', () => {
    const yaml = '- navigation:\n  - button "Submit"\n  - link "Home"';
    const trees = parseYamlToTree(yaml);
    const state = createRefState();

    const { refs, annotatedContent } = annotateSnapshot(trees, 'main', state);

    expect(refs.size).toBe(2);
    expect(annotatedContent).toContain('[@e1]');
    expect(annotatedContent).toContain('[@e2]');
  });

  it('disambiguates 3 buttons with same name via ordinal', () => {
    const yaml = [
      '- button "Submit"',
      '- button "Submit"',
      '- button "Submit"',
    ].join('\n');
    const trees = parseYamlToTree(yaml);
    const state = createRefState();

    const { refs } = annotateSnapshot(trees, 'main', state);
    const entries = [...refs.values()];

    // All should have distinct refs
    const refIds = entries.map(e => e.ref);
    expect(new Set(refIds).size).toBe(3);
  });

  it('maintains stable refs across consecutive snapshots', () => {
    const yaml = '- button "Submit"\n- link "Home"';
    const state = createRefState();

    // First snapshot
    const { refs: refs1 } = annotateSnapshot(parseYamlToTree(yaml), 'main', state);
    const button1 = [...refs1.values()].find(r => r.role === 'button')!;
    const link1 = [...refs1.values()].find(r => r.role === 'link')!;

    // Second snapshot (same content)
    const { refs: refs2 } = annotateSnapshot(parseYamlToTree(yaml), 'main', state);
    const button2 = [...refs2.values()].find(r => r.role === 'button')!;
    const link2 = [...refs2.values()].find(r => r.role === 'link')!;

    expect(button1.ref).toBe(button2.ref);
    expect(link1.ref).toBe(link2.ref);
  });

  it('assigns new ref numbers for new elements (no renumbering)', () => {
    const state = createRefState();

    // First snapshot: 2 elements
    annotateSnapshot(parseYamlToTree('- button "A"\n- button "B"'), 'main', state);

    // Second snapshot: 3 elements (C is new)
    const { refs } = annotateSnapshot(
      parseYamlToTree('- button "A"\n- button "B"\n- button "C"'),
      'main', state,
    );

    const entries = [...refs.values()];
    const refNums = entries.map(e => parseInt(e.ref.slice(2)));
    // C should get @e3 (next available), not renumber everything
    expect(refNums).toContain(3);
  });

  it('does not annotate non-interactive elements', () => {
    const yaml = '- heading "Title"\n- text "paragraph"\n- button "Click"';
    const trees = parseYamlToTree(yaml);
    const state = createRefState();

    const { refs } = annotateSnapshot(trees, 'main', state);
    // Only button is interactive
    expect(refs.size).toBe(1);
    expect([...refs.values()][0].role).toBe('button');
  });

  it('uses scoped locator when semantic ancestor exists', () => {
    const yaml = '- navigation "Main":\n  - button "Submit"';
    const trees = parseYamlToTree(yaml);
    const state = createRefState();

    const { refs } = annotateSnapshot(trees, 'main', state);
    const button = [...refs.values()][0];

    expect(button.locatorStrategy.method).toBe('scopedRole');
    expect(button.parentContext).toContain('navigation');
  });

  it('uses global locator when no semantic ancestor', () => {
    const yaml = '- button "Submit"';
    const trees = parseYamlToTree(yaml);
    const state = createRefState();

    const { refs } = annotateSnapshot(trees, 'main', state);
    const button = [...refs.values()][0];

    expect(button.locatorStrategy.method).toBe('globalRole');
  });
});

describe('resolveRef', () => {
  it('throws StaleRefError when snapshot is undefined', () => {
    expect(() => resolveRef('@e1', undefined)).toThrow(StaleRefError);
  });

  it('throws StaleRefError when ref not found', () => {
    const snapshot = {
      version: 1,
      yamlContent: '',
      annotatedContent: '',
      refs: new Map(),
      refsByHash: new Map(),
      interactiveCount: 0,
    };
    expect(() => resolveRef('@e99', snapshot)).toThrow(StaleRefError);
  });

  it('returns entry when ref exists', () => {
    const yaml = '- button "OK"';
    const state = createRefState();
    const { refs } = annotateSnapshot(parseYamlToTree(yaml), 'main', state);

    const snapshot = {
      version: 1,
      yamlContent: yaml,
      annotatedContent: '',
      refs,
      refsByHash: new Map(),
      interactiveCount: refs.size,
    };

    const entry = resolveRef('@e1', snapshot);
    expect(entry.role).toBe('button');
    expect(entry.name).toBe('OK');
  });
});

describe('buildCssFallback', () => {
  it('builds role selector', () => {
    const entry = {
      ref: '@e1', role: 'button', name: '', ordinal: 0,
      framePath: 'main', parentContext: '', identityHash: 'abc',
      domOrdinal: 0, locatorStrategy: { method: 'globalRole' as const, role: 'button', name: '' },
    };
    expect(buildCssFallback(entry)).toBe('[role="button"]');
  });

  it('adds aria-label when name present', () => {
    const entry = {
      ref: '@e1', role: 'button', name: 'Submit', ordinal: 0,
      framePath: 'main', parentContext: '', identityHash: 'abc',
      domOrdinal: 0, locatorStrategy: { method: 'globalRole' as const, role: 'button', name: 'Submit' },
    };
    expect(buildCssFallback(entry)).toBe('[role="button"][aria-label="Submit"]');
  });

  it('does NOT use :has-text()', () => {
    const entry = {
      ref: '@e1', role: 'button', name: 'Submit', ordinal: 0,
      framePath: 'main', parentContext: '', identityHash: 'abc',
      domOrdinal: 0, locatorStrategy: { method: 'globalRole' as const, role: 'button', name: 'Submit' },
    };
    const selector = buildCssFallback(entry);
    expect(selector).not.toContain(':has-text');
  });
});

describe('diffTrees', () => {
  it('detects added nodes', () => {
    const state = createRefState();
    const prev = parseYamlToTree('- button "A"');
    annotateSnapshot(prev, 'main', state);

    const curr = parseYamlToTree('- button "A"\n- button "B"');
    annotateSnapshot(curr, 'main', state);

    const diff = diffTrees(prev, curr);
    expect(diff.added.length).toBeGreaterThan(0);
  });

  it('detects removed nodes', () => {
    const state = createRefState();
    const prev = parseYamlToTree('- button "A"\n- button "B"');
    annotateSnapshot(prev, 'main', state);

    const curr = parseYamlToTree('- button "A"');
    annotateSnapshot(curr, 'main', state);

    const diff = diffTrees(prev, curr);
    expect(diff.removed.length).toBeGreaterThan(0);
  });

  it('returns confidence 1.0 for empty trees', () => {
    const diff = diffTrees([], []);
    expect(diff.confidence).toBe(1.0);
    expect(diff.fullFallback).toBe(false);
  });

  it('sets fullFallback when confidence < 0.5', () => {
    // Completely different trees
    const state1 = createRefState();
    const prev = parseYamlToTree('- button "X"');
    annotateSnapshot(prev, 'main', state1);

    const state2 = createRefState();
    const curr = parseYamlToTree('- link "Y"\n- link "Z"\n- link "W"');
    annotateSnapshot(curr, 'main', state2);

    const diff = diffTrees(prev, curr);
    expect(diff.fullFallback).toBe(true);
  });
});

describe('renderDiff', () => {
  it('renders full fallback message when confidence low', () => {
    const diff = { added: [], removed: [], modified: [], confidence: 0.3, fullFallback: true };
    const result = renderDiff(diff, 1);
    expect(result).toContain('Diff confidence too low');
  });

  it('renders no changes message', () => {
    const diff = { added: [], removed: [], modified: [], confidence: 1.0, fullFallback: false };
    const result = renderDiff(diff, 1);
    expect(result).toContain('no changes');
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(a, a)).toBe(1.0);
  });

  it('returns 0.0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 1.0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1.0);
  });

  it('computes partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

describe('filterTree', () => {
  it('filters to interactive only', () => {
    const yaml = '- heading "Title"\n- button "OK"\n- text "info"';
    const trees = parseYamlToTree(yaml);

    const filtered = filterTree(trees, { interactiveOnly: true });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].role).toBe('button');
  });

  it('filters by max depth', () => {
    const yaml = '- navigation:\n  - list:\n    - button "Deep"';
    const trees = parseYamlToTree(yaml);

    const filtered = filterTree(trees, { maxDepth: 1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].children).toHaveLength(1);
    // Depth 2 (button) should be cut
    expect(filtered[0].children[0].children).toHaveLength(0);
  });

  it('compacts long names', () => {
    const yaml = `- button "${'a'.repeat(100)}"`;
    const trees = parseYamlToTree(yaml);

    const filtered = filterTree(trees, { compact: true });
    expect(filtered[0].name!.length).toBeLessThanOrEqual(50);
    expect(filtered[0].name!).toContain('...');
  });
});

describe('STATIC_RESOURCE_TYPES', () => {
  it('includes expected types', () => {
    expect(STATIC_RESOURCE_TYPES.has('stylesheet')).toBe(true);
    expect(STATIC_RESOURCE_TYPES.has('image')).toBe(true);
    expect(STATIC_RESOURCE_TYPES.has('font')).toBe(true);
  });

  it('excludes XHR/fetch', () => {
    expect(STATIC_RESOURCE_TYPES.has('xhr')).toBe(false);
    expect(STATIC_RESOURCE_TYPES.has('fetch')).toBe(false);
  });
});
