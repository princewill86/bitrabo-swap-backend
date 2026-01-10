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
const LIFI_API_KEY = process.env.LIFI_API_KEY; // ← Critical! Must be in .env
const TIMEOUT = 15000;

// Initialize LiFi config
createConfig({ 
  integrator: LIFI_INTEGRATOR, 
  fee: FEE_PERCENT,
  apiKey: LIFI_API_KEY || undefined
});

const GAS_PRICE_ESTIMATES = {
    1: "30000000000",
    56: "3000000000",
    137: "150000000000",
    10: "100000000",
    42161: "100000000",
    8453: "100000000",
    43114: "25000000000"
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
// PROVIDER QUOTES
// ==================================================================
async function getZeroXQuote(params, amount, chainId, toDecimals, nativePriceUSD) {
    try {
        const resp = await axios.get(`https://api.0x.org/swap/allowance-holder/quote`, {
            headers: { '0x-api-key': KEYS.ZEROX, '0x-version': 'v2' },
            params: {
                chainId, sellToken: norm(params.fromTokenAddress), buyToken: norm(params.toTokenAddress),
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
    } catch (e) { console.log(`0x failed: ${e.message}`); return null; }
}

async function getOneInchQuote(params, amount, chainId, toDecimals, nativePriceUSD) {
    try {
        const resp = await axios.get(`https://api.1inch.dev/swap/v5.2/${chainId}/swap`, {
            headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
            params: {
                src: norm(params.fromTokenAddress), dst: norm(params.toTokenAddress),
                amount, from: params.userAddress || "0x5555555555555555555555555555555555555555",
                slippage: 1, fee: FEE_PERCENT * 100, referrer: FEE_RECEIVER, disableEstimate: true
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
    } catch (e) { console.log(`1inch failed: ${e.message}`); return null; }
}

async function getOkxQuote(params, amount, chainId, toDecimals, nativePriceUSD) {
    try {
        if (!params.userAddress) return null;
        const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${norm(params.fromTokenAddress)}&toTokenAddress=${norm(params.toTokenAddress)}&userWalletAddress=${params.userAddress}&slippage=0.005`;
        const ts = new Date().toISOString();
        const sign = crypto.createHmac('sha256', KEYS.OKX.SECRET).update(ts + 'GET' + path).digest('base64');
        const resp = await axios.get(`https://www.okx.com${path}`, {
            headers: {
                'OK-ACCESS-KEY': KEYS.OKX.KEY,
                'OK-ACCESS-SIGN': sign,
                'OK-ACCESS-TIMESTAMP': ts,
                'OK-ACCESS-PASSPHRASE': KEYS.OKX.PASSPHRASE,
                'X-Simulated-Trading': '0'
            }, timeout: TIMEOUT
        });
        if (resp.data.code !== '0' || !resp.data.data?.[0]) return null;
        const d = resp.data.data[0];
        const outAmount = d.toTokenAmount || d.routerResult?.toTokenAmount;
        const fiatFee = calculateFiatFee(d.tx.gas, d.tx.gasPrice, nativePriceUSD, chainId);
        return {
            toAmount: ethers.formatUnits(outAmount, toDecimals),
            tx: { to: d.tx.to, value: d.tx.value, data: d.tx.data, gasLimit: d.tx.gas },
            decimals: toDecimals, symbol: "UNK", routesData: getFakeRoutes("OKX", ""),
            ctx: { okxToNetworkId: params.toNetworkId, okxChainId: chainId }, fiatFee
        };
    } catch (e) { console.log(`OKX failed: ${e.message}`); return null; }
}

async function getLifiQuote(params, amount, fromChain, toChain) {
    try {
        const routesPromise = getRoutes({
            fromChainId: fromChain,
            toChainId: toChain,
            fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            toTokenAddress: params.toTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            fromAmount: amount,
            fromAddress: params.userAddress || "0x5555555555555555555555555555555555555555",
            options: { 
                integrator: LIFI_INTEGRATOR, 
                fee: FEE_PERCENT, 
                referrer: FEE_RECEIVER 
            }
        });

        const routes = await Promise.race([
            routesPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error("LiFi routes timeout")), TIMEOUT))
        ]);

        if (!routes?.routes?.length) {
            console.log('[LiFi] No routes returned');
            return null;
        }

        const route = routes.routes[0];
        const step = route.steps[0];
        const txResponse = await getStepTransaction(step);

        // LiFi returns nested transactionRequest
        const txRequest = txResponse?.transactionRequest || {};

        if (!txRequest.to || !ethers.isAddress(txRequest.to) || !txRequest.data) {
            console.error('[LiFi] Invalid nested transactionRequest:', txRequest);
            return null;
        }

        console.log('[LiFi] Valid txRequest - to:', txRequest.to);

        const richCtx = { 
            lifiQuoteResultCtx: { stepInfo: step, estimate: step.estimate, includedSteps: route.steps }, 
            lifiToNetworkId: params.toNetworkId 
        };

        const fiatFee = Number(step.estimate?.feeCosts?.[0]?.amountUSD || 0.1) + 
                        Number(step.estimate?.gasCosts?.[0]?.amountUSD || 0.1);

        return {
            toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
            tx: txResponse,  // Full response with nested transactionRequest
            decimals: route.toToken.decimals,
            symbol: route.toToken.symbol,
            routesData: [],
            ctx: richCtx,
            fiatFee
        };
    } catch (e) {
        console.error('[LiFi] Critical failure:', e.message);
        return null;
    }
}

// ==================================================================
// QUOTE GENERATION & ENDPOINTS
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
    { id: 'Swap1inch', name: '1inch', logo: 'https://common.onekey-asset.com/logo/1Inch.png' },
    { id: 'SwapLifi', name: 'Li.fi (Bitrabo)', logo: 'https://uni.onekey-asset.com/static/logo/lifi.png' },
    { id: 'Swap0x', name: '0x', logo: 'https://uni.onekey-asset.com/static/logo/0xlogo.png' },
    { id: 'SwapOKX', name: 'OKX Dex', logo: 'https://uni.onekey-asset.com/static/logo/OKXDex.png' }
];

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => {
    const list = PROVIDERS_CONFIG.map(p => ({
        providerInfo: { provider: p.id, name: p.name, logo: p.logo, protocol: "Swap" },
        isSupportSingleSwap: true, isSupportCrossChain: true,
        supportSingleSwapNetworks: SUPPORTED_NETWORKS,
        supportCrossChainNetworks: SUPPORTED_NETWORKS,
        providerServiceDisable: false, serviceDisableNetworks: []
    }));
    res.json(ok(list));
});

