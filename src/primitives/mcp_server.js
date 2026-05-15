// ============================================================================
// OpenHeab MCP Server — Exposes the agent-native substrate as an MCP server.
// JSON-RPC 2.0 transport at POST /mcp; discovery at GET /.well-known/mcp.json.
// invokeTool resolves :param placeholders from args, forwards remaining
// args as querystring (GET) or body (POST), preserves auth headers.
// ============================================================================
const express = require('express');

const SERVER_NAME = 'openheab';
const SERVER_VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';

// ----------------------------------------------------------------------------
// Tool definitions — 34 entries
// ----------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'openheab.identity.create',
    description: 'Create a new OpenHeab agent identity (Ed25519 keypair + DID + API key + USDC wallet).',
    inputSchema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: 'Optional human-readable name' },
        purpose: { type: 'string', description: 'Optional purpose description' }
      }
    },
    method: 'POST', path: '/v1/identities'
  },
  {
    name: 'openheab.identity.get',
    description: 'Fetch the public DID document and metadata for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string', description: 'Agent DID' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/identities/:did'
  },
  {
    name: 'openheab.wallet.balance',
    description: 'Get the USDC balance and on-chain address for an agent wallet.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/wallet/balance'
  },
  {
    name: 'openheab.wallet.transfer',
    description: 'Transfer USDC from agent wallet to another address or agent DID.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        to_address: { type: 'string' },
        to_did: { type: 'string' },
        amount_cents: { type: 'integer', minimum: 1 },
        memo: { type: 'string' }
      },
      required: ['did', 'amount_cents']
    },
    method: 'POST', path: '/v1/agents/:did/wallet/transfer'
  },
  {
    name: 'openheab.inbox.send',
    description: 'Send a signed envelope to another agent inbox (DID-routed A2A messaging).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Recipient agent DID' },
        sender_did: { type: 'string' },
        body_plain: { type: 'string' },
        body_structured: { type: 'object' }
      },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/inbox/receive'
  },
  {
    name: 'openheab.inbox.list',
    description: 'List envelopes in an agent inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        status: { type: 'string', enum: ['unread', 'read', 'archived', 'actioned', 'dismissed'] },
        limit: { type: 'integer' }
      },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/inbox'
  },
  {
    name: 'openheab.memory.kv.set',
    description: 'Set a key/value entry in agent memory with optional TTL.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        key: { type: 'string' },
        value: {},
        ttl_seconds: { type: 'integer' }
      },
      required: ['did', 'key', 'value']
    },
    method: 'POST', path: '/v1/agents/:did/memory/kv'
  },
  {
    name: 'openheab.memory.kv.get',
    description: 'Get a key/value entry from agent memory.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' }, key: { type: 'string' } },
      required: ['did', 'key']
    },
    method: 'GET', path: '/v1/agents/:did/memory/kv/:key'
  },
  {
    name: 'openheab.memory.episodic.search',
    description: 'Semantic search over an agent\'s episodic memory.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer' }
      },
      required: ['did', 'query']
    },
    method: 'POST', path: '/v1/agents/:did/memory/episodic/search'
  },
  {
    name: 'openheab.reputation.vouch',
    description: 'Issue a reputation vouch for another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Voucher agent DID' },
        target_did: { type: 'string' },
        score: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' }
      },
      required: ['did', 'target_did', 'score']
    },
    method: 'POST', path: '/v1/agents/:did/reputation/vouch'
  },
  {
    name: 'openheab.reputation.get',
    description: 'Get the aggregated reputation score for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/reputation'
  },
  {
    name: 'openheab.kyc.submit',
    description: 'Submit a KYC claim (jurisdiction, operator, sanctions_clear, etc.) for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string', description: 'Subject agent DID' },
        claim_type: { type: 'string' },
        claim_value: {},
        confidence: { type: 'number' },
        expires_at: { type: 'string' }
      },
      required: ['did', 'claim_type', 'claim_value']
    },
    method: 'POST', path: '/v1/agents/:did/kyc/claims'
  },
  {
    name: 'openheab.kyc.verify',
    description: 'Run KYC verification (claim lookup + sanctions screening) for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/kyc/verify'
  },
  {
    name: 'openheab.email.create_address',
    description: 'Provision an inbound/outbound email address bound to an agent DID.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        local_part: { type: 'string' }
      },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/email/addresses'
  },
  {
    name: 'openheab.extensions.list',
    description: 'List available platform extensions (custom plugins agents can invoke).',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' }
      }
    },
    method: 'GET', path: '/v1/extensions'
  },
  {
    name: 'openheab.extensions.invoke',
    description: 'Invoke a platform extension with structured arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        slug: { type: 'string' },
        args: { type: 'object' }
      },
      required: ['did', 'slug']
    },
    method: 'POST', path: '/v1/agents/:did/extensions/:slug/invoke'
  },
  {
    name: 'openheab.inference.chat',
    description: 'Run a chat-completion call through the metered inference proxy.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        model: { type: 'string' },
        messages: { type: 'array' },
        max_tokens: { type: 'integer' }
      },
      required: ['did', 'model', 'messages']
    },
    method: 'POST', path: '/v1/agents/:did/inference/chat'
  },
  {
    name: 'openheab.security.scan',
    description: 'Scan a prompt, URL, or input for known attack patterns (prompt injection, secrets).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        content: { type: 'string' },
        kind: { type: 'string' }
      },
      required: ['did', 'content']
    },
    method: 'POST', path: '/v1/agents/:did/security/scan'
  },
  {
    name: 'openheab.tools.list',
    description: 'List tools in the curated + community registry.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' },
        tier: { type: 'string', enum: ['curated', 'community'] }
      }
    },
    method: 'GET', path: '/v1/tools'
  },
  {
    name: 'openheab.tools.install',
    description: 'Install a tool from the registry into an agent\'s toolbelt.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        agent_did: { type: 'string' },
        version: { type: 'string' },
        pinned: { type: 'boolean' }
      },
      required: ['slug', 'agent_did']
    },
    method: 'POST', path: '/v1/tools/:slug/install'
  },
  {
    name: 'openheab.workflows.run',
    description: 'Execute a named workflow (DAG of steps) for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        workflow_id: { type: 'string' },
        inputs: { type: 'object' }
      },
      required: ['did', 'workflow_id']
    },
    method: 'POST', path: '/v1/agents/:did/workflows/:workflow_id/run'
  },
  {
    name: 'openheab.intelligence.behavior',
    description: 'Behavior analytics for an agent (actions in past 30d, top counterparties, installed tools).',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/intelligence/agents/:did/behavior'
  },
  {
    name: 'openheab.intelligence.forecast',
    description: 'EMA cost forecast (daily/7d/30d) for an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/intelligence/agents/:did/forecast'
  },
  {
    name: 'openheab.intelligence.network',
    description: 'Aggregate network metrics (total agents, new in 7d, GMV 30d, extension invocations 24h).',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/v1/intelligence/network'
  },
  {
    name: 'openheab.cost.summary',
    description: 'Summary of agent cost events (totals by kind, daily breakdown).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        window_days: { type: 'integer' }
      },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/cost/summary'
  },
  {
    name: 'openheab.cost.budget.set',
    description: 'Set or update a spending budget cap (daily/weekly/monthly) for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        limit_cents: { type: 'integer' }
      },
      required: ['did', 'period', 'limit_cents']
    },
    method: 'POST', path: '/v1/agents/:did/cost/budget'
  },
  {
    name: 'openheab.deployment.set',
    description: 'Create or update an agent deployment manifest (runtime, image, scaling, hibernation).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        runtime: { type: 'string', enum: ['modal', 'e2b', 'fly', 'local'] },
        image: { type: 'string' },
        entrypoint: { type: 'string' },
        min_replicas: { type: 'integer' },
        max_replicas: { type: 'integer' },
        idle_minutes: { type: 'integer' },
        hibernate_minutes: { type: 'integer' }
      },
      required: ['did']
    },
    method: 'POST', path: '/v1/agents/:did/deployment'
  },
  {
    name: 'openheab.payouts.request',
    description: 'Request an A2H cash-out (Stripe Connect / Wise / USDC on-ramp / manual).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        account_id: { type: 'string' },
        amount_cents: { type: 'integer', minimum: 500 },
        currency: { type: 'string' },
        idempotency_key: { type: 'string' }
      },
      required: ['did', 'account_id', 'amount_cents']
    },
    method: 'POST', path: '/v1/agents/:did/payouts'
  },
  {
    name: 'openheab.storage.upload_url',
    description: 'Get a fresh signed download URL for a stored blob.',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        blob_id: { type: 'string' },
        expires_in: { type: 'integer' }
      },
      required: ['did', 'blob_id']
    },
    method: 'POST', path: '/v1/agents/:did/storage/:blob_id/url'
  },
  {
    name: 'openheab.storage.list',
    description: 'List blobs owned by an agent.',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/storage'
  },
  {
    name: 'openheab.agents.search',
    description: 'Search the agent registry by query, category, or minimum reputation.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' },
        min_reputation: { type: 'number' },
        limit: { type: 'integer' }
      }
    },
    method: 'GET', path: '/v1/agents/search'
  },
  {
    name: 'openheab.audit.verify',
    description: 'Cryptographically verify the audit hash chain.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer' } }
    },
    method: 'GET', path: '/v1/audit/verify'
  },
  {
    name: 'openheab.secrets.list',
    description: 'List an agent\'s secret metadata (no values returned).',
    inputSchema: {
      type: 'object',
      properties: { did: { type: 'string' } },
      required: ['did']
    },
    method: 'GET', path: '/v1/agents/:did/secrets'
  },
  {
    name: 'openheab.secrets.get',
    description: 'Decrypt and return a secret value by handle (requires signed request).',
    inputSchema: {
      type: 'object',
      properties: {
        did: { type: 'string' },
        handle: { type: 'string' }
      },
      required: ['did', 'handle']
    },
    method: 'GET', path: '/v1/agents/:did/secrets/:handle'
  },
  // ==========================================================================
  // Org / billing / commerce ops (new revenue primitives)
  // ==========================================================================
  { name: 'openheab.org.create', description: 'Create a multi-agent organization (company/team/DAO).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, kind: { type: 'string' }, owner_did: { type: 'string' }, billing_email: { type: 'string' } }, required: ['name', 'owner_did'] },
    method: 'POST', path: '/v1/orgs' },
  { name: 'openheab.org.invite', description: 'Invite a member to an org by email.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } }, required: ['id', 'email'] },
    method: 'POST', path: '/v1/orgs/:id/invites' },
  { name: 'openheab.subscriptions.plans', description: 'List available OpenHeab subscription plans.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/v1/subscriptions/plans' },
  { name: 'openheab.subscriptions.subscribe', description: 'Subscribe an org to a plan (free/pro/scale/enterprise).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, plan_code: { type: 'string' }, trial_days: { type: 'integer' } }, required: ['id', 'plan_code'] },
    method: 'POST', path: '/v1/orgs/:id/subscription' },
  { name: 'openheab.credits.packs', description: 'List pre-purchased credit packs.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/v1/credits/packs' },
  { name: 'openheab.credits.purchase', description: 'Purchase a credit pack.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, pack_code: { type: 'string' }, payment_method_id: { type: 'string' } }, required: ['id', 'pack_code'] },
    method: 'POST', path: '/v1/orgs/:id/credits/purchase' },
  { name: 'openheab.credits.balance', description: 'Get current credit balance for an org.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    method: 'GET', path: '/v1/orgs/:id/credits/balance' },
  { name: 'openheab.metering.record', description: 'Record a metered usage event.',
    inputSchema: { type: 'object', properties: { org_id: { type: 'string' }, agent_did: { type: 'string' }, kind: { type: 'string' }, quantity: { type: 'number' }, idempotency_key: { type: 'string' } }, required: ['kind', 'quantity'] },
    method: 'POST', path: '/v1/metering/events' },
  { name: 'openheab.metering.usage', description: 'Get usage aggregate for an org and meter kind.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, period: { type: 'integer' } }, required: ['id'] },
    method: 'GET', path: '/v1/orgs/:id/usage' },
  { name: 'openheab.onboarding.start', description: 'Begin the onboarding journey for an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, source: { type: 'string' }, utm_source: { type: 'string' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/onboarding/start' },
  { name: 'openheab.onboarding.complete', description: 'Mark an onboarding step as complete.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, step_code: { type: 'string' } }, required: ['did', 'step_code'] },
    method: 'POST', path: '/v1/agents/:did/onboarding/complete' },
  // ==========================================================================
  // Enterprise + payments + growth (new revenue primitives)
  // ==========================================================================
  { name: 'openheab.sso.create_provider', description: 'Configure SAML or OIDC SSO for an org.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['saml', 'oidc'] }, name: { type: 'string' } }, required: ['id', 'kind', 'name'] },
    method: 'POST', path: '/v1/orgs/:id/sso/providers' },
  { name: 'openheab.rbac.check', description: 'Check whether an agent has a permission in an org.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, agent_did: { type: 'string' }, permission: { type: 'string' } }, required: ['id', 'agent_did', 'permission'] },
    method: 'GET', path: '/v1/orgs/:id/rbac/check' },
  { name: 'openheab.compliance.score', description: 'Get continuous compliance score for an org against a framework.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, framework_code: { type: 'string' } }, required: ['id'] },
    method: 'GET', path: '/v1/orgs/:id/compliance/score' },
  { name: 'openheab.directory.search', description: 'Search the public agent + extension directory (no auth).',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, kind: { type: 'string' }, category: { type: 'string' }, sort: { type: 'string' } } },
    method: 'GET', path: '/v1/directory/search' },
  { name: 'openheab.directory.publish', description: 'Publish a listing in the public directory.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, slug: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['did', 'kind', 'slug', 'title'] },
    method: 'POST', path: '/v1/agents/:did/directory/listings' },
  { name: 'openheab.embed.create', description: 'Create an embeddable widget (pay-button, badge, marketplace card).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' }, config: { type: 'object' }, target_origins: { type: 'array' } }, required: ['did', 'kind', 'name'] },
    method: 'POST', path: '/v1/agents/:did/embed/widgets' },
  { name: 'openheab.partnerships.apply', description: 'Apply to the channel partner / reseller program.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, company_name: { type: 'string' }, contact_email: { type: 'string' } }, required: ['kind', 'company_name', 'contact_email'] },
    method: 'POST', path: '/v1/partners/apply' },
  { name: 'openheab.whitelabel.provision', description: 'Provision a white-label tenant with custom domain + branding.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, custom_domain: { type: 'string' }, brand_name: { type: 'string' } }, required: ['did', 'custom_domain', 'brand_name'] },
    method: 'POST', path: '/v1/agents/:did/whitelabel' },
  { name: 'openheab.ach.add_account', description: 'Add an ACH / wire / SEPA bank account.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, account_holder_name: { type: 'string' }, routing_number: { type: 'string' }, account_number: { type: 'string' } }, required: ['did', 'kind', 'account_holder_name', 'account_number'] },
    method: 'POST', path: '/v1/agents/:did/ach/accounts' },
  { name: 'openheab.ach.transfer', description: 'Initiate an ACH / wire / SEPA transfer.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, from_account_id: { type: 'string' }, amount_cents: { type: 'integer' }, kind: { type: 'string' }, reference: { type: 'string' } }, required: ['did', 'from_account_id', 'amount_cents', 'kind'] },
    method: 'POST', path: '/v1/agents/:did/ach/transfers' },
  { name: 'openheab.quotes.create', description: 'Create a sales quote for enterprise customers.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, prepared_for_email: { type: 'string' }, line_items: { type: 'array' }, payment_terms: { type: 'string' } }, required: ['id', 'prepared_for_email', 'line_items'] },
    method: 'POST', path: '/v1/orgs/:id/quotes' },
  { name: 'openheab.quotes.send', description: 'Send a quote to the recipient via email.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, qid: { type: 'string' } }, required: ['id', 'qid'] },
    method: 'POST', path: '/v1/orgs/:id/quotes/:qid/send' },
  { name: 'openheab.revenue.dashboard', description: 'Operator-only revenue dashboard (admin token required).',
    inputSchema: { type: 'object', properties: { days: { type: 'integer' } } },
    method: 'GET', path: '/v1/admin/revenue/dashboard' },
  // ==========================================================================
  // Bank — unified account view, statements, deposits, reconciliation, sweep
  // ==========================================================================
  { name: 'openheab.bank.account', description: 'Unified bank account view for an agent: wallet, ledger, savings, lending, escrow, cards, net worth.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, chain: { type: 'string' }, fast: { type: 'string' } }, required: ['did'] },
    method: 'GET', path: '/v1/agents/:did/bank' },
  { name: 'openheab.bank.statement', description: 'Generate a bank statement (JSON or CSV) for a date range.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, format: { type: 'string', enum: ['json', 'csv'] } }, required: ['did'] },
    method: 'GET', path: '/v1/agents/:did/bank/statement' },
  { name: 'openheab.bank.deposits', description: 'List incoming USDC deposits credited to the agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, limit: { type: 'integer' } }, required: ['did'] },
    method: 'GET', path: '/v1/agents/:did/bank/deposits' },
  { name: 'openheab.bank.reconcile', description: 'Compare on-chain USDC balance to internal cents ledger; reports drift.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/bank/reconcile' },
  { name: 'openheab.bank.sweep', description: 'Atomic transfer between bank surfaces: ledger ↔ savings ↔ lending_repay.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, from: { type: 'string', enum: ['wallet', 'ledger', 'savings'] }, to: { type: 'string', enum: ['wallet', 'ledger', 'savings', 'lending_repay'] }, amount_cents: { type: 'integer' }, savings_account_id: { type: 'string' }, loan_id: { type: 'string' } }, required: ['did', 'from', 'to', 'amount_cents'] },
    method: 'POST', path: '/v1/agents/:did/bank/sweep' },
  // ==========================================================================
  // Sandbox / browser / perception
  // ==========================================================================
  { name: 'openheab.sandbox.create', description: 'Spawn an isolated code execution sandbox session.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, runtime: { type: 'string' }, idle_seconds: { type: 'integer' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/sandbox/sessions' },
  { name: 'openheab.sandbox.exec', description: 'Execute code in a sandbox session.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, session_id: { type: 'string' }, code: { type: 'string' }, language: { type: 'string' } }, required: ['did', 'session_id', 'code'] },
    method: 'POST', path: '/v1/agents/:did/sandbox/sessions/:session_id/exec' },
  { name: 'openheab.browser.create', description: 'Spawn a headless browser session.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, viewport: { type: 'object' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/browser/sessions' },
  { name: 'openheab.browser.navigate', description: 'Navigate a browser session to a URL.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, session_id: { type: 'string' }, url: { type: 'string' } }, required: ['did', 'session_id', 'url'] },
    method: 'POST', path: '/v1/agents/:did/browser/sessions/:session_id/navigate' },
  { name: 'openheab.voice.tts', description: 'Synthesize speech from text.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, text: { type: 'string' }, voice: { type: 'string' } }, required: ['did', 'text'] },
    method: 'POST', path: '/v1/agents/:did/voice/tts' },
  { name: 'openheab.voice.stt', description: 'Transcribe audio to text.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, audio_url: { type: 'string' } }, required: ['did', 'audio_url'] },
    method: 'POST', path: '/v1/agents/:did/voice/stt' },
  { name: 'openheab.vision.generate', description: 'Generate an image from a prompt.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, prompt: { type: 'string' }, size: { type: 'string' } }, required: ['did', 'prompt'] },
    method: 'POST', path: '/v1/agents/:did/vision/generate' },
  { name: 'openheab.vision.analyze', description: 'Analyze an image (caption, objects, OCR).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, image_url: { type: 'string' }, kind: { type: 'string' } }, required: ['did', 'image_url'] },
    method: 'POST', path: '/v1/agents/:did/vision/analyze' },
  { name: 'openheab.video.generate', description: 'Generate a video clip from a prompt.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, prompt: { type: 'string' }, duration_seconds: { type: 'integer' } }, required: ['did', 'prompt'] },
    method: 'POST', path: '/v1/agents/:did/video/generate' },
  { name: 'openheab.search.web', description: 'Web search over a query string.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] },
    method: 'GET', path: '/v1/search' },
  { name: 'openheab.translate.text', description: 'Translate text between languages.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, text: { type: 'string' }, target_lang: { type: 'string' } }, required: ['text', 'target_lang'] },
    method: 'POST', path: '/v1/translate' },
  { name: 'openheab.moderation.scan', description: 'Moderate content for unsafe / disallowed material.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, content: { type: 'string' } }, required: ['content'] },
    method: 'POST', path: '/v1/moderation/scan' },
  { name: 'openheab.fact_check', description: 'Fact-check a claim against grounded sources.',
    inputSchema: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] },
    method: 'POST', path: '/v1/fact_check' },
  // ==========================================================================
  // Web3 / DeFi
  // ==========================================================================
  { name: 'openheab.multisig.create', description: 'Create a multi-signature wallet.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, signers: { type: 'array' }, threshold: { type: 'integer' } }, required: ['did', 'signers', 'threshold'] },
    method: 'POST', path: '/v1/multisig/wallets' },
  { name: 'openheab.lending.borrow', description: 'Borrow USDC against collateral from a lending pool.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, pool_id: { type: 'string' }, amount_cents: { type: 'integer' } }, required: ['did', 'pool_id', 'amount_cents'] },
    method: 'POST', path: '/v1/lending/borrow' },
  { name: 'openheab.lending.repay', description: 'Repay an outstanding lending position.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, loan_id: { type: 'string' }, amount_cents: { type: 'integer' } }, required: ['did', 'loan_id'] },
    method: 'POST', path: '/v1/lending/repay' },
  { name: 'openheab.savings.deposit', description: 'Deposit USDC into an interest-bearing savings account.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, amount_cents: { type: 'integer' } }, required: ['did', 'amount_cents'] },
    method: 'POST', path: '/v1/agents/:did/savings/deposit' },
  { name: 'openheab.savings.withdraw', description: 'Withdraw USDC from a savings account.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, amount_cents: { type: 'integer' } }, required: ['did', 'amount_cents'] },
    method: 'POST', path: '/v1/agents/:did/savings/withdraw' },
  { name: 'openheab.cards.issue', description: 'Issue a virtual debit card backed by an agent USDC wallet.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, card_type: { type: 'string', enum: ['virtual', 'physical'] }, spending_limit_cents: { type: 'integer' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/cards' },
  { name: 'openheab.tokens.create', description: 'Mint an ERC-20-style agent-issued token.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' }, symbol: { type: 'string' }, supply: { type: 'string' } }, required: ['did', 'name', 'symbol', 'supply'] },
    method: 'POST', path: '/v1/agents/:did/tokens' },
  { name: 'openheab.nft.mint', description: 'Mint an NFT (metadata + on-chain pointer).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, collection_id: { type: 'string' }, metadata: { type: 'object' } }, required: ['did', 'collection_id'] },
    method: 'POST', path: '/v1/agents/:did/nfts/mint' },
  // ==========================================================================
  // Knowledge / docs / maps
  // ==========================================================================
  { name: 'openheab.documents.upload', description: 'Upload a document for parsing + indexing.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/documents' },
  { name: 'openheab.documents.extract', description: 'Extract structured content from a stored document.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, doc_id: { type: 'string' } }, required: ['did', 'doc_id'] },
    method: 'POST', path: '/v1/agents/:did/documents/:doc_id/extract' },
  { name: 'openheab.maps.geocode', description: 'Geocode an address to coordinates.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
    method: 'GET', path: '/v1/maps/geocode' },
  { name: 'openheab.maps.route', description: 'Compute a route between two points.',
    inputSchema: { type: 'object', properties: { origin: { type: 'string' }, destination: { type: 'string' }, mode: { type: 'string' } }, required: ['origin', 'destination'] },
    method: 'GET', path: '/v1/maps/route' },
  { name: 'openheab.knowledge.query', description: 'Query the shared knowledge graph.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] },
    method: 'GET', path: '/v1/knowledge/query' },
  // ==========================================================================
  // Cognition / planning / AGI
  // ==========================================================================
  { name: 'openheab.planning.create', description: 'Create a multi-step plan toward a goal.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, goal: { type: 'string' }, horizon_steps: { type: 'integer' } }, required: ['did', 'goal'] },
    method: 'POST', path: '/v1/agents/:did/planning/plans' },
  { name: 'openheab.simulation.run', description: 'Run a deterministic simulation of a plan.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, plan_id: { type: 'string' }, world_state: { type: 'object' } }, required: ['did', 'plan_id'] },
    method: 'POST', path: '/v1/agents/:did/simulation/run' },
  { name: 'openheab.beliefs.set', description: 'Set a probabilistic belief in the agent\'s world model.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, statement: { type: 'string' }, probability: { type: 'number' } }, required: ['did', 'statement', 'probability'] },
    method: 'POST', path: '/v1/agents/:did/beliefs' },
  { name: 'openheab.goals.set', description: 'Set or update a top-level agent goal.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, description: { type: 'string' }, priority: { type: 'integer' } }, required: ['did', 'description'] },
    method: 'POST', path: '/v1/agents/:did/goals' },
  { name: 'openheab.skills.list', description: 'List skills available in the registry.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    method: 'GET', path: '/v1/skills' },
  { name: 'openheab.skills.install', description: 'Install a skill for an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, skill_id: { type: 'string' } }, required: ['did', 'skill_id'] },
    method: 'POST', path: '/v1/agents/:did/skills/install' },
  { name: 'openheab.causal.estimate', description: 'Estimate a causal effect (treatment → outcome).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, treatment: { type: 'string' }, outcome: { type: 'string' } }, required: ['did', 'treatment', 'outcome'] },
    method: 'POST', path: '/v1/agents/:did/causal/estimate' },
  { name: 'openheab.tripwires.set', description: 'Set a tripwire that pauses the agent when triggered.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, condition: { type: 'string' } }, required: ['did', 'condition'] },
    method: 'POST', path: '/v1/agents/:did/tripwires' },
  { name: 'openheab.fine_tuning.start', description: 'Submit a fine-tuning job for a base model.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, base_model: { type: 'string' }, dataset_id: { type: 'string' } }, required: ['did', 'base_model', 'dataset_id'] },
    method: 'POST', path: '/v1/agents/:did/fine_tuning/jobs' },
  { name: 'openheab.federated_learning.contribute', description: 'Submit a local model update for federated aggregation.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, round_id: { type: 'string' }, gradients_url: { type: 'string' } }, required: ['did', 'round_id'] },
    method: 'POST', path: '/v1/federated_learning/contributions' },
  // ==========================================================================
  // Compute / infra
  // ==========================================================================
  { name: 'openheab.compute.spawn', description: 'Spawn a GPU/CPU compute instance.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, image: { type: 'string' }, duration_seconds: { type: 'integer' } }, required: ['did', 'kind'] },
    method: 'POST', path: '/v1/agents/:did/compute/instances' },
  { name: 'openheab.database.create', description: 'Provision a Postgres database for an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' } }, required: ['did', 'name'] },
    method: 'POST', path: '/v1/agents/:did/databases' },
  { name: 'openheab.dns.register', description: 'Register a domain (.eth / .ai / .com).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, domain: { type: 'string' }, years: { type: 'integer' } }, required: ['did', 'domain'] },
    method: 'POST', path: '/v1/agents/:did/dns/domains' },
  { name: 'openheab.hosting.deploy', description: 'Deploy a static or container site to OpenHeab hosting.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, domain: { type: 'string' }, source_url: { type: 'string' } }, required: ['did', 'source_url'] },
    method: 'POST', path: '/v1/agents/:did/hosting/sites' },
  // ==========================================================================
  // Business / org
  // ==========================================================================
  { name: 'openheab.crm.contact_create', description: 'Add a contact to an agent\'s CRM.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/crm/contacts' },
  { name: 'openheab.projects.create', description: 'Create a project workspace.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' } }, required: ['did', 'name'] },
    method: 'POST', path: '/v1/agents/:did/projects' },
  { name: 'openheab.invoicing.create', description: 'Create an invoice payable in USDC.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, payer_did: { type: 'string' }, amount_cents: { type: 'integer' }, due_at: { type: 'string' } }, required: ['did', 'amount_cents'] },
    method: 'POST', path: '/v1/agents/:did/invoicing/invoices' },
  { name: 'openheab.calendar.create_event', description: 'Add a calendar event.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, title: { type: 'string' }, starts_at: { type: 'string' }, ends_at: { type: 'string' } }, required: ['did', 'title', 'starts_at'] },
    method: 'POST', path: '/v1/agents/:did/calendar/events' },
  { name: 'openheab.dao.create', description: 'Spawn a DAO with token + treasury + proposals.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' }, governance_kind: { type: 'string' } }, required: ['did', 'name'] },
    method: 'POST', path: '/v1/dao/create' },
  { name: 'openheab.entities.create', description: 'Form a legal entity (LLC / C-Corp / foundation / DAO) for an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, jurisdiction: { type: 'string' }, name: { type: 'string' } }, required: ['did', 'kind', 'name'] },
    method: 'POST', path: '/v1/agents/:did/entities' },
  // ==========================================================================
  // Revenue / commerce (new)
  // ==========================================================================
  { name: 'openheab.brokerage.order', description: 'Place a brokerage order for equities / crypto.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, symbol: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, qty: { type: 'number' } }, required: ['did', 'symbol', 'side', 'qty'] },
    method: 'POST', path: '/v1/agents/:did/brokerage/orders' },
  { name: 'openheab.prediction_markets.bet', description: 'Place a bet in a prediction market.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, market_id: { type: 'string' }, option: { type: 'string' }, amount_cents: { type: 'integer' } }, required: ['did', 'market_id', 'option', 'amount_cents'] },
    method: 'POST', path: '/v1/prediction_markets/:market_id/orders' },
  { name: 'openheab.shopping.checkout', description: 'Check out a shopping cart via agent USDC wallet.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, cart_id: { type: 'string' } }, required: ['did', 'cart_id'] },
    method: 'POST', path: '/v1/agents/:did/shopping/cart/checkout' },
  { name: 'openheab.travel.search', description: 'Search flights / hotels / car rentals.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, origin: { type: 'string' }, destination: { type: 'string' }, dates: { type: 'object' } }, required: ['kind'] },
    method: 'POST', path: '/v1/travel/search' },
  { name: 'openheab.travel.book', description: 'Book a travel itinerary.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, offer_id: { type: 'string' } }, required: ['did', 'offer_id'] },
    method: 'POST', path: '/v1/agents/:did/travel/bookings' },
  { name: 'openheab.advertising.create_campaign', description: 'Launch an advertising campaign in the agent ad network.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, headline: { type: 'string' }, budget_cents: { type: 'integer' }, target: { type: 'object' } }, required: ['did', 'headline', 'budget_cents'] },
    method: 'POST', path: '/v1/agents/:did/advertising/campaigns' },
  { name: 'openheab.media.upload', description: 'Upload a media asset (audio / video / image) to the media library.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string' } }, required: ['did', 'url'] },
    method: 'POST', path: '/v1/agents/:did/media/assets' },
  { name: 'openheab.ratings.submit', description: 'Submit a star rating + review for an entity.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, target_kind: { type: 'string' }, target_id: { type: 'string' }, stars: { type: 'integer' } }, required: ['did', 'target_kind', 'target_id', 'stars'] },
    method: 'POST', path: '/v1/ratings' },
  { name: 'openheab.booking.create', description: 'Create a calendar booking against an availability slot.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, listing_id: { type: 'string' }, starts_at: { type: 'string' } }, required: ['did', 'listing_id', 'starts_at'] },
    method: 'POST', path: '/v1/agents/:did/booking/reservations' },
  // ==========================================================================
  // Developer infra (new)
  // ==========================================================================
  { name: 'openheab.github.repo_create', description: 'Create a GitHub repo via stored credentials.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' }, private: { type: 'boolean' } }, required: ['did', 'name'] },
    method: 'POST', path: '/v1/agents/:did/github/repos' },
  { name: 'openheab.ci_cd.run_pipeline', description: 'Trigger a CI/CD pipeline run.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, pipeline_id: { type: 'string' }, ref: { type: 'string' } }, required: ['did', 'pipeline_id'] },
    method: 'POST', path: '/v1/agents/:did/ci_cd/runs' },
  { name: 'openheab.monitoring.metric', description: 'Push a metric data point to the monitoring system.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, metric: { type: 'string' }, value: { type: 'number' }, tags: { type: 'object' } }, required: ['did', 'metric', 'value'] },
    method: 'POST', path: '/v1/monitoring/metrics' },
  { name: 'openheab.error_tracking.report', description: 'Report an error to error-tracking.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, error: { type: 'string' }, stack: { type: 'string' }, context: { type: 'object' } }, required: ['did', 'error'] },
    method: 'POST', path: '/v1/error_tracking/events' },
  { name: 'openheab.feature_flags.evaluate', description: 'Evaluate a feature flag for an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, flag_key: { type: 'string' }, context: { type: 'object' } }, required: ['did', 'flag_key'] },
    method: 'POST', path: '/v1/feature_flags/evaluate' },
  { name: 'openheab.experiments.assign', description: 'Get the experiment variant assigned to an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, experiment_key: { type: 'string' } }, required: ['did', 'experiment_key'] },
    method: 'POST', path: '/v1/experiments/assign' },
  { name: 'openheab.webhooks.subscribe', description: 'Subscribe to a webhook delivery for events.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, event_type: { type: 'string' }, target_url: { type: 'string' } }, required: ['did', 'event_type', 'target_url'] },
    method: 'POST', path: '/v1/agents/:did/webhooks' },
  { name: 'openheab.events.publish', description: 'Publish an event to the universal event bus.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, topic: { type: 'string' }, payload: { type: 'object' } }, required: ['did', 'topic', 'payload'] },
    method: 'POST', path: '/v1/events/publish' },
  // ==========================================================================
  // AGI learning + gov/legal (new)
  // ==========================================================================
  { name: 'openheab.learning.curriculum_add', description: 'Add a learning curriculum item to an agent\'s self-improvement queue.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, topic: { type: 'string' }, kind: { type: 'string' } }, required: ['did', 'topic'] },
    method: 'POST', path: '/v1/agents/:did/learning/curriculum' },
  { name: 'openheab.voice_agents.create', description: 'Create a voice agent persona (number + voice + scripts).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' }, voice: { type: 'string' } }, required: ['did', 'name'] },
    method: 'POST', path: '/v1/agents/:did/voice_agents' },
  { name: 'openheab.labs.run_experiment', description: 'Run a scientific experiment with versioned inputs/outputs.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, hypothesis: { type: 'string' }, protocol: { type: 'object' } }, required: ['did', 'hypothesis'] },
    method: 'POST', path: '/v1/agents/:did/labs/experiments' },
  { name: 'openheab.gov_filing.submit', description: 'Submit a government filing (incorporation, tax return, FBAR, etc.).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, jurisdiction: { type: 'string' }, form_id: { type: 'string' }, payload: { type: 'object' } }, required: ['did', 'jurisdiction', 'form_id'] },
    method: 'POST', path: '/v1/agents/:did/gov_filing/filings' },
  { name: 'openheab.legal_research.search', description: 'Search statutory + case law.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, jurisdiction: { type: 'string' } }, required: ['q'] },
    method: 'GET', path: '/v1/legal_research/search' },
  { name: 'openheab.court_records.search', description: 'Search the court records database.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, court: { type: 'string' } }, required: ['q'] },
    method: 'GET', path: '/v1/court_records/search' },
  { name: 'openheab.ip_registry.register', description: 'Register an IP claim (copyright, trademark, patent).',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, jurisdictions: { type: 'array' } }, required: ['did', 'kind', 'title'] },
    method: 'POST', path: '/v1/agents/:did/ip_registry/claims' },
  { name: 'openheab.climate.offset', description: 'Purchase a carbon offset from a verified registry.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, tonnes: { type: 'number' } }, required: ['did', 'tonnes'] },
    method: 'POST', path: '/v1/agents/:did/climate/offsets' },
  // ==========================================================================
  // Customer service + community (new)
  // ==========================================================================
  { name: 'openheab.support.ticket_create', description: 'Open a support ticket on behalf of an agent.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' } }, required: ['did', 'subject'] },
    method: 'POST', path: '/v1/agents/:did/support/tickets' },
  { name: 'openheab.referrals.create', description: 'Create a referral code for distribution incentives.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, reward_cents: { type: 'integer' } }, required: ['did'] },
    method: 'POST', path: '/v1/agents/:did/referrals' },
  { name: 'openheab.loyalty.points_grant', description: 'Grant loyalty points to a member.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, program_id: { type: 'string' }, member_did: { type: 'string' }, points: { type: 'integer' } }, required: ['did', 'program_id', 'member_did', 'points'] },
    method: 'POST', path: '/v1/agents/:did/loyalty/grants' },
  { name: 'openheab.surveys.create', description: 'Create a survey with reward distribution.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, title: { type: 'string' }, questions: { type: 'array' } }, required: ['did', 'title', 'questions'] },
    method: 'POST', path: '/v1/agents/:did/surveys' },
  { name: 'openheab.recruiting.candidates_search', description: 'Search candidates in the recruiting database.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, skills: { type: 'array' } }, required: ['q'] },
    method: 'GET', path: '/v1/recruiting/candidates' },
  { name: 'openheab.supply_chain.track', description: 'Track a supply chain shipment by tracking number.',
    inputSchema: { type: 'object', properties: { tracking_number: { type: 'string' } }, required: ['tracking_number'] },
    method: 'GET', path: '/v1/supply_chain/track' },
  { name: 'openheab.licensing.create', description: 'Issue a software/IP license to a counterparty.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, asset_id: { type: 'string' }, licensee_did: { type: 'string' }, terms: { type: 'object' } }, required: ['did', 'asset_id', 'licensee_did'] },
    method: 'POST', path: '/v1/agents/:did/licensing/licenses' },
  { name: 'openheab.benchmarks.submit', description: 'Submit a benchmark run result for an agent / model.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, benchmark_id: { type: 'string' }, score: { type: 'number' } }, required: ['did', 'benchmark_id', 'score'] },
    method: 'POST', path: '/v1/benchmarks/runs' },
  // ==========================================================================
  // Compliance, biometrics, fraud, notary
  // ==========================================================================
  { name: 'openheab.biometrics.verify', description: 'Verify a biometric liveness sample.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, sample_url: { type: 'string' }, kind: { type: 'string' } }, required: ['did', 'sample_url'] },
    method: 'POST', path: '/v1/agents/:did/biometrics/verify' },
  { name: 'openheab.aml.screen', description: 'Run AML screening on a transaction or counterparty.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, target_did: { type: 'string' }, amount_cents: { type: 'integer' } }, required: ['did'] },
    method: 'POST', path: '/v1/aml/screen' },
  { name: 'openheab.fraud.evaluate', description: 'Evaluate fraud risk for a transaction.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, kind: { type: 'string' }, amount_cents: { type: 'integer' }, context: { type: 'object' } }, required: ['did', 'kind'] },
    method: 'POST', path: '/v1/fraud/evaluate' },
  { name: 'openheab.notary.anchor', description: 'Anchor a hash on-chain via the notary primitive.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, hash: { type: 'string' }, chain: { type: 'string' } }, required: ['did', 'hash'] },
    method: 'POST', path: '/v1/agents/:did/notary/anchor' },
  // ==========================================================================
  // Realtime — server-sent events stream of every audit-chained event
  // ==========================================================================
  { name: 'openheab.realtime.replay', description: 'Replay a bounded range of audit-chain events as JSON.',
    inputSchema: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
    method: 'GET', path: '/v1/realtime/replay' },
  // ==========================================================================
  // API management
  // ==========================================================================
  { name: 'openheab.api_management.create', description: 'Register a new API that the agent will host.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, name: { type: 'string' }, base_url: { type: 'string' } }, required: ['did', 'name', 'base_url'] },
    method: 'POST', path: '/v1/agents/:did/apis' },
  { name: 'openheab.api_management.issue_key', description: 'Issue an API key for a hosted agent API.',
    inputSchema: { type: 'object', properties: { did: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' } }, required: ['did', 'id'] },
    method: 'POST', path: '/v1/apis/:id/keys' }
];

// ----------------------------------------------------------------------------
// Migration (no-op)
// ----------------------------------------------------------------------------
async function migrate(_pool) {
  // mcp_server has no tables — it's a JSON-RPC facade over other primitives.
}

// ----------------------------------------------------------------------------
// Tool invocation
// ----------------------------------------------------------------------------
function findTool(name) {
  return TOOLS.find(t => t.name === name);
}

function resolvePath(template, args) {
  const consumed = new Set();
  const path = template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key) => {
    if (args && key in args && args[key] !== undefined && args[key] !== null) {
      consumed.add(key);
      return encodeURIComponent(String(args[key]));
    }
    return `:${key}`;
  });
  const remaining = {};
  if (args) {
    for (const k of Object.keys(args)) {
      if (!consumed.has(k)) remaining[k] = args[k];
    }
  }
  return { path, remaining };
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') usp.append(k, JSON.stringify(v));
    else usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

