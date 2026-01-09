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
// 1. HELPERS
// ==================================================================
function toHexStrict(val) {
    if (!val) return "0x0";
    try {
        if (typeof val === 'string' && val.startsWith('0x')) return val;
        let bn = new BigNumber(val);
        if (bn.isNaN()) return "0x0";
        return "0x" + bn.toString(16);
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
    } catch (e) { return 0.15; }
}

// ⚡ HELPER: Format Token Info EXACTLY like OneKey Golden JSON
function formatTokenInfo(tokenObj, networkId) {
    const isNative = (!tokenObj.address || tokenObj.address === '0x0000000000000000000000000000000000000000');
    return {
        contractAddress: isNative ? "" : tokenObj.address, // ⚡ FORCE EMPTY STRING FOR NATIVE
        networkId: networkId,
        isNative: isNative, // ⚡ EXPLICIT BOOLEAN
        decimals: tokenObj.decimals || 18,
        name: tokenObj.name || "Token",
        symbol: tokenObj.symbol || "UNK",
        logoURI: tokenObj.logoURI || "https://uni.onekey-asset.com/static/logo/default_token.png"
    };
}

// ==================================================================
// 2. HEALTH & STARTUP
// ==================================================================
async function verifyChangeHero() {
    if (!KEYS.CHANGEHERO) return false;
    try {
        await axios.get(`https://api.changehero.io/v2/exchange-amount`, {
            params: { api_key: KEYS.CHANGEHERO, from: 'btc', to: 'eth', amount: '0.1' },
            headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000
        });
        return true;
    } catch (e) { return false; }
}

// ==================================================================
// 3. CORE HANDLERS
// ==================================================================

// QUOTE ENDPOINT
app.get(['/swap/v1/quote/events', '/swap/v1/quote'], async (req, res) => {
    console.log(`⚡ LOCAL QUOTE REQUEST CAUGHT: ${req.url.split('?')[0]}`);
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

// BUILD-TX ENDPOINT
app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    console.log("   📝 /build-tx called by Frontend");
    if (!req.body || !req.body.quoteResultCtx) return res.json(ok(null));

    const { quoteResultCtx, userAddress } = req.body;

    try {
        const valStr = new BigNumber(quoteResultCtx.tx.value).toFixed(0);
        const gasNum = Number(quoteResultCtx.tx.gas || quoteResultCtx.tx.gasLimit || 500000);
        const feeAmount = new BigNumber(quoteResultCtx.toAmount || 0).multipliedBy(FEE_PERCENT).toFixed(6);

        // ⚡ RECOVERY: Use persisted Token Info
        const fromTokenInfo = quoteResultCtx.fromTokenInfo || {};
        const toTokenInfo = quoteResultCtx.toTokenInfo || {};

        const responseData = {
            result: { 
                info: { 
                    provider: quoteResultCtx.providerId,
                    providerName: quoteResultCtx.providerId.replace("Swap", ""),
                    providerLogo: "https://uni.onekey-asset.com/static/logo/OKXDex.png" 
                }, 
                fromTokenInfo, toTokenInfo,
                protocol: 'Swap', kind: 'sell',
                fee: { percentageFee: FEE_PERCENT * 100 }, 
                routesData: quoteResultCtx.routesData || [],
                estimatedTime: 30,
                fromAmount: quoteResultCtx.fromAmount, 
                toAmount: quoteResultCtx.toAmount,
                instantRate: quoteResultCtx.instantRate,
                supportUrl: "https://help.onekey.so/hc/requests/new",
                unSupportReceiveAddressDifferent: false,
                oneKeyFeeExtraInfo: { oneKeyFeeAmount: feeAmount, oneKeyFeeSymbol: fromTokenInfo.symbol || "TOKEN", oneKeyFeeUsd: "0.10" },
                gasLimit: gasNum,
                slippage: 0.5
            },
            ctx: quoteResultCtx, 
            tx: { to: quoteResultCtx.tx.to, value: valStr, data: quoteResultCtx.tx.data },
            orderId: uuidv4()
        };

        console.log("   ✅ /build-tx Success.");
        return res.json(ok(responseData));
    } catch (e) { return res.json(ok(null)); }
});

app.post('/swap/v1/quote/verify', jsonParser, (req, res) => res.json(ok({ result: true })));

// ==================================================================
// 4. PROVIDER INTEGRATIONS
// ==================================================================

