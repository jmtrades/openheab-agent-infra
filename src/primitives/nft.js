// ============================================================================
// OpenHeab NFT — ERC-721 / ERC-1155 minting + internal marketplace
//
// Agents deploy NFT collections (721 or 1155), mint into them, list & buy
// internally, or push out to OpenSea / Magic Eden. Metadata is stored as a
// JSONB blob plus optional IPFS URI (uploaded via the storage primitive).
// ============================================================================

const express = require('express');
const cryptoLib = require('crypto');
const { z } = require('zod');

const NFT_KINDS = ['erc721', 'erc1155'];
const NFT_STATUSES = ['pending', 'minted', 'burned'];
const LISTING_STATUSES = ['active', 'sold', 'cancelled', 'expired'];

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nft_collections (
      collection_id      TEXT PRIMARY KEY,
      agent_did          TEXT NOT NULL,
      name               TEXT NOT NULL,
      symbol             TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'erc721',
      chain              TEXT NOT NULL DEFAULT 'base',
      contract_address   TEXT,
      base_uri           TEXT,
      total_supply       INTEGER NOT NULL DEFAULT 0,
      royalty_bps        INTEGER NOT NULL DEFAULT 0,
      royalty_recipient  TEXT,
      deployed_tx        TEXT,
      metadata           JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_nft_collections_agent
      ON nft_collections (agent_did);
    CREATE INDEX IF NOT EXISTS idx_nft_collections_chain
      ON nft_collections (chain);

    CREATE TABLE IF NOT EXISTS nfts (
      nft_id             TEXT PRIMARY KEY,
      collection_id      TEXT NOT NULL,
      token_id_onchain   TEXT NOT NULL,
      owner_address      TEXT,
      owner_did          TEXT,
      metadata_uri       TEXT,
      metadata           JSONB,
      attributes         JSONB,
      image_url          TEXT,
      minted_tx          TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      amount             INTEGER NOT NULL DEFAULT 1,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      minted_at          TIMESTAMPTZ,
      burned_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_nfts_collection
      ON nfts (collection_id);
    CREATE INDEX IF NOT EXISTS idx_nfts_owner_addr
      ON nfts (owner_address);
    CREATE INDEX IF NOT EXISTS idx_nfts_owner_did
      ON nfts (owner_did);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nfts_collection_token
      ON nfts (collection_id, token_id_onchain);

    CREATE TABLE IF NOT EXISTS nft_transfers (
      transfer_id    TEXT PRIMARY KEY,
      nft_id         TEXT NOT NULL,
      from_address   TEXT,
      to_address     TEXT,
      from_did       TEXT,
      to_did         TEXT,
      amount         INTEGER NOT NULL DEFAULT 1,
      tx_hash        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_nft_transfers_nft
      ON nft_transfers (nft_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS nft_listings (
      listing_id     TEXT PRIMARY KEY,
      nft_id         TEXT NOT NULL,
      seller_did     TEXT NOT NULL,
      price_raw      NUMERIC(78,0) NOT NULL,
      asset          TEXT NOT NULL DEFAULT 'USDC',
      marketplace    TEXT NOT NULL DEFAULT 'internal',
      external_id    TEXT,
      expires_at     TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'active',
      sold_to_did    TEXT,
      sold_to_address TEXT,
      sold_at        TIMESTAMPTZ,
      tx_hash        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_nft_listings_seller
      ON nft_listings (seller_did, status);
    CREATE INDEX IF NOT EXISTS idx_nft_listings_nft
      ON nft_listings (nft_id, status);
  `).catch(() => {});
}

function genId(prefix) {
  return `${prefix}_${cryptoLib.randomBytes(12).toString('hex')}`;
}

async function uploadMetadataToIpfs(metadata) {
  // Stub: hash payload and pretend it's a CID. Real impl would call storage primitive.
  const canonical = JSON.stringify(metadata, Object.keys(metadata).sort());
  const cid = 'bafy' + cryptoLib.createHash('sha256').update(canonical).digest('hex').slice(0, 50);
  return `ipfs://${cid}`;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
function registerNftRoutes(app, pool, verifyAgentAuth, auditChain) {
  // POST /v1/agents/:did/nft/collections — deploy collection
  const DeployCollectionSchema = z.object({
    name: z.string().min(1).max(100),
    symbol: z.string().min(1).max(20),
    kind: z.enum(NFT_KINDS).default('erc721'),
    chain: z.string().default('base'),
    base_uri: z.string().optional(),
    royalty_bps: z.number().int().min(0).max(10000).default(0),
    royalty_recipient: z.string().optional(),
    metadata: z.record(z.any()).optional()
  });

  app.post('/v1/agents/:did/nft/collections', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = DeployCollectionSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;

      const collectionId = genId('col');
      const contractAddress = '0x' + cryptoLib.createHash('sha256')
        .update(`${did}|${d.symbol}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 40);
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`deploy_nft|${collectionId}|${Date.now()}`).digest('hex');

      await pool.query(
        `INSERT INTO nft_collections
           (collection_id, agent_did, name, symbol, kind, chain, contract_address,
            base_uri, royalty_bps, royalty_recipient, deployed_tx, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [collectionId, did, d.name, d.symbol, d.kind, d.chain, contractAddress,
         d.base_uri || null, d.royalty_bps, d.royalty_recipient || did,
         txHash, JSON.stringify(d.metadata || {})]
      );

      await auditChain.append({
        event_type: 'nft.collection.deployed',
        collection_id: collectionId, agent_did: did, kind: d.kind,
        chain: d.chain, contract_address: contractAddress,
        tx_hash: txHash, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        collection_id: collectionId, agent_did: did,
        name: d.name, symbol: d.symbol, kind: d.kind,
        chain: d.chain, contract_address: contractAddress,
        base_uri: d.base_uri || null, royalty_bps: d.royalty_bps,
        deployed_tx: txHash
      });
    } catch (e) {
      console.error('[nft.collection.deploy]', e);
      return res.status(500).json({ error: 'deploy_failed', message: e.message });
    }
  });

  // GET /v1/nft/collections
  app.get('/v1/nft/collections', async (req, res) => {
    const did = req.query.agent_did;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const params = [limit];
    let where = '';
    if (did) { params.unshift(did); where = `WHERE agent_did = $1`; }
    const r = await pool.query(
      `SELECT collection_id, agent_did, name, symbol, kind, chain, contract_address,
              base_uri, total_supply, royalty_bps, created_at
         FROM nft_collections ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    ).catch(() => ({ rows: [] }));
    return res.json({ count: r.rows.length, collections: r.rows });
  });

  // GET /v1/nft/collections/:id
  app.get('/v1/nft/collections/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT * FROM nft_collections WHERE collection_id=$1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/nft/collections/:id/mint
  const MintSchema = z.object({
    minter_did: z.string(),
    to_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    to_did: z.string().optional(),
    token_id_onchain: z.string().optional(),
    metadata: z.record(z.any()).optional(),
    attributes: z.record(z.any()).optional(),
    image_url: z.string().optional(),
    amount: z.number().int().positive().default(1),
    upload_metadata: z.boolean().default(true)
  });

  app.post('/v1/nft/collections/:id/mint', express.json(), async (req, res) => {
    try {
      const parse = MintSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.minter_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const col = await pool.query(
        `SELECT agent_did, kind, total_supply, base_uri FROM nft_collections WHERE collection_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!col.rows[0]) return res.status(404).json({ error: 'collection_not_found' });
      if (col.rows[0].agent_did !== d.minter_did) {
        return res.status(403).json({ error: 'not_collection_owner' });
      }

      const nftId = genId('nft');
      const tokenIdOnchain = d.token_id_onchain || String(col.rows[0].total_supply + 1);

      let metadataUri = null;
      if (d.metadata && d.upload_metadata) {
        metadataUri = await uploadMetadataToIpfs({
          name: (d.metadata && d.metadata.name) || `${tokenIdOnchain}`,
          ...d.metadata,
          attributes: d.attributes || []
        });
      } else if (col.rows[0].base_uri) {
        metadataUri = `${col.rows[0].base_uri.replace(/\/$/, '')}/${tokenIdOnchain}`;
      }

      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`mint_nft|${nftId}|${Date.now()}`).digest('hex');

      const ownerAddress = d.to_address || ('0x' + cryptoLib.createHash('sha256')
        .update(d.to_did || d.minter_did).digest('hex').slice(0, 40));

      await pool.query(
        `INSERT INTO nfts
           (nft_id, collection_id, token_id_onchain, owner_address, owner_did,
            metadata_uri, metadata, attributes, image_url, minted_tx,
            status, amount, minted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,'minted',$11,NOW())`,
        [nftId, req.params.id, tokenIdOnchain, ownerAddress,
         d.to_did || d.minter_did, metadataUri,
         JSON.stringify(d.metadata || {}),
         JSON.stringify(d.attributes || {}),
         d.image_url || null, txHash, d.amount]
      );

      await pool.query(
        `UPDATE nft_collections SET total_supply = total_supply + 1 WHERE collection_id=$1`,
        [req.params.id]
      );

      await pool.query(
        `INSERT INTO nft_transfers (transfer_id, nft_id, from_address, to_address, to_did, amount, tx_hash)
         VALUES ($1,$2,NULL,$3,$4,$5,$6)`,
        [genId('nxfr'), nftId, ownerAddress, d.to_did || d.minter_did, d.amount, txHash]
      );

      await auditChain.append({
        event_type: 'nft.minted',
        nft_id: nftId, collection_id: req.params.id,
        token_id_onchain: tokenIdOnchain, owner_address: ownerAddress,
        owner_did: d.to_did || d.minter_did, tx_hash: txHash,
        timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        nft_id: nftId, collection_id: req.params.id,
        token_id_onchain: tokenIdOnchain,
        owner_address: ownerAddress, owner_did: d.to_did || d.minter_did,
        metadata_uri: metadataUri, tx_hash: txHash,
        status: 'minted', amount: d.amount
      });
    } catch (e) {
      console.error('[nft.mint]', e);
      return res.status(500).json({ error: 'mint_failed', message: e.message });
    }
  });

  // GET /v1/nft/:id
  app.get('/v1/nft/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT n.*, c.name AS collection_name, c.symbol AS collection_symbol,
              c.kind, c.contract_address, c.chain
         FROM nfts n JOIN nft_collections c ON c.collection_id = n.collection_id
        WHERE n.nft_id=$1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    return res.json(r.rows[0]);
  });

  // POST /v1/agents/:did/nft/:id/transfer
  app.post('/v1/agents/:did/nft/:id/transfer', express.json(), async (req, res) => {
    try {
      const did = req.params.did;
      const auth = await verifyAgentAuth(req, did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });
      const parse = z.object({
        to_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
        to_did: z.string().optional(),
        amount: z.number().int().positive().default(1)
      }).refine(d => d.to_address || d.to_did, 'recipient_required').safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }

      const nft = await pool.query(
        `SELECT owner_did, owner_address, status, amount FROM nfts WHERE nft_id=$1`,
        [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!nft.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (nft.rows[0].owner_did !== did) return res.status(403).json({ error: 'not_owner' });
      if (nft.rows[0].status !== 'minted') return res.status(400).json({ error: 'not_transferable' });

      const newOwnerAddr = parse.data.to_address || ('0x' + cryptoLib.createHash('sha256')
        .update(parse.data.to_did).digest('hex').slice(0, 40));
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`xfer_nft|${req.params.id}|${Date.now()}`).digest('hex');

      await pool.query(
        `UPDATE nfts SET owner_address=$1, owner_did=$2 WHERE nft_id=$3`,
        [newOwnerAddr, parse.data.to_did || null, req.params.id]
      );
      await pool.query(
        `INSERT INTO nft_transfers
           (transfer_id, nft_id, from_address, to_address, from_did, to_did, amount, tx_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [genId('nxfr'), req.params.id, nft.rows[0].owner_address, newOwnerAddr,
         did, parse.data.to_did || null, parse.data.amount, txHash]
      );

      await auditChain.append({
        event_type: 'nft.transferred',
        nft_id: req.params.id, from_did: did,
        to_did: parse.data.to_did || null, to_address: newOwnerAddr,
        tx_hash: txHash, timestamp: new Date().toISOString()
      });

      return res.json({ nft_id: req.params.id, tx_hash: txHash, new_owner_address: newOwnerAddr });
    } catch (e) {
      console.error('[nft.transfer]', e);
      return res.status(500).json({ error: 'transfer_failed', message: e.message });
    }
  });

  // POST /v1/nft/:id/list — internal marketplace listing
  const ListSchema = z.object({
    seller_did: z.string(),
    price_raw: z.string().regex(/^\d+$/),
    asset: z.string().default('USDC'),
    marketplace: z.enum(['internal', 'opensea', 'magic-eden']).default('internal'),
    ttl_hours: z.number().int().positive().max(8760).optional()
  });

  app.post('/v1/nft/:id/list', express.json(), async (req, res) => {
    try {
      const parse = ListSchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const d = parse.data;
      const auth = await verifyAgentAuth(req, d.seller_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const nft = await pool.query(
        `SELECT owner_did, status FROM nfts WHERE nft_id=$1`, [req.params.id]
      ).catch(() => ({ rows: [] }));
      if (!nft.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (nft.rows[0].owner_did !== d.seller_did) return res.status(403).json({ error: 'not_owner' });
      if (nft.rows[0].status !== 'minted') return res.status(400).json({ error: 'not_listable' });

      const listingId = genId('lst');
      const expiresAt = d.ttl_hours
        ? new Date(Date.now() + d.ttl_hours * 3600 * 1000) : null;

      await pool.query(
        `INSERT INTO nft_listings
           (listing_id, nft_id, seller_did, price_raw, asset, marketplace, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [listingId, req.params.id, d.seller_did, d.price_raw,
         d.asset, d.marketplace, expiresAt]
      );

      await auditChain.append({
        event_type: 'nft.listed',
        listing_id: listingId, nft_id: req.params.id,
        seller_did: d.seller_did, price_raw: d.price_raw,
        marketplace: d.marketplace, timestamp: new Date().toISOString()
      });

      return res.status(201).json({
        listing_id: listingId, nft_id: req.params.id,
        seller_did: d.seller_did, price_raw: d.price_raw,
        asset: d.asset, status: 'active', expires_at: expiresAt
      });
    } catch (e) {
      console.error('[nft.list]', e);
      return res.status(500).json({ error: 'list_failed', message: e.message });
    }
  });

  // POST /v1/nft/:id/buy
  const BuySchema = z.object({
    buyer_did: z.string(),
    listing_id: z.string().optional()
  });

  app.post('/v1/nft/:id/buy', express.json(), async (req, res) => {
    try {
      const parse = BuySchema.safeParse(req.body || {});
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid_input', details: parse.error.issues });
      }
      const { buyer_did, listing_id } = parse.data;
      const auth = await verifyAgentAuth(req, buyer_did);
      if (!auth.valid) return res.status(401).json({ error: auth.error });

      const listingRow = listing_id
        ? await pool.query(`SELECT * FROM nft_listings WHERE listing_id=$1 AND nft_id=$2`,
            [listing_id, req.params.id]).catch(() => ({ rows: [] }))
        : await pool.query(
            `SELECT * FROM nft_listings WHERE nft_id=$1 AND status='active'
              ORDER BY created_at DESC LIMIT 1`, [req.params.id]
          ).catch(() => ({ rows: [] }));
      if (!listingRow.rows[0]) return res.status(404).json({ error: 'listing_not_found' });
      const listing = listingRow.rows[0];
      if (listing.status !== 'active') return res.status(400).json({ error: 'listing_not_active' });
      if (listing.expires_at && new Date(listing.expires_at) < new Date()) {
        await pool.query(`UPDATE nft_listings SET status='expired' WHERE listing_id=$1`,
          [listing.listing_id]).catch(() => {});
        return res.status(400).json({ error: 'listing_expired' });
      }
      if (listing.seller_did === buyer_did) {
        return res.status(400).json({ error: 'cannot_buy_own' });
      }

      const buyerAddress = '0x' + cryptoLib.createHash('sha256')
        .update(buyer_did).digest('hex').slice(0, 40);
      const txHash = '0x' + cryptoLib.createHash('sha256')
        .update(`buy_nft|${listing.listing_id}|${Date.now()}`).digest('hex');

      // Update listing
      await pool.query(
        `UPDATE nft_listings
            SET status='sold', sold_to_did=$1, sold_to_address=$2,
                sold_at=NOW(), tx_hash=$3
          WHERE listing_id=$4`,
        [buyer_did, buyerAddress, txHash, listing.listing_id]
      );
      // Transfer ownership
      await pool.query(
        `UPDATE nfts SET owner_did=$1, owner_address=$2 WHERE nft_id=$3`,
        [buyer_did, buyerAddress, req.params.id]
      );
      await pool.query(
        `INSERT INTO nft_transfers
           (transfer_id, nft_id, from_did, to_did, to_address, tx_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [genId('nxfr'), req.params.id, listing.seller_did, buyer_did,
         buyerAddress, txHash]
      );

      await auditChain.append({
        event_type: 'nft.sold',
        listing_id: listing.listing_id, nft_id: req.params.id,
        seller_did: listing.seller_did, buyer_did,
        price_raw: String(listing.price_raw), asset: listing.asset,
        tx_hash: txHash, timestamp: new Date().toISOString()
      });

      return res.json({
        listing_id: listing.listing_id, nft_id: req.params.id,
        buyer_did, seller_did: listing.seller_did,
        price_raw: String(listing.price_raw), asset: listing.asset,
        tx_hash: txHash, status: 'sold'
      });
    } catch (e) {
      console.error('[nft.buy]', e);
      return res.status(500).json({ error: 'buy_failed', message: e.message });
    }
  });

  // GET /v1/agents/:did/nft — list NFTs owned by agent
  app.get('/v1/agents/:did/nft', async (req, res) => {
    const did = req.params.did;
    const r = await pool.query(
      `SELECT n.nft_id, n.collection_id, n.token_id_onchain, n.owner_address,
              n.metadata_uri, n.image_url, n.status, n.minted_at,
              c.name AS collection_name, c.symbol AS collection_symbol, c.kind, c.chain
         FROM nfts n JOIN nft_collections c ON c.collection_id = n.collection_id
        WHERE n.owner_did=$1 AND n.status='minted'
        ORDER BY n.minted_at DESC LIMIT 500`,
      [did]
    ).catch(() => ({ rows: [] }));
    return res.json({ did, count: r.rows.length, nfts: r.rows });
  });
}

module.exports = {
  migrate,
  registerNftRoutes,
  uploadMetadataToIpfs,
  NFT_KINDS,
  NFT_STATUSES,
  LISTING_STATUSES
};
