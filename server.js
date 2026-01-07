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

// Matches the exact provider structure OneKey expects
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  const providerData = {
    providerInfo: {
      provider: "SwapLifi",
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

// Helper: Human Input -> Atomic Units
async function normalizeAmountInput(chainId, tokenAddress, rawAmount) {
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

// Helper: Atomic Units -> Human Output (The missing piece!)
function formatAmountOutput(amountWei, decimals) {
    if(!amountWei) return "0";
    return ethers.formatUnits(amountWei, decimals || 18).toString();
}

async function fetchLiFiQuotes(params) {
  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    // Convert Input "1.5" -> "1500000..."
    const amount = await normalizeAmountInput(fromChain, fromToken, params.fromTokenAmount);
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
      // 1. Convert Amounts back to Decimals for OneKey
      const fromAmountDecimal = formatAmountOutput(route.fromAmount, route.fromToken.decimals);
      const toAmountDecimal = formatAmountOutput(route.toAmount, route.toToken.decimals);
      const minToAmountDecimal = formatAmountOutput(route.toAmountMin, route.toToken.decimals);

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
        
        // 2. Send DECIMALS (Human readable)
        fromAmount: fromAmountDecimal,
        toAmount: toAmountDecimal,
        minToAmount: minToAmountDecimal,
        
        // 3. Calculate Correct Rate (Decimal / Decimal)
        instantRate: new BigNumber(toAmountDecimal).div(fromAmountDecimal).toString(),
        
        estimatedTime: route.toToken.chainId === route.fromToken.chainId ? 30 : 120,
        quoteResultCtx: { lifiQuoteResultCtx: route }, // Keep context raw
        
        fee: {
          percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
          estimatedFeeFiatValue: 0.1
        },
        
        routesData: route.steps.map(s => ({
            name: s.toolDetails?.name || s.tool || 'Swap',
            part: 100,
            subRoutes: [[{ name: s.toolDetails?.name || s.tool || 'Swap', part: 100 }]] 
        })),
        
        // Explicitly null allowance to force frontend logic
        allowanceResult: null, 
        
        gasLimit: 500000,
        oneKeyFeeExtraInfo: {},
        supportUrl: "https://help.onekey.so/hc/requests/new",
        quoteId: uuidv4(),
        eventId: params.eventId
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
    
    // 1. HEADER
    const header = { totalQuoteCount: quotes.length, eventId: eventId };
    res.write(`data: ${JSON.stringify(header)}\n\n`);

    // 2. SLIPPAGE
    const slippageInfo = {
        autoSuggestedSlippage: 0.5,
        fromNetworkId: req.query.fromNetworkId,
        toNetworkId: req.query.toNetworkId,
        fromTokenAddress: req.query.fromTokenAddress || "",
        toTokenAddress: req.query.toTokenAddress,
        eventId: eventId
    };
    res.write(`data: ${JSON.stringify(slippageInfo)}\n\n`);

    // 3. QUOTES
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

app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
  try {
    const { quoteResultCtx, userAddress } = req.body;
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

app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  filter: (pathname) => {
    return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx') && !pathname.includes('check-support');
  }
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Server v15 Running on ${PORT}`);
});
