require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

// --- THE SPY MIDDLEWARE ---
// This proxies requests to OneKey but prints the SECRET RESPONSE to your logs.
const spyProxy = createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  selfHandleResponse: true, // Allows us to read the body before sending it back
  
  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    const responseStr = responseBuffer.toString('utf8');
    
    // Only log the interesting endpoints
    if (req.url.includes('quote') || req.url.includes('providers') || req.url.includes('build-tx')) {
      console.log(`\n\n[🕵️ SPY CAPTURED DATA] ===> ${req.url}`);
      console.log(responseStr); // <--- THIS IS THE GOLDEN KEY
      console.log('==========================================\n');
    }
    
    return responseStr; // Send data to app so it doesn't crash
  }),
});

app.use('/swap/v1', spyProxy);

app.listen(PORT, () => {
  console.log(`🕵️ BITRABO SPY SERVER RUNNING ON ${PORT}`);
  console.log("1. Open OneKey App");
  console.log("2. Perform a Swap (It will work because we are proxying)");
  console.log("3. Check these logs for the [SPY CAPTURED DATA]");
});
