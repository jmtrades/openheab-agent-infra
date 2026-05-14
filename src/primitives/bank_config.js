// ============================================================================
// bank_config.js — Multi-chain & asset configuration (pure, no migrations)
// ============================================================================

const CHAINS = {
  'base': {
    chainId: 8453,
    rpc: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    kind: 'evm',
    feeSplitter: process.env.BASE_FEE_SPLITTER || null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18
  },
  'base-sepolia': {
    chainId: 84532,
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    kind: 'evm',
    feeSplitter: process.env.BASE_SEPOLIA_FEE_SPLITTER || null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18
  },
  'optimism': {
    chainId: 10,
    rpc: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io',
    kind: 'evm',
    feeSplitter: process.env.OPTIMISM_FEE_SPLITTER || null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18
  },
  'arbitrum': {
    chainId: 42161,
    rpc: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    kind: 'evm',
    feeSplitter: process.env.ARBITRUM_FEE_SPLITTER || null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18
  },
  'polygon': {
    chainId: 137,
    rpc: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    explorer: 'https://polygonscan.com',
    kind: 'evm',
    feeSplitter: process.env.POLYGON_FEE_SPLITTER || null,
    nativeSymbol: 'MATIC',
    nativeDecimals: 18
  },
  'ethereum': {
    chainId: 1,
    rpc: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    explorer: 'https://etherscan.io',
    kind: 'evm',
    feeSplitter: process.env.ETHEREUM_FEE_SPLITTER || null,
    nativeSymbol: 'ETH',
    nativeDecimals: 18
  },
  'solana': {
    chainId: null,
    rpc: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    explorer: 'https://explorer.solana.com',
    kind: 'solana',
    feeSplitter: null,
    nativeSymbol: 'SOL',
    nativeDecimals: 9
  },
  'bitcoin': {
    chainId: null,
    rpc: process.env.BITCOIN_RPC_URL || 'https://blockstream.info/api',
    explorer: 'https://blockstream.info',
    kind: 'bitcoin',
    feeSplitter: null,
    nativeSymbol: 'BTC',
    nativeDecimals: 8
  }
};

const ASSETS = {
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    chains: {
      'base':            { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      'optimism':        { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      'arbitrum':        { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      'polygon':         { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      'ethereum':        { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      'solana':          { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }
    }
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    chains: {
      'ethereum':        { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      'polygon':         { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      'arbitrum':        { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      'optimism':        { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      'solana':          { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 }
    }
  },
  DAI: {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    chains: {
      'ethereum':        { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
      'polygon':         { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
      'arbitrum':        { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
      'optimism':        { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
      'base':            { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 }
    }
  },
  EURC: {
    symbol: 'EURC',
    name: 'Euro Coin',
    chains: {
      'base':            { address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6 },
      'ethereum':        { address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', decimals: 6 }
    }
  }
};

function getChainConfig(chain) {
  return CHAINS[chain] || null;
}

function getAssetConfig(asset, chain) {
  const a = ASSETS[asset];
  if (!a) return null;
  const c = a.chains[chain];
  if (!c) return null;
  return {
    symbol: a.symbol,
    name: a.name,
    chain,
    address: c.address,
    decimals: c.decimals
  };
}

function listSupportedAssets(chain) {
  if (!chain) {
    return Object.keys(ASSETS).map(s => ({
      symbol: s,
      name: ASSETS[s].name,
      chains: Object.keys(ASSETS[s].chains)
    }));
  }
  const out = [];
  for (const [sym, def] of Object.entries(ASSETS)) {
    if (def.chains[chain]) {
      out.push({
        symbol: sym,
        name: def.name,
        chain,
        address: def.chains[chain].address,
        decimals: def.chains[chain].decimals
      });
    }
  }
  return out;
}

function listSupportedChains() {
  return Object.entries(CHAINS).map(([name, cfg]) => ({
    name,
    chainId: cfg.chainId,
    kind: cfg.kind,
    explorer: cfg.explorer,
    nativeSymbol: cfg.nativeSymbol
  }));
}

module.exports = {
  CHAINS,
  ASSETS,
  getChainConfig,
  getAssetConfig,
  listSupportedAssets,
  listSupportedChains
};
