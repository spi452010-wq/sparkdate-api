// Usage: ADMIN_EMAIL=a@b.com ADMIN_PASSWORD='...' ADMIN_ROLE=admin npm run create-admin
// Password comes from env so it never lands in shell history args or logs.
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User } from '../modules/auth/user.model';
import { hashPassword } from '../modules/auth/password';
(async () => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(); const pw = process.env.ADMIN_PASSWORD; const role = process.env.ADMIN_ROLE ?? 'admin';
  if (!email || !pw || pw.length < 12 || !['admin', 'host'].includes(role)) { console.error('Need ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), ADMIN_ROLE admin|host'); process.exit(1); }
  await mongoose.connect(env.MONGO_URI);
  await User.updateOne({ email }, { $set: { email, role, passwordHash: await hashPassword(pw), status: 'active' } }, { upsert: true });
  console.log(`Saved ${role} ${email}`); await mongoose.disconnect();
})();
