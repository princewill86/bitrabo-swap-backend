require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken, getStepTransaction } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');

// --- INTERNAL CACHE (No Dependencies) ---
class SimpleCache {
    constructor(ttlSeconds) {
        this.cache = new Map();
        this.ttl = ttlSeconds * 1000;
    }
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
    set(key, value) {
        this.cache.set(key, { value, expiry: Date.now() + this.ttl });
    }
}
const quoteCache = new SimpleCache(15);

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER; 
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025); 

createConfig({ integrator: INTEGRATOR, fee: FEE_PERCENT });

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

// LOGGING
app.use((req, res, next) => {
  const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('check-support') || req.url.includes('build-tx');
  console.log(isHijack ? `[⚡ HIJACK] ${req.method} ${req.url}` : `[🔄 PROXY] ${req.method} ${req.url}`);
  next();
});

// ==================================================================
// 1. PROVIDER LIST (ALL PROVIDERS)
// ==================================================================
const ALL_PROVIDERS = [
    { provider: 'SwapLifi', name: 'Li.fi (Bitrabo)', logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png', priority: 100 },
    { provider: 'SwapCow', name: 'Cow Swap', logoURI: 'https://uni.onekey-asset.com/static/logo/CowSwapLogo.png', priority: 90 },
    { provider: 'SwapOKX', name: 'OKX Dex', logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png', priority: 80 },
    { provider: 'Swap1inch', name: '1inch', logoURI: 'https://uni.onekey-asset.com/static/logo/1inch.png', priority: 70 },
    { provider: 'Swap0x', name: '0x', logoURI: 'https://uni.onekey-asset.com/static/logo/0x.png', priority: 60 }
];

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
    // Return full list of providers we support
    res.json(ok(ALL_PROVIDERS.map(p => ({ ...p, status: 'available', protocols: ['swap'] }))));
});

app.get(['/swap/v1/check-support', '/check-support'], (req, res) => {
    res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
});

// ALLOWANCE HIJACK (Force "Approve" button if needed)
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => {
    res.json(ok("0")); 
});

// ==================================================================
// 2. AGGREGATOR LOGIC
// ==================================================================

// Helper to normalize amounts
async function normalizeAmountInput(chainId, tokenAddress, rawAmount) {
    if (!rawAmount || rawAmount === '0') return '0';
    try {
        const token = await getToken(chainId, tokenAddress);
        return ethers.parseUnits(Number(rawAmount).toFixed(token.decimals), token.decimals).toString();
    } catch {
        return ethers.parseUnits(Number(rawAmount).toFixed(18), 18).toString(); // Default 18
    }
}

// SIMULATE QUOTE (For providers where you don't have keys yet)
function simulateQuote(params, provider, index) {
    const rate = 3000 * (1 - (index * 0.001)); // Slight variance per provider
    const toAmount = (parseFloat(params.fromTokenAmount) * rate).toString();
    const decimals = 6; // Assume USDC for demo, or 18 otherwise
    
    // Fake Transaction (Self-Send 0 ETH)
    const tx = {
        to: params.userAddress,
        value: "0",
        data: "0x",
        gasLimit: "21000",
        chainId: parseInt(params.fromNetworkId.replace('evm--', ''))
    };

    return {
        info: {
            provider: provider.provider,
            providerName: provider.name,
            providerLogo: provider.logoURI,
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
            decimals: decimals,
            symbol: "USDC"
        },
        protocol: 'Swap',
        kind: 'sell',
        fromAmount: params.fromTokenAmount,
        toAmount: toAmount,
        instantRate: rate.toString(),
        estimatedTime: 30 + index,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: [{
            name: provider.name,
            part: 100,
            subRoutes: [[{ name: provider.name, part: 100, logo: provider.logoURI }]]
        }],
        quoteResultCtx: { 
            tx, // Stored for Build-Tx
            provider: provider.provider
        },
        allowanceResult: null, // Honest check
        gasLimit: 500000,
        quoteId: uuidv4(),
        eventId: params.eventId, // Matches stream
        isBest: index === 0
    };
}

// MAIN FETCH LOGIC
async function fetchAllQuotes(params, eventId) {
    try {
        const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
        const amount = await normalizeAmountInput(fromChain, params.fromTokenAddress, params.fromTokenAmount);
        if(!amount || amount === '0') return [];

        console.log(`[🔍 AGGREGATOR] Generating quotes for ${ALL_PROVIDERS.length} providers...`);

        // Generate a quote for EVERY provider in our list
        // (Later, you replace 'simulateQuote' with 'fetchCowQuote', etc.)
        const quotes = ALL_PROVIDERS.map((p, i) => simulateQuote({ ...params, eventId }, p, i));

        return quotes;

    } catch (e) {
        console.error("Aggregator Error:", e);
        return [];
    }
}

app.get('/swap/v1/quote/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const eventId = uuidv4();

    try {
        const quotes = await fetchAllQuotes({ ...req.query }, eventId);
        
        res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
        
        res.write(`data: ${JSON.stringify({
            autoSuggestedSlippage: 0.5,
            fromNetworkId: req.query.fromNetworkId,
            toNetworkId: req.query.toNetworkId,
            fromTokenAddress: req.query.fromTokenAddress || "",
            toTokenAddress: req.query.toTokenAddress,
            eventId: eventId
        })}\n\n`);

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
// 3. BUILD TX (Unified)
// ==================================================================
app.post('/swap/v1/build-tx', jsonParser, async (req, res) => {
    try {
        const { quoteResultCtx, userAddress } = req.body;
        const tx = quoteResultCtx?.tx;

        if (!tx) return res.json(ok(null));

        console.log(`[⚙️ BUILD-TX] Building Tx for provider: ${quoteResultCtx.provider}`);

        const response = {
            result: { 
                info: { provider: quoteResultCtx.provider, providerName: quoteResultCtx.provider },
                fromTokenInfo: quoteResultCtx.fromTokenInfo, // You'd need to pass full info in ctx
                protocol: "Swap",
                kind: "sell",
                fee: { percentageFee: FEE_PERCENT * 100 }, 
                routesData: [{
                    name: quoteResultCtx.provider,
                    part: 100,
                    subRoutes: [[{ name: quoteResultCtx.provider, part: 100 }]]
                }],
                gasLimit: tx.gasLimit ? Number(tx.gasLimit) : 500000,
                slippage: 0.5
            },
            ctx: { lifiToNetworkId: "evm--1" },
            orderId: uuidv4(),
            tx: {
                to: tx.to, 
                value: tx.value ? new BigNumber(tx.value).toFixed() : '0',
                data: tx.data, 
                from: userAddress,
                gas: tx.gasLimit ? new BigNumber(tx.gasLimit).toFixed() : undefined
            }
        };

        res.json(ok(response));

    } catch (e) {
        console.error("[❌ BUILD-TX ERROR]", e);
        res.json(ok(null));
    }
});

app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    logLevel: 'silent',
    filter: (pathname) => {
        return !pathname.includes('providers/list') && !pathname.includes('quote') && !pathname.includes('build-tx') && !pathname.includes('check-support') && !pathname.includes('allowance');
    }
}));

app.listen(PORT, () => {
    console.log(`Bitrabo PRODUCTION Server v68 Running on ${PORT}`);
});
