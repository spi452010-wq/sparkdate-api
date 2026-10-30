import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

export interface ProductPurchase {
  purchaseState: number; // 0 purchased, 1 cancelled, 2 pending
  acknowledgementState?: number; consumptionState?: number;
  orderId?: string; productId?: string; purchaseTimeMillis?: string;
  obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string;
}
export interface SubscriptionPurchase {
  subscriptionState: string; // SUBSCRIPTION_STATE_ACTIVE | _IN_GRACE_PERIOD | _ON_HOLD | _PAUSED | _CANCELED | _EXPIRED | _PENDING ...
  acknowledgementState?: string; latestOrderId?: string; startTime?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems: { productId: string; expiryTime: string; autoRenewingPlan?: { autoRenewEnabled?: boolean } }[];
}
export interface VoidedPurchase { purchaseToken: string; orderId?: string; productType?: number }

/** Google Play Developer API client. Thin wrapper over the Google Play Developer API so tests can inject a fake. */
export interface PlayClient {
  getProduct(productId: string, token: string): Promise<ProductPurchase>;
  acknowledgeProduct(productId: string, token: string): Promise<void>;
  getSubscription(token: string): Promise<SubscriptionPurchase>;
  acknowledgeSubscription(productId: string, token: string): Promise<void>;
  refundOrder(orderId: string): Promise<void>;
  listVoided(startTimeMs: number): Promise<VoidedPurchase[]>;
}

/** Google returns 400/404/410 for bad tokens; everything else is treated as transient. */
export const mapPlayError = (e: any): AppError => {
  if (e instanceof AppError) return e;
  const code = Number(e?.code ?? e?.response?.status);
  if ([400, 404, 410].includes(code)) return new AppError(400, 'PURCHASE_INVALID', 'Purchase not found or invalid');
  return new AppError(503, 'PLAY_UNAVAILABLE', 'Google Play is unavailable, retry later');
};

class GooglePlayClient implements PlayClient {
  private ap: any; private pkg = env.PLAY_PACKAGE_NAME;
  constructor() {
    const { androidpublisher, auth } = require('@googleapis/androidpublisher');
    this.ap = androidpublisher({ version: 'v3', auth: new auth.GoogleAuth({ keyFile: env.GOOGLE_PLAY_SA_JSON_PATH, scopes: ['https://www.googleapis.com/auth/androidpublisher'] }) });
  }
  private async call<T>(f: () => Promise<{ data: T }>): Promise<T> { try { return (await f()).data; } catch (e) { throw mapPlayError(e); } }
  getProduct(productId: string, token: string) { return this.call<ProductPurchase>(() => this.ap.purchases.products.get({ packageName: this.pkg, productId, token })); }
  async acknowledgeProduct(productId: string, token: string) { await this.call(() => this.ap.purchases.products.acknowledge({ packageName: this.pkg, productId, token, requestBody: {} })); }
  getSubscription(token: string) { return this.call<SubscriptionPurchase>(() => this.ap.purchases.subscriptionsv2.get({ packageName: this.pkg, token })); }
  async acknowledgeSubscription(subscriptionId: string, token: string) { await this.call(() => this.ap.purchases.subscriptions.acknowledge({ packageName: this.pkg, subscriptionId, token, requestBody: {} })); }
  async refundOrder(orderId: string) { await this.call(() => this.ap.orders.refund({ packageName: this.pkg, orderId, revoke: true })); }
  async listVoided(startTimeMs: number) {
    const d = await this.call<any>(() => this.ap.purchases.voidedpurchases.list({ packageName: this.pkg, startTime: String(startTimeMs), type: 1, maxResults: 1000 }));
    return (d.voidedPurchases ?? []) as VoidedPurchase[];
  }
}

/** Used when Play is not configured (dev): every call fails as retryable, nothing is ever accepted. */
class UnconfiguredPlayClient implements PlayClient {
  private no(): never { throw new AppError(503, 'PLAY_UNAVAILABLE', 'Google Play is not configured on this server'); }
  async getProduct(): Promise<ProductPurchase> { this.no(); }
  async acknowledgeProduct() { this.no(); }
  async getSubscription(): Promise<SubscriptionPurchase> { this.no(); }
  async acknowledgeSubscription() { this.no(); }
  async refundOrder() { this.no(); }
  async listVoided(): Promise<VoidedPurchase[]> { this.no(); }
}

let client: PlayClient | undefined;
export const getPlayClient = () => (client ??= env.PLAY_PACKAGE_NAME && env.GOOGLE_PLAY_SA_JSON_PATH ? new GooglePlayClient() : new UnconfiguredPlayClient());
export const setPlayClient = (c: PlayClient) => { client = c; };
