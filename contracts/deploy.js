// ============================================================================
// FeeSplitter deployment script — Base mainnet / Base sepolia
// ============================================================================
const fs = require('fs');
const path = require('path');
const {
  createWalletClient, createPublicClient, http, encodeAbiParameters
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base, baseSepolia } = require('viem/chains');

async function main() {
  const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
  const TREASURY = process.env.TREASURY_ADDRESS;
  const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
  const FEE_BPS = parseInt(process.env.FEE_BPS || '100');

  if (!DEPLOYER_KEY) throw new Error('DEPLOYER_KEY env var required');
  if (!TREASURY) throw new Error('TREASURY_ADDRESS env var required');
  if (FEE_BPS > 500) throw new Error('FEE_BPS cannot exceed 500 (5%)');

  const buildDir = path.join(__dirname, 'build');
  const binPath = path.join(buildDir, 'FeeSplitter.bin');
  const abiPath = path.join(buildDir, 'FeeSplitter.abi');

  if (!fs.existsSync(binPath) || !fs.existsSync(abiPath)) {
    throw new Error(
      `Bytecode not found at ${binPath}. Compile first:\n` +
      `  npx solc@0.8.24 --bin --abi contracts/FeeSplitter.sol -o contracts/build\n` +
      `or:\n  forge build`
    );
  }

  const bytecode = '0x' + fs.readFileSync(binPath, 'utf8').trim();
  const isSepolia = RPC_URL.includes('sepolia');
  const chain = isSepolia ? baseSepolia : base;

  const account = privateKeyToAccount(DEPLOYER_KEY.startsWith('0x') ? DEPLOYER_KEY : '0x' + DEPLOYER_KEY);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });

  console.log('[deploy] chain:', chain.name);
  console.log('[deploy] deployer:', account.address);
  console.log('[deploy] treasury:', TREASURY);
  console.log('[deploy] fee_bps:', FEE_BPS);

  const balance = await pub.getBalance({ address: account.address });
  console.log('[deploy] balance:', balance.toString(), 'wei');
  if (balance === 0n) throw new Error('deployer has 0 ETH');

  const constructorArgs = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint16' }],
    [TREASURY, FEE_BPS]
  );
  const deployBytecode = bytecode + constructorArgs.slice(2);

  console.log('[deploy] submitting...');
  const hash = await wallet.sendTransaction({
    data: deployBytecode, to: null, value: 0n
  });
  console.log('[deploy] tx hash:', hash);

  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('deployment failed: no contract address in receipt');
  console.log('[deploy] contract address:', receipt.contractAddress);
  console.log('[deploy] gas used:', receipt.gasUsed?.toString());

  console.log('\nAdd to Vercel env:');
  console.log(`  FEE_SPLITTER_ADDRESS=${receipt.contractAddress}`);
  console.log(`  PLATFORM_TREASURY_ADDRESS=${TREASURY}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('[deploy] failed:', e.message);
    process.exit(1);
  });
}
