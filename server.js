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

app.get(['/swap/v1/check-support', '/check-support'], (req, res) => {
  res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  res.json(ok([{
    provider: 'lifi',
    name: 'Bitrabo',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
    status: 'available',
    priority: 1
  }]));
});

// --- HELPER: Normalize Amount ---
async function normalizeAmount(chainId, tokenAddress, rawAmount) {
  if (!rawAmount || rawAmount === '0') return '0';
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

// --- QUOTE LOGIC ---
async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    // Check if Native Token (ETH, MATIC, BNB)
    const isNative = fromToken === '0x0000000000000000000000000000000000000000';

    const amount = await normalizeAmount(fromChain, fromToken, params.fromTokenAmount);
    
    if(!amount || amount === '0') return [];

    console.log(`[🔍 LIFI REQUEST] ${params.fromTokenAmount} (${amount}) ${fromToken} -> ${toToken}`);

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

    if (!routesResponse.routes || routesResponse.routes.length === 0) {
      console.log(`[⚠️ LIFI] No routes found.`);
      return [];
    }

    console.log(`[✅ LIFI] Found ${routesResponse.routes.length} routes.`);

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
        estimatedTime: route.toToken.chainId === route.fromToken.chainId ? 30 : 120,
        kind: 'sell',
        isBest: isBest,
        receivedBest: isBest,
        quoteResultCtx: route, 
        
        // --- CRITICAL FIX IS HERE ---
        // Only send allowanceResult if it's NOT native token.
        // If we send this for ETH, OneKey tries to "Approve ETH" and fails.
        allowanceResult: isNative ? null : { isApproved: true }, 
        
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
    const responsePayload = ok(quotes); 
    res.write(`data: ${JSON.stringify(responsePayload)}\n\n`);
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
    if (!quoteResultCtx || !quoteResultCtx.steps || quoteResultCtx.steps.length === 0) {
      return res.json(ok(null));
    }

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
  console.log(`Bitrabo Hybrid Server v11 Running on ${PORT}`);
});
