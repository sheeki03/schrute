import { createSign, createVerify, randomBytes } from 'node:crypto';
import { getLogger } from '../core/logger.js';
import type { SealedFetchRequest } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

interface BotIdentity {
  /** Key identifier registered with the server */
  keyId: string;
  /** PEM-encoded private key for signing */
  privateKey: string;
  /** Signing algorithm (default: 'rsa-pss-sha512') */
  algorithm?: string;
}

interface SignatureComponents {
  /** Covered content to sign */
  signatureBase: string;
  /** Signature-Input header value */
  signatureInput: string;
}

// ─── Defaults ───────────────────────────────────────────────────

const DEFAULT_ALGORITHM = 'rsa-pss-sha512';
const COVERED_COMPONENTS = ['@method', '@target-uri', 'content-type'];

// ─── Sign Request (RFC 9421) ─────────────────────────────────────

/**
 * Sign a SealedFetchRequest per RFC 9421 (HTTP Message Signatures).
 *
 * Adds `Signature` and `Signature-Input` headers for Cloudflare Web Bot Auth
 * or any RFC 9421 verifier.
 *
 * Feature-flagged: off by default. Only used when bot identity is configured.
 *
 * @param req - The request to sign
 * @param identity - Bot identity with keyId and private key
 * @returns A new SealedFetchRequest with signature headers
 */
export function signRequest(
  req: SealedFetchRequest,
  identity: BotIdentity,
): SealedFetchRequest {
  const algorithm = identity.algorithm ?? DEFAULT_ALGORITHM;
  const created = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('base64');

  // Build signature base per RFC 9421 Section 2.5
  const components = buildSignatureBase(req, {
    keyId: identity.keyId,
    algorithm,
    created,
    nonce,
  });

  // Sign the base string
  const signature = computeSignature(
    components.signatureBase,
    identity.privateKey,
    algorithm,
  );

  const signatureEncoded = Buffer.from(signature).toString('base64');

  return {
    ...req,
    headers: {
      ...req.headers,
      'Signature': `sig1=:${signatureEncoded}:`,
      'Signature-Input': components.signatureInput,
    },
  };
}

// ─── Verify Signature ────────────────────────────────────────────

/**
 * Validates signature string format (base64 encoding, expected structure).
 * Does NOT perform cryptographic verification — use {@link verifySignatureWithKey}
 * for actual signature validation against a public key.
 *
 * @param req - The request to check
 * @returns true if the signature headers are present and well-formed
 */
export function hasValidSignatureFormat(req: SealedFetchRequest): boolean {
  const sigHeader = req.headers['Signature'] ?? req.headers['signature'];
  const inputHeader = req.headers['Signature-Input'] ?? req.headers['signature-input'];

  if (!sigHeader || !inputHeader) {
    return false;
  }

  // Validate signature format: sig1=:base64:
  const sigMatch = sigHeader.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
  if (!sigMatch) {
    return false;
  }

  // Validate Signature-Input format: sig1=(...);created=...;keyid="..."
  const inputMatch = inputHeader.match(/^sig1=\(.*\);/);
  if (!inputMatch) {
    return false;
  }

  // Validate that the signature decodes from base64
  try {
    const decoded = Buffer.from(sigMatch[1], 'base64');
    if (decoded.length === 0) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Verify a request signature with a known public key.
 *
 * @param req - The request with signature headers
 * @param publicKey - PEM-encoded public key
 * @param algorithm - Signing algorithm used
 * @returns true if the cryptographic signature is valid
 */
export function verifySignatureWithKey(
  req: SealedFetchRequest,
  publicKey: string,
  algorithm = DEFAULT_ALGORITHM,
): boolean {
  const sigHeader = req.headers['Signature'] ?? req.headers['signature'];
  const inputHeader = req.headers['Signature-Input'] ?? req.headers['signature-input'];

  if (!sigHeader || !inputHeader) {
    return false;
  }

  const sigMatch = sigHeader.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
  if (!sigMatch) {
    return false;
  }

  // Parse Signature-Input to reconstruct the signature base
  const params = parseSignatureInput(inputHeader);
  if (!params) {
    return false;
  }

  const components = buildSignatureBase(req, params);
  const signatureBytes = Buffer.from(sigMatch[1], 'base64');

  try {
    const verifier = createVerify(algorithmToNodeHash(algorithm));
    verifier.update(components.signatureBase);
    return verifier.verify(
      { key: publicKey, padding: algorithmToPadding(algorithm) },
      signatureBytes,
    );
  } catch (err) {
    log.debug({ err }, 'Signature verification failed');
    return false;
  }
}

// ─── Internal ───────────────────────────────────────────────────

interface SignatureParams {
  keyId: string;
  algorithm: string;
  created: number;
  nonce: string;
}

function buildSignatureBase(
  req: SealedFetchRequest,
  params: SignatureParams,
): SignatureComponents {
  const lines: string[] = [];

  for (const component of COVERED_COMPONENTS) {
    if (component === '@method') {
      lines.push(`"@method": ${req.method.toUpperCase()}`);
    } else if (component === '@target-uri') {
      lines.push(`"@target-uri": ${req.url}`);
    } else {
      // Regular header
      const value = req.headers[component] ?? req.headers[component.toLowerCase()] ?? '';
      lines.push(`"${component}": ${value}`);
    }
  }

  const coveredStr = COVERED_COMPONENTS.map((c) => `"${c}"`).join(' ');
  const paramsStr = `(${coveredStr});created=${params.created};keyid="${params.keyId}";alg="${params.algorithm}";nonce="${params.nonce}"`;

  lines.push(`"@signature-params": ${paramsStr}`);

  return {
    signatureBase: lines.join('\n'),
    signatureInput: `sig1=${paramsStr}`,
  };
}

function computeSignature(
  signatureBase: string,
  privateKey: string,
  algorithm: string,
): Buffer {
  const signer = createSign(algorithmToNodeHash(algorithm));
  signer.update(signatureBase);
  return signer.sign({
    key: privateKey,
    padding: algorithmToPadding(algorithm),
  });
}

function algorithmToNodeHash(algorithm: string): string {
  if (algorithm.includes('sha512')) return 'SHA512';
  if (algorithm.includes('sha384')) return 'SHA384';
  return 'SHA256';
}

function algorithmToPadding(algorithm: string): number | undefined {
  if (algorithm.startsWith('rsa-pss')) {
    // RSA_PKCS1_PSS_PADDING = 6
    return 6;
  }
  return undefined;
}

function parseSignatureInput(input: string): SignatureParams | null {
  if (typeof input !== 'string' || input.length === 0) {
    return null;
  }

  const createdMatch = input.match(/created=(\d+)/);
  const keyidMatch = input.match(/keyid="([^"]+)"/);
  const algMatch = input.match(/alg="([^"]+)"/);
  const nonceMatch = input.match(/nonce="([^"]+)"/);

  if (!createdMatch || !keyidMatch) return null;

  return {
    created: parseInt(createdMatch[1], 10),
    keyId: keyidMatch[1],
    algorithm: algMatch?.[1] ?? DEFAULT_ALGORITHM,
    nonce: nonceMatch?.[1] ?? '',
  };
}
