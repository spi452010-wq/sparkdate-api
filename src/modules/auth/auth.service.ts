import { AppError } from '../../utils/errors';
import { verifyGoogleIdToken } from '../../integrations/google';
import { requestOtp, verifyOtp } from './otp.service';
import { issueTokens, rotate, revoke } from './tokens';
import { userRepository } from '../users/users.repository';

export const userOut = (u: any) => ({ id: String(u._id), phone: u.phone, email: u.email, role: u.role, profileCompleted: u.profileCompleted, verification: { status: u.verification?.status ?? 'none' } });

export { requestOtp };
/** Credential/session primitives exposed to other modules (admin auth, scripts). */
export { hashPassword, verifyPassword } from './password';
export { issueTokens, rotate, revoke };

export async function loginWithOtp(phone: string, code: string) {
  await verifyOtp(phone, code);
  const user = await userRepository.findOneAndUpdate({ phone }, { $setOnInsert: { phone } }, { upsert: true, new: true });
  if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  return { user: userOut(user), ...(await issueTokens(String(user._id), user.role)) };
}

export async function loginWithGoogle(idToken: string) {
  const g = await verifyGoogleIdToken(idToken);
  // Link by googleId first, then by verified email, so one person never gets two accounts.
  let user = await userRepository.findOne({ googleSub: g.sub }) ?? await userRepository.findOne({ email: g.email.toLowerCase() });
  if (user) { if (!user.googleSub) { user.googleSub = g.sub; await user.save(); } }
  else user = await userRepository.create({ googleSub: g.sub, email: g.email });
  if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  return { user: userOut(user), ...(await issueTokens(String(user._id), user.role)) };
}

export const refresh = (refreshToken: string) => rotate(refreshToken);
export const logout = (refreshToken: string) => revoke(refreshToken);