app.get(['/swap/v1/check-support', '/check-support'], (req, res) =>
    res.json(ok([{ status: 'available', networkId: req.query.networkId }]))
);

app.get(['/swap/v1/allowance', '/allowance'], (req, res) => res.json(ok("0")));

async function generateAllQuotes(params, eventId) {
    const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
    const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
    let amount = params.fromTokenAmount;
    let toDecimals = 18;
    let nativePriceUSD = 0;

    try {
        const t = await getToken(fromChain, params.fromTokenAddress || '0x0000000000000000000000000000000000000000');
        amount = ethers.parseUnits(Number(amount).toFixed(t.decimals), t.decimals).toString();
        const toT = await getToken(toChain, params.toTokenAddress || '0x0000000000000000000000000000000000000000');
        toDecimals = toT.decimals || 18;
        const native = await getToken(fromChain, '0x0000000000000000000000000000000000000000');
        nativePriceUSD = parseFloat(native.priceUSD || 0);
    } catch {
        amount = ethers.parseUnits(Number(amount).toFixed(18), 18).toString();
    }

    console.log(`[Fetching quotes] Native price: $${nativePriceUSD}`);

    const promises = PROVIDERS_CONFIG.map(async (p, i) => {
        let q = null;
        if (fromChain !== toChain) {
            if (p.id.includes('Lifi')) q = await getLifiQuote(params, amount, fromChain, toChain);
        } else {
            if (p.id.includes('Lifi')) q = await getLifiQuote(params, amount, fromChain, toChain);
            else if (p.id.includes('1inch')) q = await getOneInchQuote(params, amount, fromChain, toDecimals, nativePriceUSD);
            else if (p.id.includes('0x')) q = await getZeroXQuote(params, amount, fromChain, toDecimals, nativePriceUSD);
            else if (p.id.includes('OKX')) q = await getOkxQuote(params, amount, fromChain, toDecimals, nativePriceUSD);
        }
        if (!q) return null;
        console.log(` ✓ ${p.name} OK (fee ~$${q.fiatFee})`);
        return formatQuote(p, params, q, eventId, i === 0);
    });

    const results = await Promise.all(promises);
    return results.filter(Boolean);
}

