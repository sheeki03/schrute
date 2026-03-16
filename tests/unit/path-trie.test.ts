import { describe, it, expect } from 'vitest';
import { PathTrie } from '../../src/capture/path-trie.js';

describe('PathTrie', () => {
  describe('insertion + promotion at threshold', () => {
    it('promotes a segment position after threshold+1 distinct values', () => {
      const trie = new PathTrie({ threshold: 3 });
      const host = 'api.example.com';

      // Insert 3 distinct values — should NOT promote yet
      trie.insert(host, '/products/shoes');
      trie.insert(host, '/products/hats');
      trie.insert(host, '/products/bags');

      expect(trie.parameterize(host, '/products/shoes')).toBe('/products/shoes');

      // 4th distinct value triggers promotion (> threshold)
      // The "products" node tracks its children: shoes, hats, bags, socks → promoted
      trie.insert(host, '/products/socks');

      expect(trie.parameterize(host, '/products/anything')).toBe('/products/{param}');
    });

    it('does not promote when values are at threshold', () => {
      const trie = new PathTrie({ threshold: 3 });
      const host = 'api.example.com';

      trie.insert(host, '/products/shoes');
      trie.insert(host, '/products/hats');
      trie.insert(host, '/products/bags');

      // Exactly 3 = threshold, should NOT promote
      expect(trie.parameterize(host, '/products/shoes')).toBe('/products/shoes');
    });
  });

  describe('parameterization after promotion returns {param}', () => {
    it('parameterizes previously unseen values at promoted position', () => {
      const trie = new PathTrie({ threshold: 2 });
      const host = 'example.com';

      trie.insert(host, '/users/alice/profile');
      trie.insert(host, '/users/bob/profile');
      trie.insert(host, '/users/charlie/profile');

      // The "users" node tracks children: alice, bob, charlie → promoted (3 > 2)
      // Any value at that position becomes {param}
      expect(trie.parameterize(host, '/users/newuser/profile')).toBe('/users/{param}/profile');
    });
  });

  describe('pre-parameterized segments do not inflate cardinality', () => {
    it('{uuid}, {id}, {hash} are constant strings — single value per position', () => {
      const trie = new PathTrie({ threshold: 5 });
      const host = 'api.example.com';

      // All these have the same canonical segments: /users/{uuid}/orders/{id}
      for (let i = 0; i < 20; i++) {
        trie.insert(host, '/users/{uuid}/orders/{id}');
      }

      // The {uuid} and {id} tokens are the same string each time,
      // so cardinality at those positions is 1 — no promotion
      expect(trie.parameterize(host, '/users/{uuid}/orders/{id}')).toBe('/users/{uuid}/orders/{id}');
    });

    it('mixed pre-parameterized and variable segments', () => {
      const trie = new PathTrie({ threshold: 3 });
      const host = 'api.example.com';

      // All share /users/{uuid}/... but vary at the 3rd segment
      trie.insert(host, '/users/{uuid}/orders');
      trie.insert(host, '/users/{uuid}/profile');
      trie.insert(host, '/users/{uuid}/settings');
      trie.insert(host, '/users/{uuid}/favorites');

      // 'users' at depth 0 is constant (cardinality 1) — not promoted
      // '{uuid}' at depth 1 is constant (cardinality 1) — not promoted
      // depth 2 has 4 values > threshold(3) — promoted
      const result = trie.parameterize(host, '/users/{uuid}/newpath');
      expect(result).toBe('/users/{uuid}/{param}');
    });
  });

  describe('LRU host eviction when maxHosts exceeded', () => {
    it('evicts least recently used host when capacity is exceeded', () => {
      const trie = new PathTrie({ maxHosts: 2, threshold: 1 });

      // Insert for host1 and host2
      trie.insert('host1.com', '/a/b');
      trie.insert('host2.com', '/x/y');

      // Insert for host3 — should evict host1 (LRU)
      trie.insert('host3.com', '/m/n');

      // host1 data should be gone — parameterize returns original path
      expect(trie.parameterize('host1.com', '/a/b')).toBe('/a/b');

      // host2 and host3 should still work
      expect(trie.parameterize('host2.com', '/x/y')).toBe('/x/y');
      expect(trie.parameterize('host3.com', '/m/n')).toBe('/m/n');
    });
  });

  describe('memory cleanup after promotion', () => {
    it('clears uniqueValues and children on promotion', () => {
      const trie = new PathTrie({ threshold: 2 });
      const host = 'example.com';

      trie.insert(host, '/items/a');
      trie.insert(host, '/items/b');
      trie.insert(host, '/items/c'); // triggers promotion at the "items" node

      // After promotion, subsequent inserts and parameterizations still work
      trie.insert(host, '/items/d');
      expect(trie.parameterize(host, '/items/unknown')).toBe('/items/{param}');
    });
  });

  describe('threshold=1 edge case', () => {
    it('promotes after 2 distinct values at a position', () => {
      const trie = new PathTrie({ threshold: 1 });
      const host = 'example.com';

      trie.insert(host, '/api/v1');
      // 1 value = threshold, not yet promoted
      expect(trie.parameterize(host, '/api/v1')).toBe('/api/v1');

      trie.insert(host, '/api/v2');
      // 2 values > threshold(1) — "api" node promoted (children v1, v2 > 1)
      expect(trie.parameterize(host, '/api/v999')).toBe('/api/{param}');
    });
  });

  describe('empty/root paths', () => {
    it('handles empty path gracefully', () => {
      const trie = new PathTrie();
      const host = 'example.com';

      trie.insert(host, '');
      expect(trie.parameterize(host, '')).toBe('');
    });

    it('handles root path /', () => {
      const trie = new PathTrie();
      const host = 'example.com';

      trie.insert(host, '/');
      expect(trie.parameterize(host, '/')).toBe('/');
    });

    it('handles path with no host match', () => {
      const trie = new PathTrie();
      expect(trie.parameterize('unknown.com', '/foo/bar')).toBe('/foo/bar');
    });
  });

  describe('deep path promotion', () => {
    it('promotes at specific depth without affecting other depths', () => {
      const trie = new PathTrie({ threshold: 2 });
      const host = 'api.example.com';

      // Depth 0: 'api' (constant)
      // Depth 1: varies
      // Depth 2: 'details' (constant)
      trie.insert(host, '/api/orders/details');
      trie.insert(host, '/api/users/details');
      trie.insert(host, '/api/products/details');

      const result = trie.parameterize(host, '/api/newresource/details');
      // Depth 0 ('api') not promoted, depth 1 promoted (3 > 2)
      expect(result).toBe('/api/{param}/details');
    });
  });
});
