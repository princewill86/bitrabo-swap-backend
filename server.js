// server.js - Pure Proxy (Quotes Work Guaranteed)
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const PORT = process.env.PORT || 3000;

// Proxy everything to OneKey
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
}));

app.get('/', (req, res) => res.send('Bitrabo Pure Proxy Live! Quotes Working'));

app.listen(PORT, () => console.log(`Pure Proxy on port ${PORT}`));
