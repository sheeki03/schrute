import Fastify, { type FastifyInstance } from 'fastify';

const VALID_CREDENTIALS = { username: 'alice@example.com', password: 'password123' };

interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function createAuthMockServer(port?: number): Promise<{
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}> {
  const server = Fastify({ logger: false });

  let tokenCounter = 0;
  const activeTokens = new Map<string, TokenRecord>();

  function generateToken(prefix: string): string {
    tokenCounter++;
    return `${prefix}_${tokenCounter}_${Date.now()}`;
  }

  function createTokenPair(): TokenRecord {
    const accessToken = generateToken('access');
    const refreshToken = generateToken('refresh');
    const record: TokenRecord = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600_000, // 1 hour
    };
    activeTokens.set(accessToken, record);
    activeTokens.set(refreshToken, record);
    return record;
  }

  function validateBearer(authHeader: string | string[] | undefined): TokenRecord | null {
    if (typeof authHeader !== 'string') return null;
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return null;
    const token = match[1];
    const record = activeTokens.get(token);
    if (!record) return null;
    if (record.accessToken !== token) return null; // must be access, not refresh
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // POST /auth/login
  server.post('/auth/login', (request, reply) => {
    const body = request.body as { username: string; password: string };
    if (body.username !== VALID_CREDENTIALS.username || body.password !== VALID_CREDENTIALS.password) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }
    const record = createTokenPair();
    reply
      .header('Cache-Control', 'no-store')
      .send({
        access_token: record.accessToken,
        refresh_token: record.refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
  });

  // POST /auth/refresh
  server.post('/auth/refresh', (request, reply) => {
    const body = request.body as { refresh_token: string };
    const oldRecord = activeTokens.get(body.refresh_token);
    if (!oldRecord || oldRecord.refreshToken !== body.refresh_token) {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }

    // Invalidate old tokens
    activeTokens.delete(oldRecord.accessToken);
    activeTokens.delete(oldRecord.refreshToken);

    // Issue new pair
    const newRecord = createTokenPair();
    reply
      .header('Cache-Control', 'no-store')
      .send({
        access_token: newRecord.accessToken,
        refresh_token: newRecord.refreshToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
  });

  // GET /api/protected
  server.get('/api/protected', (request, reply) => {
    const record = validateBearer(request.headers['authorization']);
    if (!record) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }
    reply.send({
      message: 'Protected resource accessed',
      userId: 123,
      scope: ['read', 'write'],
    });
  });

  // GET /auth/me - returns current user info (useful for verifying tokens)
  server.get('/auth/me', (request, reply) => {
    const record = validateBearer(request.headers['authorization']);
    if (!record) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    reply.send({
      id: 123,
      username: VALID_CREDENTIALS.username,
      tokenExpiresAt: record.expiresAt,
    });
  });

  const address = await server.listen({ port: port || 0, host: '127.0.0.1' });
  return {
    server,
    url: address,
    close: () => server.close(),
  };
}
