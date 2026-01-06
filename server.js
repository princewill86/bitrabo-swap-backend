// server.js
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies (needed for POST requests like build-tx)
app.use(express.json());

// Forward ALL /swap/v1/* requests to OneKey's real swap backend
app.use(
  '/swap/v1',
  createProxyMiddleware({
    target: 'https://swap.onekeycn.com',     // OneKey's actual swap server
    changeOrigin: true,
    pathRewrite: {
      '^/swap/v1': '/v1',                    // Strip "/swap" → /v1/quote becomes correct
    },
    onProxyReq: (proxyReq, req, res) => {
      // Optional: Log requests for debugging
      console.log(`Proxying ${req.method} ${req.url}`);
    },
    onError: (err, req, res) => {
      console.error('Proxy error:', err);
      res.status(500).json({ code: 1, message: 'Proxy error, please try again' });
    },
  })
);

// Health check endpoint — important for Render
app.get('/', (req, res) => {
  res.send('Bitrabo Swap Proxy is Live and Ready! 🚀');
});

// Catch-all for any other routes (optional, helps debugging)
app.use('*', (req, res) => {
  res.status(404).json({ code: 404, message: 'Endpoint not found on proxy' });
});

app.listen(PORT, () => {
  console.log(`Bitrabo Swap Proxy running on port ${PORT}`);
  console.log(`Health check: https://your-proxy.onrender.com/`);
});
