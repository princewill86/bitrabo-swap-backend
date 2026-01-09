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
createConfig({ integrator: LIFI_INTEGRATOR });

const KEYS = {
    ZEROX: process.env.ZEROX_API_KEY,
    ONEINCH: process.env.ONEINCH_API_KEY,
    OKX: {
        KEY: process.env.OKX_API_KEY,
        SECRET: process.env.OKX_SECRET_KEY,
        PASSPHRASE: process.env.OKX_PASSPHRASE
    }
};

app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });

// Health check to force logs on Render
app.get('/health', (req, res) => {
    const now = new Date().toISOString();
    console.log(`[HEALTH] Ping at ${now}`);
    res.json({ status: 'ok', time: now });
});

// ==================================================================
// HELPERS
// ==================================================================
function getZeroXBaseUrl(chainId) {
    const map = { 1: 'https://api.0x.org', 56: 'https://bsc.api.0x.org', 137: 'https://polygon.api.0x.org', 10: 'https://optimism.api.0x.org', 42161: 'https://arbitrum.api.0x.org', 43114: 'https://avalanche.api.0x.org', 250: 'https://fantom.api.0x.org', 8453: 'https://base.api.0x.org' };
    return map[chainId] || 'https://api.0x.org';
}

function toHex(val) {
    if (!val || val === '0') return "0x0";
    if (typeof val === 'string' && val.startsWith('0x')) return val;
    return "0x" + BigInt(val).toString(16);
}

const NATIVE_ADDR = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const LIFI_NATIVE = '0x0000000000000000000000000000000000000000';

// ==================================================================
// REAL INTEGRATIONS (Updated to current 2026 APIs)
// ==================================================================
async function getLifiQuote(params, amount, chainId, fromToken, toToken) {
    const fromAddr = params.userAddress || "0x5555555555555555555555555555555555555555";
    const routes = await getRoutes({
        fromChainId: chainId, toChainId: chainId,
        fromTokenAddress: fromToken.address,
        toTokenAddress: toToken.address,
        fromAmount: amount, fromAddress: fromAddr,
        options: { integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT, referrer: FEE_RECEIVER }
    });
    if (!routes.routes?.length) throw new Error("No LiFi Routes");
    const route = routes.routes[0];
    const step = route.steps[0];
    const tx = await getStepTransaction(step);

    let protocolFees = 0;
    let estimatedFeeFiatValue = 0;
    if (step.estimate.feeCosts?.length) protocolFees = step.estimate.feeCosts.reduce((s, f) => s + parseFloat(f.amountUSD || 0), 0);
    if (step.estimate.gasCosts?.length) estimatedFeeFiatValue = step.estimate.gasCosts.reduce((s, g) => s + parseFloat(g.amountUSD || 0), 0);

    return {
        toAmount: ethers.formatUnits(route.toAmount, toToken.decimals),
        tx,
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [],
        protocolFees,
        estimatedFeeFiatValue,
        ctx: { lifiToNetworkId: params.toNetworkId }
    };
}

async function getZeroXQuote(params, amount, chainId, fromToken, toToken) {
    if (!KEYS.ZEROX) throw new Error("Missing 0x key");
    const baseUrl = getZeroXBaseUrl(chainId);
    const sellToken = fromToken.address === LIFI_NATIVE ? NATIVE_ADDR : fromToken.address;
    const buyToken = toToken.address === LIFI_NATIVE ? NATIVE_ADDR : toToken.address;

    const resp = await axios.get(`${baseUrl}/swap/allowance-holder/quote`, {
        headers: { '0x-api-key': KEYS.ZEROX, '0x-version': 'v2' },
        params: {
            sellToken, buyToken, sellAmount: amount,
            takerAddress: params.userAddress,
            feeRecipient: FEE_RECEIVER,
            buyTokenPercentageFee: FEE_PERCENT * 10000  // try 25 for 0.25%, adjust if needed
        }
    });

    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, toToken.decimals),
        tx: { to: resp.data.to, value: resp.data.value || "0", data: resp.data.data, gasLimit: resp.data.gas },
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [],
        ctx: { zeroxChainId: chainId }
    };
}

