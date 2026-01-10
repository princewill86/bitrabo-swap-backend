require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { createConfig, getRoutes, getToken, getStepTransaction } = require('@lifi/sdk');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// --- CONFIG ---
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER;
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025);
const LIFI_INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const TIMEOUT = 15000;

createConfig({ integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT });

const GAS_PRICE_ESTIMATES = {
    1: "30000000000",      // ETH: 30 Gwei
    56: "3000000000",      // BNB: 3 Gwei
    137: "150000000000",   // Polygon: 150 Gwei
    10: "100000000",       // Optimism: 0.1 Gwei
    42161: "100000000",    // Arbitrum: 0.1 Gwei
    8453: "100000000",     // Base: 0.1 Gwei
    43114: "25000000000"   // Avalanche: 25 Gwei
};

// Keys
const KEYS = {
    ZEROX: process.env.ZEROX_API_KEY ? process.env.ZEROX_API_KEY.trim() : undefined,
    ONEINCH: process.env.ONEINCH_API_KEY ? process.env.ONEINCH_API_KEY.trim() : undefined,
    CHANGEHERO: process.env.CHANGEHERO_API_KEY ? process.env.CHANGEHERO_API_KEY.trim() : undefined,
    OKX: {
        KEY: process.env.OKX_API_KEY ? process.env.OKX_API_KEY.trim() : undefined,
        SECRET: process.env.OKX_SECRET_KEY ? process.env.OKX_SECRET_KEY.trim() : undefined,
        PASSPHRASE: process.env.OKX_PASSPHRASE ? process.env.OKX_PASSPHRASE.trim() : undefined
    }
};

app.use(cors({ origin: '*' }));
const jsonParser = express.json();

const ok = (data) => ({ code: 0, message: "Success", data });

// ==================================================================
// SUPPORTED NETWORKS & PROVIDERS
// ==================================================================
const SUPPORTED_NETWORKS = [
    { networkId: "evm--1", network: "ETH", name: "Ethereum", symbol: "ETH", decimals: 18, indexerSupported: true },
    { networkId: "evm--56", network: "BNB", name: "BNB Chain", symbol: "BNB", decimals: 18, indexerSupported: true },
    { networkId: "evm--137", network: "MATIC", name: "Polygon", symbol: "MATIC", decimals: 18, indexerSupported: true },
    { networkId: "evm--42161", network: "ETH", name: "Arbitrum", symbol: "ETH", decimals: 18, indexerSupported: true },
    { networkId: "evm--10", network: "ETH", name: "Optimism", symbol: "ETH", decimals: 18, indexerSupported: true },
    { networkId: "evm--8453", network: "ETH", name: "Base", symbol: "ETH", decimals: 18, indexerSupported: true },
    { networkId: "evm--43114", network: "AVAX", name: "Avalanche", symbol: "AVAX", decimals: 18, indexerSupported: true }
];

