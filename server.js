require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken, getStepTransaction } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

// --- CACHE (Internal) ---
class SimpleCache {
    constructor(ttl) { this.cache = new Map(); this.ttl = ttl * 1000; }
    get(k) { const i = this.cache.get(k); return i && Date.now() < i.e ? i.v : null; }
    set(k, v) { this.cache.set(k, { v, e: Date.now() + this.ttl }); }
}
const quoteCache = new SimpleCache(15);

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER; 
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025); 
const LIFI_INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';

createConfig({ integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT });

// API KEYS
const KEYS = {
    ZEROX: process.env.ZEROX_API_KEY,
    ONEINCH: process.env.ONEINCH_API_KEY,
    CHANGEHERO: process.env.CHANGEHERO_API_KEY,
    OKX: {
        KEY: process.env.OKX_API_KEY,
        SECRET: process.env.OKX_SECRET_KEY,
        PASSPHRASE: process.env.OKX_PASSPHRASE
    }
};

app.use(cors({ origin: '*' }));
// NOTE: We do NOT use global jsonParser here to avoid breaking the Proxy stream.
// We only apply it to our specific routes.
const jsonParser = express.json(); 
const ok = (data) => ({ code: 0, message: "Success", data });

// ==================================================================
// 🕵️ TRAFFIC INSPECTOR (LOGGER)
// ==================================================================
app.use((req, res, next) => {
    // Log every request URL and Query Params
    const isHijack = req.url.includes('quote') || req.url.includes('providers') || req.url.includes('build-tx');
    const prefix = isHijack ? '⚡ HIJACK' : '🔄 PROXY';
    
    console.log(`\n[${prefix}] ${req.method} ${req.path}`);
    if (Object.keys(req.query).length > 0) {
        console.log(`   ❓ Params: ${JSON.stringify(req.query)}`);
    }
    next();
});

// ==================================================================
// 1. HELPERS
// ==================================================================
function getZeroXBaseUrl(chainId) {
    switch (chainId) {
        case 1: return 'https://api.0x.org'; 
        case 56: return 'https://bsc.api.0x.org';
        case 137: return 'https://polygon.api.0x.org';
        case 10: return 'https://optimism.api.0x.org';
        case 42161: return 'https://arbitrum.api.0x.org';
        case 43114: return 'https://avalanche.api.0x.org';
        default: return 'https://api.0x.org';
    }
}

// ==================================================================
// 2. REAL INTEGRATIONS (Your Keys)
// ==================================================================

// LI.FI
async function getLifiQuote(params, amount, chainId) {
    const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    
    // Fallback address for quoting only (avoids validation errors)
    const fromAddr = params.userAddress || "0x5555555555555555555555555555555555555555"; 

    const routes = await getRoutes({
        fromChainId: chainId, toChainId: chainId,
        fromTokenAddress: fromToken, toTokenAddress: toToken,
        fromAmount: amount, fromAddress: fromAddr, 
        options: { integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT, referrer: FEE_RECEIVER }
    });

    if (!routes.routes?.length) throw new Error("No Routes");
    const step = routes.routes[0].steps[0];
    const tx = await getStepTransaction(step);
    
    return {
        toAmount: ethers.formatUnits(routes.routes[0].toAmount, routes.routes[0].toToken.decimals),
        tx, decimals: routes.routes[0].toToken.decimals, symbol: routes.routes[0].toToken.symbol
    };
}

// 0x (Matcha)
async function getZeroXQuote(params, amount, chainId) {
    const baseUrl = getZeroXBaseUrl(chainId);
    const resp = await axios.get(`${baseUrl}/swap/v1/quote`, {
        headers: { '0x-api-key': KEYS.ZEROX },
        params: {
            sellToken: params.fromTokenAddress || 'ETH',
            buyToken: params.toTokenAddress,
            sellAmount: amount,
            takerAddress: params.userAddress, 
            feeRecipient: FEE_RECEIVER, 
            buyTokenPercentageFee: FEE_PERCENT
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, 18), // Default 18 if unknown
        tx: {
            to: resp.data.to, value: resp.data.value, data: resp.data.data, gasLimit: resp.data.gas
        },
        decimals: 18, symbol: "UNK"
    };
}

// 1INCH
async function getOneInchQuote(params, amount, chainId) {
    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;
    const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
        params: {
            src: params.fromTokenAddress, dst: params.toTokenAddress,
            amount, from: params.userAddress, slippage: 1,
            fee: FEE_PERCENT * 100, referrer: FEE_RECEIVER
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.dstAmount, 18),
        tx: {
            to: resp.data.tx.to, value: resp.data.tx.value, data: resp.data.tx.data, gasLimit: resp.data.tx.gas
        },
        decimals: 18, symbol: "UNK"
    };
}

