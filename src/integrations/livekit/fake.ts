import { LiveKitClient, LiveKitTokenRequest } from './index';

/** Records token requests; `failures` makes the next N mints throw (tests the retry / no:match path). */
export class FakeLiveKit implements LiveKitClient {
  readonly url = 'wss://livekit.test';
  minted: LiveKitTokenRequest[] = []; failures = 0;
  async mintToken(r: LiveKitTokenRequest) {
    if (this.failures > 0) { this.failures--; throw new Error('livekit down'); }
    this.minted.push(r);
    return `fake.${r.room}.${r.identity}.${r.ttlSec}`;
  }
}
