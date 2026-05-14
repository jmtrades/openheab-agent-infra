# OpenHeab substrate — dev shortcuts

.PHONY: help install dev migrate test boot unit smoke contracts clean

help:
	@echo "Commands:"
	@echo "  make install     install npm deps"
	@echo "  make dev         run substrate locally"
	@echo "  make migrate     run all migrations against DATABASE_URL"
	@echo "  make test        run boot + unit tests"
	@echo "  make boot        route-registration boot test"
	@echo "  make unit        pure-function unit tests"
	@echo "  make smoke       end-to-end smoke against BASE"
	@echo "  make contracts   forge build + test the FeeSplitter"

install:
	npm install --no-audit --no-fund

dev:
	node server.js

migrate:
	npm run migrate

test: boot unit

boot:
	@DATABASE_URL=postgres://x:x@x/x?sslmode=require \
	 STRIPE_SECRET_KEY=sk_test_dummy \
	 STRIPE_WEBHOOK_SECRET=whsec_dummy \
	 STRIPE_PRICE_PRO_MONTHLY=price_dummy \
	 IDENTITY_MASTER_KEK=$$(node -e "console.log('0'.repeat(64))") \
	 CRYPTO_MASTER_KEK=$$(node -e "console.log('0'.repeat(64))") \
	 BANK_MASTER_KEK=$$(node -e "console.log('0'.repeat(64))") \
	 OPERATOR_PUBLIC_URL=https://openheab.com \
	 OPENAI_API_KEY=sk-dummy \
	 node test/boot.js

unit:
	@BANK_MASTER_KEK=$$(node -e "console.log('0'.repeat(64))") \
	 node test/unit.js

smoke:
	BASE=$${BASE:-http://localhost:3000} node test/smoke.js

contracts:
	@cd contracts && forge build && forge test -vvv

clean:
	rm -rf node_modules .vercel
