require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const BigNumber = require('bignumber.js');
const { createProxyMiddleware } = require('http-proxy-middleware');


const {
  createConfig,
  getRoutes,
  executeRoute,
  getTokens,
} = require('@lifi/sdk');

const app = express();
app.use(cors());
app.use(express.json());

/**
 * LI.FI global config – Bitrabo as integrator
 */
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025),
});

const PORT = process.env.PORT || 3000;

/**
 * OneKey style wrapper
 */
function ok(data) {
  return { code: 0, data };
}

/**
 * Normalize native token address
 */
function native(addr) {
  return addr && addr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    : addr;
}

// ---------------- NETWORKS ----------------
app.get('/swap/v1/networks', async (req, res) => {
  try {
    const tokens = await getTokens();

    const chainIds = Object.keys(tokens.tokens || {});

    const out = chainIds.map(chainId => ({
      networkId: `evm--${chainId}`,
      supportSingleSwap: true,
      supportCrossChainSwap: true,
      supportLimit: false,
      defaultSelectToken: [],   // you define later
    }));

    res.json(ok(out));
  } catch (e) {
    console.error(e);
    res.json(ok([]));
  }
});

// ---------------- TOKENS ----------------
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords } = req.query;

    const all = await getTokens();

    const chainId = networkId
      ? String(networkId).replace('evm--', '')
      : null;

    let list = [];

    // Flatten selected chain
    if (chainId && all.tokens?.[chainId]) {
      list = all.tokens[chainId];
    } else {
      // Flatten all chains
      list = Object.values(all.tokens || {}).flat();
    }

    if (keywords) {
      const k = String(keywords).toLowerCase();
      list = list.filter(t =>
        String(t.symbol).toLowerCase().includes(k) ||
        String(t.name).toLowerCase().includes(k),
      );
    }

    const mapped = list.slice(0, 50).map(t => ({
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      logoURI: t.logoURI,
      contractAddress: native(t.address),
      networkId: `evm--${t.chainId}`,
      reservationValue: '0',
      price: '0',
    }));

    res.json(ok(mapped));
  } catch (e) {
    console.error(e);
    res.json(ok([]));
  }
});

// ---------------- QUOTE ----------------
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const p = req.query;

    const fromChainId = Number(
      String(p.fromNetworkId || '').replace('evm--', ''),
    );
    const toChainId = Number(
      String(p.toNetworkId || '').replace('evm--', ''),
    );

    const routes = await getRoutes({
      fromChainId,
      toChainId,

      fromTokenAddress:
        p.fromTokenAddress ||
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',

      toTokenAddress: p.toTokenAddress,
      fromAmount: p.fromTokenAmount,
      fromAddress: p.userAddress,
      slippage: Number(p.slippagePercentage) / 100 || 0.005,
    });

    if (!routes.routes?.length) {
      return res.json(ok([]));
    }

    const best = routes.routes[0];

    const quote = {
      info: {
        provider: 'lifi',
        providerName: 'LI.FI (Bitrabo)',
      },

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

      instantRate: new BigNumber(best.toAmount)
        .div(best.fromAmount)
        .toString(),

      fee: {
        percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
        feeReceiver: process.env.BITRABO_FEE_RECEIVER,
      },

      isBest: true,
      receivedBest: true,

      estimatedTime: best.estimate?.etaSeconds || 180,
      allowanceResult: { isApproved: true },

      routesData: best.steps.map(s => ({
        name: s.toolDetails?.name || s.tool,
        part: 100,
        subRoutes: [],
      })),

      quoteExtraData: {},
      kind: 'sell',
      quoteResultCtx: best,
    };

    res.json(ok([quote]));
  } catch (e) {
    console.error(e);
    res.json(ok([]));
  }
});

// ---------------- BUILD TX ----------------
app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    const { quoteResultCtx } = req.body;

    if (!quoteResultCtx) {
      return res.status(400).json(ok(null));
    }

    const execution = await executeRoute({
      route: quoteResultCtx,
    });

    res.json(ok({
      result: {
        info: { provider: 'lifi', providerName: 'Bitrabo' },
      },
      tx: execution.transactionRequest,
      raw: execution,
    }));
  } catch (e) {
    console.error(e);
    res.json(ok(null));
  }
});

// ---------------- SSE EVENTS ----------------
app.get('/swap/v1/quote/events', async (req, res) => {
  try {
    const quotes = await axios.get(
      `http://127.0.0.1:${PORT}/swap/v1/quote`,
      { params: req.query },
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    res.write(`data: ${JSON.stringify(quotes.data)}\n\n`);
    res.write('data: {"type":"done"}\n\n');
  } catch (e) {
    console.error(e);
    res.write('data: {"type":"error"}\n\n');
  } finally {
    res.end();
  }
});

// ---------------- PROXY FALLBACK ----------------
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
}));

app.listen(PORT, () => {
  console.log('Bitrabo Aggregator Running');
});
