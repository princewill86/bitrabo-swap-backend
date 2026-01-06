require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const BigNumber = require('bignumber.js');
const {
  createConfig,
  getRoutes,
  executeRoute,
  getTokens,
} = require('@lifi/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// LI.FI config with Bitrabo integrator and fee
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  routeOptions: {
    fee: Number(process.env.BITRABO_FEE || 0.0025),
  },
});

const PORT = process.env.PORT || 3000;

// Safer response wrapper - ensures data is always array/object, never undefined/null
function ok(data) {
  if (data === undefined || data === null) {
    return { code: 0, data: Array.isArray(data) ? [] : {} };
  }
  return { code: 0, data };
}

// Normalize native token (OneKey uses 0xeeee...)
function native(addr) {
  const lower = addr ? addr.toLowerCase() : '';
  if (lower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || lower === '0x0000000000000000000000000000000000000000') {
    return '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  }
  return addr || '';
}

// Normalize for LI.FI input (uses 0x0000...)
function lifiNative(addr) {
  const lower = addr ? addr.toLowerCase() : '';
  if (lower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || lower === '0x0000000000000000000000000000000000000000') {
    return '0x0000000000000000000000000000000000000000';
  }
  return addr || '';
}

// ---------------- NETWORKS ----------------
app.get('/swap/v1/networks', async (req, res) => {
  try {
    const tokens = await getTokens();
    const chainIds = Object.keys(tokens.tokens || {});
    const networks = chainIds.map(chainId => ({
      networkId: `evm--${chainId}`,
      supportSingleSwap: true,
      supportCrossChainSwap: true,
      supportLimit: false,
      defaultSelectToken: [],
    }));
    res.json(ok(networks));
  } catch (e) {
    console.error('Networks error:', e);
    res.json(ok([])); // always safe empty array
  }
});

// ---------------- TOKENS ----------------
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords } = req.query;
    const all = await getTokens();
    const chainId = networkId ? String(networkId).replace('evm--', '') : null;
    let list = [];

    if (chainId && all.tokens?.[chainId]) {
      list = all.tokens[chainId];
    } else {
      list = Object.values(all.tokens || {}).flat();
    }

    if (keywords) {
      const k = String(keywords).toLowerCase();
      list = list.filter(t =>
        String(t.symbol).toLowerCase().includes(k) ||
        String(t.name).toLowerCase().includes(k)
      );
    }

    const mapped = list.slice(0, 50).map(t => ({
      name: t.name || '',
      symbol: t.symbol || '',
      decimals: t.decimals || 18,
      logoURI: t.logoURI || '',
      contractAddress: native(t.address),
      networkId: `evm--${t.chainId}`,
      reservationValue: '0',
      price: '0',
    }));

    res.json(ok(mapped));
  } catch (e) {
    console.error('Tokens error:', e);
    res.json(ok([]));
  }
});

// ---------------- QUOTE ----------------
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const p = req.query;
    const fromChainId = Number(String(p.fromNetworkId || '').replace('evm--', ''));
    const toChainId = Number(String(p.toNetworkId || '').replace('evm--', ''));

    const routes = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: lifiNative(p.fromTokenAddress),
      toTokenAddress: lifiNative(p.toTokenAddress),
      fromAmount: p.fromTokenAmount,
      fromAddress: p.userAddress,
      toAddress: p.userAddress,
      slippage: Number(p.slippagePercentage) / 100 || 0.005,
    });

    if (!routes.routes?.length) {
      return res.json(ok([]));
    }

    const best = routes.routes[0];

    const quote = {
      info: { provider: 'lifi', providerName: 'LI.FI' },
      fromTokenInfo: {
        contractAddress: native(best.fromToken.address),
        networkId: p.fromNetworkId,
        decimals: best.fromToken.decimals,
        symbol: best.fromToken.symbol,
        name: best.fromToken.name,
      },
      toTokenInfo: {
        contractAddress: native(best.toToken.address),
        networkId: p.toNetworkId,
        decimals: best.toToken.decimals,
        symbol: best.toToken.symbol,
        name: best.toToken.name,
      },
      fromAmount: best.fromAmount,
      toAmount: best.toAmount,
      toAmountMin: best.toAmountMin,
      instantRate: new BigNumber(best.toAmount).div(best.fromAmount).toString(),
      fee: {
        percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
        feeReceiver: process.env.BITRABO_FEE_RECEIVER,
      },
      isBest: true,
      receivedBest: true,
      estimatedTime: best.estimate?.etaSeconds || 180,
      allowanceResult: { isApproved: true },
      routesData: best.steps.map(s => ({
        name: s.toolDetails?.name || s.tool || 'Unknown',
        part: 100,
        subRoutes: [],
      })),
      quoteExtraData: {},
      kind: 'sell',
      quoteResultCtx: best,
    };

    res.json(ok([quote]));
  } catch (e) {
    console.error('Quote error:', e);
    res.json(ok([]));
  }
});

