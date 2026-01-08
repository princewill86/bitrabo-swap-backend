require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware'); // <-- FIXED: Added this line
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
const MAX_ALLOWANCE = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

createConfig({ integrator: INTEGRATOR, fee: FEE_PERCENT });

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

// LOGGING
app.use((req, res, next) => {
  const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('build-tx');
  console.log(isHijack ? `[⚡ HIJACK] ${req.method} ${req.url}` : `[🔄 PROXY] ${req.method} ${req.url}`);
  next();
});

// ==================================================================
// 1. PROVIDER LIST (THE HIJACK)
// ==================================================================
const MY_PROVIDERS = [
    {
        provider: 'SwapLifi',
        name: 'Li.fi (Bitrabo)',
        logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png',
        status: 'available',
        priority: 100,
        protocols: ['swap']
    },
    {
        provider: 'SwapCow',
        name: 'Cow Swap',
        logoURI: 'https://uni.onekey-asset.com/static/logo/CowSwapLogo.png',
        status: 'available',
        priority: 50,
        protocols: ['swap']
    },
    {
        provider: 'SwapOKX',
        name: 'OKX Dex',
        logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png',
        status: 'available',
        priority: 50,
        protocols: ['swap']
    }
];

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
    // We return ONLY our list. We do not proxy OneKey anymore.
    res.json(ok(MY_PROVIDERS));
});

app.get(['/swap/v1/check-support', '/check-support'], (req, res) => {
    res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

// ==================================================================
// 2. QUOTE GENERATOR (MULTI-MOCK)
// ==================================================================
async function generateAllQuotes(params, eventId) {
    try {
        const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
        const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
        const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
        
        let amount = params.fromTokenAmount;
        try {
            const t = await getToken(fromChain, fromToken);
            amount = ethers.parseUnits(Number(params.fromTokenAmount).toFixed(t.decimals), t.decimals).toString();
        } catch {}

        console.log(`[🔍 AGGREGATOR] Fetching main quote for ${amount}...`);

        let baseQuote = null;
        let isMock = false;

        // A. TRY REAL LI.FI
        try {
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

            if (routesResponse.routes?.length) {
                const route = routesResponse.routes[0];
                const step = route.steps[0];
                const transaction = await getStepTransaction(step); 
                
                const decimals = route.toToken.decimals;
                const toAmount = ethers.formatUnits(route.toAmount, decimals);
                
                baseQuote = {
                    rate: new BigNumber(toAmount).div(params.fromTokenAmount).toFixed(),
                    toAmount: toAmount,
                    tx: transaction,
                    decimals: decimals,
                    symbol: route.toToken.symbol,
                    logoURI: route.toToken.logoURI
                };
            }
        } catch (e) {
            console.warn(`[⚠️ API FAIL] ${e.message}. Switching to MOCK mode.`);
        }

        // B. FALLBACK IF FAILED
        if (!baseQuote) {
            isMock = true;
            const mockRate = 3000; // Dummy Price
            baseQuote = {
                rate: mockRate.toString(),
                toAmount: (parseFloat(params.fromTokenAmount) * mockRate).toString(),
                tx: null,
                decimals: 18,
                symbol: "MOCK",
                logoURI: ""
            };
        }

        // C. CLONE FOR ALL PROVIDERS
        const quotes = MY_PROVIDERS.map((p, index) => {
            // Tweak the rate slightly for realism (Cow is 99%, OKX is 99.5%)
            const tweak = 1 - (index * 0.005); 
            const tweakedToAmount = new BigNumber(baseQuote.toAmount).multipliedBy(tweak).toFixed(6);
            const tweakedRate = new BigNumber(baseQuote.rate).multipliedBy(tweak).toFixed();

            return {
                info: {
                    provider: p.provider,
                    providerName: p.name,
                    providerLogo: p.logoURI
                },
                fromTokenInfo: {
                    contractAddress: params.fromTokenAddress || "",
                    networkId: params.fromNetworkId,
                    isNative: !params.fromTokenAddress,
                    decimals: 18,
                    symbol: "TOKEN"
                },
                toTokenInfo: {
                    contractAddress: params.toTokenAddress || "",
                    networkId: params.toNetworkId,
                    isNative: !params.toTokenAddress,
                    decimals: baseQuote.decimals,
                    symbol: baseQuote.symbol,
                    logoURI: baseQuote.logoURI
                },
                protocol: 'Swap',
                kind: 'sell',
                fromAmount: params.fromTokenAmount,
                toAmount: tweakedToAmount,
                instantRate: tweakedRate,
                estimatedTime: 30 + (index * 10),
                fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: 0.1 },
                
                // Route Structure
                routesData: [{ subRoutes: [[{ name: p.name, percent: "100", logo: p.logoURI }]] }],
                
                // Execution Context (Always points to Base logic)
                quoteResultCtx: { 
                    tx: baseQuote.tx, 
                    isMock: isMock,
                    providerId: p.provider 
                },
                
                // Infinite Allowance Hijack (Prevents Spinning)
                allowanceResult: {
                    allowanceTarget: LIFI_ROUTER,
                    amount: MAX_ALLOWANCE,
                    shouldResetApprove: false
                },
                
                gasLimit: 500000,
                quoteId: uuidv4(),
                eventId: eventId,
                isBest: index === 0 // First one is best
            };
        });

        return quotes;

    } catch (e) {
        console.error("Aggregator Error:", e);
        return [];
    }
}

// ==================================================================
// 3. QUOTE STREAM
// ==================================================================
app.get('/swap/v1/quote/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const eventId = uuidv4();

    try {
        const quotes = await generateAllQuotes(req.query, eventId);
        
        // Header
        res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
        
        // Slippage Info
        res.write(`data: ${JSON.stringify({
            autoSuggestedSlippage: 0.5,
            fromNetworkId: req.query.fromNetworkId,
            toNetworkId: req.query.toNetworkId,
            fromTokenAddress: req.query.fromTokenAddress || "",
            toTokenAddress: req.query.toTokenAddress,
            eventId: eventId
        })}\n\n`);

        // Send all quotes
        for (const quote of quotes) {
            res.write(`data: ${JSON.stringify({ data: [quote] })}\n\n`);
        }

        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) {
        res.write(`data: {"type":"error"}\n\n`);
    } finally {
        res.end();
    }
});

