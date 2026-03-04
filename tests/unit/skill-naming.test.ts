import { describe, it, expect } from 'vitest';
import { generateActionName } from '../../src/skill/generator.js';

describe('generateActionName', () => {
  it('GET /api/users/{id} → get_users', () => {
    expect(generateActionName('GET', '/api/users/{id}')).toBe('get_users');
  });

  it('POST /api/v2/orders → create_orders', () => {
    expect(generateActionName('POST', '/api/v2/orders')).toBe('create_orders');
  });

  it('DELETE /users/{id}/posts/{postId} → delete_posts', () => {
    expect(generateActionName('DELETE', '/users/{id}/posts/{postId}')).toBe('delete_posts');
  });

  it('PUT /api/v1/config → update_config', () => {
    expect(generateActionName('PUT', '/api/v1/config')).toBe('update_config');
  });

  it('GET /health → get_health', () => {
    expect(generateActionName('GET', '/health')).toBe('get_health');
  });

  it('PATCH maps to update prefix', () => {
    expect(generateActionName('PATCH', '/api/items/{id}')).toBe('update_items');
  });

  it('HEAD maps to get prefix', () => {
    expect(generateActionName('HEAD', '/api/status')).toBe('get_status');
  });

  it('unknown method uses lowercase method as prefix', () => {
    expect(generateActionName('TRACE', '/api/debug')).toBe('trace_debug');
  });
});
