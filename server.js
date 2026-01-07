require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getToken } = require('@lifi/sdk'); // Removed getRoutes
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
    provider: 'SwapLifi', // Must match quote provider
    name: 'Li.fi (Bitrabo)',
    logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png',
    status: 'available',
    priority: 1,
    protocols: ['swap']
  }]));
});

// Helper: Get Decimals
async function getDecimals(chainId, tokenAddress) {
    if (!tokenAddress || tokenAddress === '' || tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return 18;
    try {
        const token = await getToken(chainId, tokenAddress);
        return token.decimals || 18;
    } catch { return 18; }
}

async function fetchMockQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    // 1. Calculate Mock Amounts
    const fromAmountRaw = params.fromTokenAmount || "1";
    const rate = 3250.5; // Mock Rate: 1 Token = 3250 USDC
    const toAmountRaw = (parseFloat(fromAmountRaw) * rate).toFixed(6); 

    console.log(`[⚠️ MOCK MODE] Returning fake quote: ${fromAmountRaw} -> ${toAmountRaw}`);

    // 2. Construct Perfect OneKey Object (Based on Spy Logs)
    const quote = {
      info: {
        provider: 'SwapLifi',
        providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png',
        providerName: 'Li.fi (Bitrabo)',
      },
      fromTokenInfo: {
        contractAddress: fromToken === '0x0000000000000000000000000000000000000000' ? '' : fromToken,
        networkId: params.fromNetworkId,
        isNative: fromToken === '0x0000000000000000000000000000000000000000',
        decimals: 18,
        name: "Mock Token",
        symbol: "MOCK",
        logoURI: "https://uni.onekey-asset.com/static/chain/eth.png"
      },
      toTokenInfo: {
        contractAddress: toToken === '0x0000000000000000000000000000000000000000' ? '' : toToken,
        networkId: params.toNetworkId,
        isNative: toToken === '0x0000000000000000000000000000000000000000',
        decimals: 6,
        name: "Mock Output",
        symbol: "USDC",
        logoURI: "https://uni.onekey-asset.com/static/chain/eth.png"
      },
      protocol: 'Swap',
      kind: 'sell',
      
      // Strings required
      fromAmount: fromAmountRaw.toString(),
      toAmount: toAmountRaw.toString(),
      minToAmount: (parseFloat(toAmountRaw) * 0.99).toString(), // 1% slippage
      
      instantRate: rate.toString(),
      estimatedTime: 30,
      
      // Dummy context for build-tx
      quoteResultCtx: { 
          mock: true, 
          fromAmount: fromAmountRaw 
      },
      
      fee: {
        percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
        estimatedFeeFiatValue: 0.1
      },
      
      routesData: [{
          name: "Li.Fi Aggregator",
          part: 100,
          subRoutes: [[{ name: "Li.Fi", part: 100 }]]
      }],
      
      allowanceResult: null, // Force frontend logic
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

// Mock Build Tx - Allows clicking "Swap"
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  const { userAddress } = req.body;
  // Return a dummy self-transfer so user can see the Review Screen
  res.json(ok({
    result: { info: { provider: 'SwapLifi', providerName: 'Li.Fi (Bitrabo)' } },
    tx: {
      to: userAddress, // Self transfer
      value: "0",
      data: "0x", // Empty data
      from: userAddress,
      gas: "21000"
    }
  }));
});

app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  filter: (pathname) => {
    return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx') && !pathname.includes('check-support');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo MOCK Server v17 Running on ${PORT}`);
});