// CHANGEHERO
async function getChangeHeroQuote(params, amount, chainId) {
    // Basic mapping for demo - Expand this list for production!
    const map = { 
        '0xdac17f958d2ee523a2206206994597c13d831ec7': 'usdt',
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usdc',
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'eth'
    };
    
    const fromSym = map[params.fromTokenAddress?.toLowerCase()] || (params.fromTokenAddress ? null : 'eth');
    const toSym = map[params.toTokenAddress?.toLowerCase()];

    if (!fromSym || !toSym) throw new Error("Ticker Mapping Missing");

    const readableAmount = ethers.formatUnits(amount, 18); 
    const url = `https://api.changehero.io/v2/exchange-amount`;
    const resp = await axios.get(url, {
        params: { api_key: KEYS.CHANGEHERO, from: fromSym, to: toSym, amount: readableAmount }
    });

    return {
        toAmount: resp.data.estimated_amount,
        tx: null, // ChangeHero needs special handling
        decimals: 18, symbol: toSym.toUpperCase()
    };
}

// OKX
async function getOkxQuote(params, amount, chainId) {
    const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${params.fromTokenAddress}&toTokenAddress=${params.toTokenAddress}&userWalletAddress=${params.userAddress}&slippage=0.005`;
    const ts = new Date().toISOString();
    const sign = crypto.createHmac('sha256', KEYS.OKX.SECRET).update(ts + 'GET' + path).digest('base64');
    
    try {
        const resp = await axios.get(`https://www.okx.com${path}`, {
            headers: {
                'OK-ACCESS-KEY': KEYS.OKX.KEY, 'OK-ACCESS-SIGN': sign,
                'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': KEYS.OKX.PASSPHRASE,
                'X-Simulated-Trading': '0'
            }
        });
        if (resp.data.code !== '0') throw new Error(`OKX: ${resp.data.msg}`);
        const d = resp.data.data[0];
        return {
            toAmount: ethers.formatUnits(d.toTokenAmount, 18), 
            tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
            decimals: 18, symbol: "UNK"
        };
    } catch (e) {
        throw new Error(e.response?.data?.msg || e.message);
    }
}

