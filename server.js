// server.js - Bitrabo Custom Aggregator (Exact OneKey Format)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig, getRoutes } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
app.use(cors());
app.use(express.json());

createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025,
});

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bitrabo Aggregator Live!'));

// QUOTE - Exact OneKey format
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const params = req.query;
    const fromChainId = Number(params.fromNetworkId.replace('evm--', ''));
    const toChainId = Number(params.toNetworkId.replace('evm--', ''));

    const lifi = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    if (!lifi.routes.length) {
      return res.json({ code: 0, data: [] }); // Empty = no route (client handles gracefully)
    }

    const best = lifi.routes[0];

    const quote = {
      info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
      fromTokenInfo: { contractAddress: best.fromToken.address, networkId: params.fromNetworkId },
      toTokenInfo: { contractAddress: best.toToken.address, networkId: params.toNetworkId },
      fromAmount: best.fromAmount,
      toAmount: best.toAmount,
      toAmountMin: best.toAmountMin,
      instantRate: new BigNumber(best.toAmount).div(best.fromAmount).toString(),
      fee: { percentageFee: 0.25 },
      isBest: true,
      receivedBest: true,
      estimatedTime: best.estimate.etaSeconds || 180,
      unSupportSlippage: false,
      autoSuggestedSlippage: 0.5,
      allowanceResult: { isApproved: true }, // Assume or check later
      routesData: best.steps.map(step => ({
        name: step.tool,
        part: 100, // Simplify
        subRoutes: [],
      })),
      quoteExtraData: {},
      kind: 'sell',
      quoteResultCtx: best,
    };

    res.json({ code: 0, data: [quote] });
  } catch (error) {
    console.error(error);
    res.json({ code: 0, data: [] }); // Never 404 — client handles empty
  }
});

// SSE EVENTS - Proper format
app.get('/swap/v1/quote/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  // Send your quote as message
  const quoteJson = JSON.stringify({ code: 0, data: [/* same quote object as above */] });
  res.write(`data: ${quoteJson}\n\n`);
  res.write('data: {"type":"done"}\n\n');
  res.end();
});

// BUILD-TX - Basic for LI.FI
app.post('/swap/v1/build-tx', async (req, res) => {
  const { quoteResultCtx } = req.body;
  if (!quoteResultCtx) return res.status(400).json({ code: 1 });
  const tx = await executeRoute({ route: quoteResultCtx });
  res.json({ code: 0, data: { result: { info: { provider: 'lifi' } }, tx: tx.transactionRequest } });
});

// Proxy other endpoints
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
}));

app.listen(PORT, () => console.log('Bitrabo Aggregator Running'));
