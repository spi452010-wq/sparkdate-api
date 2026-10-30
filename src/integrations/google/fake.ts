import { AppError } from '../../utils/errors';
import { GoogleIdentity, GoogleVerifier } from './index';

/** Maps known test tokens to identities; anything else is GOOGLE_TOKEN_INVALID. */
export const fakeGoogleVerifier = (tokens: Record<string, GoogleIdentity>): GoogleVerifier => async (t) => {
  const id = tokens[t]; if (!id) throw new AppError(401, 'GOOGLE_TOKEN_INVALID'); return id;
};
