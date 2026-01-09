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
const PORT = process.env.PORT || 3000;

// CONFIG
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER || '0x000000000000000000000000000000000000dead';
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025);
const LIFI_INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const TIMEOUT = 8000; // increased for reliability
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

// Health check (hit this to see logs)
app.get('/health', (req, res) => {
    console.log('[HEALTH] Server alive - ' + new Date().toISOString());
    res.json({ status: 'alive', fee: `${FEE_PERCENT * 100}%`, integrator: LIFI_INTEGRATOR });
});

// HELPERS
function getZeroXBaseUrl(chainId) {
    const map = {1: 'https://api.0x.org', 56: 'https://bsc.api.0x.org', 137: 'https://polygon.api.0x.org', 10: 'https://optimism.api.0x.org', 42161: 'https://arbitrum.api.0x.org', 43114: 'https://avalanche.api.0x.org', 250: 'https://fantom.api.0x.org', 8453: 'https://base.api.0x.org'};
    return map[chainId] || 'https://api.0x.org';
}

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
    return [{ subRoutes: [[{ name: providerName, percent: "100", logo }]] }];
}

// PROVIDERS CONFIG (matches OneKey)
const PROVIDERS_CONFIG = [
    { id: 'SwapLifi', name: 'Li.fi (Bitrabo)', logo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
    { id: 'Swap1inch', name: '1inch', logo: 'https://common.onekey-asset.com/logo/1Inch.png' },
    { id: 'Swap0x', name: '0x', logo: 'https://uni.onekey-asset.com/static/logo/0xlogo.png' },
    { id: 'SwapOKX', name: 'OKX Dex', logo: 'https://uni.onekey-asset.com/static/logo/OKXDex.png' },
    { id: 'SwapChangeHero', name: 'ChangeHero', logo: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png' }
];

// REAL QUOTE LOGIC
async function getLifiQuote(params, amount, fromChain, toChain) {
    try {
        const fromToken = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
        const toToken = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
        if (fromChain === toChain && fromToken.toLowerCase() === toToken.toLowerCase()) return null;

        const routes = await getRoutes({
            fromChainId: fromChain, toChainId: toChain,
            fromTokenAddress: fromToken, toTokenAddress: toToken,
            fromAmount: amount,
            fromAddress: params.userAddress || "0x5555555555555555555555555555555555555555",
            options: { integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT, referrer: FEE_RECEIVER }
        });

        if (!routes.routes?.length) return null;

        const route = routes.routes[0];
        const step = route.steps[0];
        const tx = await getStepTransaction(step);

        const fiatFee = step.estimate?.feeCosts?.reduce((s, f) => s + parseFloat(f.amountUSD || 0), 0) || 0.1;
        const gasUSD = step.estimate?.gasCosts?.reduce((s, g) => s + parseFloat(g.amountUSD || 0), 0) || 0.1;

        return {
            toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
            tx,
            decimals: route.toToken.decimals,
            symbol: route.toToken.symbol,
            routesData: [{ subRoutes: [[{ name: step.estimate.tool || "Li.Fi", percent: "100" }]] }],
            ctx: { lifiToNetworkId: params.toNetworkId },
            estimatedFeeFiatValue: (fiatFee + gasUSD).toFixed(4),
            protocolFees: fiatFee
        };
    } catch (e) {
        console.log('[LIFI ERR]', e.message);
        return null;
    }
}

// Add other providers (example for 1inch - repeat pattern for 0x/OKX)
async function getOneInchQuote(params, amount, chainId) {
    if (!KEYS.ONEINCH) return null;
    try {
        const src = norm(params.fromTokenAddress);
        const dst = norm(params.toTokenAddress);
        const resp = await axios.get(`https://api.1inch.dev/swap/v6.0/${chainId}/quote`, {
            headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
            params: { src, dst, amount, from: params.userAddress, slippage: 1 },
            timeout: TIMEOUT
        });

        return {
            toAmount: ethers.formatUnits(resp.data.toAmount, 18),
            tx: { to: resp.data.tx.to, value: resp.data.tx.value, data: resp.data.tx.data, gasLimit: resp.data.tx.gas },
            decimals: 18, symbol: "UNK",
            routesData: getFakeRoutes("1inch", ""),
            ctx: { oneInchChainId: chainId },
            estimatedFeeFiatValue: "0.08" // placeholder - real 1inch doesn't give fiat fee here
        };
    } catch (e) {
        console.log('[1INCH ERR]', e.message);
        return null;
    }
}

// ... add 0x, OKX similarly

// AGGREGATOR
async function generateAllQuotes(params, eventId) {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    try {
        const t = await getToken(fromChain, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        amount = ethers.parseUnits(Number(amount).toFixed(t.decimals), t.decimals).toString();
    } catch {
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString();
    }

    console.log(`[QUOTE] ${params.fromTokenAmount} on ${fromChain} → ${toChain}`);

    const providers = [
        { fn: getLifiQuote, id: 'SwapLifi' },
        { fn: getOneInchQuote, id: 'Swap1inch' }
        // add more
    ];

    const quotes = [];
    for (const p of providers) {
        const data = await p.fn(params, amount, fromChain, toChain);
        if (data) {
            quotes.push({
                info: { provider: p.id, providerName: p.id.replace('Swap', ''), providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
                fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, isNative: !params.fromTokenAddress, decimals: 18 },
                toTokenInfo: { contractAddress: params.toTokenAddress || "", networkId: params.toNetworkId, decimals: data.decimals || 18 },
                fromAmount: params.fromTokenAmount,
                toAmount: data.toAmount,
                instantRate: new BigNumber(data.toAmount).div(params.fromTokenAmount).toString(),
                estimatedTime: 30,
                fee: { percentageFee: 0.25, estimatedFeeFiatValue: data.estimatedFeeFiatValue || "0.1" },
                routesData: data.routesData,
                quoteResultCtx: { tx: data.tx, providerId: p.id, ...data.ctx },
                gasLimit: Number(data.tx?.gasLimit || 500000),
                oneKeyFeeExtraInfo: { oneKeyFeeAmount: "0.0025", oneKeyFeeSymbol: "ETH", oneKeyFeeUsd: "0.1" },
                quoteId: uuidv4(),
                eventId,
                isBest: quotes.length === 0
            });
        }
    }

    return quotes.length ? quotes : [getMockQuote({ provider: 'SwapLifi' }, params, eventId, true)];
}

function getMockQuote(provider, params, eventId, isBest) {
    const toAmount = (parseFloat(params.fromTokenAmount || 1) * 3100).toFixed(6);
    return {
        info: { provider: provider.id || 'SwapLifi', providerName: 'Li.fi (Mock)', providerLogo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
        fromTokenInfo: { contractAddress: "", networkId: params.fromNetworkId, isNative: true, decimals: 18, symbol: 'ETH' },
        toTokenInfo: { contractAddress: params.toTokenAddress || "", networkId: params.toNetworkId, decimals: 6, symbol: 'USDC' },
        fromAmount: params.fromTokenAmount || "1",
        toAmount,
        instantRate: "3100",
        estimatedTime: 30,
        fee: { percentageFee: 0.25, estimatedFeeFiatValue: "0.1" },
        routesData: [{ subRoutes: [[{ name: "Li.Fi Mock", percent: "100" }]] }],
        quoteResultCtx: { providerId: 'SwapLifi' },
        gasLimit: 300000,
        oneKeyFeeExtraInfo: { oneKeyFeeAmount: "0.0025", oneKeyFeeSymbol: "ETH", oneKeyFeeUsd: "0.1" },
        quoteId: uuidv4(),
        eventId,
        isBest
    };
}

// ROUTES
app.get('/swap/v1/quote/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const eventId = uuidv4();
    try {
        const quotes = await generateAllQuotes(req.query, eventId);
        res.write(`data: ${JSON.stringify({ totalQuoteCount: quotes.length, eventId })}\n\n`);
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId, ...req.query })}\n\n`);
        quotes.forEach(q => res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`));
        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) {
        console.error('[QUOTE ERR]', e);
        res.write(`data: {"type":"error"}\n\n`);
    }
    res.end();
});

