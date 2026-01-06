require('dotenv').config();
const express = require('express');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getTokens } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. LIFI CONFIGURATION ---
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

// --- 2. RPC PROVIDERS (For Allowance Checks) ---
// Add your own RPCs here for better stability
const RPCS = {
  1: 'https://eth.llamarpc.com',
  56: 'https://binance.llamarpc.com',
  137: 'https://polygon.llamarpc.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io',
  8453: 'https://mainnet.base.org',
};

app.use(cors());
app.use(express.json());

// --- 3. HELPER FUNCTIONS ---

// Wraps response in OneKey's expected format: { code: 0, data: ... }
const ok = (data) => ({ code: 0, data });

const toLiFiChain = (id) => (id ? parseInt(id.replace('evm--', '')) : 1);
const toOneKeyChain = (id) => `evm--${id}`;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// --- 4. CORE ENDPOINTS ---

/**
 * GET /swap/v1/check-support
 * CRITICAL: Fixes "No provider supported" error.
 * Tells frontend that this network is supported.
 */
app.get('/swap/v1/check-support', (req, res) => {
  const { networkId } = req.query;
  // We simply say "available" for any network we are asked about
  res.json(ok([{ status: 'available', networkId }]));
});

/**
 * GET /swap/v1/providers/list
 * CRITICAL: Fixes the 404 error.
 * Tells frontend which providers to look for in the quote response.
 */
app.get('/swap/v1/providers/list', (req, res) => {
  res.json(ok([
    {
      provider: 'lifi',
      name: 'Li.Fi (Bitrabo)',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
      status: 'available',
      priority: 1
    }
  ]));
});

/**
 * GET /swap/v1/native-token-config
 * Required for ETH/Native swaps to work (calculates gas reserve).
 */
app.get('/swap/v1/native-token-config', (req, res) => {
  res.json(ok({
    networkId: req.query.networkId,
    reserveGas: '21000', 
    minValue: '0'
  }));
});

/**
 * GET /swap/v1/networks
 */
app.get('/swap/v1/networks', async (req, res) => {
  try {
    const { tokens } = await getTokens();
    const networks = Object.keys(tokens).map(id => ({
      networkId: toOneKeyChain(id),
      name: `EVM ${id}`,
      shortcode: 'ETH', // Simplified
      logoURI: '',
      supportCrossChainSwap: true,
      supportSingleSwap: true,
      defaultSelectToken: []
    }));
    res.json(ok(networks));
  } catch (e) { res.json(ok([])); }
});

/**
 * GET /swap/v1/tokens
 */
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords } = req.query;
    const chainId = toLiFiChain(networkId);
    const { tokens } = await getTokens({ chains: [chainId] });
    
    let list = tokens[chainId] || [];
    if (keywords) {
      const k = keywords.toLowerCase();
      list = list.filter(t => t.name.toLowerCase().includes(k) || t.symbol.toLowerCase().includes(k));
    }

    res.json(ok(list.slice(0, 100).map(t => ({
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      contractAddress: t.address,
      logoURI: t.logoURI,
      networkId: networkId,
      isNative: t.address === '0x0000000000000000000000000000000000000000',
    }))));
  } catch (e) { res.json(ok([])); }
});

/**
 * GET /swap/v1/allowance
 * Checks on-chain if the user needs to approve the token.
 */
