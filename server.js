// server.js - Bitrabo Hybrid Backend (Compression-Safe + LI.FI Injection)
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const zlib = require('zlib');
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
app.get('/', (req, res) => {
  res.send('Bitrabo Hybrid Backend Live! Quotes + Full Compatibility 🚀');
});

// Proxy with response interception (safe for gzip)
const proxy = createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
  selfHandleResponse: true, // Important: we handle response ourselves
  onProxyRes: async (proxyRes, req, res) => {
    // Collect response body
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', async () => {
      try {
        let body = Buffer.concat(chunks);

        // Decompress if gzipped
        if (proxyRes.headers['content-encoding'] === 'gzip') {
          body = zlib.gunzipSync(body);
        } else if (proxyRes.headers['content-encoding'] === 'deflate') {
          body = zlib.inflateSync(body);
        }

        let data = JSON.parse(body.toString());

        // Only inject on regular quote (not events or other endpoints)
        if (req.url.includes('/quote') && !req.url.includes('/events') && data.data) {
          const params = req.query;
          const fromChainId = Number(params.fromNetworkId?.replace('evm--', '') || 1);
          const toChainId = Number(params.toNetworkId?.replace('evm--', '') || 1);

          try {
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

              data.data.unshift(yourQuote); // Your quote first
            }
          } catch (e) {
            console.warn('LI.FI quote failed, skipping injection:', e.message);
          }
        }

        // Send modified response
        delete proxyRes.headers['content-encoding']; // Avoid double compression
        delete proxyRes.headers['content-length'];
        res.set(proxyRes.headers);
        res.status(proxyRes.statusCode);
        res.send(data);
      } catch (error) {
        console.error('Response handling error:', error);
        res.set(proxyRes.headers);
        res.status(proxyRes.statusCode);
        res.send(body); // Fallback: send original
      }
    });
  },
});

app.use('/swap/v1', proxy);

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Backend running on port ${PORT}`);
  console.log('Quotes load from OneKey + your LI.FI quote injected');
  console.log('0.25% fee earned when your quote used');
});