let PROVIDERS_CONFIG = [
    { id: 'Swap1inch', name: '1inch', logo: 'https://uni.onekey-asset.com/static/logo/1inch.png' },
    { id: 'SwapLifi', name: 'Li.fi (Bitrabo)', logo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
    { id: 'Swap0x', name: '0x', logo: 'https://uni.onekey-asset.com/static/logo/0xlogo.png' },
    { id: 'SwapOKX', name: 'OKX Dex', logo: 'https://uni.onekey-asset.com/static/logo/OKXDex.png' },
    { id: 'SwapChangeHero', name: 'ChangeHero', logo: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png' }
];

// ==================================================================
// HELPERS
// ==================================================================
function toHex(val) {
    if (!val || val === '0') return "0x0";
    try {
        if (val.toString().startsWith('0x')) return val.toString();
        return "0x" + new BigNumber(val).toString(16);
    } catch { return "0x0"; }
}

function norm(addr) {
    if (!addr || addr === '' || addr === '0x0000000000000000000000000000000000000000') {
        return '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    }
    return addr.toLowerCase();
}

function getFakeRoutes(providerName, logo) {
    if (providerName.includes('OKX')) return [{ subRoutes: [[{ name: "PancakeSwap V3", percent: "100", logo: "https://static.okx.com/cdn/web3/dex/logo/pancakeswap_v3.png" }]] }];
    if (providerName.includes('1inch')) return [{ part: 100, subRoutes: [[{ name: "PMM12", part: 100, logo: "https://cdn.1inch.io/liquidity-sources-logo/pmm_color.png" }]] }];
    if (providerName.includes('0x')) return [{ part: 100, subRoutes: [[{ name: "Uniswap V3" }]] }];
    return [{ subRoutes: [[{ name: providerName, percent: "100", logo: logo }]] }];
}

function calculateFiatFee(gasLimit, gasPrice, nativePriceUSD, chainId) {
    try {
        const priceWei = gasPrice ? new BigNumber(gasPrice) : new BigNumber(GAS_PRICE_ESTIMATES[chainId] || "3000000000");
        const limit = new BigNumber(gasLimit || 200000);
        const totalWei = limit.multipliedBy(priceWei);
        const totalNative = totalWei.div(1e18);
        const usdFee = totalNative.multipliedBy(nativePriceUSD);
        return parseFloat(usdFee.toFixed(2));
    } catch (e) {
        return 0.15;
    }
}

// ==================================================================
// QUOTE FETCHERS (unchanged except minor safety)
// ==================================================================
async function getZeroXQuote(params, amount, chainId, toDecimals, nativePriceUSD) { /* ... same as before ... */ }
async function getOneInchQuote(params, amount, chainId, toDecimals, nativePriceUSD) { /* ... same ... */ }
async function getOkxQuote(params, amount, chainId, toDecimals, nativePriceUSD) { /* ... same ... */ }
async function getChangeHeroQuote(params, amount, chainId, fromTicker, toTicker, nativePriceUSD, isNative) { /* ... same ... */ }
async function getLifiQuote(params, amount, fromChain, toChain) { /* ... same ... */ }

// ==================================================================
// MAIN QUOTE GENERATION
// ==================================================================
async function generateAllQuotes(params, eventId) {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    let toDecimals = 18;
    let fromSymbol = "ETH";
    let toSymbol = "USDT";
    let nativePriceUSD = 0;

    try {
        const t = await getToken(fromChain, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        fromSymbol = t.symbol;
        amount = ethers.parseUnits(Number(amount).toFixed(t.decimals), t.decimals).toString();
        const toT = await getToken(toChain, params.toTokenAddress || '0x0000000000000000000000000000000000000000');
        toSymbol = toT.symbol;
        toDecimals = toT.decimals || 18;
        const nativeToken = await getToken(fromChain, '0x0000000000000000000000000000000000000000');
        nativePriceUSD = parseFloat(nativeToken.priceUSD || 0);
    } catch {
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString();
    }

    console.log(`[🔍 AGGREGATOR] Fetching (Native Price: $${nativePriceUSD})...`);

    const isNative = (!params.fromTokenAddress || params.fromTokenAddress === '0x0000000000000000000000000000000000000000');

    const promises = PROVIDERS_CONFIG.map(async (p, i) => {
        let q = null;
        if (fromChain !== toChain) {
            if (p.id.includes('Lifi')) q = await getLifiQuote(params, amount, fromChain, toChain);
            else if (p.id.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, fromChain, fromSymbol, toSymbol, nativePriceUSD, isNative);
        } else {
            if (p.id.includes('Lifi')) q = await getLifiQuote(params, amount, fromChain, toChain);
            else if (p.id.includes('1inch')) q = await getOneInchQuote(params, amount, fromChain, toDecimals, nativePriceUSD);
            else if (p.id.includes('0x')) q = await getZeroXQuote(params, amount, fromChain, toDecimals, nativePriceUSD);
            else if (p.id.includes('OKX')) q = await getOkxQuote(params, amount, fromChain, toDecimals, nativePriceUSD);
            else if (p.id.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, fromChain, fromSymbol, toSymbol, nativePriceUSD, isNative);
        }
        if (!q) return null;
        console.log(` ✅ ${p.name} Success ($${q.fiatFee})`);
        return formatQuote(p, params, q, eventId, i === 0);
    });

    const results = await Promise.all(promises);
    return results.filter(r => r !== null);
}

function formatQuote(providerConf, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed(12);

    const now = Date.now();
    const expiresInMs = 5 * 60 * 1000; // 5 minutes

    return {
        info: { provider: providerConf.id, providerName: providerConf.name, providerLogo: providerConf.logo },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: "UNK" },
        protocol: 'Swap',
        kind: 'sell',
        fromAmount: params.fromTokenAmount,
        toAmount: data.toAmount,
        instantRate: rate,
        estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: data.fiatFee || 0.15, protocolFees: 0 },
        routesData: data.routesData || [],
        quoteResultCtx: {
            tx: data.tx,
            providerId: providerConf.id,
            isMock: false,
            ...data.ctx,
            fromAmount: params.fromTokenAmount,
            toAmount: data.toAmount,
            instantRate: rate,
            gasLimit: Number(data.tx?.gasLimit || 210000),
            fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: data.fiatFee || 0.15, protocolFees: 0 },
            routesData: data.routesData || [],
            fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
            toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: "UNK" },
            estimatedTime: 30
        },
        allowanceResult: null,
        unSupportReceiveAddressDifferent: false,
        gasLimit: Number(data.tx?.gasLimit || 210000),
        quoteId: uuidv4(),
        eventId,
        isBest,
        createdAt: now,
        expiresAt: now + expiresInMs   // ← helps prevent instant "refresh quotes"
    };
}

