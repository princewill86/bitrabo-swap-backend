require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000; // Render Default

app.use(cors({ origin: '*' }));

// IMPORTANT: Do NOT use express.json() here. 
// It interferes with the Proxy logic.

console.log(`🕵️ BITRABO SPY (Transaction Capture Mode) RUNNING ON ${PORT}`);
console.log("--------------------------------------------------");
console.log("INSTRUCTIONS:");
console.log("1. Go to your Frontend App.");
console.log("2. Perform a Swap (Select Tokens -> Click Review).");
console.log("3. Watch these logs for the [⬇️ CAUGHT RESPONSE].");
console.log("--------------------------------------------------");

app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true, 
    
    // 1. Force Accept-Encoding to prevent GZIP (unreadable binary)
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('accept-encoding', 'identity'); 
        if (req.url.includes('build-tx')) {
            console.log(`\n[⬆️ CAUGHT REQUEST] Sending Build-Tx Request to Real OneKey API...`);
        }
    },

    // 2. Intercept and Log the Response
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const responseStr = responseBuffer.toString('utf8');

        // We only care about specific endpoints
        const isBuildTx = req.url.includes('build-tx');
        const isQuote = req.url.includes('quote') && !req.url.includes('verify');

        if (isBuildTx || isQuote) {
            console.log(`\n\n[⬇️ CAUGHT RESPONSE] ${req.method} ${req.url}`);
            console.log("👇👇👇 THE GOLDEN JSON 👇👇👇");
            console.log("--------------------------------------------------");
            
            try {
                const json = JSON.parse(responseStr);
                // Pretty Print so we can read it easily
                console.log(JSON.stringify(json, null, 2)); 
            } catch (e) {
                console.log(responseStr); // Log raw if it fails parsing
            }
            console.log("--------------------------------------------------");
            console.log("👆👆👆 COPY THIS 👆👆👆\n");
        }

        return responseStr; 
    }),
}));

app.listen(PORT, () => {
    console.log(`\nServer is listening on port ${PORT}`);
});
