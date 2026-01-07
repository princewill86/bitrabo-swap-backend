require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, data });

// --- LOGGING ---
app.use((req, res, next) => {
  const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('check-support');
  console.log(isHijack ? `[⚡ HIJACK] ${req.method} ${req.url}` : `[🔄 PROXY] ${req.method} ${req.url}`);
  next();
});

// ==================================================================
// 1. HIJACKED ROUTES
// ==================================================================

// FIX: Explicitly say "Available" for every network
app.get(['/swap/v1/check-support', '/check-support'], (req, res) => {
  res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

// FIX: Ensure provider list matches Quote info exactly
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  res.json(ok([{
    provider: 'lifi',
    name: 'Bitrabo',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
    status: 'available',
    priority: 1
  }]));
});

async function normalizeAmount(chainId, tokenAddress, rawAmount) {
  if (!rawAmount || !rawAmount.includes('.')) return rawAmount;
  try {
    if (!tokenAddress || tokenAddress === '' || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
      return ethers.parseUnits(rawAmount, 18).toString();
    }
    const token = await getToken(chainId, tokenAddress);
    if (token && token.decimals) {
      const safeAmount = Number(rawAmount).toFixed(token.decimals);
      return ethers.parseUnits(safeAmount, token.decimals).toString();
    }
    return ethers.parseUnits(rawAmount, 18).toString();
  } catch (e) {
    return rawAmount;
  }
}

async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    const amount = await normalizeAmount(fromChain, fromToken, params.fromTokenAmount);
    
    if(!amount || amount === '0') return [];

    console.log(`[🔍 LIFI DEBUG] Requesting: ${amount} of ${fromToken} on Chain ${fromChain}`);

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

    // DEBUG: Log exactly what LiFi returned
    const routeCount = routesResponse.routes ? routesResponse.routes.length : 0;
    console.log(`[🔍 LIFI DEBUG] Found ${routeCount} routes.`);

    // --- FALLBACK TEST ---
    // If LiFi returns 0 routes, we inject a FAKE one to prove the UI works.
    if (routeCount === 0) {
      console.log("[⚠️ WARNING] No LiFi routes found. Sending DUMMY quote to test UI.");
      return [{
        info: {
          provider: 'lifi',
          providerName: 'Bitrabo (TEST)',
          providerLogoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
        },
        fromTokenInfo: { networkId: params.fromNetworkId, contractAddress: fromToken, symbol: 'TEST', decimals: 18 },
        toTokenInfo: { networkId: params.toNetworkId, contractAddress: toToken, symbol: 'TEST', decimals: 18 },
        fromAmount: amount,
        toAmount: amount, // 1:1 rate
        toAmountMin: amount,
        instantRate: '1',
        estimatedTime: 60,
        kind: 'sell',
        isBest: true,
        receivedBest: true,
        allowanceResult: { isApproved: true },
        routesData: [],
        quoteResultCtx: { steps: [] }, // Empty steps might fail build-tx, but will show Quote
        fee: { percentageFee: 0.0025 }
      }];
    }

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

app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  try {
    const { quoteResultCtx, userAddress } = req.body;
    // Handle our dummy quote case
    if (!quoteResultCtx || !quoteResultCtx.steps || quoteResultCtx.steps.length === 0) {
      return res.json(ok({ result: { info: { provider: 'lifi' } }, tx: null }));
    }

    const step = quoteResultCtx.steps[0];
    const tx = step.transactionRequest;

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
// 2. PROXY FALLBACK
// ==================================================================
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  filter: (pathname) => {
    return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx') && !pathname.includes('check-support');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Server v8 Running on ${PORT}`);
});