function formatQuote(providerConf, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed(8);

    return {
        info: { provider: providerConf.id, providerName: providerConf.name, providerLogo: providerConf.logo },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: "UNK" },
        protocol: 'Swap', kind: 'sell',
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
            fromAmount: params.fromTokenAmount,
            toAmount: data.toAmount,
            instantRate: rate,
            ...data.ctx
        },
        allowanceResult: null,
        unSupportReceiveAddressDifferent: false,
        gasLimit: Number(data.tx?.gasLimit || 210000),
        quoteId: uuidv4(),
        eventId,
        isBest
    };
}

app.get('/swap/v1/quote/events', async (req, res) => {
    console.log(`⚡ QUOTE EVENTS REQUEST`);
    res.setHeader('Content-Type', 'text/event-stream');
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
        res.write(`data: {"type":"error"}\n\n`);
    }
    res.end();
});

app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    console.log("📝 BUILD-TX CALLED");
    const { quoteResultCtx, userAddress } = req.body;

    if (!quoteResultCtx?.tx) {
        console.log("❌ Missing tx in quoteResultCtx");
        return res.json(ok(null));
    }

    // Handle LiFi nested structure for validation
    let txObj = quoteResultCtx.tx;
    const isLifi = quoteResultCtx.providerId?.includes('Lifi') || false;
    if (isLifi && quoteResultCtx.tx?.transactionRequest) {
        txObj = quoteResultCtx.tx.transactionRequest;
    }

    // Validate the effective tx object
    if (!txObj || !txObj.to || !ethers.isAddress(txObj.to)) {
        console.error("Invalid tx in build-tx:", txObj);
        return res.json(ok(null));
    }

    try {
        const val = isLifi ? toHex(txObj.value) : new BigNumber(txObj.value || "0").toFixed();

        const feeAmount = new BigNumber(quoteResultCtx.toAmount || "0")
            .multipliedBy(FEE_PERCENT)
            .toFixed(6);

        return res.json(ok({
            result: {
                info: { provider: quoteResultCtx.providerId },
                protocol: 'Swap',
                fromTokenInfo: quoteResultCtx.fromTokenInfo || { contractAddress: "", networkId: "", decimals: 18, symbol: "TOKEN" },
                toTokenInfo: quoteResultCtx.toTokenInfo || { contractAddress: "", networkId: "", decimals: 18, symbol: "UNK" },
                fromAmount: quoteResultCtx.fromAmount || "0",
                toAmount: quoteResultCtx.toAmount || "0",
                instantRate: quoteResultCtx.instantRate || "0",
                estimatedTime: 30,
                fee: { percentageFee: FEE_PERCENT * 100 },
                gasLimit: Number(txObj.gasLimit || 210000),
                routesData: quoteResultCtx.routesData || [],
                oneKeyFeeExtraInfo: {
                    oneKeyFeeAmount: feeAmount,
                    oneKeyFeeSymbol: "TOKEN",
                    oneKeyFeeUsd: "0.10"
                },
                slippage: 0.5,
                supportUrl: "https://help.onekey.so/hc/requests/new"
            },
            ctx: quoteResultCtx,
            tx: { ...txObj, from: userAddress, value: val }  // Use the validated txObj
        }));
    } catch (e) {
        console.error("build-tx error:", e.message);
        return res.json(ok(null));
    }
});

// Fallback proxy
app.use('/swap/v1', (req, res, next) => {
    console.log(`Proxy → OneKey: ${req.method} ${req.path}`);
    next();
});

app.use('/swap/v1', createProxyMiddleware({
    target: 'https://swap.onekeycn.com',
    changeOrigin: true,
    logLevel: 'silent'
}));

app.listen(PORT, () => {
    if (!LIFI_API_KEY) {
        console.warn('⚠️ CRITICAL: LIFI_API_KEY missing in .env - LiFi may fail');
    } else {
        console.log('✅ LiFi API key loaded');
    }
    console.log(`Bitrabo Swap Backend (LiFi Nested Fix) running on port ${PORT}`);
});
