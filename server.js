require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

console.log(`🕵️ BITRABO SPY SERVER RUNNING ON ${PORT}`);
console.log("1. Open the OneKey App.");
console.log("2. Perform a SAME-CHAIN swap (e.g. ETH -> USDT) that WORKS (using default providers).");
console.log("3. Watch these logs for [✅ GOLDEN RESPONSE].");

// SPY MIDDLEWARE
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  selfHandleResponse: true, // Allows us to read the body
  
  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    const responseStr = responseBuffer.toString('utf8');
    
    // We only care about QUOTES and ALLOWANCE
    if (req.url.includes('quote') || req.url.includes('allowance')) {
      console.log(`\n\n[🔍 REQUEST] ${req.method} ${req.url}`);
      
      try {
        // Try to pretty-print JSON if possible
        const json = JSON.parse(responseStr);
        console.log(`[✅ GOLDEN RESPONSE] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
        console.log(JSON.stringify(json, null, 2)); 
        console.log(`<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n`);
      } catch (e) {
        console.log(`[⚠️ RAW RESPONSE] ${responseStr.substring(0, 2000)}`);
      }
    }
    
    return responseStr; // Pass data back to app unmodified
  }),
}));

app.listen(PORT);
