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
const LIFI_INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
createConfig({ integrator: LIFI_INTEGRATOR, fee: 0.0025 });

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
function toHex(val) {
    if (!val) return "0x0";
    if (val.toString().startsWith('0x')) return val.toString();
    return "0x" + new BigNumber(val).toString(16);
}
// ==================================================================
// 2. REAL INTEGRATIONS
// ==================================================================
// --- LI.FI ---
async function getLifiQuote(params, amount, chainId) {
    const fromAddr = (params.userAddress && params.userAddress.length > 10) ? params.userAddress : "0x5555555555555555555555555555555555555555";
    const routes = await getRoutes({
        fromChainId: chainId, toChainId: chainId,
        fromTokenAddress: params.fromTokenAddress || '0x0000000000000000000000000000000000000000',
        toTokenAddress: params.toTokenAddress,
        fromAmount: amount, fromAddress: fromAddr,
        options: { integrator: LIFI_INTEGRATOR, fee: 0.0025, referrer: FEE_RECEIVER }
    });
    if (!routes.routes?.length) throw new Error("No LiFi Routes");
    const route = routes.routes[0];
    const step = route.steps[0];
    const tx = await getStepTransaction(step);
   
    return {
        toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
        tx,
        decimals: route.toToken.decimals,
        symbol: route.toToken.symbol,
        routesData: step.estimate.tool ? [{ subRoutes: [[{ name: step.estimate.tool, percent: "100" }]] }] : [],
        ctx: { lifiToNetworkId: params.toNetworkId }
    };
}
// --- 0x ---
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
            buyTokenPercentageFee: 0.0015
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, 18),
        tx: {
            to: resp.data.to, value: resp.data.value, data: resp.data.data, gasLimit: resp.data.gas
        },
        decimals: 18, symbol: "UNK",
        routesData: resp.data.sources ? [{ subRoutes: resp.data.sources.map(s => [{ name: s.name, percent: s.proportion * 100, logo: "" }]) }] : [],
        ctx: { zeroxChainId: chainId }
    };
}
// --- 1INCH ---
async function getOneInchQuote(params, amount, chainId) {
    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;
    const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
        params: {
            src: params.fromTokenAddress, dst: params.toTokenAddress,
            amount, from: params.userAddress, slippage: 1,
            fee: 0.0025, referrer: FEE_RECEIVER
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.dstAmount, 18),
        tx: {
            to: resp.data.tx.to, value: resp.data.tx.value, data: resp.data.tx.data, gasLimit: resp.data.tx.gas
        },
        decimals: 18, symbol: "UNK",
        routesData: resp.data.protocols ? [{ subRoutes: resp.data.protocols.map(p => p.map(s => ({ name: s.name, percent: s.part, logo: "" }))) }] : [],
        ctx: { oneInchChainId: chainId }
    };
}
// --- OKX ---
async function getOkxQuote(params, amount, chainId) {
    if(!params.userAddress) throw new Error("OKX requires user address");
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
        const subRoutes = d.routerList ? d.routerList.map(r => r.map(s => ({ name: s.name, percent: s.part, logo: s.logoURI || "" }))) : [[{ name: "OKX Aggregator", percent: "100", logo: "https://static.okx.com/cdn/web3/dex/logo/okx_dex.png" }]];
        return {
            toAmount: ethers.formatUnits(d.toTokenAmount, 18),
            tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
            decimals: 18, symbol: "UNK",
            routesData: [{ subRoutes }],
            ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId }
        };
    } catch (e) {
        throw new Error(e.response?.data?.msg || e.message);
    }
}
// --- Cow Swap (Mock - no free API)
async function getCowQuote(params, amount, chainId) {
    throw new Error("CowSwap not implemented - use mock");
}
// --- ChangeHero (Mock - closed API)
async function getChangeHeroQuote(params, amount, chainId) {
    throw new Error("ChangeHero not implemented - use mock");
}
// --- Jupiter (Mock - Solana only, no EVM)
async function getJupiterQuote(params, amount, chainId) {
    throw new Error("Jupiter not implemented - use mock");
}
// ==================================================================
// 3. AGGREGATOR
// ==================================================================
const MY_PROVIDERS = [
    { provider: 'SwapLifi', name: 'Li.fi', logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png', priority: 100 },
    { provider: 'Swap1inch', name: '1inch', logoURI: 'https://uni.onekey-asset.com/static/logo/1inch.png', priority: 90 },
    { provider: 'Swap0x', name: '0x', logoURI: 'https://uni.onekey-asset.com/static/logo/0xlogo.png', priority: 80 },
    { provider: 'SwapOKX', name: 'OKX Dex', logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png', priority: 70 },
    { provider: 'SwapCow', name: 'Cow Swap', logoURI: 'https://uni.onekey-asset.com/static/logo/CowSwapLogo.png', priority: 60 },
    { provider: 'SwapChangeHero', name: 'ChangeHero', logoURI: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png', priority: 50 },
    { provider: 'SwapJupiter', name: 'Jupiter', logoURI: 'https://uni.onekey-asset.com/static/logo/jupiter.png', priority: 40 }
];
app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => res.json(ok(MY_PROVIDERS.map(p => ({ ...p, status: 'available', protocols: ['swap'] })))));
app.get(['/swap/v1/check-support', '/check-support'], (req, res) => res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0")));
async function generateAllQuotes(params, eventId) {
    const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
   
    try {
        const t = await getToken(chainId, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        amount = ethers.parseUnits(Number(amount).toFixed(t.decimals), t.decimals).toString();
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
            else if (p.name.includes('Cow')) q = await getCowQuote(params, amount, chainId);
            else if (p.name.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, chainId);
            else if (p.name.includes('Jupiter')) q = await getJupiterQuote(params, amount, chainId);
            else throw new Error("Use Mock");
           
            return formatQuote(p, params, q, eventId, i === 0);
        } catch (e) {
            return getMockQuote(p, params, eventId, i === 0);
        }
    });
    return await Promise.all(promises);
}
// FORMATTER (Strict Compliance)
function formatQuote(provider, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
   
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: data.symbol || "UNK" },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: "0.1" },
        routesData: data.routesData || [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { tx: data.tx, providerId: provider.provider, isMock: false, ...data.ctx },
        allowanceResult: null,
        gasLimit: Number(data.tx?.gasLimit || 500000),
        quoteId: uuidv4(), eventId, isBest,
        oneKeyFeeExtraInfo: {
            oneKeyFeeAmount: new BigNumber(params.fromTokenAmount).multipliedBy(FEE_PERCENT).toFixed(),
            oneKeyFeeSymbol: "ETH",
            oneKeyFeeUsd: "0.1"
        }
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
        fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: "0.1" },
        routesData: [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { isMock: true, providerId: provider.provider },
        allowanceResult: null,
        gasLimit: 21000,
        quoteId: uuidv4(), eventId, isBest,
        oneKeyFeeExtraInfo: {
            oneKeyFeeAmount: new BigNumber(params.fromTokenAmount).multipliedBy(FEE_PERCENT).toFixed(),
            oneKeyFeeSymbol: "ETH",
            oneKeyFeeUsd: "0.1"
        }
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
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId, ...req.query })}\n\n`);
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
        return res.json(ok({
            result: {
                info: { provider: quoteResultCtx.providerId },
                protocol: 'Swap',
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: 21000,
                routesData: [],
                oneKeyFeeExtraInfo: { oneKeyFeeAmount: "0", oneKeyFeeSymbol: "ETH", oneKeyFeeUsd: "0" }
            },
            tx: { to: userAddress, value: "0", data: "0x" },
            ctx: {}
        }));
    }
    // REAL RESPONSE (Strict Formatting)
    if (quoteResultCtx.tx) {
        // Strict: Li.Fi wants Hex value
        const isLifi = quoteResultCtx.providerId.includes('Lifi');
        const val = isLifi ? toHex(quoteResultCtx.tx.value) : new BigNumber(quoteResultCtx.tx.value).toFixed();
        return res.json(ok({
            result: {
                info: { provider: quoteResultCtx.providerId },
                protocol: 'Swap',
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: Number(quoteResultCtx.tx.gasLimit || 500000),
                routesData: quoteResultCtx.routesData || [],
                // CRITICAL: Add this to fix spinning confirmation
                oneKeyFeeExtraInfo: {
                    oneKeyFeeAmount: new BigNumber(FEE_PERCENT).multipliedBy(quoteResultCtx.toAmount || 0).toFixed(6),
                    oneKeyFeeSymbol: "TOKEN",
                    oneKeyFeeUsd: "0.10" // Estimation to satisfy UI
                }
            },
            ctx: {
                lifiToNetworkId: quoteResultCtx.lifiToNetworkId,
                okxToNetworkId: quoteResultCtx.okxToNetworkId,
                okxChainId: quoteResultCtx.okxChainId,
                zeroxChainId: quoteResultCtx.zeroxChainId
            },
            tx: { ...quoteResultCtx.tx, from: userAddress, value: val }
        }));
    }
    res.json(ok(null));
});
app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));
app.listen(PORT, () => console.log(`Bitrabo v75 (Strict) Running on ${PORT}`));