// ==================================================================
// 3. AGGREGATOR
// ==================================================================
const MY_PROVIDERS = [
    { provider: 'SwapLifi', name: 'Li.fi (Bitrabo)', logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png', priority: 100 },
    { provider: 'Swap1inch', name: '1inch', logoURI: 'https://uni.onekey-asset.com/static/logo/1inch.png', priority: 90 },
    { provider: 'Swap0x', name: '0x', logoURI: 'https://uni.onekey-asset.com/static/logo/0x.png', priority: 80 },
    { provider: 'SwapChangeHero', name: 'ChangeHero', logoURI: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png', priority: 70 },
    { provider: 'SwapOKX', name: 'OKX Dex', logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png', priority: 60 },
    { provider: 'SwapJupiter', name: 'Jupiter', logoURI: 'https://uni.onekey-asset.com/static/logo/jupiter.png', priority: 50 }
];

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => res.json(ok(MY_PROVIDERS.map(p => ({ ...p, status: 'available', protocols: ['swap'] })))));
app.get(['/swap/v1/check-support', '/check-support'], (req, res) => res.json(ok([{ status: 'available', networkId: req.query.networkId }])));
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0"))); 

async function generateAllQuotes(params, eventId) {
    const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    
    // Normalize Amount
    try { 
        const t = await getToken(chainId, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        amount = ethers.parseUnits(Number(amount).toFixed(t.decimals), t.decimals).toString();
    } catch {
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString();
    }

    console.log(`[🔍 AGGREGATOR] Fetching for ${amount}...`);

    const promises = MY_PROVIDERS.map(async (p, i) => {
        try {
            let q = null;
            if (p.name.includes('Li.fi')) q = await getLifiQuote(params, amount, chainId);
            else if (p.name.includes('1inch')) q = await getOneInchQuote(params, amount, chainId);
            else if (p.name.includes('0x')) q = await getZeroXQuote(params, amount, chainId);
            else if (p.name.includes('OKX')) q = await getOkxQuote(params, amount, chainId);
            else if (p.name.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, chainId);
            else if (p.name.includes('Jupiter')) {
                if(!params.fromNetworkId.includes('sol')) throw new Error("Not Solana");
            }
            
            // Real Data Success
            return formatQuote(p, params, q, eventId, i === 0);

        } catch (e) {
            console.warn(`[⚠️ ${p.name} FAIL] ${e.message}. Using MOCK.`);
            return getMockQuote(p, params, eventId, i === 0);
        }
    });

    return await Promise.all(promises);
}

// FORMATTERS
function formatQuote(provider, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: data.symbol || "UNK" },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { tx: data.tx, providerId: provider.provider, isMock: false },
        allowanceResult: null,
        gasLimit: Number(data.tx?.gasLimit || 500000),
        quoteId: uuidv4(), eventId, isBest
    };
}

function getMockQuote(provider, params, eventId, isBest) {
    const mockRate = 3000;
    const toAmount = (parseFloat(params.fromTokenAmount) * mockRate).toString();
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: 18, symbol: "USDC" },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount,
        instantRate: mockRate.toString(), estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { isMock: true, providerId: provider.provider },
        allowanceResult: null,
        gasLimit: 21000,
        quoteId: uuidv4(), eventId, isBest
    };
}

// ==================================================================
// 4. ROUTES & CATCH-ALL SPY PROXY
// ==================================================================

app.get('/swap/v1/quote/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const eventId = uuidv4();
    try {
        const quotes = await generateAllQuotes(req.query, eventId);
        res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId, ...req.query })}\n\n`);
        for (const q of quotes) res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`);
        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) { res.write(`data: {"type":"error"}\n\n`); }
    res.end();
});

app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
    
    // Log the Build Request
    console.log(`[⚙️ BUILD-TX REQUEST] Provider: ${quoteResultCtx?.providerId} | User: ${userAddress}`);

    if (quoteResultCtx?.isMock) {
        console.log(`   ⚠️ Sending MOCK Transaction (No Fee)`);
        return res.json(ok({
            result: { info: { provider: quoteResultCtx.providerId }, protocol: 'Swap', fee: { percentageFee: 0.25 }, gasLimit: 21000 },
            tx: { to: userAddress, value: "0", data: "0x" }
        }));
    }
    if (quoteResultCtx?.tx) {
        console.log(`   ✅ Sending REAL Transaction (Fee Included)`);
        return res.json(ok({
            result: { info: { provider: quoteResultCtx.providerId }, protocol: 'Swap', fee: { percentageFee: FEE_PERCENT * 100 }, gasLimit: Number(quoteResultCtx.tx.gasLimit || 500000) },
            tx: { ...quoteResultCtx.tx, from: userAddress, value: new BigNumber(quoteResultCtx.tx.value).toFixed() }
        }));
    }
    res.json(ok(null));
});

// SPY PROXY (Catch-All)
// This proxies everything we didn't handle to OneKey and LOGS the output
app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    selfHandleResponse: true, // Allow us to read body
    onProxyReq: (proxyReq) => {
        // Disable compression so we can read the text response
        proxyReq.setHeader('accept-encoding', 'identity'); 
    },
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const responseStr = responseBuffer.toString('utf8');
        try {
            // Log OneKey's Real Response for debugging
            if (req.url.includes('quote') || req.url.includes('allowance')) {
                console.log(`\n[🕵️ ONEKEY SPY] Response from ${req.url}:`);
                console.log(responseStr.substring(0, 500)); // Log first 500 chars to avoid spam
            }
        } catch (e) {}
        return responseStr;
    })
}));

app.listen(PORT, () => console.log(`Bitrabo v72 Running on ${PORT}`));
