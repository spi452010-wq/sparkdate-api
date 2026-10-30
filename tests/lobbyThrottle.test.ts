process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
process.env.NODE_ENV = 'test'; process.env.MEDIA_URL_SECRET = 'm'.repeat(40); process.env.MONGO_URI = 'mongodb://placeholder';
process.env.LIVE_LOBBY_THROTTLE_MS = '300';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { User } from '../src/modules/users/user.model';
import { Event } from '../src/modules/events/event.model';
import { Booking } from '../src/modules/bookings/booking.model';
import { join, setLiveEmitter, resetLobbyThrottle } from '../src/modules/live/live.service';
import { setLiveStore } from '../src/integrations/livestore';
import { MemoryLiveStore } from '../src/integrations/livestore/fake';

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); setLiveStore(new MemoryLiveStore()); });
afterAll(async () => { resetLobbyThrottle(); await mongoose.disconnect(); await mongo.stop(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('coalesces lobby:state: N rapid joins -> bounded emits, last emit carries the final count', async () => {
  const emits: { at: number; data: any }[] = [];
  setLiveEmitter({ toUser() {}, toEvent(_e: string, ev: string, data: any) { if (ev === 'lobby:state') emits.push({ at: Date.now(), data }); }, isOnline: async () => false });
  const ev = await Event.create({ title: 'T', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3600_000), roundMinutes: 1,
    status: 'live', capacity: { male: 50, female: 50 }, createdBy: new mongoose.Types.ObjectId() });
  const eventId = String(ev._id); const N = 40;
  const users = await User.insertMany(Array.from({ length: N }, (_, i) => ({ phone: `+9192000${String(i).padStart(5, '0')}`, profileCompleted: true,
    verification: { status: 'approved' }, profile: { fullName: `U${i}`, gender: i % 2 ? 'female' : 'male', interestedIn: i % 2 ? 'male' : 'female', dob: new Date('1995-01-01') } })));
  await Booking.insertMany(users.map((u: any) => ({ eventId, userId: u._id, gender: u.profile.gender, status: 'confirmed' })));

  const t0 = Date.now();
  await Promise.all(users.map((u) => join(String(u._id), eventId)));
  const elapsed = Date.now() - t0;
  await sleep(700); // let the trailing emit fire
  const bound = Math.ceil(elapsed / 300) + 2; // one leading + one per window + trailing
  expect(emits.length).toBeLessThanOrEqual(bound);
  expect(emits.length).toBeLessThan(N);
  for (let i = 1; i < emits.length; i++) expect(emits[i].at - emits[i - 1].at).toBeGreaterThanOrEqual(290);
  expect(emits[emits.length - 1].data).toMatchObject({ eventId, waiting: N });
});
