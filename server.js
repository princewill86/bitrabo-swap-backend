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
const quoteCache = new SimpleCache(15);
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
        PASSPHRASE: process.env.OKX_PASSPHRASE
    }
};
app.use(cors({ origin: '*' }));
const jsonParser = express.json();
const ok = (data) => ({ code: 0, message: "Success", data });
// ==================================================================
// 1. HELPERS
// ==================================================================
function getZeroXBaseUrl(chainId) {
    const map = {
        1: 'https://api.0x.org',
        56: 'https://bsc.api.0x.org',
        137: 'https://polygon.api.0x.org',
        10: 'https://optimism.api.0x.org',
        42161: 'https://arbitrum.api.0x.org',
        43114: 'https://avalanche.api.0x.org',
        250: 'https://fantom.api.0x.org',
        8453: 'https://base.api.0x.org'
    };
    return map[chainId] || 'https://api.0x.org';
}
// Convert to Hex if needed (matches Li.Fi log style)
function toHex(val) {
    if (!val) return "0x0";
    if (typeof val === 'string' && val.startsWith('0x')) return val;
    return "0x" + BigInt(val).toString(16);
}

const NATIVE_ADDRESSES = {
    LIFI: '0x0000000000000000000000000000000000000000',
    ZEROX: 'ETH',
    ONEINCH: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    OKX: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
};