// ==================================================================
// ENDPOINTS
// ==================================================================
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
    const list = PROVIDERS_CONFIG.map(p => ({
        providerInfo: { provider: p.id, name: p.name, logo: p.logo, protocol: "Swap" },
        isSupportSingleSwap: true, isSupportCrossChain: true,
        supportSingleSwapNetworks: SUPPORTED_NETWORKS,
        supportCrossChainNetworks: SUPPORTED_NETWORKS,
        providerServiceDisable: false,
        serviceDisableNetworks: []
    }));
    res.json(ok(list));
});

app.get(['/swap/v1/check-support', '/check-support'], (req, res) => 
    res.json(ok([{ status: 'available', networkId: req.query.networkId }]))
);

app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0")));

// Quote streaming
app.get('/swap/v1/quote/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const eventId = uuidv4();

    try {
        const quotes = await generateAllQuotes(req.query, eventId);

        res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId, ...req.query })}\n\n`);

        for (const q of quotes) {
            res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`);
        }

        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) {
        console.error(e);
        res.write(`data: {"type":"error","message":"${e.message}"}\n\n`);
    }

    res.end();
});

// NEW: Basic quote refresh endpoint (prevents "Refresh quotes" immediately)
app.post('/swap/v1/quote/refresh', jsonParser, async (req, res) => {
    const { quoteId, fromNetworkId, toNetworkId, fromTokenAddress, toTokenAddress, fromTokenAmount } = req.body;

    console.log(`[REFRESH] Requested for quote ${quoteId}`);

    // For simplicity we re-generate fresh quotes (you can optimize later)
    const fakeParams = {
        fromNetworkId,
        toNetworkId,
        fromTokenAddress,
        toTokenAddress,
        fromTokenAmount
    };

    const newEventId = uuidv4();
    const freshQuotes = await generateAllQuotes(fakeParams, newEventId);

    if (freshQuotes.length === 0) {
        return res.status(500).json({ code: 1, message: "Failed to refresh quotes" });
    }

    res.json(ok({ data: freshQuotes }));
});

// Build transaction
app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;

    if (!quoteResultCtx || !quoteResultCtx.tx) {
        return res.json(ok(null));
    }

    try {
        const isLifi = quoteResultCtx.providerId?.includes('Lifi') || false;
        const val = isLifi ? toHex(quoteResultCtx.tx.value) : new BigNumber(quoteResultCtx.tx.value || 0).toFixed();

        const feeAmount = new BigNumber(quoteResultCtx.toAmount || 0)
            .multipliedBy(FEE_PERCENT)
            .toFixed(6);

        const result = {
            info: { provider: quoteResultCtx.providerId },
            protocol: 'Swap',
            fromTokenInfo: quoteResultCtx.fromTokenInfo,
            toTokenInfo: quoteResultCtx.toTokenInfo,
            fromAmount: quoteResultCtx.fromAmount,
            toAmount: quoteResultCtx.toAmount,
            instantRate: quoteResultCtx.instantRate,
            estimatedTime: quoteResultCtx.estimatedTime || 30,
            fee: quoteResultCtx.fee,
            routesData: quoteResultCtx.routesData || [],
            oneKeyFeeExtraInfo: {
                oneKeyFeeAmount: feeAmount,
                oneKeyFeeSymbol: quoteResultCtx.toTokenInfo?.symbol || "TOKEN",
                oneKeyFeeUsd: (Number(feeAmount) * 1).toFixed(2) // dummy conversion
            },
            gasLimit: quoteResultCtx.gasLimit || 210000
        };

        res.json(ok({
            result,
            ctx: quoteResultCtx,
            tx: {
                ...quoteResultCtx.tx,
                from: userAddress,
                value: val
            }
        }));
    } catch (e) {
        console.error('Build-tx error:', e);
        res.json(ok(null));
    }
});

// Fallback proxy
app.use('/swap/v1', (req, res, next) => {
    console.log(`⚠️ Proxying to OneKey: ${req.method} ${req.path}`);
    next();
});

app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    logLevel: 'silent'
}));

// Start server
app.listen(PORT, async () => {
    console.log(`Bitrabo Swap API (v101 - Refresh + Confirm Fix) running on port ${PORT}`);
    // Optional: verify ChangeHero
    if (KEYS.CHANGEHERO) {
        try {
            await axios.get(`https://api.changehero.io/v2/exchange-amount`, {
                params: { api_key: KEYS.CHANGEHERO, from: 'btc', to: 'eth', amount: '0.1' },
                timeout: 5000
            });
            console.log("ChangeHero API is reachable");
        } catch (e) {
            console.warn("ChangeHero check failed:", e.message);
        }
    }
});
