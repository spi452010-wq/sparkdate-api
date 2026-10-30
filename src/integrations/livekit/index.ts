import { AccessToken } from 'livekit-server-sdk';
import { logger } from '../../utils/logger';

export interface LiveKitTokenRequest { room: string; identity: string; name?: string; ttlSec: number }
/** Mints LiveKit join tokens. Rooms auto-create on first join (server default emptyTimeout should be 30 s). */
export interface LiveKitClient {
  readonly url: string;
  mintToken(r: LiveKitTokenRequest): Promise<string>;
}

/** Real client: a JWT signed with the API secret, granting roomJoin to exactly one room. No network call. */
export class LiveKitTokenClient implements LiveKitClient {
  constructor(readonly url: string, private key: string, private secret: string) {}
  async mintToken({ room, identity, name, ttlSec }: LiveKitTokenRequest) {
    const at = new AccessToken(this.key, this.secret, { identity, name, ttl: Math.max(1, Math.ceil(ttlSec)) });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true,
      roomCreate: false, roomList: false, roomAdmin: false, roomRecord: false });
    return at.toJwt();
  }
}

/** Dev only, when LIVEKIT_* are unset (production refuses to start without them, see config/env.ts). */
class UnconfiguredLiveKit implements LiveKitClient {
  readonly url = '';
  async mintToken(r: LiveKitTokenRequest) { logger.warn({ room: r.room }, 'LIVEKIT_* not set: issuing a dev placeholder token'); return `dev-unsigned.${r.room}.${r.identity}`; }
}

let client: LiveKitClient | undefined;
export function getLiveKit(): LiveKitClient {
  if (!client) {
    const { LIVEKIT_URL: u, LIVEKIT_API_KEY: k, LIVEKIT_API_SECRET: s } = process.env;
    client = u && k && s ? new LiveKitTokenClient(u, k, s) : new UnconfiguredLiveKit();
  }
  return client;
}
/** Test seam. */
export const setLiveKit = (c: LiveKitClient) => { client = c; };
