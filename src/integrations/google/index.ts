import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

export interface GoogleIdentity { sub: string; email: string }
/** Verifies a Google Sign-In ID token; throws AppError on failure. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

const google = new OAuth2Client();
const googleIdTokenVerifier: GoogleVerifier = async (idToken) => {
  const audience = env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!audience.length) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED');
  try {
    const p = (await google.verifyIdToken({ idToken, audience })).getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw new Error('unverified');
    return { sub: p.sub, email: p.email };
  } catch { throw new AppError(401, 'GOOGLE_TOKEN_INVALID'); }
};

let verifier: GoogleVerifier = googleIdTokenVerifier;
export const verifyGoogleIdToken = (idToken: string) => verifier(idToken);
/** Test seam. */
export const setGoogleVerifier = (f: GoogleVerifier) => { verifier = f; };
