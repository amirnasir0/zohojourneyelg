import { SignJWT, jwtVerify } from 'jose';
import { getPrivateKey, getPublicKey, JWT_ALG } from './jwt.js';

// Staff sessions live much shorter than customer ones (90 days) — this is a
// back-office tool used on a work device, not a rarely-opened consumer app;
// a shorter TTL bounds how long a lost/stolen staff device stays valid.
// Exported so the login route can set a matching StaffSession.expiresAt.
export const STAFF_JWT_TTL_SECONDS = 12 * 60 * 60;
const STAFF_AUDIENCE = 'staff';

export interface StaffSessionTokenPayload {
  sub: string;
  jti: string;
  role: string;
}

/**
 * Reuses the exact same RS256 keypair as customer sessions (src/lib/jwt.ts)
 * — no separate key generation or Railway env vars to manage — but stamps
 * an explicit `aud: "staff"` claim. jose's jwtVerify rejects a token with no
 * `aud` claim when an audience is required, so this is a real cryptographic
 * boundary: existing customer tokens (which have no aud claim at all,
 * verifySessionToken is untouched) are rejected by verifyStaffSessionToken,
 * and a staff token is equally rejected by the customer-side verify if ever
 * pointed at it (customer verify doesn't check audience, but a staff token
 * carries no `sub` that resolves to a real Contact/Session row, so it fails
 * downstream at the session lookup either way).
 */
export async function signStaffSessionToken(staffId: string, jti: string, role: string): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ sub: staffId, jti, role })
    .setProtectedHeader({ alg: JWT_ALG })
    .setAudience(STAFF_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${STAFF_JWT_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyStaffSessionToken(token: string): Promise<StaffSessionTokenPayload> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, { algorithms: [JWT_ALG], audience: STAFF_AUDIENCE });

  if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || typeof payload.role !== 'string') {
    throw new Error('malformed staff session token payload');
  }

  return { sub: payload.sub, jti: payload.jti, role: payload.role };
}
