require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers'); // Ensure ethers is installed
const { createConfig, getRoutes, getToken } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

app.use(cors({ origin: '*' }));

// --- LOGGING ---
app.use((req, res, next) => {
  // Simple visual check to see what is being hijacked vs proxied
  const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('build-tx');
  console.log(isHijack ? `[⚡ HIJACK] ${req.method} ${req.url}` : `[🔄 PROXY] ${req.method} ${req.url}`);
  next();
});

// JSON Parser (Only for non-proxy routes)
const jsonParser = express.json();
const ok = (data) => ({ code: 0, data });

// ==================================================================
// 1. CRITICAL HIJACKS (Must be defined BEFORE the Proxy)
// ==================================================================

// FIX #1: Force the Provider List. 
// We use regex to ensure we catch it even if there are query params.
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  res.json(ok([{
    provider: 'lifi',
    name: 'Bitrabo',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
    status: 'available',
    priority: 1
  }]));
});

// FIX #2: Helper to fix the "0.0011" Amount Error
async function normalizeAmount(chainId, tokenAddress, rawAmount) {
  // If it doesn't contain a dot, it's likely already Wei (Integer)
  if (!rawAmount || !rawAmount.includes('.')) return rawAmount;

  try {
    // If native token (empty address), we know it's 18 decimals
    if (!tokenAddress || tokenAddress === '' || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
      return ethers.parseUnits(rawAmount, 18).toString();
    }
    
    // For other tokens, we must fetch decimals to convert correctly
    // (e.g. USDC is 6 decimals, not 18)
    const token = await getToken(chainId, tokenAddress);
    if (token && token.decimals) {
      // safe conversion limits to avoid "too many decimal points" error
      const safeAmount = Number(rawAmount).toFixed(token.decimals);
      return ethers.parseUnits(safeAmount, token.decimals).toString();
    }
    
    // Fallback if token fetch fails (assume 18)
    return ethers.parseUnits(rawAmount, 18).toString();
  } catch (e) {
    console.error("Amount Normalization Failed:", e);
    return rawAmount; // Try passing raw as last resort
  }
}

// --- QUOTE LOGIC ---
async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    // Apply Fix #2
    const amount = await normalizeAmount(fromChain, fromToken, params.fromTokenAmount);
    
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

    return routesResponse.routes.map((route, i) => {
      const isBest = i === 0;
      return {
        info: {
          provider: 'lifi', 
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
        quoteResultCtx: route, 
        allowanceResult: { isApproved: true }, // Assume approved, let build-tx handle perms
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

// SSE Endpoint (Hijack)
app.get('/swap/v1/quote/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

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

// Build Tx Endpoint (Hijack)
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

// ==================================================================
// 2. PROXY FALLBACK (Everything else goes to OneKey)
// ==================================================================
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  // Ensure we don't double-proxy the hijacked routes if something slips through
  filter: (pathname, req) => {
    return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Server v7 Running on ${PORT}`);
});
