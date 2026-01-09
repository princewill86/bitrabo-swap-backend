require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

console.log(`🕵️ BITRABO SPY SERVER v73 RUNNING ON ${PORT}`);
console.log("MODE: PASS-THROUGH (No hijacking, just logging)");

// ==================================================================
// THE SPY PROXY
// ==================================================================
app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true, // Critical: Allows us to modify/read response
    
    onProxyReq: (proxyReq, req, res) => {
        // Remove compression headers so we receive plain text/JSON
        proxyReq.setHeader('accept-encoding', 'identity');
        console.log(`\n[⬆️ REQUEST] ${req.method} ${req.url}`);
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const responseStr = responseBuffer.toString('utf8');

        // Filter: Only log interesting endpoints
        if (req.url.includes('quote') || req.url.includes('build-tx') || req.url.includes('providers')) {
            console.log(`\n[⬇️ RESPONSE from OneKey] ${req.url}`);
            
            try {
                // Try to format it as JSON for readability
                const json = JSON.parse(responseStr);
                
                // If it's the Provider List, log it clearly
                if (req.url.includes('providers/list')) {
                    console.log("*********** PROVIDER LIST STRUCTURE ***********");
                    console.log(JSON.stringify(json, null, 2));
                    console.log("***********************************************");
                }
                
                // If it's a Quote, log the first result clearly
                else if (req.url.includes('quote')) {
                    console.log("*********** QUOTE EVENT STRUCTURE ***********");
                    // Just log the first chunk of data to avoid 10MB logs
                    console.log(JSON.stringify(json, null, 2).substring(0, 3000)); 
                    console.log("... (truncated) ...");
                    console.log("*********************************************");
                } 
                
                // If it's Build-TX, log everything
                else if (req.url.includes('build-tx')) {
                     console.log("*********** BUILD TX STRUCTURE ***********");
                     console.log(JSON.stringify(json, null, 2));
                     console.log("******************************************");
                }

            } catch (e) {
                // If not JSON (e.g. streaming data), log raw string
                console.log("[⚠️ RAW DATA] " + responseStr.substring(0, 1000));
            }
        }

        return responseStr; // Send original data to the app
    }),
}));

app.listen(PORT);
