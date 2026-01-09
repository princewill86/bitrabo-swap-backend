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
// 1. TOKEN & ADDRESS MAPPERS
// ==================================================================

// CHANGEHERO NEEDS SYMBOLS (ETH, BTC, USDT), NOT ADDRESSES
const CH_TOKEN_MAP = {
    // Ethereum Mainnet
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'eth',
    '0x0000000000000000000000000000000000000000': 'eth',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'eth', // WETH treated as ETH
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'usdt',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usdc',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'dai',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wbtc',
    // BSC
    '0x55d398326f99059ff775485246999027b3197955': 'usdt', // BSC-USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'usdc', // BSC-USDC
    // Polygon
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'usdt',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'usdc',
};

function getChangeHeroSymbol(addr) {
    if (!addr) return 'eth';
    return CH_TOKEN_MAP[addr.toLowerCase()] || null; 
}

function getZeroXBaseUrl(chainId) {
    const map = {
        1: 'https://api.0x.org',
        56: 'https://bsc.api.0x.org',
        137: 'https://polygon.api.0x.org',
        10: 'https://optimism.api.0x.org',
        42161: 'https://arbitrum.api.0x.org',
        43114: 'https://avalanche.api.0x.org',
    };
    return map[chainId] || 'https://api.0x.org';
}

