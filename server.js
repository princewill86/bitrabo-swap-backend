// server.js - Final Hybrid Proxy (Fixes 404 for quote/events)
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.send('Bitrabo Swap Proxy Live! Full Compatibility Fixed 🚀');
});

// Proxy /swap/v1/* to OneKey WITHOUT rewriting path for quote/events
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  // NO pathRewrite — keep /swap/v1/quote/events as-is (OneKey backend expects it)
  onProxyReq: (proxyReq, req, res) => {
    console.log(`Proxy → ${req.method} ${req.url}`);
  },
}));

// Fallback health
app.use('*', (req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`Bitrabo Proxy running on port ${PORT}`);
  console.log('Now supports /swap/v1/quote/events → no more 404!');
});
