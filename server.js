require('dotenv').config();
const express = require('express');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { createConfig, getRoutes, getTokens } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
});

app.use(cors());
app.use(express.json());

// --- HELPERS ---
const ok = (data) => ({ code: 0, data });
const toLiFiChain = (id) => (id ? parseInt(id.replace('evm--', '')) : 1);
const toOneKeyChain = (id) => `evm--${id}`;

// --- CORE LOGIC (Shared) ---
async function fetchLiFiQuotes(params) {
  try {
    // 1. Setup Params
    const fromChain = toLiFiChain(params.fromNetworkId);
    const toChain = toLiFiChain(params.toNetworkId);
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    const amount = params.fromTokenAmount;
    const user = params.userAddress;

    // 2. Fetch from LiFi
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

    // 3. Transform to OneKey Format
    return routesResponse.routes.map((route, i) => {
      const isBest = i === 0;
      return {
        info: {
          provider: 'lifi', // Must match ID in provider list
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
        quoteResultCtx: route, // Context for build-tx
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

// --- DISCOVERY ENDPOINTS (Fixes "No Provider Supported") ---

// 1. Check Support: Tells frontend "Yes, this chain works"
app.get('/swap/v1/check-support', (req, res) => {
  res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

// 2. Providers List: Tells frontend "These are the providers available"
app.get('/swap/v1/providers/list', (req, res) => {
  res.json(ok([
    {
      provider: 'lifi',
      name: 'Bitrabo',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
      status: 'available',
      priority: 1
    }
  ]));
});

// 3. Native Token Config: Gas buffers (Required for ETH/Native swaps)
app.get('/swap/v1/native-token-config', (req, res) => {
  res.json(ok({
    networkId: req.query.networkId,
    reserveGas: '21000', // Standard gas buffer
    minValue: '0'
  }));
});

// --- CORE ENDPOINTS ---

app.get('/swap/v1/networks', async (req, res) => {
  try {
    const { tokens } = await getTokens();
    const networks = Object.keys(tokens).map(id => ({
      networkId: toOneKeyChain(id),
      name: `EVM ${id}`,
      shortcode: 'ETH',
      logoURI: '',
      supportCrossChainSwap: true,
      supportSingleSwap: true,
      defaultSelectToken: []
    }));
    res.json(ok(networks));
  } catch (e) { res.json(ok([])); }
});

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

app.get('/swap/v1/quote', async (req, res) => {
  const quotes = await fetchLiFiQuotes(req.query);
  res.json(ok(quotes));
});

// Fixes SSE connection issues
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
    res.json(ok(null)); // Frontend handles null gracefully
  }
});

app.listen(PORT, () => console.log(`Bitrabo Mirror Running on ${PORT}`));
