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
 * ----------------------------------------------------
 * LI.FI global config – Bitrabo as integrator
 * ----------------------------------------------------
 */
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: Number(process.env.BITRABO_FEE || 0.0025), // 0.25%
});

const PORT = process.env.PORT || 3000;

/**
 * OneKey style success wrapper
 */
function ok(data) {
  return { code: 0, data };
}

/**
 * Normalize native token address
 */
function native(addr) {
  if (!addr) return addr;

  const N = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  return addr.toLowerCase() === N ? N : addr;
}

/**
 * Convert human amount → BigNumberish smallest units
 */
function toSmallestUnits(amount, decimals = 18) {
  try {
    const bn = new BigNumber(String(amount || '0'));
    if (bn.lte(0)) return '0';

    return bn
      .multipliedBy(new BigNumber(10).pow(decimals))
      .integerValue(BigNumber.ROUND_FLOOR)
      .toString();
  } catch {
    return '0';
  }
}

// ====================================================
// ---------------- NETWORKS --------------------------
// ====================================================
app.get('/swap/v1/networks', async (req, res) => {
  try {
    const tokens = await getTokens();

    // Current SDK → array of token objects in tokens.tokens
    const chainIds = [
      ...new Set((tokens.tokens || []).map(t => t.chainId)),
    ];

    const out = chainIds.map(chainId => ({
      networkId: `evm--${chainId}`,
      supportSingleSwap: true,
      supportCrossChainSwap: true,
      supportLimit: false,
      defaultSelectToken: [],
    }));

    res.json(ok(out));
  } catch (e) {
    console.error('NETWORK ERROR', e);
    res.json(ok([]));
  }
});

// ====================================================
// ---------------- TOKENS ----------------------------
// ====================================================
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords } = req.query;

    const all = await getTokens();

    let list = all.tokens || [];

    // Filter by chain if provided
    if (networkId) {
      const chainId = Number(
        String(networkId).replace('evm--', ''),
      );
      if (chainId) {
        list = list.filter(t => t.chainId === chainId);
      }
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
      contractAddress: native(t.address || t.address),
      networkId: `evm--${t.chainId}`,
      reservationValue: '0',
      price: '0',
    }));

    res.json(ok(mapped));
  } catch (e) {
    console.error('TOKEN ERROR', e);
    res.json(ok([]));
  }
});

// ====================================================
// ---------------- QUOTE -----------------------------
// ====================================================
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const p = req.query;

    const fromChainId = Number(
      String(p.fromNetworkId || '').replace('evm--', ''),
    );
    const toChainId = Number(
      String(p.toNetworkId || '').replace('evm--', ''),
    );

    // ---- strict guards so we don’t silently cancel ----
    if (
      !fromChainId ||
      !toChainId ||
      !p.fromTokenAmount ||
      !p.toTokenAddress
    ) {
      return res.json(ok([]));
    }

    const decimals =
      Number(p.fromTokenDecimals) ||
      Number(p.fromTokenDecimals) ||
      18;

    const smallest = toSmallestUnits(
      p.fromTokenAmount,
      decimals,
    );

    if (smallest === '0') {
      return res.json(ok([]));
    }

    const routes = await getRoutes({
      fromChainId,
      toChainId,

      fromTokenAddress:
        native(p.fromTokenAddress) ||
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',

      toTokenAddress: native(p.toTokenAddress),

      fromAmount: smallest,          // ✅ BigNumberish
      fromAddress: p.userAddress,    // optional
      slippage:
        Number(p.slippagePercentage) / 100 || 0.005,
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
        percentageFee: Number(
          process.env.BITRABO_FEE || 0.0025,
        ),
        feeReceiver: process.env.BITRABO_FEE_RECEIVER,
      },

      isBest: true,
      receivedBest: true,

      estimatedTime:
        best.estimate?.etaSeconds || 180,

      allowanceResult: { isApproved: true },

      routesData: (best.steps || []).map(s => ({
        name:
          s.toolDetails?.name || s.tool,
        part: 100,
        subRoutes: [],
      })),

      kind: 'sell',
      quoteResultCtx: best,

      quoteExtraData: {},
    };

    res.json(ok([quote]));
  } catch (e) {
    console.error('LI.FI QUOTE ERROR', e);
    res.json(ok([]));
  }
});

// ====================================================
// ---------------- BUILD TX --------------------------
// ====================================================
app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    const { quoteResultCtx } = req.body;

    if (!quoteResultCtx) {
      return res.status(400).json(ok(null));
    }

    const execution = await executeRoute({
      route: quoteResultCtx,
    });

    res.json(
      ok({
        result: {
          info: {
            provider: 'lifi',
            providerName: 'Bitrabo',
          },
        },
        tx: execution.transactionRequest,
        raw: execution,
      }),
    );
  } catch (e) {
    console.error('BUILD TX ERROR', e);
    res.json(ok(null));
  }
});

// ====================================================
// ---------------- SSE EVENTS ------------------------
// ====================================================
app.get('/swap/v1/quote/events', async (req, res) => {
  try {
    const quotes = await axios.get(
      `http://127.0.0.1:${PORT}/swap/v1/quote`,
      { params: req.query },
    );

    res.setHeader(
      'Content-Type',
      'text/event-stream',
    );
    res.setHeader(
      'Cache-Control',
      'no-cache',
    );

    res.write(
      `data: ${JSON.stringify(quotes.data)}\n\n`,
    );
    res.write('data: {"type":"done"}\n\n');
  } catch (e) {
    console.error('SSE ERROR', e);
    res.write('data: {"type":"error"}\n\n');
  } finally {
    res.end();
  }
});

// ====================================================
// ---------------- PROXY FALLBACK --------------------
// ====================================================
app.use(
  '/swap/v1',
  createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
  }),
);

app.listen(PORT, () => {
  console.log('Bitrabo Aggregator Running');
});
