require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

console.log(`🕵️ BITRABO SPY v82 RUNNING ON ${PORT}`);
console.log("--------------------------------------------------");
console.log("WAITING FOR TRAFFIC...");
console.log("1. Restart App (to fetch Providers)");
console.log("2. Open Swap Tab");
console.log("3. Enter Amount (to fetch Quotes)");
console.log("--------------------------------------------------");

app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true, 
    
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('accept-encoding', 'identity'); // Force plain text
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const responseStr = responseBuffer.toString('utf8');

        // URL Filters
        const isProviderList = req.url.includes('providers/list');
        const isQuote = req.url.includes('quote');
        const isBuildTx = req.url.includes('build-tx');
        const isRisk = req.url.includes('risk-check');

        if (isProviderList || isQuote || isBuildTx || isRisk) {
            console.log(`\n\n[⬇️ CAUGHT RESPONSE] ${req.method} ${req.url}`);
            console.log("👇👇👇 COPY BELOW 👇👇👇");
            
            try {
                const json = JSON.parse(responseStr);
                
                // Pretty Print the JSON
                console.log(JSON.stringify(json, null, 2)); 

            } catch (e) {
                console.log(responseStr); // Log raw if not JSON
            }
            console.log("👆👆👆 COPY ABOVE 👆👆👆");
            console.log("--------------------------------------------------");
        }

        return responseStr; 
    }),
}));

app.listen(PORT);
