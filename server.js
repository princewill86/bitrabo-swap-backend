require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { createConfig, getRoutes, getTokens } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

app.use(cors({ origin: '*' }));

// We need a separate JSON parser for our hijacked routes, 
// BUT we must not parse the Proxy routes (proxy needs raw stream)
const jsonParser = express.json();

// --- LOGGING ---
app.use((req, res, next) => {
  // Only log interesting endpoints to keep logs clean
  if(req.url.includes('quote') || req.url.includes('build')) {
    console.log(`[⚡ HIJACK] ${req.method} ${req.url}`);
  } else {
    console.log(`[🔄 PROXY] ${req.method} ${req.url}`);
  }
  next();
});

// ==================================================================
// 1. THE HIJACKED ROUTES (Your Fees & Logic)
// ==================================================================

// Helper to format response like OneKey
const ok = (data) => ({ code: 0, data });

// --- QUOTE LOGIC (Shared) ---
async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    const amount = params.fromTokenAmount;
    
    // Quick validation
    if(!amount || amount === '0') return [];

    const routesResponse = await getRoutes({
      fromChainId: fromChain,
      toChainId: toChain,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount: amount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage || 0.5) / 100,
      options: {
        integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
        fee: Number(process.env.BITRABO_FEE || 0.0025),
      }
    });

    if (!routesResponse.routes || routesResponse.routes.length === 0) return [];

    // Map LiFi result to OneKey structure
    // This structure matches what "ServiceSwap.ts" expects
    return routesResponse.routes.map((route, i) => {
      const isBest = i === 0;
      return {
        info: {
          provider: 'lifi', // Must match the ID in providers/list
          providerName: 'Bitrabo',
          providerLogoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
        },
        fromTokenInfo: {
          networkId: params.fromNetworkId,
          contractAddress: route.fromToken.address,
          symbol: route.fromToken.symbol,
          decimals: route.fromToken.decimals
        },
        toTokenInfo: {
          networkId: params.toNetworkId,
          contractAddress: route.toToken.address,
          symbol: route.toToken.symbol,
          decimals: route.toToken.decimals
        },
        fromAmount: route.fromAmount,
        toAmount: route.toAmount,
        toAmountMin: route.toAmountMin,
        instantRate: new BigNumber(route.toAmount).div(route.fromAmount).toString(),
        estimatedTime: 60,
        kind: 'sell',
        isBest: isBest,
        receivedBest: isBest,
        
        // IMPORTANT: Passing the raw route so we can build tx later
        quoteResultCtx: route, 
        
        // IMPORTANT: Fake the approval so the button says "Swap" initially.
        // If approval is actually needed, the build-tx step handles it in LiFi
        allowanceResult: { isApproved: true },

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
    console.error("Quote Logic Error:", e.message);
    return [];
  }
}

// Intercept Standard Quote
app.get('/swap/v1/quote', async (req, res) => {
  const quotes = await fetchLiFiQuotes(req.query);
  res.json(ok(quotes));
});

// Intercept SSE Quote (The one causing "No Provider" usually)
app.get('/swap/v1/quote/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const quotes = await fetchLiFiQuotes(req.query);
    // Send the data exactly how EventSource expects it
    res.write(`data: ${JSON.stringify(quotes)}\n\n`);
    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    res.write(`data: {"type":"error"}\n\n`);
  } finally {
    res.end();
  }
});

// Intercept Build Transaction
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
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

// Force our Provider into the list
app.get('/swap/v1/providers/list', (req, res) => {
  res.json(ok([{
    provider: 'lifi', // This ID matches the quote response
    name: 'Bitrabo',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
    status: 'available',
    priority: 1
  }]));
});

// ==================================================================
// 2. THE PROXY ROUTES (Balances, History, etc.)
// ==================================================================

// Everything NOT matched above goes to OneKey's real server.
// This fixes your "Wallet amount doesn't display" error.
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent' 
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Server Running on ${PORT}`);
});