app.get('/swap/v1/allowance', async (req, res) => {
  try {
    const { networkId, tokenAddress, spenderAddress, walletAddress } = req.query;
    const chainId = toLiFiChain(networkId);

    // If native token (e.g. ETH), allowance is always infinite
    if (tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
      return res.json(ok({ allowance: '115792089237316195423570985008687907853269984665640564039457584007913129639935' }));
    }

    const rpc = RPCS[chainId];
    if (!rpc) {
      // If we don't have an RPC, assume 0 allowance to force an approve (safer)
      return res.json(ok({ allowance: '0' })); 
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const allowance = await contract.allowance(walletAddress, spenderAddress);
    
    res.json(ok({ allowance: allowance.toString() }));

  } catch (e) {
    console.error("Allowance Error:", e);
    res.json(ok({ allowance: '0' }));
  }
});

// --- 5. QUOTE & TX LOGIC ---

async function fetchLiFiQuotes(params) {
  try {
    const fromChain = toLiFiChain(params.fromNetworkId);
    const toChain = toLiFiChain(params.toNetworkId);
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    const amount = params.fromTokenAmount;
    const user = params.userAddress;

    const routesResponse = await getRoutes({
      fromChainId: fromChain,
      toChainId: toChain,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount: amount,
      fromAddress: user,
      slippage: Number(params.slippagePercentage || 0.5) / 100,
      options: {
        integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
        fee: Number(process.env.BITRABO_FEE || 0.0025),
      },
    });

    if (!routesResponse.routes || routesResponse.routes.length === 0) return [];

    return routesResponse.routes.map((route, i) => {
      const isBest = i === 0;
      return {
        info: {
          provider: 'lifi',
          providerName: 'Bitrabo (Li.Fi)',
          providerLogoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
        },
        fromTokenInfo: {
          networkId: params.fromNetworkId,
          contractAddress: route.fromToken.address,
          symbol: route.fromToken.symbol,
          name: route.fromToken.name,
          decimals: route.fromToken.decimals,
          isNative: route.fromToken.address === '0x0000000000000000000000000000000000000000',
        },
        toTokenInfo: {
          networkId: params.toNetworkId,
          contractAddress: route.toToken.address,
          symbol: route.toToken.symbol,
          name: route.toToken.name,
          decimals: route.toToken.decimals,
          isNative: route.toToken.address === '0x0000000000000000000000000000000000000000',
        },
        fromAmount: route.fromAmount,
        toAmount: route.toAmount,
        toAmountMin: route.toAmountMin,
        instantRate: new BigNumber(route.toAmount).div(route.fromAmount).toString(),
        estimatedTime: 60,
        kind: 'sell',
        isBest,
        receivedBest: isBest,
        quoteResultCtx: route, 
        routesData: route.steps.map(s => ({
            name: s.toolDetails.name,
            part: 100,
            subRoutes: [[{ name: s.toolDetails.name, part: 100 }]] 
        })),
        fee: {
          percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
          feeReceiver: process.env.BITRABO_FEE_RECEIVER
        }
      };
    });
  } catch (e) {
    console.error("Quote Error:", e.message);
    return [];
  }
}

app.get('/swap/v1/quote', async (req, res) => {
  const quotes = await fetchLiFiQuotes(req.query);
  res.json(ok(quotes));
});

app.get('/swap/v1/quote/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    const quotes = await fetchLiFiQuotes(req.query);
    res.write(`data: ${JSON.stringify(quotes)}\n\n`);
    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    res.write(`data: {"type":"error"}\n\n`);
  } finally {
    res.end();
  }
});

app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    const { quoteResultCtx, userAddress } = req.body;
    if (!quoteResultCtx || !quoteResultCtx.steps) return res.json(ok(null));

    const step = quoteResultCtx.steps[0]; 
    const tx = step.transactionRequest;

    if (!tx) throw new Error("No transaction request found");

    res.json(ok({
      result: { info: { provider: 'lifi', providerName: 'Bitrabo' } },
      tx: {
        to: tx.to,
        value: tx.value ? new BigNumber(tx.value).toFixed() : '0',
        data: tx.data,
        from: userAddress,
        gas: tx.gasLimit ? new BigNumber(tx.gasLimit).toFixed() : undefined
      }
    }));
  } catch (e) {
    console.error(e);
    res.json(ok(null));
  }
});

app.listen(PORT, () => console.log(`Bitrabo Mirror Running on ${PORT}`));
