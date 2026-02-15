import Fastify, { type FastifyInstance } from 'fastify';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  department?: string;
  createdAt: string;
  updatedAt: string;
}

const SEED_USERS: User[] = [
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com', role: 'admin', department: 'Engineering', createdAt: '2025-12-01T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com', role: 'user', department: 'Marketing', createdAt: '2025-12-15T00:00:00Z', updatedAt: '2025-12-15T00:00:00Z' },
  { id: 3, name: 'Carol White', email: 'carol@example.com', role: 'user', department: 'Sales', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

const VALID_TOKEN = 'token123';

export async function createRestMockServer(port?: number): Promise<{
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}> {
  const server = Fastify({ logger: false });

  // In-memory store, reset per server instance
  let users: User[] = [...SEED_USERS];
  let nextId = 4;
  let rateLimitRemaining = 100;

  // Auth check hook
  function checkAuth(request: { headers: Record<string, string | string[] | undefined> }): boolean {
    const auth = request.headers['authorization'];
    return typeof auth === 'string' && auth === `Bearer ${VALID_TOKEN}`;
  }

  // GET /api/users
  server.get('/api/users', (request, reply) => {
    if (!checkAuth(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    rateLimitRemaining--;
    const query = request.query as { page?: string; limit?: string };
    const page = parseInt(query.page || '1', 10);
    const limit = parseInt(query.limit || '10', 10);
    const start = (page - 1) * limit;
    const slice = users.slice(start, start + limit);

    reply
      .header('X-RateLimit-Remaining', String(rateLimitRemaining))
      .header('X-RateLimit-Limit', '100')
      .header('X-Total-Count', String(users.length))
      .send(slice);
  });

  // GET /api/users/:id
  server.get<{ Params: { id: string } }>('/api/users/:id', (request, reply) => {
    if (!checkAuth(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    rateLimitRemaining--;
    const id = parseInt(request.params.id, 10);
    const user = users.find(u => u.id === id);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    reply
      .header('X-RateLimit-Remaining', String(rateLimitRemaining))
      .send(user);
  });

  // POST /api/users
  server.post('/api/users', (request, reply) => {
    if (!checkAuth(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    rateLimitRemaining--;
    const body = request.body as { name: string; email: string; role?: string };
    const now = new Date().toISOString();
    const user: User = {
      id: nextId++,
      name: body.name,
      email: body.email,
      role: body.role || 'user',
      createdAt: now,
      updatedAt: now,
    };
    users.push(user);
    reply
      .status(201)
      .header('Location', `/api/users/${user.id}`)
      .header('X-RateLimit-Remaining', String(rateLimitRemaining))
      .send(user);
  });

  // PUT /api/users/:id
  server.put<{ Params: { id: string } }>('/api/users/:id', (request, reply) => {
    if (!checkAuth(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    rateLimitRemaining--;
    const id = parseInt(request.params.id, 10);
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const body = request.body as Partial<User>;
    users[idx] = {
      ...users[idx],
      ...body,
      id, // prevent id override
      updatedAt: new Date().toISOString(),
    };
    reply
      .header('X-RateLimit-Remaining', String(rateLimitRemaining))
      .send(users[idx]);
  });

  // DELETE /api/users/:id
  server.delete<{ Params: { id: string } }>('/api/users/:id', (request, reply) => {
    if (!checkAuth(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    rateLimitRemaining--;
    const id = parseInt(request.params.id, 10);
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) {
      return reply.status(404).send({ error: 'User not found' });
    }
    users.splice(idx, 1);
    reply
      .status(204)
      .header('X-RateLimit-Remaining', String(rateLimitRemaining))
      .send();
  });

  const address = await server.listen({ port: port || 0, host: '127.0.0.1' });
  return {
    server,
    url: address,
    close: () => server.close(),
  };
}
