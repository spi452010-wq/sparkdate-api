import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env';

/** Verifies a Pub/Sub push OIDC bearer token; throws if not genuine. */
export type PubsubVerifier = (idToken: string) => Promise<void>;

const oauth = new OAuth2Client();
/** Google signature, audience = our push URL, email = push service account. */
const googlePubsubVerifier: PubsubVerifier = async (idToken) => {
  if (!env.PUBSUB_PUSH_AUDIENCE || !env.PUBSUB_SA_EMAIL) throw new Error('Pub/Sub push auth not configured');
  const t = await oauth.verifyIdToken({ idToken, audience: env.PUBSUB_PUSH_AUDIENCE });
  const p = t.getPayload();
  if (!p?.email_verified || p.email !== env.PUBSUB_SA_EMAIL) throw new Error('Unexpected push identity');
};

let verifier: PubsubVerifier = googlePubsubVerifier;
export const verifyPubsubToken = (idToken: string) => verifier(idToken);
/** Test seam. */
export const setPubsubVerifier = (v: PubsubVerifier) => { verifier = v; };