async function getOneInchQuote(params, amount, chainId, fromToken, toToken) {
    if (!KEYS.ONEINCH) throw new Error("Missing 1inch key");
    const src = fromToken.address === LIFI_NATIVE ? NATIVE_ADDR : fromToken.address;
    const dst = toToken.address === LIFI_NATIVE ? NATIVE_ADDR : toToken.address;

    const resp = await axios.get(`https://api.1inch.dev/swap/v6.0/${chainId}/swap`, {
        headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
        params: {
            src, dst, amount,
            from: params.userAddress,
            slippage: 50,
            referrerAddress: FEE_RECEIVER,
            fee: FEE_PERCENT
        }
    });

    return {
        toAmount: ethers.formatUnits(resp.data.toAmount || resp.data.dstAmount, toToken.decimals),
        tx: resp.data.tx,
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [{ subRoutes: [[{ name: "1inch", percent: "100", logo: "https://uni.onekey-asset.com/static/logo/1inch.png" }]] }],
        ctx: { oneInchChainId: chainId }
    };
}

async function getOkxQuote(params, amount, chainId, fromToken, toToken) {
    if (!params.userAddress || !KEYS.OKX.KEY) throw new Error("Missing OKX");
    const fromAddr = fromToken.address === LIFI_NATIVE ? NATIVE_ADDR : fromToken.address;
    const toAddr = toToken.address === LIFI_NATIVE ? NATIVE_ADDR : toToken.address;

    const path = `/api/v6/dex/aggregator/swap?chainIndex=${chainId}&fromTokenAddress=${fromAddr}&toTokenAddress=${toAddr}&amount=${amount}&userWalletAddress=${params.userAddress}&slippagePercent=0.5`;
    const ts = new Date().toISOString();
    const sign = crypto.createHmac('sha256', KEYS.OKX.SECRET).update(ts + 'GET' + path).digest('base64');

    const resp = await axios.get(`https://web3.okx.com${path}`, {
        headers: {
            'OK-ACCESS-KEY': KEYS.OKX.KEY,
            'OK-ACCESS-SIGN': sign,
            'OK-ACCESS-TIMESTAMP': ts,
            'OK-ACCESS-PASSPHRASE': KEYS.OKX.PASSPHRASE
        }
    });

    if (resp.data.code !== '0') throw new Error(`OKX: ${resp.data.msg}`);
    const d = resp.data.data[0];
    if (!d?.tx) throw new Error("Incomplete OKX");

    return {
        toAmount: ethers.formatUnits(d.toTokenAmount || d.toAmount, toToken.decimals),
        tx: { to: d.tx.to, value: d.tx.value || "0", data: d.tx.data, gasLimit: d.tx.gas || d.gasLimit },
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [{ subRoutes: d.routerResult?.dexRouterList || [[{ name: "OKX Dex", percent: "100" }]] }],
        ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId }
    };
}

// ==================================================================
// AGGREGATOR
// ==================================================================
const MY_PROVIDERS = [
    { provider: 'SwapLifi', name: 'Li.fi (Bitrabo)', logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png', priority: 100 },
    { provider: 'SwapOKX', name: 'OKX Dex', logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png', priority: 90 },
    { provider: 'Swap1inch', name: '1inch', logoURI: 'https://common.onekey-asset.com/logo/1Inch.png', priority: 80 },
    { provider: 'Swap0x', name: '0x', logoURI: 'https://uni.onekey-asset.com/static/logo/0xlogo.png', priority: 70 },
    { provider: 'SwapCow', name: 'Cow Swap', logoURI: 'https://uni.onekey-asset.com/static/logo/CowSwapLogo.png', priority: 60 }
    // Add more if you implement them
];

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => res.json(ok(MY_PROVIDERS.map(p => ({ ...p, status: 'available', protocols: ['swap'] })))));

async function generateAllQuotes(params, eventId) {
    const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
    const fromAddr = params.fromTokenAddress || LIFI_NATIVE;
    const toAddr = params.toTokenAddress || LIFI_NATIVE;
    const fromToken = await getToken(chainId, fromAddr);
    const toToken = await getToken(chainId, toAddr);
    const amount = ethers.parseUnits(params.fromTokenAmount, fromToken.decimals).toString();

    console.log(`[AGG] Quote for ${params.fromTokenAmount} on chain ${chainId}`);

    const promises = MY_PROVIDERS.map(async (p, i) => {
        try {
            let q;
            if (p.provider === 'SwapLifi') q = await getLifiQuote(params, amount, chainId, fromToken, toToken);
            else if (p.provider === 'SwapOKX') q = await getOkxQuote(params, amount, chainId, fromToken, toToken);
            else if (p.provider === 'Swap1inch') q = await getOneInchQuote(params, amount, chainId, fromToken, toToken);
            else if (p.provider === 'Swap0x') q = await getZeroXQuote(params, amount, chainId, fromToken, toToken);
            else throw new Error("Mock");
            return formatQuote(p, params, q, eventId, i === 0, fromToken, toToken);
        } catch (e) {
            console.log(`[ERR] ${p.name}: ${e.message}`);
            return getMockQuote(p, params, eventId, i === 0, fromToken, toToken);
        }
    });
    return Promise.all(promises);
}

function formatQuote(provider, params, data, eventId, isBest, fromToken, toToken) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toString();
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, isNative: !params.fromTokenAddress, decimals: fromToken.decimals, name: fromToken.name, symbol: fromToken.symbol, logoURI: fromToken.logoURI || `https://uni.onekey-asset.com/server-service-indexer/${params.fromNetworkId}/tokens/address-${params.fromTokenAddress || ''}.png` },
        toTokenInfo: { contractAddress: params.toTokenAddress || "", networkId: params.toNetworkId, isNative: !params.toTokenAddress, decimals: toToken.decimals, name: toToken.name, symbol: toToken.symbol, logoURI: toToken.logoURI || `https://uni.onekey-asset.com/server-service-indexer/${params.toNetworkId}/tokens/address-${params.toTokenAddress || ''}.png` },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: data.routesData,
        quoteResultCtx: { tx: data.tx, providerId: provider.provider, isMock: false, ...data.ctx, fromAmount: params.fromTokenAmount, fromSymbol: fromToken.symbol, toAmount: data.toAmount, protocolFees: data.protocolFees || 0 },
        gasLimit: Number(data.tx?.gasLimit || data.tx?.gas || 500000),
        quoteId: uuidv4(), eventId, isBest
    };
}

