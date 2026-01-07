require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

// --- THE BUILD-TX SPY ---
const spyProxy = createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  selfHandleResponse: true, 
  
  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    const responseStr = responseBuffer.toString('utf8');
    
    // We only care about the BUILD-TX response now
    if (req.url.includes('build-tx')) {
      console.log(`\n\n[🕵️ GOLDEN KEY FOUND] ===> ${req.url}`);
      console.log(responseStr); 
      console.log('==========================================\n');
    }
    
    return responseStr; 
  }),
});

app.use('/swap/v1', spyProxy);

app.listen(PORT, () => {
  console.log(`🕵️ BITRABO BUILD-TX SPY RUNNING ON ${PORT}`);
  console.log("1. Open OneKey App.");
  console.log("2. Select a Token Pair (e.g. ETH -> USDC).");
  console.log("3. Click 'Swap' to open the Preview.");
  console.log("4. COPY the huge JSON blob that appears in these logs.");
});
