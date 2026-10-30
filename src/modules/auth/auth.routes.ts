import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { validate } from '../../middleware/validate';
import { asyncHandler, AppError } from '../../utils/errors';
import { env } from '../../config/env';
import { requestOtp, verifyOtp } from './otp.service';
import { issueTokens, rotate, revoke } from './tokens';
import { User } from './user.model';

const r = Router();
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164, e.g. +919876543210');
const ipLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.AUTH_IP_LIMIT_PER_15MIN, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'OTP_RATE_LIMITED', message: 'Too many requests from this IP' } }) });

const userOut = (u: any) => ({ id: String(u._id), phone: u.phone, email: u.email, role: u.role, profileCompleted: u.profileCompleted, verification: { status: u.verification?.status ?? 'none' } });

r.post('/otp/request', ipLimiter, validate(z.object({ phone })), asyncHandler(async (req, res) => {
  res.json(await requestOtp(req.body.phone));
}));

r.post('/otp/verify', ipLimiter, validate(z.object({ phone, code: z.string().regex(/^\d{6}$/) })), asyncHandler(async (req, res) => {
  await verifyOtp(req.body.phone, req.body.code);
  const user = await User.findOneAndUpdate({ phone: req.body.phone }, { $setOnInsert: { phone: req.body.phone } }, { upsert: true, new: true });
  if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  res.json({ user: userOut(user), ...(await issueTokens(String(user._id), user.role)) });
}));

const google = new OAuth2Client();
export let verifyGoogleToken = async (idToken: string) => {
  const audience = env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!audience.length) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED');
  try {
    const p = (await google.verifyIdToken({ idToken, audience })).getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw new Error('unverified');
    return { sub: p.sub, email: p.email };
  } catch { throw new AppError(401, 'GOOGLE_TOKEN_INVALID'); }
};
export const setGoogleVerifier = (f: typeof verifyGoogleToken) => { verifyGoogleToken = f; };

r.post('/google', ipLimiter, validate(z.object({ idToken: z.string().min(10) })), asyncHandler(async (req, res) => {
  const g = await verifyGoogleToken(req.body.idToken);
  // Link by googleId first, then by verified email, so one person never gets two accounts.
  let user = await User.findOne({ googleSub: g.sub }) ?? await User.findOne({ email: g.email.toLowerCase() });
  if (user) { if (!user.googleSub) { user.googleSub = g.sub; await user.save(); } }
  else user = await User.create({ googleSub: g.sub, email: g.email });
  if (user.status === 'blocked') throw new AppError(403, 'ACCOUNT_BLOCKED');
  res.json({ user: userOut(user), ...(await issueTokens(String(user._id), user.role)) });
}));

r.post('/refresh', validate(z.object({ refreshToken: z.string().min(20) })), asyncHandler(async (req, res) => {
  res.json(await rotate(req.body.refreshToken));
}));

r.post('/logout', validate(z.object({ refreshToken: z.string().min(20) })), asyncHandler(async (req, res) => {
  await revoke(req.body.refreshToken);
  res.status(204).end();
}));

export default r;
