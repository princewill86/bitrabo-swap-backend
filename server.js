// server.js - Pure Proxy + Your LI.FI Integrator
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.send('Bitrabo Proxy Live! Using YOUR LI.FI Integrator 🚀');
});

// Proxy all requests — but add your integrator header for LI.FI
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  // No pathRewrite — keeps /swap/v1/quote/events working
  onProxyReq: (proxyReq, req, res) => {
    // Add your LI.FI integrator to every request
    // OneKey's backend will forward it to LI.FI when that provider is used
    proxyReq.setHeader('x-lifi-integrator', process.env.BITRABO_INTEGRATOR || 'bitrabo');
    
    console.log(`Proxy → ${req.method} ${req.url} (Integrator: ${process.env.BITRABO_INTEGRATOR || 'bitrabo'})`);
  },
}));

app.listen(PORT, () => {
  console.log(`Bitrabo Proxy running on port ${PORT}`);
  console.log(`Your LI.FI Integrator: ${process.env.BITRABO_INTEGRATOR || 'bitrabo'}`);
  console.log('Fees now go to YOUR wallet when LI.FI route is selected!');
});
