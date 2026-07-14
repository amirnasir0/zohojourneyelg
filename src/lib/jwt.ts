import { readFileSync } from 'node:fs';
import { type CryptoKey, SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';

const JWT_ALG = 'RS256';
const JWT_TTL_SECONDS = 90 * 24 * 60 * 60;

let privateKeyPromise: Promise<CryptoKey> | null = null;
let publicKeyPromise: Promise<CryptoKey> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function getPrivateKey(): Promise<CryptoKey> {
  if (!privateKeyPromise) {
    const pem = readFileSync(requireEnv('JWT_PRIVATE_KEY_PATH'), 'utf-8');
    privateKeyPromise = importPKCS8(pem, JWT_ALG);
  }
  return privateKeyPromise;
}

function getPublicKey(): Promise<CryptoKey> {
  if (!publicKeyPromise) {
    const pem = readFileSync(requireEnv('JWT_PUBLIC_KEY_PATH'), 'utf-8');
    publicKeyPromise = importSPKI(pem, JWT_ALG);
  }
  return publicKeyPromise;
}

export interface SessionTokenPayload {
  sub: string;
  jti: string;
}

export async function signSessionToken(contactId: string, jti: string): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ sub: contactId, jti })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySessionToken(token: string): Promise<SessionTokenPayload> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, { algorithms: [JWT_ALG] });

  if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    throw new Error('malformed session token payload');
  }

  return { sub: payload.sub, jti: payload.jti };
}
