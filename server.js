// server.js - Hybrid: Proxy OneKey + Your LI.FI Override
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const { createConfig, getRoutes } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize LI.FI SDK with your integrator (real fee collection)
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025, // 0.25% real fee
});

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.send('Bitrabo Hybrid Swap Backend Live! (Proxy + LI.FI)');
});

// OPTIONAL: Override /swap/v1/quote with your LI.FI quote (uncomment to enable)
// app.get('/swap/v1/quote', async (req, res) => { ... your LI.FI code ... });

// Proxy ALL /swap/v1/* to OneKey (fixes 404 for /quote/events, build-tx, etc.)
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`Proxy → ${req.method} ${req.url}`);
  },
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
    res.status(500).json({ code: 1, message: 'Service unavailable' });
  },
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Hybrid Backend running on port ${PORT}`);
  console.log('All Swap requests proxied to OneKey (full compatibility)');
  console.log('LI.FI fee active via SDK config');
});
