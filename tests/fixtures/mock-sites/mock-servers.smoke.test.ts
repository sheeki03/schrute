import { describe, it, expect, afterEach } from 'vitest';
import { createRestMockServer } from './rest-mock-server.js';
import { createGraphQLMockServer } from './graphql-mock-server.js';
import { createAuthMockServer } from './auth-mock-server.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length) {
    await closers.pop()!();
  }
});

describe('REST mock server', () => {
  it('starts, serves requests, and stops cleanly', async () => {
    const { url, close } = await createRestMockServer();
    closers.push(close);

    // Unauthorized request
    const unauth = await fetch(`${url}/api/users`);
    expect(unauth.status).toBe(401);

    // Authorized GET /api/users
    const list = await fetch(`${url}/api/users`, {
      headers: { Authorization: 'Bearer token123' },
    });
    expect(list.status).toBe(200);
    const users = await list.json();
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBe(3);

    // POST /api/users
    const created = await fetch(`${url}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Test', email: 'test@example.com' }),
    });
    expect(created.status).toBe(201);
    const newUser = await created.json();
    expect(newUser.id).toBe(4);

    // GET /api/users/:id
    const single = await fetch(`${url}/api/users/4`, {
      headers: { Authorization: 'Bearer token123' },
    });
    expect(single.status).toBe(200);
    expect((await single.json()).name).toBe('Test');

    // PUT /api/users/:id
    const updated = await fetch(`${url}/api/users/4`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Test Updated' }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).name).toBe('Test Updated');

    // DELETE /api/users/:id
    const deleted = await fetch(`${url}/api/users/4`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token123' },
    });
    expect(deleted.status).toBe(204);

    // 404 after delete
    const gone = await fetch(`${url}/api/users/4`, {
      headers: { Authorization: 'Bearer token123' },
    });
    expect(gone.status).toBe(404);

    // Rate limit headers present
    expect(list.headers.get('x-ratelimit-remaining')).toBeTruthy();
  });
});

describe('GraphQL mock server', () => {
  it('handles GetUsers, GetUser, and CreateUser operations', async () => {
    const { url, close } = await createGraphQLMockServer();
    closers.push(close);

    // GetUsers
    const listRes = await fetch(`${url}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query GetUsers($limit: Int) { users(limit: $limit) { id name } }',
        operationName: 'GetUsers',
        variables: { limit: 2 },
      }),
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.data.users.length).toBe(2);

    // GetUser
    const userRes = await fetch(`${url}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query GetUser($id: ID!) { user(id: $id) { id name } }',
        operationName: 'GetUser',
        variables: { id: '1' },
      }),
    });
    expect(userRes.status).toBe(200);
    const userData = await userRes.json();
    expect(userData.data.user.name).toBe('Alice Johnson');

    // CreateUser
    const createRes = await fetch(`${url}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id name } }',
        operationName: 'CreateUser',
        variables: { input: { name: 'New', email: 'new@test.com' } },
      }),
    });
    expect(createRes.status).toBe(200);
    const createData = await createRes.json();
    expect(createData.data.createUser.name).toBe('New');

    // Unknown operation
    const unknownRes = await fetch(`${url}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ foo }',
        operationName: 'NoSuchOp',
      }),
    });
    const unknownData = await unknownRes.json();
    expect(unknownData.errors[0].message).toContain('Unknown operation');
  });
});

describe('Auth mock server', () => {
  it('handles login, protected access, refresh, and expired token flows', async () => {
    const { url, close } = await createAuthMockServer();
    closers.push(close);

    // Fail login with wrong credentials
    const badLogin = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wrong', password: 'wrong' }),
    });
    expect(badLogin.status).toBe(401);

    // Successful login
    const loginRes = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    expect(loginData.access_token).toBeTruthy();
    expect(loginData.refresh_token).toBeTruthy();
    expect(loginData.token_type).toBe('Bearer');

    // Access protected resource
    const protectedRes = await fetch(`${url}/api/protected`, {
      headers: { Authorization: `Bearer ${loginData.access_token}` },
    });
    expect(protectedRes.status).toBe(200);
    const protectedData = await protectedRes.json();
    expect(protectedData.userId).toBe(123);

    // Protected resource without token
    const noAuthRes = await fetch(`${url}/api/protected`);
    expect(noAuthRes.status).toBe(401);

    // Refresh token
    const refreshRes = await fetch(`${url}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: loginData.refresh_token }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.access_token).toBeTruthy();
    expect(refreshData.access_token).not.toBe(loginData.access_token);

    // Old token should be invalid after refresh
    const oldTokenRes = await fetch(`${url}/api/protected`, {
      headers: { Authorization: `Bearer ${loginData.access_token}` },
    });
    expect(oldTokenRes.status).toBe(401);

    // New token should work
    const newTokenRes = await fetch(`${url}/api/protected`, {
      headers: { Authorization: `Bearer ${refreshData.access_token}` },
    });
    expect(newTokenRes.status).toBe(200);
  });
});
