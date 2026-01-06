// server.js - Your Own Aggregator (LI.FI + 1inch)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig, getRoutes } = require('@lifi/sdk');
const axios = require('axios');
const BigNumber = require('bignumber.js');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
app.use(cors());
app.use(express.json());

// Your LI.FI config - real fee to your wallet
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025, // 0.25%
});

const PORT = process.env.PORT || 3000;

// Health
app.get('/', (req, res) => res.send('Bitrabo Custom Aggregator Live!'));

// QUOTE - Your quotes (LI.FI + 1inch)
app.get('/swap/v1/quote', async (req, res) => {
  const params = req.query;
  const quotes = [];

  try {
    const fromChainId = Number(params.fromNetworkId.replace('evm--', ''));
    const toChainId = Number(params.toNetworkId.replace('evm--', ''));

    // LI.FI
    const lifi = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    if (lifi.routes.length) {
      const best = lifi.routes[0];
      quotes.push({
        info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
        fromTokenInfo: { contractAddress: best.fromToken.address, networkId: params.fromNetworkId },
        toTokenInfo: { contractAddress: best.toToken.address, networkId: params.toNetworkId },
        fromAmount: best.fromAmount,
        toAmount: best.toAmount,
        toAmountMin: best.toAmountMin,
        instantRate: new BigNumber(best.toAmount).div(best.fromAmount).toString(),
        fee: { percentageFee: 0.25 },
        isBest: true,
        estimatedTime: 180,
        quoteResultCtx: best,
      });
    }

    // 1inch (same-chain only)
    if (fromChainId === toChainId) {
      try {
        const inch = await axios.get(`https://api.1inch.dev/swap/v6.0/${fromChainId}/quote`, {
          params: {
            fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            toTokenAddress: params.toTokenAddress,
            amount: params.fromTokenAmount,
          },
          headers: { Authorization: 'Bearer YOUR_1INCH_API_KEY' }, // Get free key at 1inch.dev
        });
        quotes.push({
          info: { provider: '1inch', providerName: '1inch (Bitrabo)' },
          fromTokenInfo: { contractAddress: inch.data.fromToken.address, networkId: params.fromNetworkId },
          toTokenInfo: { contractAddress: inch.data.toToken.address, networkId: params.toNetworkId },
          fromAmount: inch.data.fromAmount,
          toAmount: inch.data.toAmount,
          toAmountMin: inch.data.toAmount,
          instantRate: new BigNumber(inch.data.toAmount).div(inch.data.fromAmount).toString(),
          fee: { percentageFee: 0.25 },
          isBest: quotes.length === 1,
          estimatedTime: 120,
          quoteResultCtx: inch.data,
        });
      } catch {}
    }

    res.json({ code: 0, data: quotes.length ? quotes : [{ info: { provider: '', providerName: 'No route' } }] });
  } catch (e) {
    res.status(404).json({ code: 1, message: 'No route' });
  }
});

// SSE QUOTE EVENTS - Send your quotes
app.get('/swap/v1/quote/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  res.write('data: {"type":"info","totalQuoteCount":1}\n\n');
  res.write('data: {"type":"message","data":' + JSON.stringify({ code: 0, data: [/* your quote object */] }) + '}\n\n');
  res.write('data: {"type":"done"}\n\n');
  res.end();
});

// BUILD-TX - Use LI.FI for your quote
app.post('/swap/v1/build-tx', async (req, res) => {
  const { quoteResultCtx } = req.body;
  const tx = await executeRoute({ route: quoteResultCtx });
  res.json({ code: 0, data: { tx: tx.transactionRequest } });
});

// Proxy other endpoints to OneKey
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
}));

app.listen(PORT, () => console.log('Bitrabo Custom Aggregator Running'));
