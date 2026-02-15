import Fastify, { type FastifyInstance } from 'fastify';

interface GqlUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
  department?: string;
  createdAt: string;
  updatedAt: string;
}

const SEED_USERS: GqlUser[] = [
  { id: '1', name: 'Alice Johnson', email: 'alice@example.com', role: 'ADMIN', department: 'Engineering', createdAt: '2025-12-01T00:00:00Z', updatedAt: '2026-01-10T00:00:00Z' },
  { id: '2', name: 'Bob Smith', email: 'bob@example.com', role: 'USER', department: 'Marketing', createdAt: '2025-12-15T00:00:00Z', updatedAt: '2025-12-15T00:00:00Z' },
  { id: '3', name: 'Carol White', email: 'carol@example.com', role: 'USER', department: 'Sales', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

interface GqlRequestBody {
  query: string;
  operationName?: string;
  variables?: Record<string, unknown>;
}

export async function createGraphQLMockServer(port?: number): Promise<{
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}> {
  const server = Fastify({ logger: false });

  let users: GqlUser[] = [...SEED_USERS];
  let nextId = 4;

  server.post('/graphql', (request, reply) => {
    const body = request.body as GqlRequestBody;
    const { operationName, variables } = body;

    if (!operationName) {
      return reply.status(400).send({
        errors: [{ message: 'operationName is required' }],
      });
    }

    switch (operationName) {
      case 'GetUsers': {
        const limit = (variables?.limit as number) ?? 10;
        const offset = (variables?.offset as number) ?? 0;
        const slice = users.slice(offset, offset + limit);
        return reply.send({
          data: {
            users: slice.map(({ id, name, email, role, createdAt }) => ({
              id, name, email, role, createdAt,
            })),
          },
        });
      }

      case 'GetUser': {
        const id = variables?.id as string;
        const user = users.find(u => u.id === id);
        if (!user) {
          return reply.send({
            data: { user: null },
            errors: [{ message: `User ${id} not found` }],
          });
        }
        return reply.send({ data: { user } });
      }

      case 'CreateUser': {
        const input = variables?.input as { name: string; email: string; role?: string };
        if (!input?.name || !input?.email) {
          return reply.send({
            errors: [{ message: 'input.name and input.email are required' }],
          });
        }
        const now = new Date().toISOString();
        const user: GqlUser = {
          id: String(nextId++),
          name: input.name,
          email: input.email,
          role: (input.role as GqlUser['role']) || 'USER',
          createdAt: now,
          updatedAt: now,
        };
        users.push(user);
        return reply.send({
          data: {
            createUser: {
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              createdAt: user.createdAt,
            },
          },
        });
      }

      default:
        return reply.send({
          errors: [{ message: `Unknown operation: ${operationName}` }],
        });
    }
  });

  const address = await server.listen({ port: port || 0, host: '127.0.0.1' });
  return {
    server,
    url: address,
    close: () => server.close(),
  };
}