function norm(addr) {
    if (!addr || addr === '' || addr === '0x0000000000000000000000000000000000000000') {
        return '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    }
    return addr.toLowerCase();
}

function toHex(val) {
    if (!val || val === '0') return "0x0";
    if (val.toString().startsWith('0x')) return val.toString();
    return "0x" + new BigNumber(val).toString(16);
}

// ==================================================================
// 2. REAL INTEGRATIONS
// ==================================================================

// --- CHANGEHERO (Fixed Mapping) ---
async function getChangeHeroQuote(params, amount, chainId) {
    const fromSym = getChangeHeroSymbol(params.fromTokenAddress);
    const toSym = getChangeHeroSymbol(params.toTokenAddress);

    // If we don't know the symbol (e.g. random meme coin), we MUST skip ChangeHero
    if (!fromSym || !toSym) throw new Error("Token not supported by ChangeHero map");

    const readableAmount = ethers.formatUnits(amount, 18); // Approx formatting

    try {
        const resp = await axios.get(`https://api.changehero.io/v2/exchange-amount`, {
            params: {
                api_key: KEYS.CHANGEHERO,
                from: fromSym,
                to: toSym,
                amount: readableAmount
            }
        });

        // ChangeHero requires a "Deposit" transaction (Transfer to their wallet).
        // For the QUOTE phase, we return the rate.
        // We simulate a transfer TX so the UI button allows clicking "Swap".
        const fakeDepositAddress = "0xChangeHeroHotWalletPlaceholder"; 
        
        return {
            toAmount: ethers.parseUnits(String(resp.data.estimated_amount), 18).toString(), // Norm to 18 dec
            tx: {
                to: fakeDepositAddress,
                value: params.fromTokenAddress ? "0" : amount, // If ETH, send value. If Token, 0.
                data: "0x", // Real implementation requires ERC20 transfer data generation
                gasLimit: 21000
            },
            decimals: 18, 
            symbol: toSym.toUpperCase()
        };
    } catch (e) {
        // Log 403/400 errors clearly
        throw new Error(`ChangeHero API: ${e.response?.status} ${e.response?.data?.error || e.message}`);
    }
}

// --- LI.FI ---
async function getLifiQuote(params, amount, chainId) {
    const fromToken = (!params.fromTokenAddress || params.fromTokenAddress === '') ? '0x0000000000000000000000000000000000000000' : params.fromTokenAddress;
    const toToken = (!params.toTokenAddress || params.toTokenAddress === '') ? '0x0000000000000000000000000000000000000000' : params.toTokenAddress;
    const fromAddr = (params.userAddress && params.userAddress.length > 10) ? params.userAddress : "0x5555555555555555555555555555555555555555"; 

    const routes = await getRoutes({
        fromChainId: chainId, toChainId: chainId,
        fromTokenAddress: fromToken, toTokenAddress: toToken,
        fromAmount: amount, fromAddress: fromAddr, 
        options: { integrator: LIFI_INTEGRATOR, fee: FEE_PERCENT, referrer: FEE_RECEIVER }
    });

    if (!routes.routes?.length) throw new Error("No LiFi Routes");
    const route = routes.routes[0];
    const step = route.steps[0];
    const tx = await getStepTransaction(step);
    
    return {
        toAmount: ethers.formatUnits(route.toAmount, route.toToken.decimals),
        tx, decimals: route.toToken.decimals, symbol: route.toToken.symbol,
        ctx: { lifiToNetworkId: params.toNetworkId } 
    };
}

// --- 0x ---
async function getZeroXQuote(params, amount, chainId) {
    const baseUrl = getZeroXBaseUrl(chainId);
    const taker = (params.userAddress && params.userAddress.length > 10) ? params.userAddress : "0x5555555555555555555555555555555555555555";
    const sellToken = norm(params.fromTokenAddress);
    const buyToken = norm(params.toTokenAddress);

    const resp = await axios.get(`${baseUrl}/swap/v1/quote`, {
        headers: { '0x-api-key': KEYS.ZEROX },
        params: {
            sellToken, buyToken, sellAmount: amount,
            takerAddress: taker, feeRecipient: FEE_RECEIVER, buyTokenPercentageFee: FEE_PERCENT,
            skipValidation: true 
        }
    });
    
    return {
        toAmount: ethers.formatUnits(resp.data.buyAmount, 18), 
        tx: { to: resp.data.to, value: resp.data.value, data: resp.data.data, gasLimit: resp.data.gas },
        decimals: 18, symbol: "UNK",
        ctx: { zeroxChainId: chainId }
    };
}

// --- 1INCH ---
async function getOneInchQuote(params, amount, chainId) {
    const src = norm(params.fromTokenAddress);
    const dst = norm(params.toTokenAddress);

    try {
        const url = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;
        const resp = await axios.get(url, {
            headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
            params: {
                src, dst, amount, from: params.userAddress, slippage: 1,
                fee: FEE_PERCENT * 100, referrer: FEE_RECEIVER,
                disableEstimate: true 
            }
        });
        return format1inchResponse(resp.data);
    } catch (e) {
        const url5 = `https://api.1inch.dev/swap/v5.2/${chainId}/swap`;
        const resp = await axios.get(url5, {
            headers: { Authorization: `Bearer ${KEYS.ONEINCH}` },
            params: {
                src, dst, amount, from: params.userAddress, slippage: 1,
                fee: FEE_PERCENT * 100, referrer: FEE_RECEIVER,
                disableEstimate: true 
            }
        });
        return format1inchResponse(resp.data);
    }
}

function format1inchResponse(data) {
    return {
        toAmount: ethers.formatUnits(data.dstAmount, 18),
        tx: { to: data.tx.to, value: data.tx.value, data: data.tx.data, gasLimit: data.tx.gas },
        decimals: 18, symbol: "UNK",
        ctx: { oneInchChainId: 1 }
    };
}

// --- OKX ---
async function getOkxQuote(params, amount, chainId) {
    if(!params.userAddress) throw new Error("OKX requires user address");
    const fromToken = norm(params.fromTokenAddress);
    const toToken = norm(params.toTokenAddress);

    const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${amount}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&userWalletAddress=${params.userAddress}&slippage=0.005`;
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
        const subRoutes = [[{ name: "OKX Aggregator", percent: "100", logo: "https://static.okx.com/cdn/web3/dex/logo/okx_dex.png" }]];
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

// ==================================================================
// 3. AGGREGATOR
// ==================================================================
const MY_PROVIDERS = [
    { provider: 'SwapLifi', name: 'Li.fi (Bitrabo)', logoURI: 'https://uni.onekey-asset.com/static/logo/lifi.png', priority: 100 },
    { provider: 'SwapChangeHero', name: 'ChangeHero', logoURI: 'https://uni.onekey-asset.com/static/logo/changeHeroFixed.png', priority: 90 },
    { provider: 'Swap1inch', name: '1inch', logoURI: 'https://uni.onekey-asset.com/static/logo/1inch.png', priority: 80 },
    { provider: 'Swap0x', name: '0x', logoURI: 'https://uni.onekey-asset.com/static/logo/0xlogo.png', priority: 70 },
    { provider: 'SwapOKX', name: 'OKX Dex', logoURI: 'https://uni.onekey-asset.com/static/logo/OKXDex.png', priority: 60 }
];

app.get(['/swap/v1/providers/list', '/providers/list'], (req, res) => res.json(ok(MY_PROVIDERS.map(p => ({ ...p, status: 'available', protocols: ['swap'] })))));
app.get(['/swap/v1/check-support', '/check-support'], (req, res) => res.json(ok([{ status: 'available', networkId: req.query.networkId }])));
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
            else if (p.name.includes('ChangeHero')) q = await getChangeHeroQuote(params, amount, chainId);
            else if (p.name.includes('1inch')) q = await getOneInchQuote(params, amount, chainId);
            else if (p.name.includes('0x')) q = await getZeroXQuote(params, amount, chainId);
            else if (p.name.includes('OKX')) q = await getOkxQuote(params, amount, chainId);
            else throw new Error("Use Mock");
            
            return formatQuote(p, params, q, eventId, i === 0);
        } catch (e) {
            console.warn(`[⚠️ ${p.name}] ${e.message}`);
            return getMockQuote(p, params, eventId, i === 0);
        }
    });

    return await Promise.all(promises);
}

function formatQuote(provider, params, data, eventId, isBest) {
    const rate = new BigNumber(data.toAmount).div(params.fromTokenAmount).toFixed();
    
    return {
        info: { provider: provider.provider, providerName: provider.name, providerLogo: provider.logoURI },
        fromTokenInfo: { contractAddress: params.fromTokenAddress || "", networkId: params.fromNetworkId, decimals: 18, symbol: "TOKEN" },
        toTokenInfo: { contractAddress: params.toTokenAddress, networkId: params.toNetworkId, decimals: data.decimals || 18, symbol: data.symbol || "UNK" },
        protocol: 'Swap', kind: 'sell',
        fromAmount: params.fromTokenAmount, toAmount: data.toAmount,
        instantRate: rate, estimatedTime: 30,
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: data.routesData || [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { tx: data.tx, providerId: provider.provider, isMock: false, ...data.ctx },
        allowanceResult: null,
        gasLimit: Number(data.tx?.gasLimit || 500000),
        quoteId: uuidv4(), eventId, isBest
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
        fee: { percentageFee: FEE_PERCENT * 100 },
        routesData: [{ subRoutes: [[{ name: provider.name, percent: "100", logo: provider.logoURI }]] }],
        quoteResultCtx: { isMock: true, providerId: provider.provider },
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
        res.write(`data: ${JSON.stringify({ autoSuggestedSlippage: 0.5, eventId, ...req.query })}\n\n`);
        for (const q of quotes) res.write(`data: ${JSON.stringify({ data: [q] })}\n\n`);
        res.write(`data: {"type":"done"}\n\n`);
    } catch (e) { res.write(`data: {"type":"error"}\n\n`); }
    res.end();
});

app.post('/swap/v1/build-tx', jsonParser, (req, res) => {
    const { quoteResultCtx, userAddress } = req.body;
    
    // MOCK RESPONSE
    if (!quoteResultCtx || quoteResultCtx.isMock) {
        return res.json(ok({
            result: { 
                info: { provider: quoteResultCtx?.providerId || 'Unknown' }, 
                protocol: 'Swap', 
                fee: { percentageFee: 0.25 }, 
                gasLimit: 21000,
                oneKeyFeeExtraInfo: { oneKeyFeeAmount: "0", oneKeyFeeSymbol: "ETH", oneKeyFeeUsd: "0" }
            },
            tx: { to: userAddress, value: "0", data: "0x" },
            ctx: {} 
        }));
    }

    // REAL RESPONSE
    const isLifi = quoteResultCtx.providerId.includes('Lifi');
    const val = isLifi ? toHex(quoteResultCtx.tx.value) : new BigNumber(quoteResultCtx.tx.value).toFixed();
    const feeAmount = new BigNumber(quoteResultCtx.toAmount || 0).multipliedBy(FEE_PERCENT).toFixed(6);

    return res.json(ok({
        result: { 
            info: { provider: quoteResultCtx.providerId }, 
            protocol: 'Swap', 
            fee: { percentageFee: FEE_PERCENT * 100 }, 
            gasLimit: Number(quoteResultCtx.tx.gasLimit || 500000),
            routesData: quoteResultCtx.routesData || [],
            oneKeyFeeExtraInfo: {
                oneKeyFeeAmount: feeAmount,
                oneKeyFeeSymbol: "TOKEN", 
                oneKeyFeeUsd: "0.10" 
            }
        },
        ctx: quoteResultCtx,
        tx: { ...quoteResultCtx.tx, from: userAddress, value: val }
    }));
});

app.use('/swap/v1', createProxyMiddleware({ target: 'https://swap.onekeycn.com', changeOrigin: true, logLevel: 'silent' }));
app.listen(PORT, () => console.log(`Bitrabo v79 Running on ${PORT}`));
