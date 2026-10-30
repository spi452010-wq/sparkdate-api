/* Seeds a live-ready event with 150 male + 150 female users for the /live load test (npm run load:live).
 * Usage:  npm run seed:load            -> creates data, writes tokens, prints LOAD_EVENT_ID
 *         npm run seed:load -- --clean -> deletes ONLY documents tagged by this script (seedTag)
 * Env: MONGO_URI (local by default), LOAD_TOKENS_FILE (default ./load-tokens.txt), SEED_TAG (default 'load-seed'),
 *      SEED_START_IN_MIN (default 5), SEED_DURATION_MIN (default 60), SEED_ROUND_MIN (default 3).
 * Never drops anything. Refuses NODE_ENV=production and any non-local database unless SEED_ALLOW_REMOTE=1 and the db name contains 'test'.
 * With REDIS_URL set, the event's timeline jobs go to the shared queue and the running API executes them;
 * without it they live in this process only, so start the event manually (admin) or run against a server with REDIS_URL. */
import { writeFileSync, chmodSync } from 'node:fs';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'mongodb-memory'];

/** Throws unless the target database is clearly a disposable one. Pure: safe to unit-test. */
export function assertSafeSeedTarget(e: Record<string, string | undefined>) {
  if (e.NODE_ENV === 'production') throw new Error('seed:load refuses to run with NODE_ENV=production');
  const uri = e.MONGO_URI ?? '';
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/.exec(uri);
  if (!m) throw new Error('seed:load: MONGO_URI is missing or not a mongodb:// URI');
  const hosts = m[1].split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase());
  const db = decodeURIComponent(m[2] ?? '');
  if (hosts.every((h) => LOCAL_HOSTS.includes(h))) return { hosts, db, remote: false };
  if (e.SEED_ALLOW_REMOTE === '1' && /test/i.test(db)) return { hosts, db, remote: true };
  throw new Error(`seed:load refuses remote database ${hosts.join(',')}/${db || '(none)'}: set SEED_ALLOW_REMOTE=1 and use a db name containing "test"`);
}

const N_PER_GENDER = 150;
const INTERESTS = ['music', 'travel', 'movies', 'fitness', 'books', 'food', 'art', 'tech', 'cricket', 'dance'];
const CITIES = ['Indore', 'Pune', 'Bhopal', 'Mumbai'];

async function main() {
  assertSafeSeedTarget(process.env); // before anything connects
  const mongoose = (await import('mongoose')).default;
  const { env } = await import('../src/config/env');
  const { User } = await import('../src/modules/users/user.model');
  const { Event } = await import('../src/modules/events/event.model');
  const { Booking } = await import('../src/modules/bookings/booking.model');
  const { Block } = await import('../src/modules/blocks/block.model');
  const { RefreshToken } = await import('../src/modules/auth/refreshToken.model');
  const adminEvents = await import('../src/modules/events/adminEvents.service');
  const { issueTokens } = await import('../src/modules/auth/tokens');
  const tag = process.env.SEED_TAG ?? 'load-seed';
  await mongoose.connect(env.MONGO_URI);
  const tagged = { seedTag: tag };
  try {
    if (process.argv.includes('--clean')) {
      const users = (await User.collection.find(tagged, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
      const r: Record<string, number> = {};
      r.refreshTokens = (await RefreshToken.collection.deleteMany({ user: { $in: users } })).deletedCount;
      for (const [name, M] of [['bookings', Booking], ['blocks', Block], ['events', Event], ['users', User]] as const)
        r[name] = (await (M as any).collection.deleteMany(tagged)).deletedCount;
      console.log(`seed:load --clean (${tag}):`, r);
      return;
    }
    const startInMin = Number(process.env.SEED_START_IN_MIN ?? 5); const durMin = Number(process.env.SEED_DURATION_MIN ?? 60);
    const roundMinutes = Number(process.env.SEED_ROUND_MIN ?? 3);
    const run = Date.now().toString().slice(-6); // keeps phones unique across runs
    const host = await User.create({ email: `seed-host-${run}@load.test`, role: 'admin', status: 'active' });
    await User.collection.updateOne({ _id: host._id }, { $set: tagged });

    const docs = [] as any[];
    for (const gender of ['male', 'female'] as const) for (let i = 0; i < N_PER_GENDER; i++) {
      const k = docs.length;
      docs.push({ phone: `+916${run}${String(k).padStart(3, '0')}`, role: 'user', status: 'active', profileCompleted: true,
        verification: { status: 'approved' },
        profile: { fullName: `Load ${gender === 'male' ? 'M' : 'F'}${i}`, gender, interestedIn: gender === 'male' ? 'female' : 'male',
          dob: new Date(1990 + (k % 12), k % 12, 1 + (k % 27)), city: CITIES[k % CITIES.length], bio: `Load test user ${k}`,
          interests: [INTERESTS[k % 10], INTERESTS[(k * 3 + 1) % 10], INTERESTS[(k * 7 + 2) % 10]].filter((x, j, a) => a.indexOf(x) === j) } });
    }
    const users = await User.insertMany(docs); // schema validation applies
    await User.collection.updateMany({ _id: { $in: users.map((u) => u._id) } }, { $set: tagged });

    const startsAt = new Date(Date.now() + startInMin * 60_000);
    const ev = await adminEvents.create({ id: String(host._id), role: 'admin' }, {
      title: `Load test ${run}`, city: 'Indore', startsAt, endsAt: new Date(+startsAt + durMin * 60_000), roundMinutes,
      priceInPaise: 0, status: 'published', capacity: { male: N_PER_GENDER, female: N_PER_GENDER } });
    const eventId = String((ev as any).id ?? (ev as any)._id);
    await Event.collection.updateOne({ _id: new mongoose.Types.ObjectId(eventId) }, { $set: { ...tagged, booked: { male: N_PER_GENDER, female: N_PER_GENDER } } });

    const bookings = await Booking.insertMany(users.map((u: any) => ({ eventId, userId: u._id, gender: u.profile.gender, status: 'confirmed', amountInPaise: 0, confirmedAt: new Date() })));
    await Booking.collection.updateMany({ _id: { $in: bookings.map((b) => b._id) } }, { $set: tagged });

    const males = users.filter((u: any) => u.profile.gender === 'male'); const females = users.filter((u: any) => u.profile.gender === 'female');
    const blocks = await Block.insertMany([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i % 2
      ? { blockerId: females[i * 3]._id, blockedId: males[i * 5]._id } : { blockerId: males[i * 7]._id, blockedId: females[i * 2]._id }));
    await Block.collection.updateMany({ _id: { $in: blocks.map((b) => b._id) } }, { $set: tagged });

    const tokens: string[] = [];
    for (const u of users) tokens.push((await issueTokens(String(u._id), 'user')).accessToken); // real signing via config secrets
    const file = process.env.LOAD_TOKENS_FILE ?? './load-tokens.txt';
    writeFileSync(file, tokens.join('\n') + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
    console.log(`seed:load (${tag}): ${users.length} users, ${bookings.length} confirmed bookings, ${blocks.length} blocks; tokens -> ${file}`);
    console.log(`event starts ${startsAt.toISOString()}, ${durMin} min, ${roundMinutes}-min rounds${env.REDIS_URL ? '' : ' (no REDIS_URL: timeline jobs were NOT shared with the API)'}`);
    console.log(`LOAD_EVENT_ID=${eventId}`);
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
