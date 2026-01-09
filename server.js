require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: '*' }));

console.log(`🕵️ BITRABO CONFIRMATION SPY RUNNING ON ${PORT}`);
console.log("--------------------------------------------------");
console.log("WAITING FOR YOU TO CLICK 'CONFIRM'...");
console.log("1. Go to your App.");
console.log("2. Perform a Swap.");
console.log("3. Click 'Review' -> Then Click 'Confirm'.");
console.log("--------------------------------------------------");

app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true, 
    
    onProxyReq: (proxyReq, req, res) => {
        // Force plain text so we can read the response
        proxyReq.setHeader('accept-encoding', 'identity'); 
        
        if (req.url.includes('build-tx')) {
            console.log(`\n[⬆️ CAUGHT REQUEST] Frontend is asking for the Transaction...`);
        }
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const responseStr = responseBuffer.toString('utf8');

        // ⚡ WE ONLY CARE ABOUT THE BUILD-TX RESPONSE
        if (req.url.includes('build-tx')) {
            console.log(`\n\n[⬇️ CAUGHT RESPONSE] ${req.method} ${req.url}`);
            console.log("👇👇👇 THIS IS THE PAYLOAD SAFEPAL WANTS 👇👇👇");
            console.log("--------------------------------------------------");
            
            try {
                const json = JSON.parse(responseStr);
                console.log(JSON.stringify(json, null, 2)); 
            } catch (e) {
                console.log(responseStr);
            }
            console.log("--------------------------------------------------");
            console.log("👆👆👆 COPY THIS JSON 👆👆👆\n");
        }

        return responseStr; 
    }),
}));

app.listen(PORT);
