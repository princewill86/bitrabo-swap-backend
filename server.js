require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const { createConfig, getRoutes } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Your LI.FI config
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025, // 0.25% real fee
});

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => res.send('Bitrabo Hybrid Backend Live!'));

// Proxy all /swap/v1/* to OneKey
const proxy = createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
  onProxyRes: async (proxyRes, req, res) => {
    if (req.url.includes('/quote') && proxyRes.statusCode === 200) {
      let body = [];
      proxyRes.on('data', chunk => body.push(chunk));
      proxyRes.on('end', async () => {
        try {
          const originalBody = Buffer.concat(body).toString();
          let data = JSON.parse(originalBody);

          // Add your LI.FI quote to the list
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

          if (routes?.routes?.length) {
            const best = routes.routes[0];
            const yourQuote = {
              info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
              fromTokenInfo: { contractAddress: best.fromToken.address, networkId: params.fromNetworkId },
              toTokenInfo: { contractAddress: best.toToken.address, networkId: params.toNetworkId },
              fromAmount: best.fromAmount,
              toAmount: best.toAmount,
              minToAmount: best.toAmountMin,
              instantRate: new BigNumber(best.toAmount).div(best.fromAmount).toString(),
              fee: { percentageFee: 0.25 },
              isBest: true,
              estimatedTime: 180,
              quoteResultCtx: best,
            };

            if (data.data) {
              data.data.unshift(yourQuote); // Add your quote first
            }
          }

          res.json(data);
        } catch (e) {
          console.error('Injection error:', e);
          res.send(originalBody); // Fallback
        }
      });
    }
  },
});

app.use('/swap/v1', proxy);

app.listen(PORT, () => console.log(`Bitrabo Hybrid Backend on port ${PORT}`));
