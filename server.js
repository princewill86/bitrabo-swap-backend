require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken, getStepTransaction } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');

// Simple cache
class SimpleCache {
  constructor(ttlSeconds) {
    this.cache = new Map();
    this.ttl = ttlSeconds * 1000;
  }
  get(key) {
    const item = this.cache.get(key);
    if (!item || Date.now() > item.expiry) {
      if (item) this.cache.delete(key);
      return null;
    }
    return item.value;
  }
  set(key, value) {
    this.cache.set(key, { value, expiry: Date.now() + this.ttl });
  }
}
const quoteCache = new SimpleCache(15);

const app = express();
const PORT = process.env.PORT || 3000;

const INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER;
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025);

createConfig({
  integrator: INTEGRATOR,
  routeOptions: { fee: FEE_PERCENT },
});

app.use(cors({ origin: '*' }));
app.use(express.json());

const ok = (data) => ({ code: 0, data });

// ==================================================================
// HIJACKED ROUTES
// ==================================================================

// 1. Providers List - CRITICAL: Must match OneKey exactly
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
  res.json(ok([
    {
      providerInfo: {
        provider: 'lifi',  // ← MUST be 'lifi' (lowercase)
        name: 'LI.FI',     // ← Exact name
        logoURI: 'https://li.fi/images/logo.svg',
      },
      enable: true,
      disableNetworks: [],
    },
  ]));
});

// 2. Check Support
app.get(['/swap/v1/check-support'], (req, res) => {
  const supported = req.query.networkId?.startsWith('evm--');
  res.json(ok([{ supported, reason: supported ? null : 'Network not supported' }]));
});

// 3. Allowance - return large number so no approve needed
app.get(['/swap/v1/allowance'], (req, res) => {
  res.json(ok({
    isApproved: true,
    allowance: '115792089237316195423570985008687907853269984665640564039457584007913129639935'
  }));
});

// 4. Quote Events - Main logic
app.get('/swap/v1/quote/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const eventId = uuidv4();
  const params = req.query;

  try {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));

    const cacheKey = `${fromChain}-${toChain}-${params.fromTokenAddress}-${params.toTokenAddress}-${params.fromTokenAmount}`;
    let quotes = quoteCache.get(cacheKey);

    if (!quotes) {
      const amount = params.fromTokenAmount 
        ? ethers.parseUnits(params.fromTokenAmount, await getDecimals(fromChain, params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toString()
        : '1000000000000000000';

      const routes = await getRoutes({
        fromChainId: fromChain,
        toChainId: toChain,
        fromTokenAddress: params.fromTokenAddress || '0x0000000000000000000000000000000000000000',
        toTokenAddress: params.toTokenAddress,
        fromAmount: amount,
        fromAddress: params.userAddress,
        slippage: Number(params.slippagePercentage || 0.5) / 100,
      });

      if (!routes.routes?.length) {
        quotes = [];
      } else {
        quotes = await Promise.all(routes.routes.map(async (route, i) => {
          const stepTx = await getStepTransaction(route.steps[0]);

          return {
            info: {
              provider: 'lifi',  // ← Critical: must be 'lifi'
              providerName: 'LI.FI',
            },
            fromTokenInfo: {
              contractAddress: native(route.fromToken.address),
              networkId: params.fromNetworkId,
              decimals: route.fromToken.decimals,
              symbol: route.fromToken.symbol,
              name: route.fromToken.name,
            },
            toTokenInfo: {
              contractAddress: native(route.toToken.address),
              networkId: params.toNetworkId,
              decimals: route.toToken.decimals,
              symbol: route.toToken.symbol,
              name: route.toToken.name,
            },
            fromAmount: params.fromTokenAmount,
            toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
            toAmountMin: ethers.formatUnits(route.toAmountMin, route.toToken.decimals),
            instantRate: new BigNumber(route.toAmount).div(route.fromAmount).toString(),
            fee: {
              percentageFee: FEE_PERCENT,
              feeReceiver: FEE_RECEIVER,
            },
            estimatedTime: route.estimate?.etaSeconds || 180,
            allowanceResult: { isApproved: true },
            routesData: route.steps.map(s => ({
              name: s.toolDetails?.name || s.tool || 'Li.FI',
              part: 100,
              subRoutes: [],
            })),
            quoteExtraData: {},
            kind: 'sell',
            quoteResultCtx: route,
            isBest: i === 0,
            receivedBest: i === 0,
            quoteId: uuidv4(),
            eventId,
          };
        }));
        quoteCache.set(cacheKey, quotes);
      }
    }

    res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
    res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5 })}\n\n`);

    quotes.forEach(q => {
      res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`);
    });

    res.write('data: {"type":"done"}\n\n');
  } catch (e) {
    console.error('Quote error:', e);
    res.write('data: {"type":"error"}\n\n');
  } finally {
    res.end();
  }
});

// 5. Build TX
app.post('/swap/v1/build-tx', express.json(), async (req, res) => {
  try {
    const { quoteResultCtx } = req.body;
    if (!quoteResultCtx) return res.json(ok(null));

    const execution = await executeRoute({ route: quoteResultCtx });

    res.json(ok({
      result: {
        info: { provider: 'lifi', providerName: 'LI.FI' },
      },
      tx: execution.transactionRequest,
      raw: execution,
    }));
  } catch (e) {
    console.error('Build error:', e);
    res.json(ok(null));
  }
});

// ==================================================================
// PROXY EVERYTHING ELSE
// ==================================================================
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  logLevel: 'silent',
  pathRewrite: { '^/swap/v1': '/swap/v1' },
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('x-lifi-integrator', INTEGRATOR);
  },
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Swap Backend vFinal Running on ${PORT}`);
  console.log(`Integrator: ${INTEGRATOR} | Fee: ${FEE_PERCENT * 100}%`);
});
