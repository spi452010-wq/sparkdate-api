import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../../utils/errors';
import { env } from '../../config/env';
import { requestOtp, verifyOtp } from './otp.service';
import { issueTokens, rotate, revoke } from './tokens';
import { User } from './user.model';

export const userOut = (u: any) => ({ id: String(u._id), phone: u.phone, email: u.email, role: u.role, profileCompleted: u.profileCompleted, verification: { status: u.verification?.status ?? 'none' } });

const google = new OAuth2Client();
type GoogleVerifier = (idToken: string) => Promise<{ sub: string; email: string }>;
const defaultGoogleVerifier: GoogleVerifier = async (idToken) => {
  const audience = env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!audience.length) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED');
  try {
    const p = (await google.verifyIdToken({ idToken, audience })).getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw new Error('unverified');
    return { sub: p.sub, email: p.email };
  } catch { throw new AppError(401, 'GOOGLE_TOKEN_INVALID'); }
};
let verifyGoogleToken = defaultGoogleVerifier;
/** Test seam: replace Google ID token verification. */
export const setGoogleVerifier = (f: GoogleVerifier) => { verifyGoogleToken = f; };

export { requestOtp };

export async function loginWithOtp(phone: string, code: string) {
  await verifyOtp(phone, code);
  const user = await User.findOneAndUpdate({ phone }, { $setOnInsert: { phone } }, { upsert: true, new: true });
  if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  return { user: userOut(user), ...(await issueTokens(String(user._id), user.role)) };
}

export async function loginWithGoogle(idToken: string) {
  const g = await verifyGoogleToken(idToken);
  // Link by googleId first, then by verified email, so one person never gets two accounts.
  let user = await User.findOne({ googleSub: g.sub }) ?? await User.findOne({ email: g.email.toLowerCase() });
  if (user) { if (!user.googleSub) { user.googleSub = g.sub; await user.save(); } }
  else user = await User.create({ googleSub: g.sub, email: g.email });
  if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  return { user: userOut(user), ...(await issueTokens(String(user._id), user.role)) };
}

export const refresh = (refreshToken: string) => rotate(refreshToken);
export const logout = (refreshToken: string) => revoke(refreshToken);
