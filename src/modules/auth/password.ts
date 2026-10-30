import argon2 from 'argon2';
const OPTS = { type: argon2.argon2id as 2, memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP baseline
export const hashPassword = (pw: string) => argon2.hash(pw, OPTS);
let dummy: Promise<string> | undefined;
export async function verifyPassword(pw: string, stored?: string | null) {
  // Unknown email still runs a hash so response time doesn't reveal which emails exist.
  const h = stored ?? (await (dummy ??= argon2.hash('not-a-real-password', OPTS)));
  try { return (await argon2.verify(h, pw)) && !!stored; } catch { return false; }
}
