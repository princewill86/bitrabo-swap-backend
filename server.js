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
    if (typeof val === 'string' && val.startsWith('0x')) return val;
    return "0x" + BigInt(val).toString(16);
}
const NATIVE_ADDRESSES = {
    LIFI: '0x0000000000000000000000000000000000000000',
    ZEROX: 'ETH',
    ONEINCH: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    OKX: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
};
// ==================================================================
// 2. REAL INTEGRATIONS
// ==================================================================
// --- LI.FI ---
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
    if (step.estimate.feeCosts?.length) {
        protocolFees = step.estimate.feeCosts.reduce((sum, f) => sum + parseFloat(f.amountUSD || 0), 0);
    }
    if (step.estimate.gasCosts?.length) {
        estimatedFeeFiatValue = step.estimate.gasCosts.reduce((sum, g) => sum + parseFloat(g.amountUSD || 0), 0);
    }
    
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
// --- 0x ---
async function getZeroXQuote(params, amount, chainId, fromToken, toToken) {
    if (!KEYS.ZEROX) throw new Error("Missing 0x API key");
    const baseUrl = getZeroXBaseUrl(chainId);
    const sellToken = fromToken.isNative ? 'ETH' : fromToken.address;
    const buyToken = toToken.isNative ? 'ETH' : toToken.address;
    const resp = await axios.get(`${baseUrl}/swap/v2/quote`, {
        headers: { '0x-api-key': KEYS.ZEROX, '0x-version': 'v2' },
        params: {
            sellToken,
            buyToken,
            sellAmount: amount,
            takerAddress: params.userAddress,
            feeRecipient: FEE_RECEIVER,
            buyTokenPercentageFee: FEE_PERCENT * 100 // in basis points?
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, toToken.decimals),
        tx: {
            to: resp.data.to,
            value: resp.data.value || "0",
            data: resp.data.data,
            gas: resp.data.gas,
            gasPrice: resp.data.gasPrice
        },
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [],
        ctx: { zeroxChainId: chainId }
    };
}
// --- 1INCH ---
async function getOneInchQuote(params, amount, chainId, fromToken, toToken) {
    if (!KEYS.ONEINCH) throw new Error("Missing 1inch API key");
    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;
    const src = fromToken.isNative ? NATIVE_ADDRESSES.ONEINCH : fromToken.address;
    const dst = toToken.isNative ? NATIVE_ADDRESSES.ONEINCH : toToken.address;
    const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
        params: {
            src, dst,
            amount,
            from: params.userAddress,
            slippage: 50, // 0.5%
            referrer: FEE_RECEIVER,
            fee: FEE_PERCENT
        }
    });
    return {
        toAmount: ethers.formatUnits(resp.data.toAmount, toToken.decimals),
        tx: resp.data.tx,
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: [{ subRoutes: [[{ name: "1inch", percent: "100", logo: "https://uni.onekey-asset.com/static/logo/1inch.png" }]] }],
        ctx: { oneInchChainId: chainId }
    };
}
// --- OKX ---
async function getOkxQuote(params, amount, chainId, fromToken, toToken) {
    if (!params.userAddress) throw new Error("OKX requires user address");
    if (!KEYS.OKX.KEY || !KEYS.OKX.SECRET || !KEYS.OKX.PASSPHRASE) throw new Error("Missing OKX credentials");
    const fromAddr = fromToken.isNative ? NATIVE_ADDRESSES.OKX : fromToken.address;
    const toAddr = toToken.isNative ? NATIVE_ADDRESSES.OKX : toToken.address;
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
    if (resp.data.code !== '0') throw new Error(`OKX error: ${resp.data.msg}`);
    const d = resp.data.data[0];
    if (!d || !d.tx) throw new Error("Incomplete OKX data");
    return {
        toAmount: ethers.formatUnits(d.toTokenAmount || d.toAmount, toToken.decimals),
        tx: { to: d.tx.to, value: d.tx.value || "0", data: d.tx.data, gasLimit: d.tx.gas || d.gasLimit },
        decimals: toToken.decimals,
        symbol: toToken.symbol,
        routesData: d.routerResult?.dexRouterList || [{ subRoutes: [[{ name: "OKX Aggregator", percent: "100" }]] }],
        ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId }
    };
}
// ==================================================================
// 3. AGGREGATOR & REST SAME AS BEFORE (with minor fixes for token info)
// ==================================================================
// ... (keep generateAllQuotes, formatQuote, getMockQuote as in previous version, with proper token info including isNative, logoURI from OneKey style)

app.get('/swap/v1/quote/events', /* same */);
app.post('/swap/v1/build-tx', /* same with fixes for fee object per provider */);
app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));
app.listen(PORT, () => console.log(`Bitrabo Fixed v80 Running on ${PORT}`));
