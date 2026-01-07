require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

// --- THE QUOTE SPY ---
const spyProxy = createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  selfHandleResponse: true, 
  
  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    const responseStr = responseBuffer.toString('utf8');
    
    // We want to see the QUOTE response
    if (req.url.includes('quote')) {
      console.log(`\n\n[🕵️ GOLDEN QUOTE FOUND] ===> ${req.url}`);
      console.log(responseStr.substring(0, 3000)); // Log first 3000 chars (enough to see the structure)
      console.log('==========================================\n');
    }
    
    return responseStr; 
  }),
});

app.use('/swap/v1', spyProxy);

app.listen(PORT, () => {
  console.log(`🕵️ BITRABO QUOTE SPY RUNNING ON ${PORT}`);
  console.log("1. Open OneKey App.");
  console.log("2. Select a Token Pair (e.g. ETH -> USDC).");
  console.log("3. Wait for the quotes to load.");
  console.log("4. COPY the huge text block starting with 'data: {' from the logs.");
});
