require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken, getStepTransaction } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

app.use((req, res, next) => {
  const isHijack = req.url.includes('quote') || req.url.includes('build-tx');
  console.log(isHijack ? `[⚡ HIJACK] ${req.method} ${req.url}` : `[🔄 PROXY] ${req.method} ${req.url}`);
  next();
});

// ==================================================================
// 1. HELPERS
// ==================================================================

async function getDecimals(chainId, tokenAddress) {
    if (!tokenAddress || tokenAddress === '' || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return 18;
    try {
        const token = await getToken(chainId, tokenAddress);
        return token.decimals || 18;
    } catch { return 18; }
}

async function normalizeAmountInput(chainId, tokenAddress, rawAmount) {
  if (!rawAmount || rawAmount === '0') return '0';
  const decimals = await getDecimals(chainId, tokenAddress);
  const safeAmount = Number(rawAmount).toFixed(decimals); 
  return ethers.parseUnits(safeAmount, decimals).toString();
}

async function formatAmountOutput(chainId, tokenAddress, amountWei) {
    if(!amountWei) return "0";
    const decimals = await getDecimals(chainId, tokenAddress);
    return ethers.formatUnits(amountWei, decimals).toString();
}

// ==================================================================
// 2. HIJACKED QUOTE ENGINE
// ==================================================================

async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    const amount = await normalizeAmountInput(fromChain, fromToken, params.fromTokenAmount);
    if(!amount || amount === '0') return [];

    console.log(`[🔍 LIFI] Requesting ${amount} atomic units`);

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

    return await Promise.all(routesResponse.routes.map(async (route, i) => {
      const fromAmountDecimal = await formatAmountOutput(fromChain, route.fromToken.address, route.fromAmount);
      const toAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmount);
      const minToAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmountMin);

      if(i===0) console.log(`[✅ QUOTE] ${fromAmountDecimal} -> ${toAmountDecimal}`);

      return {
        info: {
          provider: 'SwapLifi', 
          providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png',
          providerName: 'Li.fi (Bitrabo)',
        },
        fromTokenInfo: {
          contractAddress: route.fromToken.address === '0x0000000000000000000000000000000000000000' ? '' : route.fromToken.address,
          networkId: params.fromNetworkId,
          isNative: route.fromToken.address === '0x0000000000000000000000000000000000000000',
          decimals: route.fromToken.decimals,
          symbol: route.fromToken.symbol,
        },
        toTokenInfo: {
          contractAddress: route.toToken.address === '0x0000000000000000000000000000000000000000' ? '' : route.toToken.address,
          networkId: params.toNetworkId,
          isNative: route.toToken.address === '0x0000000000000000000000000000000000000000',
          decimals: route.toToken.decimals,
          symbol: route.toToken.symbol,
        },
        protocol: 'Swap',
        kind: 'sell',
        fromAmount: fromAmountDecimal,
        toAmount: toAmountDecimal,
        minToAmount: minToAmountDecimal,
        instantRate: new BigNumber(toAmountDecimal).div(fromAmountDecimal).toString(),
        estimatedTime: 30,
        
        // Pass the RAW route so build-tx can use it
        quoteResultCtx: { lifiQuoteResultCtx: route }, 
        
        fee: {
          percentageFee: Number(process.env.BITRABO_FEE || 0.0025) * 100, // Display 0.25%
          estimatedFeeFiatValue: 0.1 
        },
        routesData: [{
            name: "Li.Fi",
            part: 100,
            subRoutes: [[{ name: "Li.Fi", part: 100, logo: "https://uni.onekey-asset.com/static/logo/lifi.png" }]]
        }],
        
        allowanceResult: null, // Force frontend logic
        gasLimit: 500000,
        oneKeyFeeExtraInfo: {},
        supportUrl: "https://help.onekey.so/hc/requests/new",
        quoteId: uuidv4(),
        eventId: params.eventId
      };
    }));
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

  const eventId = uuidv4();

  try {
    const quotes = await fetchLiFiQuotes({ ...req.query, eventId });
    
    // Header
    res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
    res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId })}\n\n`);

    // Quotes
    for (const quote of quotes) {
        res.write(`data: ${JSON.stringify({ data: [quote] })}\n\n`);
    }

    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    res.write(`data: {"type":"error"}\n\n`);
  } finally {
    res.end();
  }
});

// ==================================================================
// 3. HIJACKED TRANSACTION BUILDER (FIXED)
// ==================================================================

app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  try {
    console.log("[⚙️ BUILD-TX] Received Request");
    const { quoteResultCtx, userAddress } = req.body;
    const route = quoteResultCtx?.lifiQuoteResultCtx;

    if (!route || !route.steps) {
        console.error("Missing route context");
        return res.json(ok(null));
    }

    // CRITICAL FIX: Fetch FRESH transaction data from Li.Fi
    // This ensures we get the latest 'data' payload for the current block
    const step = route.steps[0];
    console.log(`[⚙️ BUILD-TX] Fetching Transaction for Step: ${step.id}`);
    
    const transaction = await getStepTransaction(step); 

    if (!transaction) {
        console.error("Li.Fi failed to return transaction data");
        throw new Error("No transaction request found");
    }

    console.log("[✅ BUILD-TX] Success!");

    res.json(ok({
      result: { info: { provider: 'SwapLifi', providerName: 'Li.fi (Bitrabo)' } },
      tx: {
        to: transaction.to,
        value: transaction.value ? new BigNumber(transaction.value).toFixed() : '0',
        data: transaction.data,
        from: userAddress,
        gas: transaction.gasLimit ? new BigNumber(transaction.gasLimit).toFixed() : undefined
      }
    }));
  } catch (e) {
    console.error("[❌ BUILD-TX ERROR]", e);
    res.json(ok(null));
  }
});

// ==================================================================
// 4. PROXY FALLBACK (Providers, Config, Tokens, etc)
// ==================================================================

app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  filter: (pathname) => {
    // ONLY Hijack Quote and Build-Tx. Let Provider List go to OneKey!
    return !pathname.includes('quote') && !pathname.includes('build-tx');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Stealth Server v21 Running on ${PORT}`);
});
