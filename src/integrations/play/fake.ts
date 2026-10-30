import { PlayClient, ProductPurchase, SubscriptionPurchase, VoidedPurchase } from './index';

/** In-memory Play client for tests: preload purchases by token, inspect calls afterwards. */
export class FakePlayClient implements PlayClient {
  products = new Map<string, ProductPurchase>();
  subscriptions = new Map<string, SubscriptionPurchase>();
  voided: VoidedPurchase[] = [];
  acknowledged: string[] = [];
  refunded: string[] = [];
  async getProduct(_productId: string, token: string) {
    const p = this.products.get(token); if (!p) throw Object.assign(new Error('not found'), { code: 404 }); return p;
  }
  async acknowledgeProduct(_productId: string, token: string) { this.acknowledged.push(token); }
  async getSubscription(token: string) {
    const s = this.subscriptions.get(token); if (!s) throw Object.assign(new Error('not found'), { code: 404 }); return s;
  }
  async acknowledgeSubscription(_productId: string, token: string) { this.acknowledged.push(token); }
  async refundOrder(orderId: string) { this.refunded.push(orderId); }
  async listVoided() { return this.voided; }
}
