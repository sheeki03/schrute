import { describe, it, expect } from 'vitest';
import { classifySideEffect } from '../../src/skill/side-effects.js';
import { SideEffectClass } from '../../src/skill/types.js';

describe('side-effects', () => {
  it('GET -> read-only', () => {
    expect(classifySideEffect('GET', '/api/users')).toBe(SideEffectClass.READ_ONLY);
  });

  it('HEAD -> read-only', () => {
    expect(classifySideEffect('HEAD', '/api/users')).toBe(SideEffectClass.READ_ONLY);
  });

  it('POST to /graphql with query -> read-only', () => {
    const body = JSON.stringify({ query: 'query { users { id name } }' });
    expect(classifySideEffect('POST', '/graphql', undefined, body)).toBe(SideEffectClass.READ_ONLY);
  });

  it('POST to /graphql with mutation -> non-idempotent', () => {
    const body = JSON.stringify({ query: 'mutation { createUser(name: "test") { id } }' });
    expect(classifySideEffect('POST', '/graphql', undefined, body)).toBe(SideEffectClass.NON_IDEMPOTENT);
  });

  it('POST to /mutation -> non-idempotent', () => {
    expect(classifySideEffect('POST', '/api/mutation')).toBe(SideEffectClass.NON_IDEMPOTENT);
  });

  it('POST to /charge -> non-idempotent', () => {
    expect(classifySideEffect('POST', '/billing/charge')).toBe(SideEffectClass.NON_IDEMPOTENT);
  });

  it('PUT -> idempotent', () => {
    expect(classifySideEffect('PUT', '/api/users/1')).toBe(SideEffectClass.IDEMPOTENT);
  });

  it('PATCH -> non-idempotent', () => {
    expect(classifySideEffect('PATCH', '/api/users/1')).toBe(SideEffectClass.NON_IDEMPOTENT);
  });

  it('DELETE -> idempotent', () => {
    expect(classifySideEffect('DELETE', '/api/users/1')).toBe(SideEffectClass.IDEMPOTENT);
  });

  it('POST to search-like path -> read-only', () => {
    expect(classifySideEffect('POST', '/api/search')).toBe(SideEffectClass.READ_ONLY);
  });

  it('default POST -> non-idempotent', () => {
    expect(classifySideEffect('POST', '/api/submit')).toBe(SideEffectClass.NON_IDEMPOTENT);
  });
});
