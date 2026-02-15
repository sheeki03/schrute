import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signRequest, verifySignature, verifySignatureWithKey } from '../../src/automation/bot-auth.js';
import type { SealedFetchRequest } from '../../src/skill/types.js';

function makeRequest(overrides: Partial<SealedFetchRequest> = {}): SealedFetchRequest {
  return {
    url: 'https://api.example.com/data',
    method: 'GET',
    headers: { 'content-type': 'application/json' },
    ...overrides,
  };
}

function generateTestKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('bot-auth', () => {
  describe('signRequest', () => {
    it('adds Signature and Signature-Input headers', () => {
      const { privateKey } = generateTestKeyPair();
      const req = makeRequest();

      const signed = signRequest(req, {
        keyId: 'test-bot-1',
        privateKey,
      });

      expect(signed.headers['Signature']).toBeDefined();
      expect(signed.headers['Signature-Input']).toBeDefined();
    });

    it('preserves original request headers', () => {
      const { privateKey } = generateTestKeyPair();
      const req = makeRequest({ headers: { 'x-custom': 'value', 'content-type': 'text/plain' } });

      const signed = signRequest(req, {
        keyId: 'test-bot-1',
        privateKey,
      });

      expect(signed.headers['x-custom']).toBe('value');
      expect(signed.headers['content-type']).toBe('text/plain');
    });

    it('signature format follows RFC 9421 structure', () => {
      const { privateKey } = generateTestKeyPair();
      const req = makeRequest();

      const signed = signRequest(req, {
        keyId: 'test-bot-1',
        privateKey,
      });

      // Signature format: sig1=:base64:
      expect(signed.headers['Signature']).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);

      // Signature-Input format: sig1=(...);created=...;keyid="...";alg="...";nonce="..."
      expect(signed.headers['Signature-Input']).toMatch(/^sig1=\(/);
      expect(signed.headers['Signature-Input']).toContain('keyid="test-bot-1"');
      expect(signed.headers['Signature-Input']).toContain('created=');
    });

    it('does not mutate the original request', () => {
      const { privateKey } = generateTestKeyPair();
      const req = makeRequest();
      const originalHeaders = { ...req.headers };

      signRequest(req, { keyId: 'bot-1', privateKey });

      expect(req.headers).toEqual(originalHeaders);
    });
  });

  describe('verifySignature', () => {
    it('returns true for structurally valid signed requests', () => {
      const { privateKey } = generateTestKeyPair();
      const req = makeRequest();

      const signed = signRequest(req, {
        keyId: 'test-bot-1',
        privateKey,
      });

      expect(verifySignature(signed)).toBe(true);
    });

    it('returns false for requests without signatures', () => {
      expect(verifySignature(makeRequest())).toBe(false);
    });

    it('returns false for malformed Signature header', () => {
      const req = makeRequest({
        headers: {
          ...makeRequest().headers,
          'Signature': 'not-valid',
          'Signature-Input': 'sig1=("@method");created=12345;keyid="k"',
        },
      });
      expect(verifySignature(req)).toBe(false);
    });

    it('returns false for malformed Signature-Input header', () => {
      const req = makeRequest({
        headers: {
          ...makeRequest().headers,
          'Signature': 'sig1=:dGVzdA==:',
          'Signature-Input': 'garbage',
        },
      });
      expect(verifySignature(req)).toBe(false);
    });
  });

  describe('verifySignatureWithKey', () => {
    it('verifies a valid signature with the correct public key', () => {
      const { publicKey, privateKey } = generateTestKeyPair();
      const req = makeRequest();

      const signed = signRequest(req, {
        keyId: 'test-bot-1',
        privateKey,
        algorithm: 'rsa-pss-sha512',
      });

      expect(verifySignatureWithKey(signed, publicKey, 'rsa-pss-sha512')).toBe(true);
    });

    it('rejects a signature with the wrong public key', () => {
      const { privateKey } = generateTestKeyPair();
      const { publicKey: wrongKey } = generateTestKeyPair();
      const req = makeRequest();

      const signed = signRequest(req, {
        keyId: 'test-bot-1',
        privateKey,
        algorithm: 'rsa-pss-sha512',
      });

      expect(verifySignatureWithKey(signed, wrongKey, 'rsa-pss-sha512')).toBe(false);
    });
  });
});