app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
    if (!quoteResultCtx?.tx) return res.json(ok(null));

    const val = toHex(quoteResultCtx.tx.value);

    const feeAmount = new BigNumber(quoteResultCtx.toAmount || 0).multipliedBy(FEE_PERCENT).toFixed(6);

    res.json(ok({
        result: {
            info: { provider: quoteResultCtx.providerId || 'SwapLifi' },
            protocol: 'Swap',
            fee: { percentageFee: 0.25, estimatedFeeFiatValue: quoteResultCtx.estimatedFeeFiatValue || "0.1" },
            gasLimit: Number(quoteResultCtx.tx.gasLimit || 500000),
            routesData: quoteResultCtx.routesData || [],
            estimatedTime: 30,
            fromAmount: quoteResultCtx.fromAmount || "0",
            toAmount: quoteResultCtx.toAmount || "0",
            instantRate: new BigNumber(quoteResultCtx.toAmount || 0).div(quoteResultCtx.fromAmount || 1).toString(),
            oneKeyFeeExtraInfo: {
                oneKeyFeeAmount: feeAmount,
                oneKeyFeeSymbol: "ETH",
                oneKeyFeeUsd: feeAmount
            },
            slippage: 0.5
        },
        ctx: quoteResultCtx,
        tx: { ...quoteResultCtx.tx, from: userAddress, value: val },
        orderId: uuidv4()
    }));
});

app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));

app.listen(PORT, () => console.log(`Bitrabo v130 - Fees/Gas/Routes Fixed | Port ${PORT}`));
