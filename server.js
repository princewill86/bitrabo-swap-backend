require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
// 1. Fee for Li.Fi Execution (0.0025 = 0.25%)
const INTEGRATOR_FEE = Number(process.env.BITRABO_FEE || 0.0025);
// 2. Fee for OneKey Display (0.25 = 0.25%)
const DISPLAY_FEE = INTEGRATOR_FEE * 100; 

createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: INTEGRATOR_FEE,
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
    provider: 'SwapLifi', 
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

// Helper: Human -> Atomic
async function normalizeAmountInput(chainId, tokenAddress, rawAmount) {
  if (!rawAmount || rawAmount === '0') return '0';
  const decimals = await getDecimals(chainId, tokenAddress);
  const safeAmount = Number(rawAmount).toFixed(decimals); 
  return ethers.parseUnits(safeAmount, decimals).toString();
}

// Helper: Atomic -> Human
async function formatAmountOutput(chainId, tokenAddress, amountWei) {
    if(!amountWei) return "0";
    const decimals = await getDecimals(chainId, tokenAddress);
    return ethers.formatUnits(amountWei, decimals).toString();
}

async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    // 1. Prepare Amount
    const amount = await normalizeAmountInput(fromChain, fromToken, params.fromTokenAmount);
    if(!amount || amount === '0') return [];

    console.log(`[🔍 LIFI] Requesting ${amount} atomic units on Chain ${fromChain}`);

    // 2. Call Li.Fi
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
        fee: INTEGRATOR_FEE, // 0.0025
      }
    });

    if (!routesResponse.routes || routesResponse.routes.length === 0) return [];

    // 3. Map Response
    return await Promise.all(routesResponse.routes.map(async (route, i) => {
      const fromAmountDecimal = await formatAmountOutput(fromChain, route.fromToken.address, route.fromAmount);
      const toAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmount);
      const minToAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmountMin);

      // Log successful quote for debugging
      if (i===0) console.log(`[✅ QUOTE] ${fromAmountDecimal} -> ${toAmountDecimal}`);

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
        fromAmount: fromAmountDecimal,
        toAmount: toAmountDecimal,
        minToAmount: minToAmountDecimal,
        instantRate: new BigNumber(toAmountDecimal).div(fromAmountDecimal).toString(),
        estimatedTime: route.toToken.chainId === route.fromToken.chainId ? 30 : 120,
        
        quoteResultCtx: { lifiQuoteResultCtx: route }, 
        
        // --- FEE DISPLAY FIX ---
        fee: {
          percentageFee: DISPLAY_FEE, // Sends 0.25 (User sees 0.25%)
          estimatedFeeFiatValue: 0.1 
        },
        
        routesData: [{
            name: "Li.Fi Aggregator",
            part: 100,
            subRoutes: [[{ name: route.steps[0]?.toolDetails?.name || "Li.Fi", part: 100 }]]
        }],
        
        allowanceResult: null, 
        gasLimit: 500000,
        oneKeyFeeExtraInfo: {},
        supportUrl: "https://help.onekey.so/hc/requests/new",
        quoteId: uuidv4(),
        eventId: params.eventId
      };
    }));
  } catch (e) {
    console.error("Quote Logic Error:", e.message);
    return []; // Return empty to prevent crash
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
    const header = { totalQuoteCount: quotes.length, eventId: eventId };
    res.write(`data: ${JSON.stringify(header)}\n\n`);

    // Slippage
    const slippageInfo = {
        autoSuggestedSlippage: 0.5,
        fromNetworkId: req.query.fromNetworkId,
        toNetworkId: req.query.toNetworkId,
        fromTokenAddress: req.query.fromTokenAddress || "",
        toTokenAddress: req.query.toTokenAddress,
        eventId: eventId
    };
    res.write(`data: ${JSON.stringify(slippageInfo)}\n\n`);

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

app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  try {
    const { quoteResultCtx, userAddress } = req.body;
    const route = quoteResultCtx?.lifiQuoteResultCtx;

    if (!route || !route.steps) return res.json(ok(null));

    const step = route.steps[0];
    const tx = step.transactionRequest;

    if (!tx) throw new Error("No transaction request found");

    res.json(ok({
      result: { info: { provider: 'SwapLifi', providerName: 'Li.fi (Bitrabo)' } },
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

app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  filter: (pathname) => {
    return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx') && !pathname.includes('check-support');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Server v19 Running on ${PORT}`);
});