function pickAuthHeaders(srcHeaders = {}) {
  const out = {};
  const passthrough = [
    'authorization', 'x-agent-did', 'x-agent-sig',
    'x-idempotency-key', 'x-admin-token', 'x-cron-secret', 'x-demo-did'
  ];
  for (const h of passthrough) {
    if (srcHeaders[h]) out[h] = srcHeaders[h];
  }
  return out;
}

async function invokeTool(toolName, args, reqHeaders) {
  const tool = findTool(toolName);
  if (!tool) return { ok: false, error: 'unknown_tool', tool: toolName };

  const base = process.env.OPERATOR_PUBLIC_URL
    || process.env.MCP_INTERNAL_BASE_URL
    || `http://localhost:${process.env.PORT || 3000}`;
  const { path, remaining } = resolvePath(tool.path, args || {});

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...pickAuthHeaders(reqHeaders || {})
  };

  let url = `${base}${path}`;
  let body;
  if (tool.method === 'GET' || tool.method === 'DELETE') {
    url += buildQueryString(remaining);
  } else {
    body = JSON.stringify(remaining || {});
  }

  if (typeof fetch !== 'function') {
    return { ok: false, error: 'fetch_unavailable' };
  }

  try {
    const r = await fetch(url, { method: tool.method, headers, body });
    let json = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { json = await r.json(); } catch { json = null; }
    } else {
      try { json = { text: await r.text() }; } catch { json = null; }
    }
    return { ok: r.ok, status: r.status, result: json };
  } catch (e) {
    return { ok: false, error: 'invocation_failed', message: e.message };
  }
}

