import { PubsubVerifier } from './index';

/** Accepts exactly one bearer token (tests). */
export const fakePubsubVerifier = (validToken: string): PubsubVerifier => async (t) => { if (t !== validToken) throw new Error('bad token'); };
