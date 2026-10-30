process.env.NODE_ENV = 'test'; process.env.MONGO_URI = 'mongodb://placeholder';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40); process.env.JWT_REFRESH_SECRET = 'b'.repeat(40); process.env.MEDIA_URL_SECRET = 'm'.repeat(40);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findUnsafeSecrets } = require('../src/config/env') as typeof import('../src/config/env');

const strong = (c: string) => c.repeat(48);

describe('findUnsafeSecrets', () => {
  it('flags .env.example placeholders', () => {
    expect(findUnsafeSecrets({
      JWT_ACCESS_SECRET: 'change-me-min-32-chars',
      JWT_REFRESH_SECRET: 'change-me-too-min-32-chars',
      MEDIA_URL_SECRET: 'change-me-min-32-chars-media',
    }).sort()).toEqual(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MEDIA_URL_SECRET']);
  });
  it('flags reused secrets', () => {
    const s = 'k9Qz3vLm8Rt2Wp7Yb4Nc6Hd1Fg5Js0Ka';
    expect(findUnsafeSecrets({ JWT_ACCESS_SECRET: s, JWT_REFRESH_SECRET: s, MEDIA_URL_SECRET: s + 'q' }).sort())
      .toEqual(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']);
  });
  it('accepts distinct random secrets', () => {
    expect(findUnsafeSecrets({
      JWT_ACCESS_SECRET: 'a1' + strong('b'), JWT_REFRESH_SECRET: 'c2' + strong('d'), MEDIA_URL_SECRET: 'e3' + strong('f'),
    })).toEqual([]);
  });
});