async function getZeroXQuote(params, amount, chainId, toDecimals, nativePriceUSD) {
    try {
        const resp = await axios.get(`https://api.0x.org/swap/allowance-holder/quote`, {
            headers: { '0x-api-key': KEYS.ZEROX, '0x-version': 'v2' },
            params: {
                chainId: chainId, sellToken: norm(params.fromTokenAddress), buyToken: norm(params.toTokenAddress),
                sellAmount: amount, taker: params.userAddress || "0x5555555555555555555555555555555555555555",
                swapFeeRecipient: FEE_RECEIVER, swapFeeBps: 25, skipValidation: true 
            }, timeout: TIMEOUT
        });
        const d = resp.data;
        const fiatFee = calculateFiatFee(d.transaction.gas, d.transaction.gasPrice, nativePriceUSD, chainId);
        return {
            toAmount: ethers.formatUnits(d.buyAmount, toDecimals), 
            tx: { to: d.transaction.to, value: d.transaction.value, data: d.transaction.data, gasLimit: d.transaction.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("0x", ""),
            ctx: { zeroxChainId: chainId }, fiatFee
        };
    } catch (e) { return null; }
}

async function getOneInchQuote(params, amount, chainId, toDecimals, nativePriceUSD) {
    try {
        const resp = await axios.get(`https://api.1inch.dev/swap/v5.2/${chainId}/swap`, {
            headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
            params: {
                src: norm(params.fromTokenAddress), dst: norm(params.toTokenAddress),
                amount, from: params.userAddress || "0x5555555555555555555555555555555555555555",
                slippage: 1, fee: 0.25, referrer: FEE_RECEIVER, disableEstimate: true 
            }, timeout: TIMEOUT
        });
        const d = resp.data;
        const dstAmount = d.toTokenAmount || d.dstAmount || d.toAmount;
        if (!dstAmount) throw new Error("No amount");
        const fiatFee = calculateFiatFee(d.tx.gas, d.tx.gasPrice, nativePriceUSD, chainId);
        return {
            toAmount: ethers.formatUnits(dstAmount, toDecimals),
            tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("1inch", ""),
            ctx: { oneInchChainId: 1 }, fiatFee
        };
    } catch (e) { return null; }
}

async function getOkxQuote(params, amount, chainId, toDecimals, nativePriceUSD) {
    try {
        if(!params.userAddress) return null;
        const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${norm(params.fromTokenAddress)}&toTokenAddress=${norm(params.toTokenAddress)}&userWalletAddress=${params.userAddress}&slippage=0.005`;
        const ts = new Date().toISOString();
        const sign = crypto.createHmac('sha256', KEYS.OKX.SECRET).update(ts + 'GET' + path).digest('base64');
        const resp = await axios.get(`https://www.okx.com${path}`, {
            headers: { 'OK-ACCESS-KEY': KEYS.OKX.KEY, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': KEYS.OKX.PASSPHRASE, 'X-Simulated-Trading': '0' }, timeout: TIMEOUT
        });
        if (resp.data.code !== '0' || !resp.data.data[0]) return null;
        const d = resp.data.data[0];
        const outAmount = d.toTokenAmount || d.routerResult?.toTokenAmount;
        const fiatFee = calculateFiatFee(d.tx.gas, d.tx.gasPrice, nativePriceUSD, chainId);
        return {
            toAmount: ethers.formatUnits(outAmount, toDecimals), 
            tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("OKX", ""),
            ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId }, fiatFee
        };
    } catch (e) { return null; }
}

async function getChangeHeroQuote(params, amount, chainId, fromTicker, toTicker, nativePriceUSD, isNative) {
    try {
        if(!fromTicker || !toTicker) return null;
        const readableAmount = ethers.formatUnits(amount, 18);
        const resp = await axios.get(`https://api.changehero.io/v2/exchange-amount`, {
            params: { api_key: KEYS.CHANGEHERO, from: fromTicker.toLowerCase(), to: toTicker.toLowerCase(), amount: readableAmount }, 
            headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: TIMEOUT
        });
        const gasLimit = isNative ? 21000 : 65000;
        const fiatFee = calculateFiatFee(gasLimit, null, nativePriceUSD, chainId);
        return {
            toAmount: String(resp.data.estimated_amount),
            tx: { to: "0xChangeHeroDepositAddr", value: amount, data: "0x", gasLimit: 21000 }, 
            decimals: 18, symbol: toTicker.toUpperCase(), routesData: [{ subRoutes: [[{ name: "ChangeHero", percent: "100", logo: "https://uni.onekey-asset.com/static/logo/changeHeroFixed.png" }]] }],
            ctx: { isChangeHero: true }, fiatFee
        };
    } catch (e) { return null; }
}

async function getLifiQuote(params, amount, fromChain, toChain) {
    try {
        const routesPromise = getRoutes({
            fromChainId: fromChain, toChainId: toChain,
            fromTokenAddress: params.fromTokenAddress || '0x0000000000000000000000000000000000000000', 
            toTokenAddress: params.toTokenAddress || '0x0000000000000000000000000000000000000000',
            fromAmount: amount, fromAddress: params.userAddress || "0x5555555555555555555555555555555555555555", 
            options: { integrator: LIFI_INTEGRATOR, fee: 0.0025, referrer: FEE_RECEIVER }
        });
        const routes = await Promise.race([routesPromise, new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), TIMEOUT))]);
        if (!routes.routes?.length) return null;
        const route = routes.routes[0];
        const step = route.steps[0];
        const tx = await getStepTransaction(step);
        const richCtx = { lifiQuoteResultCtx: { stepInfo: step, estimate: step.estimate, includedSteps: route.steps }, lifiToNetworkId: params.toNetworkId };
        const fiatFee = step.estimate?.feeCosts?.[0]?.amountUSD || 0.1;
        const gasCostUSD = step.estimate?.gasCosts?.[0]?.amountUSD || 0.1;
        return {
            toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
            tx, decimals: route.toToken.decimals, symbol: route.toToken.symbol,
            routesData: [], ctx: richCtx, fiatFee: parseFloat(fiatFee) + parseFloat(gasCostUSD)
        };
    } catch (e) { return null; }
}

