require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getToken } = require('@lifi/sdk'); 
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

app.use(cors({ origin: '*' }));

// --- LOGGING ---
app.use((req, res, next) => {
  const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('check-support') || req.url.includes('build-tx');
  console.log(isHijack ? `[⚡ HIJACK] ${req.method} ${req.url}` : `[🔄 PROXY] ${req.method} ${req.url}`);
  next();
});

const ok = (data) => ({ code: 0, message: "Success", data });

// ==================================================================
// 1. HIJACKED ROUTES
// ==================================================================

app.get(['/swap/v1/check-support', '/check-support'], (req, res) => {
  res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  res.json(ok([{
    provider: 'SwapLifi',
    name: 'Li.fi (Bitrabo)',
    logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png',
    status: 'available',
    priority: 1,
    protocols: ['swap']
  }]));
});

// Mock Logic
async function fetchMockQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress;
    const toToken = params.toTokenAddress;
    
    // STRICT NATIVE CHECK
    const isNativeSell = (!fromToken || fromToken === '' || fromToken === '0x0000000000000000000000000000000000000000' || fromToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');

    const fromAmountRaw = params.fromTokenAmount || "1";
    let rate, toAmountRaw;

    if (isNativeSell) {
        rate = 3250.5;
        toAmountRaw = (parseFloat(fromAmountRaw) * rate).toFixed(6); 
    } else {
        rate = 1 / 3250.5; 
        toAmountRaw = (parseFloat(fromAmountRaw) * rate).toFixed(18); 
    }

    console.log(`[⚠️ MOCK CALC] ${fromAmountRaw} ${isNativeSell ? 'ETH' : 'USDT'} -> ${toAmountRaw}`);

    const quote = {
      info: {
        provider: 'SwapLifi',
        providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png',
        providerName: 'Li.fi (Bitrabo)',
      },
      fromTokenInfo: {
        contractAddress: isNativeSell ? '' : fromToken,
        networkId: params.fromNetworkId,
        isNative: isNativeSell,
        decimals: isNativeSell ? 18 : 6, 
        name: isNativeSell ? "Ethereum" : "Tether USD",
        symbol: isNativeSell ? "ETH" : "USDT",
        logoURI: "https://uni.onekey-asset.com/static/chain/eth.png"
      },
      toTokenInfo: {
        contractAddress: isNativeSell ? toToken : '',
        networkId: params.toNetworkId,
        isNative: !isNativeSell,
        decimals: isNativeSell ? 6 : 18,
        name: isNativeSell ? "USD Coin" : "Ethereum",
        symbol: isNativeSell ? "USDC" : "ETH",
        logoURI: "https://uni.onekey-asset.com/static/chain/eth.png"
      },
      protocol: 'Swap',
      kind: 'sell',
      
      fromAmount: fromAmountRaw.toString(),
      toAmount: toAmountRaw.toString(),
      minToAmount: (parseFloat(toAmountRaw) * 0.99).toString(),
      
      instantRate: rate.toString(),
      estimatedTime: 30,
      
      // Pass data safely to build-tx
      quoteResultCtx: { 
          mock: true, 
          fromAmount: fromAmountRaw,
          isNative: isNativeSell,
          toToken: toToken
      },
      
      fee: {
        percentageFee: 0.25, 
        estimatedFeeFiatValue: 0.1
      },
      
      routesData: [{
          name: "Li.Fi Aggregator",
          part: 100,
          subRoutes: [[{ name: "Li.Fi", part: 100 }]]
      }],
      
      allowanceResult: null,
      gasLimit: 500000,
      oneKeyFeeExtraInfo: {},
      supportUrl: "https://help.onekey.so/hc/requests/new",
      quoteId: uuidv4(),
      eventId: params.eventId
    };

    return [quote];
  } catch (e) {
    console.error("Mock Logic Error:", e.message);
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
    const quotes = await fetchMockQuotes({ ...req.query, eventId });
    
    const header = { totalQuoteCount: quotes.length, eventId: eventId };
    res.write(`data: ${JSON.stringify(header)}\n\n`);

    const slippageInfo = {
        autoSuggestedSlippage: 0.5,
        fromNetworkId: req.query.fromNetworkId,
        toNetworkId: req.query.toNetworkId,
        fromTokenAddress: req.query.fromTokenAddress || "",
        toTokenAddress: req.query.toTokenAddress,
        eventId: eventId
    };
    res.write(`data: ${JSON.stringify(slippageInfo)}\n\n`);

    for (const quote of quotes) {
        const payload = { data: [quote] }; 
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    res.write(`data: {"type":"error"}\n\n`);
  } finally {
    res.end();
  }
});

// CRASH PROOF BUILD-TX
app.post('/swap/v1/build-tx', express.json(), async (req, res) => {
  try {
      console.log("[⚙️ BUILD-TX] Generating Transaction...");
      
      // Default to "0" and "ETH" if body parsing fails
      let fromAmount = "0";
      let isNative = true;
      let userAddress = "0x0000000000000000000000000000000000000000";

      if (req.body && req.body.quoteResultCtx) {
          fromAmount = req.body.quoteResultCtx.fromAmount || "0";
          isNative = req.body.quoteResultCtx.isNative;
          userAddress = req.body.userAddress || userAddress;
      }

      // Calculate Value:
      const valueWei = isNative 
        ? ethers.parseUnits(fromAmount.toString(), 18).toString() 
        : "0";

      // Self-transfer data
      const data = "0x"; 

      const response = {
        result: { info: { provider: 'SwapLifi', providerName: 'Li.Fi (Bitrabo)' } },
        tx: {
          to: userAddress, 
          value: valueWei,
          data: data, 
          from: userAddress,
          gas: "21000"
        }
      };

      console.log("[✅ BUILD-TX] Sending Response");
      res.json(ok(response));

  } catch (e) {
      console.error("[❌ BUILD-TX ERROR]", e);
      // Send a dummy fallback instead of crashing
      res.json(ok({
          result: { info: { provider: 'SwapLifi', providerName: 'Li.Fi (Bitrabo)' } },
          tx: { to: req.body?.userAddress, value: "0", data: "0x" }
      }));
  }
});

// Proxy Fallback
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  filter: (pathname) => {
    return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx') && !pathname.includes('check-support');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo PERFECT MOCK Server v23 Running on ${PORT}`);
});
