import { assertSafeSeedTarget } from '../scripts/seed-load';

describe('seed:load safety guard', () => {
  it('allows local hosts', () => {
    for (const h of ['localhost:27017', '127.0.0.1', 'mongodb-memory:1234'])
      expect(() => assertSafeSeedTarget({ MONGO_URI: `mongodb://${h}/sparkdate` })).not.toThrow();
  });
  it('refuses production even on localhost', () => {
    expect(() => assertSafeSeedTarget({ NODE_ENV: 'production', MONGO_URI: 'mongodb://localhost/x' })).toThrow(/production/);
  });
  it('refuses remote hosts unless opted in with a test db', () => {
    expect(() => assertSafeSeedTarget({ MONGO_URI: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/sparkdate_test' })).toThrow(/remote/);
    expect(() => assertSafeSeedTarget({ SEED_ALLOW_REMOTE: '1', MONGO_URI: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/sparkdate' })).toThrow(/remote/);
    expect(() => assertSafeSeedTarget({ MONGO_URI: 'mongodb://localhost,db.example.com/x' })).toThrow(/remote/);
    expect(assertSafeSeedTarget({ SEED_ALLOW_REMOTE: '1', MONGO_URI: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/sparkdate_test?retryWrites=true' }).remote).toBe(true);
  });
  it('refuses a missing URI', () => { expect(() => assertSafeSeedTarget({})).toThrow(/MONGO_URI/); });
});