// ==================================================================
// 5. GENERATOR LOGIC
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

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
    const list = PROVIDERS_CONFIG.map(p => ({
        providerInfo: { provider: p.id, name: p.name, logo: p.logo, protocol: "Swap" },
        isSupportSingleSwap: true, isSupportCrossChain: true,
        supportSingleSwapNetworks: SUPPORTED_NETWORKS, supportCrossChainNetworks: SUPPORTED_NETWORKS,
        providerServiceDisable: false, serviceDisableNetworks: []
    }));
    res.json(ok(list));
});

app.get(['/swap/v1/check-support', '/check-support'], (req, res) => res.json(ok([{ status: 'available', networkId: req.query.networkId }])));
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("99999999999999999999999999999999")));

async function generateAllQuotes(params, eventId) {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    let toDecimals = 18;
    let fromSymbol = "ETH";
    let toSymbol = "USDT";
    let nativePriceUSD = 0;
    
    // ⚡ PREPARE TOKEN INFO (STRICT FORMATTING)
    // 1. Get raw info
    let fromT, toT, nativeToken;
    try { 
        fromT = await getToken(fromChain, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        toT = await getToken(toChain, params.toTokenAddress || '0x0000000000000000000000000000000000000000');
        nativeToken = await getToken(fromChain, '0x0000000000000000000000000000000000000000');
        
        amount = ethers.parseUnits(Number(amount).toFixed(fromT.decimals), fromT.decimals).toString();
        toDecimals = toT.decimals || 18;
        fromSymbol = fromT.symbol;
        toSymbol = toT.symbol;
        nativePriceUSD = parseFloat(nativeToken.priceUSD || 0);

    } catch (e) { 
        // Fallback for safety
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString(); 
        fromT = { address: params.fromTokenAddress, decimals: 18, symbol: 'ETH' };
        toT = { address: params.toTokenAddress, decimals: 18, symbol: 'UNK' };
    }

    // 2. Format Info using Helper (Fixes the "Empty Address" vs "0x000" issue)
    const fromTokenInfo = formatTokenInfo(fromT, params.fromNetworkId);
    const toTokenInfo = formatTokenInfo(toT, params.toNetworkId);

    console.log(`[🔍 AGGREGATOR] Fetching (Native Price: $${nativePriceUSD})...`);
    const isNative = fromTokenInfo.isNative;

    // 3. Enrich Params
    const enrichedParams = { ...params, fromTokenInfo, toTokenInfo };

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
        console.log(`   ✅ ${p.name} Success ($${q.fiatFee})`);
        return formatQuote(p, enrichedParams, q, eventId, i === 0);
    });

    const results = await Promise.all(promises);
    return results.filter(r => r !== null);
}

function formatQuote(providerConf, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
    return {
        info: { provider: providerConf.id, providerName: providerConf.name, providerLogo: providerConf.logo },
        fromTokenInfo: params.fromTokenInfo, // ⚡ STRICT INFO
        toTokenInfo: params.toTokenInfo,     // ⚡ STRICT INFO
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: data.fiatFee || 0.1, protocolFees: 0 },
        routesData: data.routesData,
        quoteResultCtx: { 
            tx: data.tx, 
            providerId: providerConf.id, 
            fromTokenInfo: params.fromTokenInfo,
            toTokenInfo: params.toTokenInfo,
            fromAmount: params.fromTokenAmount,
            toAmount: data.toAmount,
            instantRate: rate,
            isMock: false, 
            ...data.ctx 
        },
        allowanceResult: null, unSupportReceiveAddressDifferent: false,
        gasLimit: Number(data.tx?.gasLimit || 500000),
        quoteId: uuidv4(), eventId, isBest
    };
}

// ==================================================================
// 6. FALLBACK PROXY
// ==================================================================
app.use('/swap/v1', (req, res, next) => {
    console.log(`⚠️ Proxying to OneKey: ${req.path}`);
    next();
});
app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));

app.listen(PORT, async () => {
    console.log(`Bitrabo v106 (Strict Token Formatting) Running on ${PORT}`);
    const isChangeHeroAlive = await verifyChangeHero();
    if (!isChangeHeroAlive) PROVIDERS_CONFIG = PROVIDERS_CONFIG.filter(p => p.id !== 'SwapChangeHero');
});
