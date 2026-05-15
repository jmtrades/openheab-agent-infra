/**
 * OpenHeab Substrate — TypeScript client SDK
 *
 * Usage:
 *   import { OpenHeab } from '@openheab/sdk';
 *   const client = new OpenHeab({ baseUrl: 'https://openheab.com' });
 *   const agent = await client.identity.create({ name: 'my-agent' });
 *   client.useApiKey(agent.api_key);
 *   const balance = await client.wallet.balance(agent.did);
 */

export interface OpenHeabConfig {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface Identity {
  did: string;
  public_key: string;
  private_key: string;
  api_key: string;
  wallet?: { address: string; chain: string };
}

export interface WalletBalance {
  agent_did: string;
  chain: string;
  address: string;
  asset: 'USDC';
  balance_raw: string;
  balance: string;
}

export interface BankTransfer {
  tx_hash: string;
  from_address: string;
  to_address: string;
  gross: string;
  fee_raw: string;
  net_raw: string;
  chain: string;
  status: 'pending' | 'confirmed' | 'failed';
  audit_hash: string | null;
}

export interface AuditVerifyResult {
  valid: boolean;
  verified: number;
  total: number;
}

class HttpError extends Error {
  constructor(public status: number, public body: any) {
    super(`HTTP ${status}: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
}

export class OpenHeab {
  private baseUrl: string;
  private apiKey?: string;
  private fetcher: typeof fetch;

  identity: IdentityModule;
  wallet: WalletModule;
  bank: BankModule;
  cards: CardsModule;
  savings: SavingsModule;
  audit: AuditModule;
  email: EmailModule;
  inbox: InboxModule;
  kyc: KycModule;
  memory: MemoryModule;
  reputation: ReputationModule;
  marketplace: MarketplaceModule;
  extensions: ExtensionsModule;
  inference: InferenceModule;
  org: OrgModule;
  subscriptions: SubscriptionsModule;
  credits: CreditsModule;
  onboarding: OnboardingModule;

  constructor(cfg: OpenHeabConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
    this.fetcher = cfg.fetch || globalThis.fetch;

    this.identity = new IdentityModule(this);
    this.wallet = new WalletModule(this);
    this.bank = new BankModule(this);
    this.cards = new CardsModule(this);
    this.savings = new SavingsModule(this);
    this.audit = new AuditModule(this);
    this.email = new EmailModule(this);
    this.inbox = new InboxModule(this);
    this.kyc = new KycModule(this);
    this.memory = new MemoryModule(this);
    this.reputation = new ReputationModule(this);
    this.marketplace = new MarketplaceModule(this);
    this.extensions = new ExtensionsModule(this);
    this.inference = new InferenceModule(this);
    this.org = new OrgModule(this);
    this.subscriptions = new SubscriptionsModule(this);
    this.credits = new CreditsModule(this);
    this.onboarding = new OnboardingModule(this);
  }

  useApiKey(key: string) { this.apiKey = key; }

  async request<T = any>(
    method: string, path: string,
    opts: { body?: any; query?: Record<string, any>; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.headers || {})
    };
    if (this.apiKey && !headers['authorization']) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    const res = await this.fetcher(url.toString(), {
      method, headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let body: any;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) body = await res.json().catch(() => null);
    else body = await res.text();
    if (!res.ok) throw new HttpError(res.status, body);
    return body as T;
  }
}

class IdentityModule {
  constructor(private c: OpenHeab) {}
  create(metadata?: Record<string, any>) {
    return this.c.request<Identity>('POST', '/v1/identities', { body: metadata || {} });
  }
  get(did: string) {
    return this.c.request<{ did: string; public_key: string; created_at: string; metadata: any }>(
      'GET', `/v1/identities/${did}`
    );
  }
}

class WalletModule {
  constructor(private c: OpenHeab) {}
  provision(did: string) {
    return this.c.request('POST', `/v1/agents/${did}/wallet/provision`);
  }
  balance(did: string) {
    return this.c.request<WalletBalance>('GET', `/v1/agents/${did}/wallet/balance`);
  }
  transfer(did: string, args: { to_did?: string; to_address?: string; amount_usdc: string; reason?: string }, idempotencyKey?: string) {
    return this.c.request<BankTransfer>('POST', `/v1/agents/${did}/wallet/transfer`, {
      body: args, headers: idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}
    });
  }
  transactions(did: string, limit = 50) {
    return this.c.request<{ agent_did: string; transactions: any[] }>(
      'GET', `/v1/agents/${did}/wallet/transactions`, { query: { limit } }
    );
  }
}

class AuditModule {
  constructor(private c: OpenHeab) {}
  verify(limit = 1000) {
    return this.c.request<AuditVerifyResult>('GET', '/v1/audit/verify', { query: { limit } });
  }
  chain(limit = 100, offset = 0) {
    return this.c.request<{ entries: any[] }>('GET', '/v1/audit/chain', { query: { limit, offset } });
  }
}

class EmailModule {
  constructor(private c: OpenHeab) {}
  claimAddress(did: string, localPart: string) {
    return this.c.request('POST', `/v1/agents/${did}/email/address`, { body: { local_part: localPart } });
  }
  send(did: string, msg: { to: string; cc?: string[]; subject?: string; body_text?: string; body_html?: string; in_reply_to?: string }) {
    return this.c.request('POST', `/v1/agents/${did}/email/send`, { body: msg });
  }
  list(did: string, direction: 'in' | 'out' = 'in', limit = 50) {
    return this.c.request<{ messages: any[] }>('GET', `/v1/agents/${did}/email/messages`, { query: { direction, limit } });
  }
}

class InboxModule {
  constructor(private c: OpenHeab) {}
  receive(did: string, envelope: any) {
    return this.c.request('POST', `/v1/agents/${did}/inbox/receive`, { body: envelope });
  }
  list(did: string, status?: string, limit = 50) {
    return this.c.request<{ envelopes: any[] }>('GET', `/v1/agents/${did}/inbox`, { query: { status, limit } });
  }
  ack(did: string, envelopeId: string) {
    return this.c.request('POST', `/v1/agents/${did}/inbox/${envelopeId}/ack`);
  }
}

class KycModule {
  constructor(private c: OpenHeab) {}
  submitClaim(did: string, claim: { claim_type: string; claim_value: string }) {
    return this.c.request('POST', `/v1/agents/${did}/kyc/claims`, { body: claim });
  }
  verify(did: string) {
    return this.c.request<{ result: 'clear' | 'flagged' | 'incomplete'; claims: Record<string, any>; sanctions_matches: any[] }>(
      'GET', `/v1/agents/${did}/kyc/verify`
    );
  }
  tier(did: string) {
    return this.c.request('GET', `/v1/agents/${did}/kyc/tier`);
  }
}

class MemoryModule {
  constructor(private c: OpenHeab) {}
  kvPut(did: string, key: string, value: any, ttlSeconds?: number) {
    return this.c.request('PUT', `/v1/agents/${did}/memory/kv/${key}`, { body: { value, ttl_seconds: ttlSeconds } });
  }
  kvGet(did: string, key: string) {
    return this.c.request('GET', `/v1/agents/${did}/memory/kv/${key}`);
  }
  search(did: string, query: string, k = 10) {
    return this.c.request<{ results: any[] }>('POST', `/v1/agents/${did}/memory/search`, { body: { query, k } });
  }
}

class ReputationModule {
  constructor(private c: OpenHeab) {}
  vouch(did: string, targetDid: string, args: { domain: string; weight?: number }) {
    return this.c.request('POST', `/v1/agents/${did}/reputation/vouch`, { body: { target_did: targetDid, ...args } });
  }
}

class MarketplaceModule {
  constructor(private c: OpenHeab) {}
  list(filters?: Record<string, any>) {
    return this.c.request<{ listings: any[] }>('GET', '/v1/marketplace/listings', { query: filters });
  }
}

class ExtensionsModule {
  constructor(private c: OpenHeab) {}
  list(filters: { category?: string; q?: string; sort?: string; limit?: number } = {}) {
    return this.c.request<{ extensions: any[] }>('GET', '/v1/extensions', { query: filters });
  }
  get(slug: string) {
    return this.c.request('GET', `/v1/extensions/${slug}`);
  }
  invoke(slug: string, callerDid: string, input: any) {
    return this.c.request('POST', `/v1/extensions/${slug}/invoke`, {
      body: { input }, headers: { 'x-agent-did': callerDid }
    });
  }
}

// ----------------------------------------------------------------------------
// Bank, cards, savings, inference, org, subscriptions, credits, onboarding
// ----------------------------------------------------------------------------
class BankModule {
  constructor(private c: OpenHeab) {}
  account(did: string, opts: { fast?: boolean } = {}) {
    return this.c.request('GET', `/v1/agents/${did}/bank`, { query: opts.fast ? { fast: '1' } : {} });
  }
  statement(did: string, opts: { from?: string; to?: string; format?: 'json' | 'csv' } = {}) {
    return this.c.request('GET', `/v1/agents/${did}/bank/statement`, { query: opts });
  }
  deposits(did: string, limit = 50) {
    return this.c.request<{ deposits: any[] }>('GET', `/v1/agents/${did}/bank/deposits`, { query: { limit } });
  }
  reconcile(did: string) {
    return this.c.request<{ in_sync: boolean; drift_cents: number; ledger_cents: number; onchain_cents: number }>(
      'POST', `/v1/agents/${did}/bank/reconcile`
    );
  }
  sweep(did: string, args: {
    from: 'wallet' | 'ledger' | 'savings';
    to: 'wallet' | 'ledger' | 'savings' | 'lending_repay';
    amount_cents: number;
    savings_account_id?: string;
    loan_id?: string;
  }) {
    return this.c.request('POST', `/v1/agents/${did}/bank/sweep`, { body: args });
  }
}

class CardsModule {
  constructor(private c: OpenHeab) {}
  issue(did: string, args: { kind?: 'virtual' | 'physical'; monthly_limit_cents?: number; per_tx_limit_cents?: number; shipping_address?: any } = {}) {
    return this.c.request('POST', `/v1/agents/${did}/cards`, { body: args });
  }
  list(did: string) {
    return this.c.request<{ cards: any[] }>('GET', `/v1/agents/${did}/cards`);
  }
  freeze(did: string, cardId: string) {
    return this.c.request('POST', `/v1/agents/${did}/cards/${cardId}/freeze`);
  }
  cancel(did: string, cardId: string) {
    return this.c.request('POST', `/v1/agents/${did}/cards/${cardId}/cancel`);
  }
}

class SavingsModule {
  constructor(private c: OpenHeab) {}
  open(did: string, args: { strategy?: string; auto_compound?: boolean; lock_until?: string } = {}) {
    return this.c.request('POST', `/v1/agents/${did}/savings/accounts`, { body: args });
  }
  list(did: string) {
    return this.c.request<{ accounts: any[] }>('GET', `/v1/agents/${did}/savings/accounts`);
  }
  deposit(did: string, accountId: string, amountRaw: string) {
    return this.c.request('POST', `/v1/agents/${did}/savings/accounts/${accountId}/deposit`, { body: { amount_raw: amountRaw } });
  }
  withdraw(did: string, accountId: string, amountRaw: string) {
    return this.c.request('POST', `/v1/agents/${did}/savings/accounts/${accountId}/withdraw`, { body: { amount_raw: amountRaw } });
  }
}

class InferenceModule {
  constructor(private c: OpenHeab) {}
  chat(did: string, args: { model: string; messages: any[]; max_tokens?: number; temperature?: number }) {
    return this.c.request('POST', `/v1/agents/${did}/inference/chat`, { body: args });
  }
  embeddings(did: string, args: { model: string; input: string[] }) {
    return this.c.request('POST', `/v1/agents/${did}/inference/embeddings`, { body: args });
  }
}

class OrgModule {
  constructor(private c: OpenHeab) {}
  create(args: { name: string; slug?: string; kind?: string; owner_did: string; billing_email?: string }) {
    return this.c.request('POST', '/v1/orgs', { body: args });
  }
  get(orgId: string) {
    return this.c.request('GET', `/v1/orgs/${orgId}`);
  }
  members(orgId: string) {
    return this.c.request<{ members: any[] }>('GET', `/v1/orgs/${orgId}/members`);
  }
  invite(orgId: string, args: { email: string; role?: string }) {
    return this.c.request('POST', `/v1/orgs/${orgId}/invites`, { body: args });
  }
}

class SubscriptionsModule {
  constructor(private c: OpenHeab) {}
  plans() {
    return this.c.request<{ plans: any[] }>('GET', '/v1/subscriptions/plans');
  }
  subscribe(orgId: string, args: { plan_code: string; trial_days?: number; payment_method_id?: string; billing_interval?: 'monthly' | 'annual' }) {
    return this.c.request('POST', `/v1/orgs/${orgId}/subscription`, { body: args });
  }
  current(orgId: string) {
    return this.c.request('GET', `/v1/orgs/${orgId}/subscription`);
  }
  upgrade(orgId: string, newPlanCode: string) {
    return this.c.request('POST', `/v1/orgs/${orgId}/subscription/upgrade`, { body: { new_plan_code: newPlanCode } });
  }
  cancel(orgId: string, atPeriodEnd = true) {
    return this.c.request('POST', `/v1/orgs/${orgId}/subscription/cancel`, { body: { at_period_end: atPeriodEnd } });
  }
}

class CreditsModule {
  constructor(private c: OpenHeab) {}
  packs() {
    return this.c.request<{ packs: any[] }>('GET', '/v1/credits/packs');
  }
  purchase(orgId: string, packCode: string, paymentMethodId?: string) {
    return this.c.request('POST', `/v1/orgs/${orgId}/credits/purchase`, {
      body: { pack_code: packCode, payment_method_id: paymentMethodId }
    });
  }
  balance(orgId: string) {
    return this.c.request('GET', `/v1/orgs/${orgId}/credits/balance`);
  }
}

class OnboardingModule {
  constructor(private c: OpenHeab) {}
  start(did: string, args: { source?: string; utm_source?: string; org_id?: string } = {}) {
    return this.c.request('POST', `/v1/agents/${did}/onboarding/start`, { body: args });
  }
  state(did: string) {
    return this.c.request('GET', `/v1/agents/${did}/onboarding`);
  }
  complete(did: string, stepCode: string, evidencePayload?: any) {
    return this.c.request('POST', `/v1/agents/${did}/onboarding/complete`, {
      body: { step_code: stepCode, evidence_payload: evidencePayload }
    });
  }
}

export { HttpError };
export default OpenHeab;
