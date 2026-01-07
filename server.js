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

const INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025); 

createConfig({
  integrator: INTEGRATOR,
  fee: FEE_PERCENT,
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

// HELPERS
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

// REAL QUOTE LOGIC
async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    const isNativeSell = fromToken === '0x0000000000000000000000000000000000000000';

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
        integrator: INTEGRATOR,
        fee: FEE_PERCENT,
      }
    });

    if (!routesResponse.routes || routesResponse.routes.length === 0) return [];

    return await Promise.all(routesResponse.routes.map(async (route, i) => {
      const fromAmountDecimal = await formatAmountOutput(fromChain, route.fromToken.address, route.fromAmount);
      const toAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmount);
      const minToAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmountMin);

      if (i===0) console.log(`[✅ QUOTE] ${fromAmountDecimal} -> ${toAmountDecimal}`);

      const fromTokenInfo = {
        contractAddress: isNativeSell ? '' : route.fromToken.address,
        networkId: params.fromNetworkId,
        isNative: isNativeSell,
        decimals: route.fromToken.decimals,
        name: route.fromToken.name,
        symbol: route.fromToken.symbol,
        logoURI: route.fromToken.logoURI
      };

      const toTokenInfo = {
        contractAddress: route.toToken.address === '0x0000000000000000000000000000000000000000' ? '' : route.toToken.address,
        networkId: params.toNetworkId,
        isNative: route.toToken.address === '0x0000000000000000000000000000000000000000',
        decimals: route.toToken.decimals,
        name: route.toToken.name,
        symbol: route.toToken.symbol,
        logoURI: route.toToken.logoURI
      };

      return {
        info: {
          provider: 'SwapLifi',
          providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png',
          providerName: 'Li.fi (Bitrabo)',
        },
        fromTokenInfo,
        toTokenInfo,
        protocol: 'Swap',
        kind: 'sell',
        fromAmount: fromAmountDecimal,
        toAmount: toAmountDecimal,
        minToAmount: minToAmountDecimal,
        instantRate: new BigNumber(toAmountDecimal).div(fromAmountDecimal).toString(),
        estimatedTime: 30, // Force 30s to be safe
        
        quoteResultCtx: { 
            lifiQuoteResultCtx: route,
            fromTokenInfo,
            toTokenInfo,
            fromAmount: fromAmountDecimal,
            toAmount: toAmountDecimal,
            instantRate: new BigNumber(toAmountDecimal).div(fromAmountDecimal).toString()
        }, 
        
        fee: {
          percentageFee: FEE_PERCENT * 100, // Display 0.25%
          estimatedFeeFiatValue: 0.1 
        },
        
        // --- THIS IS THE FIX (Reverted to v25 Structure) ---
        routesData: [{
            name: "Li.Fi",
            part: 100,
            subRoutes: [[{ name: "Li.Fi", part: 100, logo: "https://uni.onekey-asset.com/static/logo/lifi.png" }]]
        }],
        
        allowanceResult: null, 
        gasLimit: 500000,
        oneKeyFeeExtraInfo: {},
        supportUrl: "https://help.onekey.so/hc/requests/new",
        quoteId: uuidv4(),
        eventId: params.eventId,
        isBest: i === 0 // Mark first quote as best
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
    
    // 1. Header
    res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
    
    // 2. Slippage
    const slippageInfo = {
        autoSuggestedSlippage: 0.5,
        fromNetworkId: req.query.fromNetworkId,
        toNetworkId: req.query.toNetworkId,
        fromTokenAddress: req.query.fromTokenAddress || "",
        toTokenAddress: req.query.toTokenAddress,
        eventId: eventId
    };
    res.write(`data: ${JSON.stringify(slippageInfo)}\n\n`);

    // 3. Quotes
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

    console.log("[⚙️ BUILD-TX] Fetching Li.Fi Transaction...");
    const step = route.steps[0];
    const transaction = await getStepTransaction(step); 

    if (!transaction) throw new Error("Li.Fi failed to return transaction");

    const response = {
        result: { 
            info: { provider: 'SwapLifi', providerName: 'Li.fi (Bitrabo)', providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
            fromTokenInfo: quoteResultCtx.fromTokenInfo,
            toTokenInfo: quoteResultCtx.toTokenInfo,
            protocol: "Swap",
            kind: "sell",
            fromAmount: quoteResultCtx.fromAmount,
            toAmount: quoteResultCtx.toAmount,
            instantRate: quoteResultCtx.instantRate,
            estimatedTime: 30,
            fee: { percentageFee: FEE_PERCENT * 100 }, 
            routesData: [{
                name: "Li.Fi",
                part: 100,
                subRoutes: [[{ name: "Li.Fi", part: 100, logo: "https://uni.onekey-asset.com/static/logo/lifi.png" }]]
            }],
            gasLimit: transaction.gasLimit ? Number(transaction.gasLimit) : 500000,
            slippage: 0.5,
            oneKeyFeeExtraInfo: {}
        },
        ctx: { lifiToNetworkId: "evm--1" },
        orderId: uuidv4(),
        tx: {
          to: transaction.to, 
          value: transaction.value ? new BigNumber(transaction.value).toFixed() : '0',
          data: transaction.data, 
          from: userAddress,
          gas: transaction.gasLimit ? new BigNumber(transaction.gasLimit).toFixed() : undefined
        }
    };

    console.log("[✅ BUILD-TX] Success! Real Transaction Sent.");
    res.json(ok(response));

  } catch (e) {
    console.error("[❌ BUILD-TX ERROR]", e);
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
  console.log(`Bitrabo PRODUCTION Server v30 Running on ${PORT}`);
});
