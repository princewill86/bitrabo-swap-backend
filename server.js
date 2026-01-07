require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid'); // Install uuid: npm install uuid

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

// --- PROVIDER LIST: Copied EXACTLY from your logs ---
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  const providerData = {
    providerInfo: {
      provider: "SwapLifi", // Must match "provider" in Quote
      protocol: "Swap",
      logo: "https://uni.onekey-asset.com/static/logo/lifi.png",
      providerName: "Li.fi (Bitrabo)"
    },
    isSupportSingleSwap: true,
    isSupportCrossChain: true,
    providerServiceDisable: false,
    serviceDisableNetworks: [],
    supportSingleSwapNetworks: [
      { networkId: "evm--1", name: "Ethereum", symbol: "ETH", decimals: 18, indexerSupported: true },
      { networkId: "evm--56", name: "BNB Chain", symbol: "BNB", decimals: 18, indexerSupported: true },
      { networkId: "evm--137", name: "Polygon", symbol: "MATIC", decimals: 18, indexerSupported: true },
      { networkId: "evm--42161", name: "Arbitrum", symbol: "ETH", decimals: 18, indexerSupported: true },
      { networkId: "evm--10", name: "Optimism", symbol: "ETH", decimals: 18, indexerSupported: true },
      { networkId: "evm--8453", name: "Base", symbol: "ETH", decimals: 18, indexerSupported: true },
      { networkId: "sol--101", name: "Solana", symbol: "SOL", decimals: 9, indexerSupported: true }
    ],
    supportCrossChainNetworks: [
      { networkId: "evm--1", name: "Ethereum" },
      { networkId: "evm--56", name: "BNB Chain" },
      { networkId: "evm--137", name: "Polygon" },
      { networkId: "evm--42161", name: "Arbitrum" },
      { networkId: "sol--101", name: "Solana" }
    ]
  };
  
  res.json(ok([providerData]));
});

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

async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    const amount = await normalizeAmount(fromChain, fromToken, params.fromTokenAmount);
    if(!amount || amount === '0') return [];

    console.log(`[🔍 LIFI] Requesting ${amount} on Chain ${fromChain}`);

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
      return {
        info: {
          provider: 'SwapLifi', // MATCHES PROVIDER LIST
          providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png',
          providerName: 'Li.fi (Bitrabo)',
        },
        fromTokenInfo: {
          contractAddress: route.fromToken.address === '0x0000000000000000000000000000000000000000' ? '' : route.fromToken.address,
          networkId: params.fromNetworkId,
          isNative: route.fromToken.address === '0x0000000000000000000000000000000000000000',
          decimals: route.fromToken.decimals,
          name: route.fromToken.name,
          symbol: route.fromToken.symbol,
          logoURI: route.fromToken.logoURI
        },
        toTokenInfo: {
          contractAddress: route.toToken.address === '0x0000000000000000000000000000000000000000' ? '' : route.toToken.address,
          networkId: params.toNetworkId,
          isNative: route.toToken.address === '0x0000000000000000000000000000000000000000',
          decimals: route.toToken.decimals,
          name: route.toToken.name,
          symbol: route.toToken.symbol,
          logoURI: route.toToken.logoURI
        },
        protocol: 'Swap',
        kind: 'sell',
        fromAmount: route.fromAmount,
        toAmount: route.toAmount,
        instantRate: new BigNumber(route.toAmount).div(route.fromAmount).toString(),
        estimatedTime: route.toToken.chainId === route.fromToken.chainId ? 30 : 120,
        
        // --- CONTEXT: This matches your logs EXACTLY ---
        quoteResultCtx: {
            lifiQuoteResultCtx: route
        },
        
        fee: {
          percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
          estimatedFeeFiatValue: 0.1 // Dummy value to prevent crash
        },
        
        routesData: [],
        toAmountSlippage: 0,
        gasLimit: 500000,
        oneKeyFeeExtraInfo: {},
        supportUrl: "https://help.onekey.so/hc/requests/new",
        quoteId: uuidv4(), // Generate unique ID
        eventId: params.eventId // Pass through from header
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

  const eventId = uuidv4();

  try {
    const quotes = await fetchLiFiQuotes({ ...req.query, eventId });
    
    // 1. Send the HEADER (Total Count) - Copied from your logs
    const header = {
        totalQuoteCount: quotes.length,
        eventId: eventId
    };
    res.write(`data: ${JSON.stringify(header)}\n\n`);

    // 2. Send the AUTO SLIPPAGE info - Copied from your logs
    const slippageInfo = {
        autoSuggestedSlippage: 0.5,
        fromNetworkId: req.query.fromNetworkId,
        toNetworkId: req.query.toNetworkId,
        fromTokenAddress: req.query.fromTokenAddress || "",
        toTokenAddress: req.query.toTokenAddress,
        eventId: eventId
    };
    res.write(`data: ${JSON.stringify(slippageInfo)}\n\n`);

    // 3. Send EACH QUOTE wrapped in "data" object - Copied from your logs
    for (const quote of quotes) {
        const payload = { data: [quote] }; // OneKey sends quotes one by one in arrays
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    console.error(e);
    res.write(`data: {"type":"error"}\n\n`);
  } finally {
    res.end();
  }
});

app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  try {
    const { quoteResultCtx, userAddress } = req.body;
    
    // Unwrap the nested context we created earlier
    const route = quoteResultCtx?.lifiQuoteResultCtx;

    if (!route || !route.steps) return res.json(ok(null));

    const step = route.steps[0];
    const tx = step.transactionRequest;

    if (!tx) throw new Error("No transaction request found");

    res.json(ok({
      result: { info: { provider: 'SwapLifi', providerName: 'Li.Fi (Bitrabo)' } },
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
  console.log(`Bitrabo Hybrid Server v14 Running on ${PORT}`);
});