function getMockQuote(provider, params, eventId, isBest, fromToken, toToken) {
    const toAmount = new BigNumber(params.fromTokenAmount).multipliedBy(3100).toFixed(toToken.decimals); // mock rate
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, isNative: !params.fromTokenAddress, decimals: fromToken.decimals, name: fromToken.name, symbol: fromToken.symbol },
        toTokenInfo: { contractAddress: params.toTokenAddress || "", networkId: params.toNetworkId, isNative: !params.toTokenAddress, decimals: toToken.decimals, name: toToken.name, symbol: toToken.symbol },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount,
        instantRate: "3100", estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { isMock: true, providerId: provider.provider },
        gasLimit: 210000,
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
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId })}\n\n`);
        for (const q of quotes) res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`);
        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) {
        console.log('[ERR] Quote events:', e.message);
        res.write(`data: {"type":"error"}\n\n`);
    }
    res.end();
});

app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
    if (!quoteResultCtx?.tx) return res.json(ok(null));

    console.log(`[BUILD] ${quoteResultCtx.providerId} mock:${quoteResultCtx.isMock}`);

    const isLifi = quoteResultCtx.providerId === 'SwapLifi';
    const isZerox = quoteResultCtx.providerId === 'Swap0x';
    const val = isLifi ? toHex(quoteResultCtx.tx.value) : quoteResultCtx.tx.value || "0";

    const feeAmount = new BigNumber(FEE_PERCENT).multipliedBy(quoteResultCtx.fromAmount || 0).toFixed(6);
    const fee = { percentageFee: FEE_PERCENT * 100 };
    if (isLifi) Object.assign(fee, { protocolFees: quoteResultCtx.protocolFees || 0 });

    const response = {
        result: {
            info: { provider: quoteResultCtx.providerId },
            protocol: 'Swap',
            fee,
            gasLimit: Number(quoteResultCtx.tx.gasLimit || quoteResultCtx.tx.gas || 500000),
            routesData: [],
            estimatedTime: 30,
            fromAmount: quoteResultCtx.fromAmount,
            toAmount: quoteResultCtx.toAmount,
            instantRate: new BigNumber(quoteResultCtx.toAmount).div(quoteResultCtx.fromAmount).toString(),
            supportUrl: "https://help.onekey.so/hc/requests/new",
            unSupportReceiveAddressDifferent: isZerox,
            oneKeyFeeExtraInfo: { oneKeyFeeAmount: feeAmount, oneKeyFeeSymbol: quoteResultCtx.fromSymbol || "ETH", oneKeyFeeUsd: feeAmount },
            slippage: 0.5
        },
        ctx: quoteResultCtx,
        tx: { ...quoteResultCtx.tx, from: userAddress, value: val },
        orderId: uuidv4()
    };

    if (isLifi) response.socketBridgeScanUrl = "https://scan.li.fi/tx/";

    res.json(ok(response));
});

app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));

app.listen(PORT, () => console.log(`Bitrabo v100 - Fixed & Logging | Port ${PORT}`));
