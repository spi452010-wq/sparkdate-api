import crypto from 'crypto';
import { otpSender } from '../../integrations/whatsapp';
import { sha256 } from './tokens';
import { AppError } from '../../utils/errors';
import { otpRepository } from './auth.repository';

export const OTP_RULES = { length: 6, ttlSec: 300, resendCooldownSec: 30, maxSendsPerHour: 5, maxAttempts: 5, lockMinutes: 15 };

export async function requestOtp(phone: string) {
  const now = new Date();
  const existing = await otpRepository.findOne({ phone });
  if (existing?.lockedUntil && existing.lockedUntil > now)
    throw new AppError(429, 'OTP_LOCKED', 'Too many wrong attempts', { retryAfterSec: Math.ceil((+existing.lockedUntil - +now) / 1000) });
  if (existing && +now - +existing.lastSentAt < OTP_RULES.resendCooldownSec * 1000)
    throw new AppError(429, 'OTP_RATE_LIMITED', 'Please wait before resending', { retryAfterSec: Math.ceil((OTP_RULES.resendCooldownSec * 1000 - (+now - +existing.lastSentAt)) / 1000) });
  const recent = (existing?.sendLog ?? []).filter((d) => +now - +d < 3600_000);
  if (recent.length >= OTP_RULES.maxSendsPerHour) throw new AppError(429, 'OTP_RATE_LIMITED', 'Hourly OTP limit reached');

  const code = crypto.randomInt(0, 10 ** OTP_RULES.length).toString().padStart(OTP_RULES.length, '0');
  await otpSender.send(phone, code); // throws PROVIDER_UNAVAILABLE; nothing saved, no account created
  await otpRepository.findOneAndUpdate({ phone }, {
    phone, codeHash: sha256(`${phone}:${code}`), expiresAt: new Date(+now + OTP_RULES.ttlSec * 1000),
    attempts: 0, lastSentAt: now, sendLog: [...recent, now], $unset: { lockedUntil: 1 },
  }, { upsert: true });
  return { expiresInSec: OTP_RULES.ttlSec, resendAfterSec: OTP_RULES.resendCooldownSec };
}

export async function verifyOtp(phone: string, code: string) {
  const now = new Date();
  const otp = await otpRepository.findOne({ phone });
  if (!otp) throw new AppError(400, 'OTP_INVALID');
  if (otp.lockedUntil && otp.lockedUntil > now) throw new AppError(429, 'OTP_LOCKED');
  if (otp.expiresAt < now) throw new AppError(400, 'OTP_EXPIRED');
  const ok = crypto.timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(sha256(`${phone}:${code}`)));
  if (!ok) {
    const attempts = otp.attempts + 1;
    const lock = attempts >= OTP_RULES.maxAttempts ? new Date(+now + OTP_RULES.lockMinutes * 60_000) : undefined;
    await otpRepository.updateOne({ _id: otp._id }, { attempts, ...(lock && { lockedUntil: lock }) });
    throw new AppError(lock ? 429 : 400, lock ? 'OTP_LOCKED' : 'OTP_INVALID');
  }
  // Single use: delete atomically; a double-tap second verify finds nothing.
  const consumed = await otpRepository.findOneAndDelete({ _id: otp._id, codeHash: otp.codeHash });
  if (!consumed) throw new AppError(400, 'OTP_INVALID');
}