// ==================================================================
// 4. BUILD TX
// ==================================================================
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;

    // A. MOCK MODE (If LiFi is banned)
    if (quoteResultCtx?.isMock) {
        console.log(`[⚙️ BUILD-TX] Returning MOCK Tx for provider ${quoteResultCtx.providerId}`);
        return res.json(ok({
            result: {
                info: { provider: quoteResultCtx.providerId },
                fromTokenInfo: { symbol: 'MOCK', decimals: 18 },
                protocol: 'Swap',
                kind: 'sell',
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: 21000,
                routesData: [{ subRoutes: [[{ name: "Simulation", percent: "100" }]] }]
            },
            tx: {
                to: userAddress, 
                value: "0",
                data: "0x",
                from: userAddress
            }
        }));
    }

    // B. REAL MODE (If LiFi works)
    if (quoteResultCtx?.tx) {
        console.log(`[⚙️ BUILD-TX] Returning LI.FI Tx for provider ${quoteResultCtx.providerId}`);
        const tx = quoteResultCtx.tx;
        return res.json(ok({
            result: {
                info: { provider: quoteResultCtx.providerId },
                fromTokenInfo: { symbol: 'TOKEN', decimals: 18 },
                protocol: 'Swap',
                kind: 'sell',
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: Number(tx.gasLimit || 500000),
                routesData: [{ subRoutes: [[{ name: "Li.Fi", percent: "100" }]] }]
            },
            tx: {
                to: tx.to,
                value: new BigNumber(tx.value).toFixed(),
                data: tx.data,
                from: userAddress
            }
        }));
    }

    res.json(ok(null));
});

// 5. ALLOWANCE HIJACK (Always Approved)
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => {
    res.json(ok({ allowance: MAX_ALLOWANCE })); 
});

// 6. CATCH-ALL PROXY (For everything else like token lists)
app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    logLevel: 'silent'
}));

app.listen(PORT, () => {
    console.log(`Bitrabo PRODUCTION Server v64 Running on ${PORT}`);
});