// ----------------------------------------------------------------------------
// JSON-RPC handler
// ----------------------------------------------------------------------------
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

async function handleRpc(req, body) {
  const { id, method, params } = body || {};
  if (!method) return rpcError(id, -32600, 'invalid_request: missing method');

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } }
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema
      }))
    });
  }
  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};
    const tool = findTool(toolName);
    if (!tool) return rpcError(id, -32601, `unknown_tool: ${toolName}`);
    const out = await invokeTool(toolName, args, req.headers);
    if (!out.ok) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(out) }]
      });
    }
    return rpcResult(id, {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(out.result) }]
    });
  }
  if (method === 'ping') return rpcResult(id, { pong: true });
  return rpcError(id, -32601, `method_not_found: ${method}`);
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerMcpRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /mcp — JSON-RPC 2.0
  app.post('/mcp', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const body = req.body;
      if (Array.isArray(body)) {
        const out = await Promise.all(body.map(b => handleRpc(req, b)));
        return res.json(out);
      }
      const out = await handleRpc(req, body);
      return res.json(out);
    } catch (e) {
      console.error('[mcp.rpc]', e);
      return res.status(500).json(rpcError(null, -32603, 'internal_error', e.message));
    }
  });

  // GET /mcp/manifest — flat manifest for non-RPC discovery
  app.get('/mcp/manifest', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || '';
    return res.json({
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      transport: 'http+jsonrpc',
      endpoint: base ? `${base}/mcp` : '/mcp',
      protocol_version: MCP_PROTOCOL_VERSION,
      tools: TOOLS.map(t => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema
      }))
    });
  });

  // GET /.well-known/mcp.json — discovery doc
  app.get('/.well-known/mcp.json', (req, res) => {
    const base = process.env.OPERATOR_PUBLIC_URL || '';
    return res.json({
      mcp_version: MCP_PROTOCOL_VERSION,
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      transports: [
        { type: 'http+jsonrpc', endpoint: base ? `${base}/mcp` : '/mcp' }
      ],
      manifest: base ? `${base}/mcp/manifest` : '/mcp/manifest',
      tool_count: TOOLS.length
    });
  });
}

module.exports = {
  migrate,
  registerMcpRoutes,
  TOOLS,
  invokeTool,
  resolvePath,
  pickAuthHeaders,
  handleRpc
};
