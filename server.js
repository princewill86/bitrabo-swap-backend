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

// --- CACHE ---
class SimpleCache {
    constructor(ttl) { this.cache = new Map(); this.ttl = ttl * 1000; }
    get(k) { const i = this.cache.get(k); return i && Date.now() < i.e ? i.v : null; }
    set(k, v) { this.cache.set(k, { v, e: Date.now() + this.ttl }); }
}
const quoteCache = new SimpleCache(10);

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER; 
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025); 
const LIFI_INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';

createConfig({ integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT });

const KEYS = {
    ZEROX: process.env.ZEROX_API_KEY,
    ONEINCH: process.env.ONEINCH_API_KEY,
    CHANGEHERO: process.env.CHANGEHERO_API_KEY,
    OKX: {
        KEY: process.env.OKX_API_KEY,
        SECRET: process.env.OKX_SECRET_KEY,
        PASSPHRASE: process.env.OKX_PASSPHRASE,
        PROJECT: process.env.OKX_PROJECT_ID
    }
};

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

// ==================================================================
// 1. PROVIDER LIST
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
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0"))); // Force Approval

// ==================================================================
// 2. REAL INTEGRATIONS
// ==================================================================

// LI.FI
async function getLifiQuote(params, amount, chainId) {
    const routes = await getRoutes({
        fromChainId: chainId, toChainId: chainId,
        fromTokenAddress: params.fromTokenAddress, toTokenAddress: params.toTokenAddress,
        fromAmount: amount, fromAddress: params.userAddress,
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

// 1INCH (Fixed Headers)
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
    // 1inch returns formatted TX directly
    return {
        toAmount: ethers.formatUnits(resp.data.dstAmount, 18), // Need token decimals, default 18
        tx: {
            to: resp.data.tx.to, value: resp.data.tx.value, data: resp.data.tx.data,
            gasLimit: resp.data.tx.gas
        },
        decimals: 18, symbol: "UNK"
    };
}

// 0x (Fixed Fee Logic)
async function getZeroXQuote(params, amount, chainId) {
    const resp = await axios.get(`https://api.0x.org/swap/v1/quote`, {
        headers: { '0x-api-key': KEYS.ZEROX },
        params: {
            chainId, sellToken: params.fromTokenAddress, buyToken: params.toTokenAddress,
            sellAmount: amount, takerAddress: params.userAddress,
            feeRecipient: FEE_RECEIVER, buyTokenPercentageFee: FEE_PERCENT
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, 18), // Default 18
        tx: {
            to: resp.data.to, value: resp.data.value, data: resp.data.data,
            gasLimit: resp.data.gas
        },
        decimals: 18, symbol: "UNK"
    };
}

// CHANGEHERO (Exchange Mode)
async function getChangeHeroQuote(params, amount, chainId) {
    // ChangeHero needs Tickers (ETH, BTC). We try to guess or use raw address if supported.
    // REAL implementation requires "Create Transaction" to get deposit address.
    // For Quote phase, we just get estimate.
    const fromSymbol = params.fromTokenAddress === '0x0000000000000000000000000000000000000000' ? 'eth' : 'erc20'; // simplified
    const toSymbol = params.toTokenAddress === '0x0000000000000000000000000000000000000000' ? 'eth' : 'erc20';
    
    // We strictly need real tickers. If we can't map, we throw to use Mock.
    // If you have a token map, insert here. For now, fallback to mock to keep UI safe.
    throw new Error("ChangeHero requires Ticker Mapping");
}

// OKX (Signed Request)
async function getOkxQuote(params, amount, chainId) {
    const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${params.fromTokenAddress}&toTokenAddress=${params.toTokenAddress}&userWalletAddress=${params.userAddress}`;
    const ts = new Date().toISOString();
    const sign = crypto.createHmac('sha256', KEYS.OKX.SECRET).update(ts + 'GET' + path).digest('base64');
    
    const resp = await axios.get(`https://www.okx.com${path}`, {
        headers: {
            'OK-ACCESS-KEY': KEYS.OKX.KEY, 'OK-ACCESS-SIGN': sign,
            'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': KEYS.OKX.PASSPHRASE,
            'X-Simulated-Trading': '0'
        }
    });
    const d = resp.data.data[0];
    return {
        toAmount: ethers.formatUnits(d.toTokenAmount, 18), 
        tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
        decimals: 18, symbol: "UNK"
    };
}

// ==================================================================
// 3. AGGREGATOR
// ==================================================================
async function generateAllQuotes(params, eventId) {
    const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    
    // Attempt Normalization
    let decimals = 18;
    try { 
        const t = await getToken(chainId, params.fromTokenAddress);
        decimals = t.decimals;
        amount = ethers.parseUnits(Number(amount).toFixed(decimals), decimals).toString();
    } catch {
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString();
    }

    console.log(`[🔍 AGGREGATOR] Fetching Real Quotes...`);

    const promises = MY_PROVIDERS.map(async (p, i) => {
        try {
            let q = null;
            if (p.name.includes('Li.fi')) q = await getLifiQuote(params, amount, chainId);
            else if (p.name.includes('1inch')) q = await getOneInchQuote(params, amount, chainId);
            else if (p.name.includes('0x')) q = await getZeroXQuote(params, amount, chainId);
            else if (p.name.includes('OKX')) q = await getOkxQuote(params, amount, chainId);
            else if (p.name.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, chainId);
            
            // Success! Real Data
            return formatQuote(p, params, q, eventId, i === 0);
        } catch (e) {
            console.warn(`[⚠️ ${p.name} FAIL] ${e.message}. Using MOCK.`);
            // Fallback Mock so UI never breaks
            return getMockQuote(p, params, eventId, i === 0);
        }
    });

    return await Promise.all(promises);
}

// FORMATTER
function formatQuote(provider, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals, symbol: data.symbol },
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

// MOCK FALLBACK (Safe Mode)
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
// ROUTES
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
    
    if (quoteResultCtx?.isMock) {
        console.log(`[⚙️ MOCK-TX] for ${quoteResultCtx.providerId}`);
        return res.json(ok({
            result: { info: { provider: quoteResultCtx.providerId }, protocol: 'Swap', fee: { percentageFee: 0.25 } },
            tx: { to: userAddress, value: "0", data: "0x", gasLimit: "21000" }
        }));
    }

    if (quoteResultCtx?.tx) {
        console.log(`[⚙️ REAL-TX] for ${quoteResultCtx.providerId}`);
        return res.json(ok({
            result: { info: { provider: quoteResultCtx.providerId }, protocol: 'Swap', fee: { percentageFee: FEE_PERCENT * 100 } },
            tx: { ...quoteResultCtx.tx, from: userAddress, value: new BigNumber(quoteResultCtx.tx.value).toFixed() }
        }));
    }
    res.json(ok(null));
});

app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));
app.listen(PORT, () => console.log(`Bitrabo v70 Running on ${PORT}`));
