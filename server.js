require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken, getStepTransaction } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER; 
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025); 
const LIFI_ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

createConfig({ integrator: INTEGRATOR, fee: FEE_PERCENT });

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

// ==================================================================
// 1. LI.FI LOGIC (Isolated)
// ==================================================================
async function generateLiFiQuote(params, eventId) {
    try {
        const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
        const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
        const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
        const isNativeSell = fromToken === '0x0000000000000000000000000000000000000000';
        
        // Safe amount formatting
        let amount = '0';
        try {
            const token = await getToken(fromChain, fromToken);
            amount = ethers.parseUnits(Number(params.fromTokenAmount).toFixed(token.decimals || 18), token.decimals || 18).toString();
        } catch {
            amount = ethers.parseUnits(Number(params.fromTokenAmount).toFixed(18), 18).toString();
        }

        console.log(`[🔍 LIFI] Fetching...`);
        const routesResponse = await getRoutes({
            fromChainId: fromChain,
            toChainId: toChain,
            fromTokenAddress: fromToken,
            toTokenAddress: params.toTokenAddress,
            fromAmount: amount,
            fromAddress: params.userAddress,
            slippage: 0.005,
            options: { integrator: INTEGRATOR, fee: FEE_PERCENT }
        });

        if (!routesResponse.routes?.length) return null;

        const route = routesResponse.routes[0];
        const step = route.steps[0];
        const transaction = await getStepTransaction(step); 

        // Output formatting
        let toAmountDecimal = '0';
        try {
            const tToken = await getToken(toChain, route.toToken.address);
            toAmountDecimal = ethers.formatUnits(route.toAmount, tToken.decimals || 18);
        } catch {
            toAmountDecimal = ethers.formatUnits(route.toAmount, 18);
        }

        const rate = new BigNumber(toAmountDecimal).div(params.fromTokenAmount).toFixed();

        // Allowance (Honest: null if Native, Target if Token)
        let allowanceResult = null;
        if (!isNativeSell) {
             allowanceResult = {
                allowanceTarget: LIFI_ROUTER,
                amount: params.fromTokenAmount,
                shouldResetApprove: false
            };
        }

        return {
            info: {
                provider: 'SwapLifi',
                providerName: 'Li.fi (Bitrabo)',
                providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png'
            },
            fromTokenInfo: {
                contractAddress: isNativeSell ? "" : fromToken.toLowerCase(),
                networkId: params.fromNetworkId,
                isNative: isNativeSell,
                decimals: route.fromToken.decimals,
                symbol: route.fromToken.symbol,
                logoURI: route.fromToken.logoURI
            },
            toTokenInfo: {
                contractAddress: route.toToken.address.toLowerCase(),
                networkId: params.toNetworkId,
                isNative: false,
                decimals: route.toToken.decimals,
                symbol: route.toToken.symbol,
                logoURI: route.toToken.logoURI
            },
            protocol: 'Swap',
            kind: 'sell',
            fromAmount: params.fromTokenAmount,
            toAmount: toAmountDecimal,
            instantRate: rate,
            estimatedTime: 30,
            fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: 0.1 },
            routesData: [{ subRoutes: [[{ name: "Li.Fi", percent: "100", logo: "https://uni.onekey-asset.com/static/logo/lifi.png" }]] }],
            quoteResultCtx: { tx: transaction },
            allowanceResult,
            gasLimit: transaction.gasLimit ? Number(transaction.gasLimit) : 500000,
            quoteId: uuidv4(),
            eventId: eventId, // IMPORTANT: Matches OneKey Stream
            isBest: true
        };
    } catch (e) {
        console.error("[⚠️ LIFI FAIL]", e.message); // Likely 429
        return null;
    }
}

// ==================================================================
// 2. PROVIDER LIST (Inject LiFi)
// ==================================================================
app.use('/swap/v1/providers/list', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('accept-encoding', 'identity'), // Disable compression
    onProxyRes: responseInterceptor(async (responseBuffer) => {
        try {
            const data = JSON.parse(responseBuffer.toString('utf8'));
            if (data.data) {
                // Add LiFi to the list
                data.data.unshift({
                    provider: 'SwapLifi',
                    name: 'Li.fi (Bitrabo)',
                    logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png',
                    status: 'available',
                    priority: 100,
                    protocols: ['swap']
                });
            }
            return JSON.stringify(data);
        } catch { return responseBuffer; }
    })
}));

// ==================================================================
// 3. QUOTE STREAM (Sidecar Logic)
// ==================================================================
app.get('/swap/v1/quote/events', async (req, res) => {
    const oneKeyUrl = `https://swap.onekeycn.com/swap/v1/quote/events?${new URLSearchParams(req.query).toString()}`;
    
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        // 1. Connect to OneKey Real Stream
        const response = await axios({
            method: 'get',
            url: oneKeyUrl,
            responseType: 'stream',
            headers: { 
                'User-Agent': 'OneKey/1.0',
                'Accept-Encoding': 'identity' // Critical: No Gzip
            }
        });

        let eventId = null;
        let lifiSent = false;

        response.data.on('data', async (chunk) => {
            const str = chunk.toString();
            
            // A. Pass OneKey data to user immediately (So it doesn't spin)
            res.write(chunk);

            // B. Sniff EventID from the first OneKey packet
            if (!eventId && str.includes('"eventId":"')) {
                const match = str.match(/"eventId":"([^"]+)"/);
                if (match) {
                    eventId = match[1];
                    console.log(`[📡 STREAM] Synced EventID: ${eventId}`);
                }
            }

            // C. Inject LiFi (Sidecar)
            if (eventId && !lifiSent) {
                lifiSent = true;
                // Run in background, don't block the stream
                generateLiFiQuote(req.query, eventId).then(lifiQuote => {
                    if (lifiQuote) {
                        console.log("[💉 INJECT] Sending Li.Fi Quote...");
                        res.write(`data: ${JSON.stringify({ data: [lifiQuote] })}\n\n`);
                    }
                });
            }
        });

        response.data.on('end', () => res.end());

    } catch (e) {
        console.error("Stream Proxy Error:", e.message);
        res.end(); // Close stream if OneKey fails
    }
});

// ==================================================================
// 4. BUILD TX (Hijack if LiFi, Proxy if others)
// ==================================================================
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
    
    // IF LI.FI: Handle locally
    if (quoteResultCtx?.tx) {
        console.log("[⚙️ BUILD-TX] Handling Li.Fi Transaction");
        const tx = quoteResultCtx.tx;
        return res.json(ok({
            result: {
                info: { provider: 'SwapLifi' },
                fromTokenInfo: quoteResultCtx.fromTokenInfo,
                protocol: 'Swap',
                kind: 'sell',
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: Number(tx.gasLimit || 500000)
            },
            tx: {
                to: tx.to,
                value: new BigNumber(tx.value).toFixed(),
                data: tx.data,
                from: userAddress
            }
        }));
    }

    // IF OTHERS: Proxy to OneKey
    try {
        const resp = await axios.post('https://swap.onekeycn.com/swap/v1/build-tx', req.body);
        res.json(resp.data);
    } catch (e) {
        res.status(500).json({ code: -1, message: "Proxy Error" });
    }
});

// ==================================================================
// 5. CATCH-ALL PROXY
// ==================================================================
app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    logLevel: 'silent',
    onProxyReq: (proxyReq) => proxyReq.setHeader('accept-encoding', 'identity')
}));

app.listen(PORT, () => {
    console.log(`Bitrabo PRODUCTION Server v61 Running on ${PORT}`);
});
