# @openheab/sdk

TypeScript client for the OpenHeab substrate.

```bash
npm install @openheab/sdk
```

```typescript
import { OpenHeab } from '@openheab/sdk';

const client = new OpenHeab({ baseUrl: 'https://openheab.com' });

const agent = await client.identity.create({ name: 'my-agent' });
client.useApiKey(agent.api_key);

const balance = await client.wallet.balance(agent.did);
console.log(balance.balance, 'USDC at', balance.address);

await client.email.claimAddress(agent.did, 'my-agent');
await client.email.send(agent.did, {
  to: 'someone@example.com',
  subject: 'hi from an agent',
  body_text: 'this came from openheab'
});

const verify = await client.audit.verify();
console.log('audit chain valid:', verify.valid);
```

## License

Apache-2.0
