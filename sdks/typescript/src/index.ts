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
  audit: AuditModule;
  email: EmailModule;
  inbox: InboxModule;
  kyc: KycModule;
  memory: MemoryModule;
  reputation: ReputationModule;
  marketplace: MarketplaceModule;
  extensions: ExtensionsModule;

  constructor(cfg: OpenHeabConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
    this.fetcher = cfg.fetch || globalThis.fetch;

    this.identity = new IdentityModule(this);
    this.wallet = new WalletModule(this);
    this.audit = new AuditModule(this);
    this.email = new EmailModule(this);
    this.inbox = new InboxModule(this);
    this.kyc = new KycModule(this);
    this.memory = new MemoryModule(this);
    this.reputation = new ReputationModule(this);
    this.marketplace = new MarketplaceModule(this);
    this.extensions = new ExtensionsModule(this);
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

export { HttpError };
export default OpenHeab;
