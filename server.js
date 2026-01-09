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

// --- CONFIG ---
const FEE_RECEIVER = process.env.BITRABO_FEE_RECEIVER; 
const FEE_PERCENT = Number(process.env.BITRABO_FEE || 0.0025); 
const LIFI_INTEGRATOR = process.env.BITRABO_INTEGRATOR || 'bitrabo';
const TIMEOUT = 6000;

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
// 1. DATA DEFINITIONS
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

const PROVIDERS_CONFIG = [
    { id: 'Swap1inch', name: '1inch', logo: 'https://uni.onekey-asset.com/static/logo/1inch.png' },
    { id: 'SwapLifi', name: 'Li.fi (Bitrabo)', logo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
    { id: 'Swap0x', name: '0x', logo: 'https://uni.onekey-asset.com/static/logo/0xlogo.png' },
    { id: 'SwapOKX', name: 'OKX Dex', logo: 'https://uni.onekey-asset.com/static/logo/OKXDex.png' },
    { id: 'SwapChangeHero', name: 'ChangeHero', logo: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png' }
];

// ==================================================================
// 2. HELPERS
// ==================================================================
function getZeroXBaseUrl(chainId) {
    // Force Number type for lookup
    const id = Number(chainId);
    const map = {
        1: 'https://api.0x.org',
        56: 'https://bsc.api.0x.org',
        137: 'https://polygon.api.0x.org',
        10: 'https://optimism.api.0x.org',
        42161: 'https://arbitrum.api.0x.org',
        43114: 'https://avalanche.api.0x.org',
        8453: 'https://base.api.0x.org'
    };
    return map[id] || 'https://api.0x.org';
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
    return [{ subRoutes: [[{ name: providerName, percent: "100", logo: logo }]] }];
}

// ==================================================================
// 3. REAL INTEGRATIONS
// ==================================================================

// 0x: Fixed URL Mapping
async function getZeroXQuote(params, amount, chainId, toDecimals) {
    try {
        const baseUrl = getZeroXBaseUrl(chainId);
        // console.log(`   --> 0x Request: ${baseUrl} (Chain ${chainId})`);
        
        const resp = await axios.get(`${baseUrl}/swap/v1/quote`, {
            headers: { '0x-api-key': KEYS.ZEROX },
            params: {
                sellToken: norm(params.fromTokenAddress), buyToken: norm(params.toTokenAddress),
                sellAmount: amount, takerAddress: params.userAddress || "0x5555555555555555555555555555555555555555",
                feeRecipient: FEE_RECEIVER, buyTokenPercentageFee: 0.0025, skipValidation: true 
            }, timeout: TIMEOUT
        });
        
        console.log(`   ✅ 0x Success`);
        return {
            toAmount: ethers.formatUnits(resp.data.buyAmount, toDecimals), 
            tx: { to: resp.data.to, value: resp.data.value, data: resp.data.data, gasLimit: resp.data.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("0x", ""),
            ctx: { zeroxChainId: chainId }, fiatFee: 0.15
        };
    } catch (e) { 
        const url = getZeroXBaseUrl(chainId);
        console.log(`   ❌ 0x Failed (${url}): ${e.response?.status}`); 
        return null; 
    }
}

// 1inch: Fixed Field Parsing & Fallback
async function getOneInchQuote(params, amount, chainId, toDecimals) {
    try {
        // Try /swap first (Rich Data)
        const resp = await axios.get(`https://api.1inch.dev/swap/v5.2/${chainId}/swap`, {
            headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
            params: {
                src: norm(params.fromTokenAddress), dst: norm(params.toTokenAddress),
                amount, from: params.userAddress || "0x5555555555555555555555555555555555555555",
                slippage: 1, fee: 0.25, referrer: FEE_RECEIVER, disableEstimate: true 
            }, timeout: TIMEOUT
        });

        // 1inch v5.2 returns 'toTokenAmount', v5.0 returned 'toAmount', v4 returned 'dstAmount'
        const dstAmount = resp.data.toTokenAmount || resp.data.dstAmount || resp.data.toAmount;
        
        if (!dstAmount) {
            console.log(`   ⚠️ 1inch Data Missing. Keys: ${Object.keys(resp.data)}`);
            throw new Error("No amount field");
        }

        console.log("   ✅ 1inch Success");
        return {
            toAmount: ethers.formatUnits(dstAmount, toDecimals),
            tx: { to: resp.data.tx.to, value: resp.data.tx.value, data: resp.data.tx.data, gasLimit: resp.data.tx.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("1inch", ""),
            ctx: { oneInchChainId: 1 }, fiatFee: 0.20
        };
    } catch (e) { 
        console.log(`   ❌ 1inch Failed: ${e.response?.status || e.message}`);
        return null; 
    }
}

async function getLifiQuote(params, amount, fromChain, toChain) {
    try {
        const fromToken = (!params.fromTokenAddress) ? '0x0000000000000000000000000000000000000000' : params.fromTokenAddress;
        const toToken = (!params.toTokenAddress) ? '0x0000000000000000000000000000000000000000' : params.toTokenAddress;
        if(fromChain === toChain && fromToken.toLowerCase() === toToken.toLowerCase()) return null;

        const routesPromise = getRoutes({
            fromChainId: fromChain, toChainId: toChain,
            fromTokenAddress: fromToken, toTokenAddress: toToken,
            fromAmount: amount, 
            fromAddress: params.userAddress || "0x5555555555555555555555555555555555555555", 
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

        console.log("   ✅ Li.Fi Success");
        return {
            toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
            tx, decimals: route.toToken.decimals, symbol: route.toToken.symbol,
            routesData: [], ctx: richCtx, fiatFee: parseFloat(fiatFee) + parseFloat(gasCostUSD)
        };
    } catch (e) { return null; }
}

async function getOkxQuote(params, amount, chainId, toDecimals) {
    try {
        if(!params.userAddress) return null;
        const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${norm(params.fromTokenAddress)}&toTokenAddress=${norm(params.toTokenAddress)}&userWalletAddress=${params.userAddress}&slippage=0.005`;
        const ts = new Date().toISOString();
        const sign = crypto.createHmac('sha256', KEYS.OKX.SECRET).update(ts + 'GET' + path).digest('base64');
        const resp = await axios.get(`https://www.okx.com${path}`, {
            headers: { 'OK-ACCESS-KEY': KEYS.OKX.KEY, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': KEYS.OKX.PASSPHRASE, 'X-Simulated-Trading': '0' }, timeout: TIMEOUT
        });

        if (resp.data.code !== '0' || !resp.data.data || !resp.data.data[0]) return null;
        
        const d = resp.data.data[0];
        const outAmount = d.toTokenAmount || d.routerResult?.toTokenAmount;
        if (!outAmount) return null;

        console.log("   ✅ OKX Success");
        return {
            toAmount: ethers.formatUnits(outAmount, toDecimals), 
            tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("OKX", ""),
            ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId }, fiatFee: 0.25
        };
    } catch (e) { return null; }
}

async function getChangeHeroQuote(params, amount, chainId) {
    try {
        const map = { '0xdac17f958d2ee523a2206206994597c13d831ec7': 'usdt', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'eth' };
        const fromSym = map[norm(params.fromTokenAddress)];
        const toSym = map[norm(params.toTokenAddress)];
        if(!fromSym || !toSym) return null;
        const readableAmount = ethers.formatUnits(amount, 18);
        const resp = await axios.get(`https://api.changehero.io/v2/exchange-amount`, {
            params: { api_key: KEYS.CHANGEHERO, from: fromSym, to: toSym, amount: readableAmount }, timeout: TIMEOUT
        });
        console.log("   ✅ ChangeHero Success");
        return {
            toAmount: String(resp.data.estimated_amount),
            tx: { to: "0xChangeHeroDepositAddr", value: amount, data: "0x", gasLimit: 21000 }, 
            decimals: 18, symbol: toSym.toUpperCase(), routesData: [{ subRoutes: [[{ name: "ChangeHero", percent: "100", logo: "https://uni.onekey-asset.com/static/logo/changeHeroFixed.png" }]] }],
            ctx: { isChangeHero: true }, fiatFee: 0.50
        };
    } catch (e) { return null; }
}

// ==================================================================
// 4. ENDPOINTS
// ==================================================================
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
app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0")));

async function generateAllQuotes(params, eventId) {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    let toDecimals = 18;

    try { 
        const t = await getToken(fromChain, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        amount = ethers.parseUnits(Number(amount).toFixed(t.decimals), t.decimals).toString();
        const toT = await getToken(toChain, params.toTokenAddress || '0x0000000000000000000000000000000000000000');
        toDecimals = toT.decimals || 18;
    } catch { 
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString(); 
    }

    console.log(`[🔍 AGGREGATOR] Fetching (To Decimals: ${toDecimals})...`);

    const promises = PROVIDERS_CONFIG.map(async (p, i) => {
        let q = null;
        if (fromChain !== toChain) {
            if (p.id.includes('Lifi')) q = await getLifiQuote(params, amount, fromChain, toChain);
            else if (p.id.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, fromChain);
        } else {
            if (p.id.includes('Lifi')) q = await getLifiQuote(params, amount, fromChain, toChain);
            else if (p.id.includes('1inch')) q = await getOneInchQuote(params, amount, fromChain, toDecimals);
            else if (p.id.includes('0x')) q = await getZeroXQuote(params, amount, fromChain, toDecimals);
            else if (p.id.includes('OKX')) q = await getOkxQuote(params, amount, fromChain, toDecimals);
            else if (p.id.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, fromChain);
        }
        if (!q) return null; 
        return formatQuote(p, params, q, eventId, i === 0);
    });

    const results = await Promise.all(promises);
    return results.filter(r => r !== null);
}

function formatQuote(providerConf, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
    return {
        info: { provider: providerConf.id, providerName: providerConf.name, providerLogo: providerConf.logo },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: "UNK" },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100, estimatedFeeFiatValue: data.fiatFee || 0.1, protocolFees: 0 },
        routesData: data.routesData,
        quoteResultCtx: { tx: data.tx, providerId: providerConf.id, isMock: false, ...data.ctx },
        allowanceResult: null, unSupportReceiveAddressDifferent: false,
        gasLimit: Number(data.tx?.gasLimit || 500000),
        quoteId: uuidv4(), eventId, isBest
    };
}

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
    if (!quoteResultCtx || !quoteResultCtx.tx) return res.json(ok(null));

    try {
        const isLifi = quoteResultCtx.providerId.includes('Lifi');
        const val = isLifi ? toHex(quoteResultCtx.tx.value) : new BigNumber(quoteResultCtx.tx.value).toFixed();
        const feeAmount = new BigNumber(quoteResultCtx.toAmount || 0).multipliedBy(FEE_PERCENT).toFixed(6);

        return res.json(ok({
            result: { 
                info: { provider: quoteResultCtx.providerId }, 
                protocol: 'Swap', fee: { percentageFee: FEE_PERCENT * 100 }, 
                gasLimit: Number(quoteResultCtx.tx.gasLimit || 500000),
                routesData: quoteResultCtx.routesData || [],
                oneKeyFeeExtraInfo: { oneKeyFeeAmount: feeAmount, oneKeyFeeSymbol: "TOKEN", oneKeyFeeUsd: "0.10" }
            },
            ctx: quoteResultCtx,
            tx: { ...quoteResultCtx.tx, from: userAddress, value: val }
        }));
    } catch (e) { return res.json(ok(null)); }
});

app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));
app.listen(PORT, () => console.log(`Bitrabo v93 (Router Fixed) Running on ${PORT}`));
