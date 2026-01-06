// server.js - Bitrabo Final Backend: Proxy + Your LI.FI Quote
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const { createConfig, getRoutes } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Your LI.FI integrator config — this earns you real fees
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025, // 0.25% — LI.FI pays this to your wallet
});

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.send('Bitrabo Swap Backend Live! Your Quotes + Full Compatibility 🚀');
});

// YOUR CUSTOM QUOTE — Override OneKey's quotes with yours
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const params = req.query;

    const fromChainId = Number(params.fromNetworkId.replace('evm--', ''));
    const toChainId = Number(params.toNetworkId.replace('evm--', ''));

    const routes = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    if (!routes?.routes?.length) {
      return res.json({ code: 1, message: 'No route found' });
    }

    const best = routes.routes[0];

    res.json({
      code: 0,
      data: [{
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
        quoteResultCtx: best, // Save full route for build-tx
      }]
    });
  } catch (error) {
    console.error('Your quote error:', error);
    // Fallback: proxy to OneKey if your quote fails
    return createProxyMiddleware({
      target: 'https://swap.onekeycn.com',
      changeOrigin: true,
      pathRewrite: { '^/swap/v1/quote': '/v1/quote' },
    })(req, res);
  }
});

// Proxy EVERYTHING ELSE to OneKey (build-tx, events, tokens, etc.)
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
  onProxyReq: (proxyReq, req) => {
    if (req.url.includes('/quote')) return; // Skip logging your override
    console.log(`Proxy → ${req.method} ${req.url}`);
  },
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Backend Live on port ${PORT}`);
  console.log('Your LI.FI quotes shown + full compatibility');
  console.log('0.25% fee → your wallet when LI.FI used');
});