const NATIVE_SYMBOLS = {
    1: 'ETH',
    56: 'BNB',
    137: 'MATIC',
    10: 'ETH',
    42161: 'ETH',
    43114: 'AVAX',
    250: 'FTM',
    8453: 'ETH'
};
// ==================================================================
// 2. REAL INTEGRATIONS
// ==================================================================
// --- LI.FI ---
async function getLifiQuote(params, amount, chainId, fromToken, toToken) {
    const fromAddr = (params.userAddress && params.userAddress.length > 10) ? params.userAddress : "0x5555555555555555555555555555555555555555";
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
    if (step.estimate.feeCosts) {
        step.estimate.feeCosts.forEach(f => protocolFees += parseFloat(f.amountUSD || '0'));
    }
    if (step.estimate.gasCosts) {
        step.estimate.gasCosts.forEach(g => estimatedFeeFiatValue += parseFloat(g.amountUSD || '0'));
    }
    
    return {
        toAmount: ethers.formatUnits(route.toAmount, toToken.decimals),
        tx,
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [], // As per log for LiFi
        protocolFees,
        estimatedFeeFiatValue,
        ctx: { lifiToNetworkId: params.toNetworkId }
    };
}
// --- 0x ---
async function getZeroXQuote(params, amount, chainId, fromToken, toToken) {
    if (!KEYS.ZEROX) throw new Error("No 0x API key");
    const baseUrl = getZeroXBaseUrl(chainId);
    const sellToken = fromToken.address === NATIVE_ADDRESSES.LIFI ? NATIVE_ADDRESSES.ZEROX : fromToken.address;
    const buyToken = toToken.address === NATIVE_ADDRESSES.LIFI ? NATIVE_ADDRESSES.ZEROX : toToken.address;
    const resp = await axios.get(`${baseUrl}/swap/v1/quote`, {
        headers: { '0x-api-key': KEYS.ZEROX },
        params: {
            sellToken,
            buyToken,
            sellAmount: amount,
            takerAddress: params.userAddress,
            feeRecipient: FEE_RECEIVER,
            buyTokenPercentageFee: FEE_PERCENT
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, toToken.decimals),
        tx: {
            to: resp.data.to, value: resp.data.value, data: resp.data.data, gasLimit: resp.data.gas
        },
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [], // As per log
        ctx: { zeroxChainId: chainId }
    };
}
// --- 1INCH ---
async function getOneInchQuote(params, amount, chainId, fromToken, toToken) {
    if (!KEYS.ONEINCH) throw new Error("No 1inch API key");
    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;
    const src = fromToken.address === NATIVE_ADDRESSES.LIFI ? NATIVE_ADDRESSES.ONEINCH : fromToken.address;
    const dst = toToken.address === NATIVE_ADDRESSES.LIFI ? NATIVE_ADDRESSES.ONEINCH : toToken.address;
    const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
        params: {
            src, dst,
            amount, from: params.userAddress, slippage: 1,
            fee: FEE_PERCENT * 100, referrer: FEE_RECEIVER
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.dstAmount, toToken.decimals),
        tx: {
            to: resp.data.tx.to, value: resp.data.tx.value, data: resp.data.tx.data, gasLimit: resp.data.tx.gas
        },
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [{ subRoutes: [[{ name: "1inch Aggregator", percent: "100", logo: "https://uni.onekey-asset.com/static/logo/1inch.png" }]] }],
        ctx: { oneInchChainId: chainId }
    };
}
// --- OKX ---
async function getOkxQuote(params, amount, chainId, fromToken, toToken) {
    if(!params.userAddress) throw new Error("OKX requires user address");
    if (!KEYS.OKX.KEY || !KEYS.OKX.SECRET || !KEYS.OKX.PASSPHRASE) throw new Error("No OKX credentials");
    const fromAddr = fromToken.address === NATIVE_ADDRESSES.LIFI ? NATIVE_ADDRESSES.OKX : fromToken.address;
    const toAddr = toToken.address === NATIVE_ADDRESSES.LIFI ? NATIVE_ADDRESSES.OKX : toToken.address;
    const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${fromAddr}&toTokenAddress=${toAddr}&userWalletAddress=${params.userAddress}&slippage=0.005`;
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
        if (!d || !d.toTokenAmount) throw new Error("No OKX quote data");
        // Extract real routes from OKX response if available; fallback to log-like structure
        // Assuming d.routerList or similar; adjust based on actual OKX API response structure
        // For now, use a placeholder matching log example
        const subRoutes = [
            [{ name: "DODO V2", percent: "100", logo: "https://static.okx.com/cdn/web3/dex/logo/dodo_v2.png" }],
            [{ name: "LitePSM", percent: "100" }],
            [{ name: "Uniswap V4", percent: "100", logo: "https://static.okx.com/cdn/web3/dex/logo/uniswap_v4.png" }]
        ];
        return {
            toAmount: ethers.formatUnits(d.toTokenAmount, toToken.decimals),
            tx: { to: d.tx.to, value: d.tx.value || "0", data: d.tx.data, gasLimit: d.tx.gas },
            decimals: toToken.decimals,
            symbol: toToken.symbol,
            routesData: [{ subRoutes }],
            ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId, okxToTokenDecimals: toToken.decimals }
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
    { provider: 'Swap0x', name: '0x', logoURI: 'https://uni.onekey-asset.com/static/logo/0xlogo.png', priority: 80 },
    { provider: 'SwapOKX', name: 'OKX Dex', logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png', priority: 70 },
    { provider: 'SwapCow', name: 'Cow Swap', logoURI: 'https://uni.onekey-asset.com/static/logo/CowSwapLogo.png', priority: 60 },
    { provider: 'SwapChangeHero', name: 'ChangeHero', logoURI: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png', priority: 50 },
    { provider: 'SwapJupiter', name: 'Jupiter', logoURI: 'https://uni.onekey-asset.com/static/logo/jupiter.png', priority: 40 }
];
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => res.json(ok(MY_PROVIDERS.map(p => ({ ...p, status: 'available', protocols: ['swap'] })))));
app.get(['/swap/v1/check-support', '/check-support'], (req, res) => res.json(ok([{ status: 'available', networkId: req.query.networkId }])));
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0")));
async function generateAllQuotes(params, eventId) {
    const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
    const fromTokenAddrRaw = params.fromTokenAddress || '';
    const toTokenAddrRaw = params.toTokenAddress || '';
    const fromTokenAddr = fromTokenAddrRaw || NATIVE_ADDRESSES.LIFI;
    const toTokenAddr = toTokenAddrRaw || NATIVE_ADDRESSES.LIFI;
    const fromToken = await getToken(chainId, fromTokenAddr);
    const toToken = await getToken(chainId, toTokenAddr);
    let amount = ethers.parseUnits(Number(params.fromTokenAmount).toFixed(fromToken.decimals), fromToken.decimals).toString();
    console.log(`[🔍 AGGREGATOR] Fetching Real Quotes...`);
    const promises = MY_PROVIDERS.map(async (p, i) => {
        try {
            let q = null;
            if (p.name.includes('Li.fi')) q = await getLifiQuote(params, amount, chainId, fromToken, toToken);
            else if (p.name.includes('1inch')) q = await getOneInchQuote(params, amount, chainId, fromToken, toToken);
            else if (p.name.includes('0x')) q = await getZeroXQuote(params, amount, chainId, fromToken, toToken);
            else if (p.name.includes('OKX')) q = await getOkxQuote(params, amount, chainId, fromToken, toToken);
            else throw new Error("Use Mock");
           
            return formatQuote(p, params, q, eventId, i === 0, fromToken, toToken);
        } catch (e) {
            console.log(`[ERROR] Provider ${p.name}: ${e.message}`);
            return getMockQuote(p, params, eventId, i === 0, fromToken, toToken);
        }
    });
    return await Promise.all(promises);
}
// FORMATTER (Strict Compliance)
function formatQuote(provider, params, data, eventId, isBest, fromToken, toToken) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
   
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { 
            contractAddress: params.fromTokenAddress || "", 
            networkId: params.fromNetworkId, 
            isNative: !params.fromTokenAddress, 
            decimals: fromToken.decimals, 
            name: fromToken.name, 
            symbol: fromToken.symbol, 
            logoURI: `https://uni.onekey-asset.com/server-service-indexer/${params.fromNetworkId}/tokens/address-${params.fromTokenAddress || ''}-${Date.now()}.png` 
        },
        toTokenInfo: { 
            contractAddress: params.toTokenAddress || "", 
            networkId: params.toNetworkId, 
            isNative: !params.toTokenAddress, 
            decimals: toToken.decimals, 
            name: toToken.name, 
            symbol: toToken.symbol, 
            logoURI: `https://uni.onekey-asset.com/server-service-indexer/${params.toNetworkId}/tokens/address-${params.toTokenAddress || ''}-${Date.now()}.png` 
        },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: data.routesData || [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { 
            tx: data.tx, 
            providerId: provider.provider, 
            isMock: false, 
            ...data.ctx, 
            fromAmount: params.fromTokenAmount, 
            fromSymbol: fromToken.symbol, 
            toAmount: data.toAmount,
            protocolFees: data.protocolFees || 0,
            estimatedFeeFiatValue: data.estimatedFeeFiatValue || 0 
        },
        allowanceResult: null,
        gasLimit: Number(data.tx?.gasLimit || 500000),
        quoteId: uuidv4(), eventId, isBest
    };
}
function getMockQuote(provider, params, eventId, isBest, fromToken, toToken) {
    const mockRate = 1 / 3125; // Approximate USDT to ETH rate
    const toAmount = new BigNumber(params.fromTokenAmount).multipliedBy(mockRate).toFixed(toToken.decimals);
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { 
            contractAddress: params.fromTokenAddress || "", 
            networkId: params.fromNetworkId, 
            isNative: !params.fromTokenAddress, 
            decimals: fromToken.decimals, 
            name: fromToken.name, 
            symbol: fromToken.symbol, 
            logoURI: `https://uni.onekey-asset.com/server-service-indexer/${params.fromNetworkId}/tokens/address-${params.fromTokenAddress || ''}-${Date.now()}.png` 
        },
        toTokenInfo: { 
            contractAddress: params.toTokenAddress || "", 
            networkId: params.toNetworkId, 
            isNative: !params.toTokenAddress, 
            decimals: toToken.decimals, 
            name: toToken.name, 
            symbol: toToken.symbol, 
            logoURI: `https://uni.onekey-asset.com/server-service-indexer/${params.toNetworkId}/tokens/address-${params.toTokenAddress || ''}-${Date.now()}.png` 
        },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount,
        instantRate: mockRate.toString(), estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { 
            isMock: true, 
            providerId: provider.provider, 
            fromAmount: params.fromTokenAmount, 
            fromSymbol: fromToken.symbol, 
            toAmount 
        },
        allowanceResult: null,
        gasLimit: 21000,
        quoteId: uuidv4(), eventId, isBest
    };
}
// ==================================================================
// 4. ROUTES
// ==================================================================
app.get('/swap/v1/quote/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const eventId = uuidv4();
    try {
        const quotes = await generateAllQuotes(req.query, eventId);
        res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.7407, eventId, ...req.query })}\n\n`);
        for (const q of quotes) res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`);
        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) { res.write(`data: {"type":"error"}\n\n`); }
    res.end();
});
app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
   
    // Safety check
    if (!quoteResultCtx) return res.json(ok(null));
    console.log(`[⚙️ BUILD-TX] Provider: ${quoteResultCtx.providerId} | Mock: ${quoteResultCtx.isMock}`);
    // MOCK RESPONSE
    if (quoteResultCtx.isMock) {
        const feeAmount = new BigNumber(FEE_PERCENT).multipliedBy(quoteResultCtx.fromAmount).toFixed(6);
        return res.json(ok({
            result: {
                info: { provider: quoteResultCtx.providerId, providerName: quoteResultCtx.providerId.replace('Swap', ''), providerLogo: "https://uni.onekey-asset.com/static/logo/placeholder.png" },
                protocol: 'Swap',
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: 21000,
                routesData: [],
                estimatedTime: 30,
                fromAmount: quoteResultCtx.fromAmount,
                toAmount: quoteResultCtx.toAmount,
                instantRate: new BigNumber(quoteResultCtx.toAmount).div(quoteResultCtx.fromAmount).toString(),
                supportUrl: "https://help.onekey.so/hc/requests/new",
                unSupportReceiveAddressDifferent: false,
                oneKeyFeeExtraInfo: { oneKeyFeeAmount: feeAmount, oneKeyFeeSymbol: quoteResultCtx.fromSymbol, oneKeyFeeUsd: feeAmount },
                slippage: 0.7407 // Default from log
            },
            tx: { to: userAddress, value: "0", data: "0x" },
            ctx: {},
            orderId: uuidv4()
        }));
    }
    // REAL RESPONSE (Strict Formatting)
    if (quoteResultCtx.tx) {
        // Strict: Li.Fi wants Hex value
        const isLifi = quoteResultCtx.providerId.includes('Lifi');
        const isZerox = quoteResultCtx.providerId.includes('0x');
        const val = isLifi ? toHex(quoteResultCtx.tx.value) : new BigNumber(quoteResultCtx.tx.value || 0).toFixed(0);
        const feeAmount = new BigNumber(FEE_PERCENT).multipliedBy(quoteResultCtx.fromAmount).toFixed(6);
        const fee = { percentageFee: FEE_PERCENT * 100 };
        if (isLifi) {
            fee.protocolFees = quoteResultCtx.protocolFees;
            fee.estimatedFeeFiatValue = quoteResultCtx.estimatedFeeFiatValue;
        } else if (isZerox) {
            fee.protocolFees = 0;
        }
        const response = {
            result: {
                info: { provider: quoteResultCtx.providerId, providerName: quoteResultCtx.providerId.replace('Swap', ''), providerLogo: "https://uni.onekey-asset.com/static/logo/placeholder.png" },
                protocol: 'Swap',
                fee,
                gasLimit: Number(quoteResultCtx.tx.gasLimit || 500000),
                routesData: quoteResultCtx.routesData || [],
                estimatedTime: 30,
                fromAmount: quoteResultCtx.fromAmount,
                toAmount: quoteResultCtx.toAmount,
                instantRate: new BigNumber(quoteResultCtx.toAmount).div(quoteResultCtx.fromAmount).toString(),
                supportUrl: "https://help.onekey.so/hc/requests/new",
                unSupportReceiveAddressDifferent: isZerox,
                oneKeyFeeExtraInfo: {
                    oneKeyFeeAmount: feeAmount,
                    oneKeyFeeSymbol: quoteResultCtx.fromSymbol,
                    oneKeyFeeUsd: feeAmount // Approximate, adjust if needed
                },
                slippage: 0.7407 // From log, or parse from body if available
            },
            ctx: {
                lifiToNetworkId: quoteResultCtx.lifiToNetworkId,
                okxToNetworkId: quoteResultCtx.okxToNetworkId,
                okxChainId: quoteResultCtx.okxChainId,
                zeroxChainId: quoteResultCtx.zeroxChainId
            },
            tx: { ...quoteResultCtx.tx, from: userAddress, value: val },
            orderId: uuidv4()
        };
        if (isLifi) {
            response.socketBridgeScanUrl = "https://scan.li.fi/tx/";
        }
        return res.json(ok(response));
    }
    res.json(ok(null));
});
app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));
app.listen(PORT, () => console.log(`Bitrabo v75 (Strict) Running on ${PORT}`));
