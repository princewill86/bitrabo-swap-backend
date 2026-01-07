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
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

app.use((req, res, next) => {
  const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('check-support') || req.url.includes('build-tx');
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
    provider: 'SwapLifi',
    name: 'Li.fi (Bitrabo)',
    logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png',
    status: 'available',
    priority: 1,
    protocols: ['swap']
  }]));
});

// Mock Quote Logic
async function fetchMockQuotes(params) {
  try {
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

    console.log(`[⚠️ MOCK CALC] ${fromAmountRaw} ${isNativeSell ? 'ETH' : 'TOKEN'} -> ${toAmountRaw}`);

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
      
      // Pass VITAL info to build-tx
      quoteResultCtx: { 
          mock: true, 
          fromAmount: fromAmountRaw,
          isNative: isNativeSell,
          fromTokenAddress: fromToken
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

// --- BUILD TX (GOLDEN KEY MATCHED) ---
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  try {
      console.log("[⚙️ BUILD-TX] Generating Transaction...");
      
      let fromAmount = "0";
      let isNative = true;
      let fromTokenAddress = "";
      let userAddress = req.body.userAddress;

      if (req.body && req.body.quoteResultCtx) {
          fromAmount = req.body.quoteResultCtx.fromAmount || "0";
          isNative = req.body.quoteResultCtx.isNative;
          fromTokenAddress = req.body.quoteResultCtx.fromTokenAddress;
      }

      let txTo, txValue, txData;

      if (isNative) {
          // ETH: Send directly to Self
          txTo = userAddress;
          txValue = ethers.parseUnits(fromAmount.toString(), 18).toString();
          txData = "0x";
      } else {
          // TOKEN: Encode "transfer(to, amount)" to Self
          // This creates valid EVM data so simulation succeeds
          txTo = fromTokenAddress; // Send TO the token contract
          txValue = "0";
          
          const abi = ["function transfer(address to, uint256 amount) returns (bool)"];
          const iface = new ethers.Interface(abi);
          // Assuming 6 decimals for USDT mockup
          const amountAtomic = ethers.parseUnits(fromAmount.toString(), 6); 
          txData = iface.encodeFunctionData("transfer", [userAddress, amountAtomic]);
      }

      // Structure matches the Golden Key Spy Log EXACTLY
      const response = {
        result: { 
            info: { provider: 'SwapLifi', providerName: 'Li.fi (Bitrabo)' },
            routesData: [] // Required by Golden Key
        },
        ctx: { lifiToNetworkId: "evm--1" },
        orderId: uuidv4(),
        tx: {
          to: txTo, 
          value: txValue,
          data: txData, 
          from: userAddress,
          gas: "100000"
        }
      };

      console.log("[✅ BUILD-TX] Sending Valid Simulation Data");
      res.json(ok(response));

  } catch (e) {
      console.error("[❌ BUILD-TX ERROR]", e);
      res.json(ok(null));
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
  console.log(`Bitrabo VALID MOCK Server v24 Running on ${PORT}`);
});
