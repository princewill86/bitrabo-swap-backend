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
// 1. HELPERS
// ==================================================================
function formatTokenAddress(address, isNative) {
    if (isNative) return "";
    if (!address || address === '0x0000000000000000000000000000000000000000') return "";
    return address.toLowerCase();
}

async function normalizeAmountInput(chainId, tokenAddress, rawAmount) {
  if (!rawAmount || rawAmount === '0') return '0';
  try {
      const token = await getToken(chainId, tokenAddress);
      const decimals = token.decimals || 18;
      return ethers.parseUnits(Number(rawAmount).toFixed(decimals), decimals).toString();
  } catch {
      return ethers.parseUnits(Number(rawAmount).toFixed(18), 18).toString();
  }
}

async function formatAmountOutput(chainId, tokenAddress, amountWei) {
    if(!amountWei) return "0";
    try {
        const token = await getToken(chainId, tokenAddress);
        const decimals = token.decimals || 18;
        return ethers.formatUnits(amountWei, decimals).toString();
    } catch {
        return ethers.formatUnits(amountWei, 18).toString();
    }
}

// ==================================================================
// 2. LI.FI FETCH LOGIC
// ==================================================================
async function generateLiFiQuote(params, eventId) {
    try {
        const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
        const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
        const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
        const isNativeSell = fromToken === '0x0000000000000000000000000000000000000000';
        
        const amount = await normalizeAmountInput(fromChain, fromToken, params.fromTokenAmount);
        
        console.log(`[🔍 LIFI] Fetching quote for ${amount}...`);
        
        const routesResponse = await getRoutes({
            fromChainId: fromChain,
            toChainId: toChain,
            fromTokenAddress: fromToken,
            toTokenAddress: params.toTokenAddress || '0x0000000000000000000000000000000000000000',
            fromAmount: amount,
            fromAddress: params.userAddress,
            slippage: 0.005,
            options: { integrator: INTEGRATOR, fee: FEE_PERCENT }
        });

        if (!routesResponse.routes || !routesResponse.routes.length) return null;

        const route = routesResponse.routes[0];
        const step = route.steps[0];
        const transaction = await getStepTransaction(step); // Eager load tx

        const toAmountDecimal = await formatAmountOutput(toChain, route.toToken.address, route.toAmount);
        const rate = new BigNumber(toAmountDecimal).div(params.fromTokenAmount).toFixed();

        // Allowance Logic
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
                contractAddress: formatTokenAddress(route.fromToken.address, isNativeSell),
                networkId: params.fromNetworkId,
                isNative: isNativeSell,
                decimals: route.fromToken.decimals,
                symbol: route.fromToken.symbol,
                logoURI: route.fromToken.logoURI
            },
            toTokenInfo: {
                contractAddress: formatTokenAddress(route.toToken.address, false),
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
            eventId: eventId, // IMPORTANT: Must match stream
            isBest: true
        };
    } catch (e) {
        console.error("LiFi Error:", e.message);
        return null;
    }
}

// ==================================================================
// 3. MIDDLEWARE & ROUTES
// ==================================================================

// 3a. Inject LiFi into Provider List
app.use('/swap/v1/providers/list', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true,
    onProxyRes: responseInterceptor(async (responseBuffer) => {
        try {
            const data = JSON.parse(responseBuffer.toString('utf8'));
            if (data.data) {
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

// 3b. Inject LiFi Quote into Event Stream
app.get('/swap/v1/quote/events', async (req, res) => {
    // 1. Start Real Stream from OneKey
    const oneKeyUrl = `https://swap.onekeycn.com/swap/v1/quote/events?${new URLSearchParams(req.query).toString()}`;
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        const response = await axios({
            method: 'get',
            url: oneKeyUrl,
            responseType: 'stream',
            headers: { 'User-Agent': 'OneKey/1.0' }
        });

        let eventId = null;
        let lifiSent = false;

        response.data.on('data', async (chunk) => {
            const str = chunk.toString();
            
            // Capture EventID from first chunk
            if (!eventId && str.includes('"eventId":"')) {
                const match = str.match(/"eventId":"([^"]+)"/);
                if (match) eventId = match[1];
                console.log(`[📡 STREAM] Captured EventID: ${eventId}`);
            }

            // Pass chunk to user
            res.write(chunk);

            // Fetch & Inject LiFi ONCE
            if (eventId && !lifiSent) {
                lifiSent = true;
                const lifiQuote = await generateLiFiQuote(req.query, eventId);
                if (lifiQuote) {
                    console.log("[💉 INJECT] Sending Li.Fi Quote to stream");
                    const eventStr = `data: ${JSON.stringify({ data: [lifiQuote] })}\n\n`;
                    res.write(eventStr);
                }
            }
        });

        response.data.on('end', () => res.end());

    } catch (e) {
        console.error("Stream Error:", e.message);
        res.end();
    }
});

// 3c. Handle Build Tx
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
    
    // If it's ours (has 'tx' property)
    if (quoteResultCtx?.tx) {
        console.log("[⚙️ BUILD-TX] Handling Li.Fi Transaction");
        const tx = quoteResultCtx.tx;
        return res.json(ok({
            result: {
                // Return minimal valid structure
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

    // If it's not ours, proxy to real OneKey
    // (We need to construct a manual proxy request here or redirect)
    // For simplicity, we just assume if it hits here with unknown context, we error or handle separately.
    // Ideally, the proxy middleware below handles non-Lifi requests if we didn't catch it.
    // But since we can't easily conditional proxy inside a POST handler, let's just return null if not ours.
    res.status(500).json({ code: -1, message: "Unknown Provider" });
});

// 3d. Fallback Proxy for everything else (allowance, etc.)
app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    logLevel: 'silent'
}));

app.listen(PORT, () => {
    console.log(`Bitrabo PRODUCTION Server v59 Running on ${PORT}`);
});