// ---------------- BUILD TX ----------------
app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    const { quoteResultCtx } = req.body;
    if (!quoteResultCtx) return res.status(400).json(ok(null));

    const execution = await executeRoute({ route: quoteResultCtx });
    res.json(ok({
      result: { info: { provider: 'lifi', providerName: 'LI.FI' } },
      tx: execution.transactionRequest,
      raw: execution,
    }));
  } catch (e) {
    console.error('Build-tx error:', e);
    res.json(ok(null));
  }
});

// ---------------- SSE EVENTS ----------------
app.get('/swap/v1/quote/events', async (req, res) => {
  try {
    const quotes = await axios.get(`http://localhost:${PORT}/swap/v1/quote`, {
      params: req.query,
      timeout: 15000,
    });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify(quotes.data)}\n\n`);
    setTimeout(() => {
      res.write('data: {"type":"done"}\n\n');
      res.end();
    }, 200);
  } catch (e) {
    console.error('SSE error:', e);
    res.write('data: {"type":"error"}\n\n');
    res.end();
  }
});

// ---------------- PROVIDERS LIST ----------------
app.get('/swap/v1/providers/list', (req, res) => {
  res.json(ok([
    {
      providerInfo: {
        provider: 'lifi',
        name: 'LI.FI',
        logoURI: 'https://li.fi/images/logo.svg',
      },
      enable: true,
      disableNetworks: [],
    },
  ]));
});

// ---------------- CHECK SUPPORT ----------------
app.get('/swap/v1/check-support', (req, res) => {
  const { networkId } = req.query;
  const supported = networkId?.startsWith('evm--');
  res.json(ok([{ supported, reason: supported ? null : 'Network not supported' }]));
});

// ---------------- ALLOWANCE ----------------
app.get('/swap/v1/allowance', (req, res) => {
  res.json(ok({
    isApproved: true,
    allowance: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
  }));
});

// ---------------- SPEED CONFIG ----------------
app.get('/swap/v1/speed-config', (req, res) => {
  res.json(ok({
    provider: '',
    supportSpeedSwap: false,
    speedConfig: { slippage: 0.5 },
    speedDefaultSelectToken: null,
  }));
});

// ---------------- NATIVE TOKEN CONFIG ----------------
app.get('/swap/v1/native-token-config', (req, res) => {
  res.json(ok({
    networkId: req.query.networkId || '',
    reserveGas: '0.01',
  }));
});

// ---------------- SWAP CONFIG ----------------
app.get('/swap/v1/swap-config', (req, res) => {
  res.json(ok({ swapMevNetConfig: [] }));
});

// ---------------- STATE TX ----------------
app.post('/swap/v1/state-tx', (req, res) => {
  res.json(ok({
    state: 'SUCCESS',
    dealReceiveAmount: req.body.toTokenAmount || '0',
  }));
});

// Global fallback
app.use((req, res) => {
  console.log('Unhandled route:', req.path);
  res.json(ok([]));
});

app.listen(PORT, () => {
  console.log(`Bitrabo Swap Backend running on port ${PORT}`);
});
