require('dotenv').config();
const express = require('express');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getTokens, getToken } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. LIFI CONFIG ---
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

// --- 2. MIDDLEWARE ---
app.use(cors({ origin: '*' }));
app.use(express.json());

// Log requests to keep visibility
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.url}`);
  next();
});

// --- 3. HELPERS ---
const ok = (data) => ({ code: 0, data });
const toLiFiChain = (id) => (id ? parseInt(id.replace('evm--', '')) : 1);
const toOneKeyChain = (id) => `evm--${id}`;
// Fix empty address (ETH) to LiFi's zero address
const normalizeAddr = (addr) => (!addr || addr === '') ? '0x0000000000000000000000000000000000000000' : addr;

// --- 4. DISCOVERY & CONFIG ENDPOINTS (From your logs) ---

app.get('/swap/v1/check-support', (req, res) => {
  res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

app.get('/swap/v1/providers/list', (req, res) => {
  res.json(ok([{
    provider: 'lifi',
    name: 'Bitrabo',
    logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
    status: 'available',
    priority: 1
  }]));
});

app.get('/swap/v1/native-token-config', (req, res) => {
  res.json(ok({ networkId: req.query.networkId, reserveGas: '21000', minValue: '0' }));
});

app.get('/swap/v1/swap-config', (req, res) => {
  // Return empty config to satisfy the call
  res.json(ok({ swapMevNetConfig: [] }));
});

app.get('/swap/v1/speed-config', (req, res) => {
  // Return default disabled speed config
  res.json(ok({
    provider: '',
    supportSpeedSwap: false,
    speedConfig: { slippage: 0.5, defaultTokens: [] }
  }));
});

app.get('/swap/v1/popular/tokens', async (req, res) => {
  // Return standard stablecoins/ETH as popular
  res.json(ok([
    { symbol: 'ETH', networkId: 'evm--1', contractAddress: '' },
    { symbol: 'USDC', networkId: 'evm--1', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    { symbol: 'USDT', networkId: 'evm--1', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7' }
  ]));
});

// --- 5. DATA ENDPOINTS ---

app.get('/swap/v1/networks', async (req, res) => {
  try {
    const { tokens } = await getTokens();
    const networks = Object.keys(tokens).map(id => ({
      networkId: toOneKeyChain(id),
      name: `EVM ${id}`,
      shortcode: 'ETH',
      logoURI: '',
      supportCrossChainSwap: true,
      supportSingleSwap: true,
      defaultSelectToken: []
    }));
    res.json(ok(networks));
  } catch (e) { res.json(ok([])); }
});

app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords } = req.query;
    const chainId = toLiFiChain(networkId);
    const { tokens } = await getTokens({ chains: [chainId] });
    
    let list = tokens[chainId] || [];
    if (keywords) {
      const k = keywords.toLowerCase();
      list = list.filter(t => t.name.toLowerCase().includes(k) || t.symbol.toLowerCase().includes(k));
    }

    res.json(ok(list.slice(0, 100).map(t => ({
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      contractAddress: t.address,
      logoURI: t.logoURI,
      networkId: networkId,
      isNative: t.address === '0x0000000000000000000000000000000000000000',
    }))));
  } catch (e) { res.json(ok([])); }
});

// Detailed Token Info (Seen in your logs)
app.get('/swap/v1/token/detail', async (req, res) => {
  try {
    const { networkId, contractAddress } = req.query;
    const chainId = toLiFiChain(networkId);
    const tokenAddr = normalizeAddr(contractAddress);

    // If native, return manual native details immediately
    if (tokenAddr === '0x0000000000000000000000000000000000000000') {
       return res.json(ok([{
         name: "Native Token",
         symbol: "ETH", // Or dynamic based on chain
         decimals: 18,
         contractAddress: "",
         networkId,
         logoURI: "https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png"
       }]));
    }

    const token = await getToken(chainId, tokenAddr);
    res.json(ok([{
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      contractAddress: token.address,
      logoURI: token.logoURI,
      networkId
    }]));
  } catch (e) {
    console.error("Token Detail Error:", e.message);
    res.json(ok([]));
  }
});

// --- 6. QUOTE & TX LOGIC ---

async function fetchLiFiQuotes(params) {
  try {
    // Log params to debug empty inputs
    console.log("Fetching Quote for:", params);

    const fromChain = toLiFiChain(params.fromNetworkId);
    const toChain = toLiFiChain(params.toNetworkId);
    const fromToken = normalizeAddr(params.fromTokenAddress);
    const toToken = normalizeAddr(params.toTokenAddress);
    const amount = params.fromTokenAmount;
    const user = params.userAddress;

    // Validation
    if (!amount || amount === '0') return [];

    const routesResponse = await getRoutes({
      fromChainId: fromChain,
      toChainId: toChain,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount: amount,
      fromAddress: user,
      slippage: Number(params.slippagePercentage || 0.5) / 100,
      options: {
        integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
        fee: Number(process.env.BITRABO_FEE || 0.0025),
      },
    });

    if (!routesResponse.routes || routesResponse.routes.length === 0) return [];

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
          decimals: route.fromToken.decimals,
        },
        toTokenInfo: {
          networkId: params.toNetworkId,
          contractAddress: route.toToken.address,
          symbol: route.toToken.symbol,
          decimals: route.toToken.decimals,
        },
        fromAmount: route.fromAmount,
        toAmount: route.toAmount,
        toAmountMin: route.toAmountMin,
        instantRate: new BigNumber(route.toAmount).div(route.fromAmount).toString(),
        estimatedTime: 60,
        kind: 'sell',
        isBest,
        receivedBest: isBest,
        quoteResultCtx: route, 
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
    console.error("Quote Error:", e.message);
    return [];
  }
}

// Simple Quote (Fallback)
app.get('/swap/v1/quote', async (req, res) => {
  const quotes = await fetchLiFiQuotes(req.query);
  res.json(ok(quotes));
});

// SSE Quote (The one seen in your logs)
app.get('/swap/v1/quote/events', async (req, res) => {
  // CRITICAL: SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Ensure headers are sent immediately

  try {
    const quotes = await fetchLiFiQuotes(req.query);
    // Send data
    res.write(`data: ${JSON.stringify(quotes)}\n\n`);
    // Close stream
    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    res.write(`data: {"type":"error"}\n\n`);
  } finally {
    res.end();
  }
});

// Build Transaction
app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    const { quoteResultCtx, userAddress } = req.body;
    if (!quoteResultCtx || !quoteResultCtx.steps) return res.json(ok(null));

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

app.listen(PORT, () => console.log(`Bitrabo Production Mirror Running on ${PORT}`));
