#!/bin/bash
# ============================================================================
# OpenHeab Email Gateway — Debian 12 installer
# ============================================================================
set -euo pipefail

: "${DOMAIN:?DOMAIN env var required (e.g. openheab.com)}"
: "${SUBSTRATE_URL:?SUBSTRATE_URL env var required}"
: "${SUBSTRATE_SECRET:?SUBSTRATE_SECRET env var required (32+ hex chars)}"

MAIL_HOST="mail.${DOMAIN}"
DKIM_SELECTOR="openheab"
LOG_FILE="/var/log/openheab-gateway.log"

echo "[setup] installing packages..."
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  postfix postfix-pcre opendkim opendkim-tools spamassassin spamc \
  certbot ufw curl ca-certificates jq

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

hostnamectl set-hostname "$MAIL_HOST"
grep -q "$MAIL_HOST" /etc/hosts || echo "127.0.1.1 $MAIL_HOST" >> /etc/hosts

# DKIM
mkdir -p /etc/opendkim/keys/"$DOMAIN"
if [[ ! -f /etc/opendkim/keys/"$DOMAIN"/"$DKIM_SELECTOR".private ]]; then
  opendkim-genkey -b 2048 -d "$DOMAIN" -s "$DKIM_SELECTOR" -D /etc/opendkim/keys/"$DOMAIN"/
  chown -R opendkim:opendkim /etc/opendkim/keys
  chmod 600 /etc/opendkim/keys/"$DOMAIN"/"$DKIM_SELECTOR".private
fi

ufw allow OpenSSH || true
ufw allow 25/tcp; ufw allow 465/tcp; ufw allow 587/tcp; ufw allow 8443/tcp
ufw --force enable

# Cert
if ! certbot certificates 2>/dev/null | grep -q "$MAIL_HOST"; then
  certbot certonly --standalone -d "$MAIL_HOST" --non-interactive --agree-tos \
    -m "postmaster@${DOMAIN}" --preferred-challenges http
fi

# Relay service
INSTALL_DIR=/opt/openheab-gateway
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/relay.js" "$INSTALL_DIR/relay.js"

cat > "$INSTALL_DIR/.env" <<EOF
DOMAIN=${DOMAIN}
SUBSTRATE_URL=${SUBSTRATE_URL}
SUBSTRATE_SECRET=${SUBSTRATE_SECRET}
RELAY_PORT=3001
OUTBOUND_TLS_CERT=/etc/letsencrypt/live/${MAIL_HOST}/fullchain.pem
OUTBOUND_TLS_KEY=/etc/letsencrypt/live/${MAIL_HOST}/privkey.pem
OUTBOUND_PORT=8443
LOG_FILE=${LOG_FILE}
EOF

cat > /etc/systemd/system/openheab-gateway.service <<EOF
[Unit]
Description=OpenHeab Email Gateway relay
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/relay.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable openheab-gateway
systemctl restart openheab-gateway

echo ""
echo "============================================================"
echo "Gateway is up. Last step: add the DKIM public key to DNS."
echo "Name:  ${DKIM_SELECTOR}._domainkey.${DOMAIN}"
echo "Value:"
cat /etc/opendkim/keys/${DOMAIN}/${DKIM_SELECTOR}.txt | grep -oE '"[^"]+"' | tr -d '"' | tr -d '\n'
echo ""
echo "============================================================"
echo ""
echo "Set substrate env:"
echo "  EMAIL_GATEWAY_URL=https://${MAIL_HOST}:8443"
echo "  EMAIL_GATEWAY_SECRET=${SUBSTRATE_SECRET}"
