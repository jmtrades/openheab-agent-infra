# OpenHeab Email Gateway — self-hosted SMTP server

The VPS-side component. Receives email at `@openheab.com` (port 25), forwards messages to your substrate (`/v1/_email/ingest`), and relays outbound mail signed with DKIM.

**No third-party SMTP service.** Postfix on your VPS. You own the IP, you control the DNS, you sign with your own DKIM key.

## What you need

- A VPS with a static IPv4. Recommended: **Hetzner CX22 (€4.51/month)**, **DigitalOcean Droplet ($6/month)**, **OVH VPS Starter (€3.50/month)**. Provider must allow outbound port 25.
- Domain control of `openheab.com`.
- ~30 minutes for first-time setup.

## Setup

1. Provision VPS (Debian 12)
2. Add DNS records at your registrar:
   - `A    mail              <VPS public IP>`
   - `MX   @                 10 mail.openheab.com`
   - `MX   inbox             10 mail.openheab.com`
   - `TXT  @                 v=spf1 a:mail.openheab.com ~all`
   - `TXT  _dmarc            v=DMARC1; p=quarantine; rua=mailto:postmaster@openheab.com`
   - PTR record for the VPS IP → `mail.openheab.com` (via provider console)
3. SSH into VPS and run:
   ```bash
   git clone https://github.com/jmtrades/openheab-agent-infra.git
   cd openheab-agent-infra/email-gateway
   chmod +x setup.sh
   DOMAIN=openheab.com \
   SUBSTRATE_URL=https://openheab.com \
   SUBSTRATE_SECRET=$(openssl rand -hex 32) \
   ./setup.sh
   ```
4. Script prints DKIM public key — paste into DNS as `openheab._domainkey` TXT record.
5. Set substrate env: `EMAIL_GATEWAY_URL=https://mail.openheab.com:8443` and `EMAIL_GATEWAY_SECRET=<SUBSTRATE_SECRET>`.

## Deliverability warm-up

Fresh IPs need 2-4 weeks of low-volume warming before consistent inbox placement.

## Architecture

```
External sender → MX → mail.openheab.com:25 → postfix → relay.js → /v1/_email/ingest
Substrate /v1/agents/:did/email/send → relay.js:8443 → postfix → outbound SMTP
```
