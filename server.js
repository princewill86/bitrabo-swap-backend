require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');
const {
  createConfig,
  getRoutes,
  executeRoute,
  getTokens,
} = require('@lifi/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// LI.FI config
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  routeOptions: {
    fee: Number(process.env.BITRABO_FEE || 0.001), // Reduced to 0.1% to avoid issues
  },
});

const PORT = process.env.PORT || 3000;

// Safe response wrapper
function ok(data) {
  return { code: 0, data: data ?? (Array.isArray(data) ? [] : {}) };
}

// Native token normalizers
function native(addr) {
  const lower = addr ? addr.toLowerCase() : '';
  if (lower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || lower === '0x0000000000000000000000000000000000000000' || lower === '') {
    return '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  }
  return addr || '';
}

function lifiNative(addr) {
  const lower = addr ? addr.toLowerCase() : '';
  if (lower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || lower === '0x0000000000000000000000000000000000000000' || lower === '') {
    return '0x0000000000000000000000000000000000000000';
  }
  return addr || '';
}

// RPC URLs
const RPC_URLS = {
  1: 'https://rpc.ankr.com/eth',
  56: 'https://rpc.ankr.com/bsc',
  137: 'https://rpc.ankr.com/polygon',
  43114: 'https://rpc.ankr.com/avalanche',
  42161: 'https://rpc.ankr.com/arbitrum',
  10: 'https://rpc.ankr.com/optimism',
  100: 'https://rpc.ankr.com/gnosis',
  42220: 'https://rpc.ankr.com/celo',
  204: 'https://opbnb-mainnet-rpc.bnbchain.org',
  324: 'https://mainnet.era.zksync.io',
  167000: 'https://rpc.taiko.xyz',
  1101: 'https://zkevm-rpc.com',
  2020: 'https://rpc.roninchain.com',
  1284: 'https://rpc.api.moonbeam.network',
  534352: 'https://rpc.scroll.io',
  34443: 'https://mainnet.mode.network',
  1088: 'https://andromeda.metis.io/?owner=1088',
  5000: 'https://rpc.mantle.xyz',
  59144: 'https://rpc.linea.build',
  8217: 'https://public-en.node.klaytn.com',
  14: 'https://flare-api.flare.network/ext/C/rpc',
  288: 'https://mainnet.boba.network',
  25: 'https://evm.cronos.org',
  81457: 'https://rpc.blast.io',
  8453: 'https://rpc.ankr.com/base',
  60808: 'https://rpc.gobob.xyz',
  1313161554: 'https://mainnet.aurora.dev',
  30: 'https://mycrypto.rsk.co',
  80094: 'https://bera-testnet.rpc.berachain.com', // Adjust if mainnet
  1329: 'https://evm-rpc.sei-apis.com',
  146: 'https://rpc.dogechain.dog',
  130: 'https://rpc.bt.io',
  988: 'https://rpc.sophon.xyz',
  480: 'https://api.wemix.com',
  999: 'https://api.zilliqa.com',
  50: 'https://rpc.xdc.org',
  9745: 'https://time-rpc.chain.com',
  143: 'https://mainnet.anyswap.exchange',
  // Add any missing
};

function getRpcUrl(chainId) {
  return RPC_URLS[chainId] || RPC_URLS[1];
}

// ---------------- NETWORKS ----------------
app.get('/swap/v1/networks', async (req, res) => {
  try {
    const tokens = await getTokens();
    const chainIds = Object.keys(tokens.tokens || {});
    const networks = chainIds.map(chainId => ({
      networkId: `evm--${chainId}`,
      supportSingleSwap: true,
      supportCrossChainSwap: true,
      supportLimit: false,
      defaultSelectToken: [],
    }));
    res.json(ok(networks));
  } catch (e) {
    console.error('Networks error:', e);
    res.json(ok([]));
  }
});

// ---------------- TOKENS ----------------
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords, limit = 50, accountAddress, onlyAccountTokens, withCheckInscription, skipReservationValue, accountNetworkId } = req.query;
    const all = await getTokens();
    const chainId = networkId ? Number(String(networkId).replace('evm--', '')) : null;
    let list = [];

    if (chainId && all.tokens?.[chainId]) {
      list = all.tokens[chainId];
    } else {
      list = Object.values(all.tokens || {}).flat();
    }

    if (keywords) {
      const k = String(keywords).toLowerCase();
      list = list.filter(t =>
        String(t.symbol).toLowerCase().includes(k) ||
        String(t.name).toLowerCase().includes(k)
      );
    }

    let mapped = list.slice(0, Number(limit)).map(t => ({
      name: t.name || '',
      symbol: t.symbol || '',
      decimals: t.decimals || 18,
      logoURI: t.logoURI || '',
      contractAddress: native(t.address),
      networkId: `evm--${t.chainId}`,
      reservationValue: skipReservationValue === 'true' ? undefined : '0',
      price: '0',
      balance: '0',
      isNative: t.address === '0x0000000000000000000000000000000000000000',
    }));

    // Fetch balances if needed
    if (onlyAccountTokens === 'true' && accountAddress && chainId) {
      const provider = new ethers.JsonRpcProvider(getRpcUrl(chainId));
      const user = accountAddress.toString();

      mapped = (await Promise.all(mapped.map(async (t) => {
        let balance = '0';
        try {
          if (t.isNative) {
            balance = (await provider.getBalance(user)).toString();
          } else if (t.contractAddress && t.contractAddress !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
            const tokenContract = new ethers.Contract(t.contractAddress, ['function balanceOf(address) view returns (uint256)'], provider);
            balance = (await tokenContract.balanceOf(user)).toString();
          }
        } catch (err) {
          console.error('Balance fetch error for token:', t.contractAddress, err);
        }
        return { ...t, balance };
      }))).filter(t => new BigNumber(t.balance).gt(0));
    }

    // Ignore withCheckInscription for now

    res.json(ok(mapped));
  } catch (e) {
    console.error('Tokens error:', e);
    res.json(ok([]));
  }
});

// ---------------- TOKEN DETAIL ----------------
app.get('/swap/v1/token/detail', async (req, res) => {
  try {
    const { networkId, contractAddress, accountAddress, withCheckInscription } = req.query;
    const chainId = Number(String(networkId).replace('evm--', ''));
    const all = await getTokens();
    let token = all.tokens[chainId]?.find(t => native(t.address).toLowerCase() === (contractAddress || '').toLowerCase());

    if (!contractAddress || contractAddress === '') {
      token = all.tokens[chainId]?.find(t => t.address === '0x0000000000000000000000000000000000000000');
    }

    if (!token) return res.json(ok([]));

    let mapped = [{
      name: token.name || '',
      symbol: token.symbol || '',
      decimals: token.decimals || 18,
      logoURI: token.logoURI || '',
      contractAddress: native(token.address),
      networkId,
      reservationValue: '0',
      price: '0',
      balance: '0',
      isNative: token.address === '0x0000000000000000000000000000000000000000',
    }];

    if (accountAddress) {
      const provider = new ethers.JsonRpcProvider(getRpcUrl(chainId));
      const user = accountAddress.toString();
      let balance = '0';
      try {
        if (mapped[0].isNative) {
          balance = (await provider.getBalance(user)).toString();
        } else {
          const tokenContract = new ethers.Contract(mapped[0].contractAddress, ['function balanceOf(address) view returns (uint256)'], provider);
          balance = (await tokenContract.balanceOf(user)).toString();
        }
      } catch (err) {
        console.error('Detail balance error:', err);
      }
      mapped[0].balance = balance;
    }

    // Ignore withCheckInscription

    res.json(ok(mapped));
  } catch (e) {
    console.error('Token detail error:', e);
    res.json(ok([]));
  }
});

// ---------------- POPULAR TOKENS ----------------
app.get('/swap/v1/popular/tokens', (req, res) => {
  // Dummy - add real if needed
  res.json(ok([]));
});

// ---------------- QUOTE ----------------
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const p = req.query;
    console.log('Quote params:', p);
    const fromChainId = Number(String(p.fromNetworkId || '').replace('evm--', ''));
    const toChainId = Number(String(p.toNetworkId || '').replace('evm--', ''));
    const all = await getTokens();
    const fromToken = all.tokens[fromChainId]?.find(t => native(t.address).toLowerCase() === lifiNative(p.fromTokenAddress).toLowerCase());
    const decimals = fromToken?.decimals || 18;

    let fromAmount = p.fromTokenAmount;
    const minAmount = new BigNumber(1).shiftedBy(decimals - 2); // 0.01 units
    let scaleFactor = new BigNumber(1);
    if (new BigNumber(fromAmount).lt(minAmount)) {
      fromAmount = minAmount.toString();
      scaleFactor = new BigNumber(p.fromTokenAmount).div(fromAmount);
    }

    const routesRes = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: lifiNative(p.fromTokenAddress),
      toTokenAddress: lifiNative(p.toTokenAddress),
      fromAmount,
      fromAddress: p.userAddress,
      toAddress: p.userAddress,
      slippage: Number(p.slippagePercentage) / 100 || 0.005,
    });
    console.log('Li.FI routes response:', routesRes);

    if (!routesRes || !Array.isArray(routesRes.routes) || !routesRes.routes.length) {
      console.log('No routes found');
      return res.json(ok([]));
    }

    let best = routesRes.routes[0];

    // Scale back if adjusted
    if (!scaleFactor.eq(1)) {
      best.fromAmount = p.fromTokenAmount;
      best.toAmount = new BigNumber(best.toAmount).times(scaleFactor).toFixed(0);
      best.toAmountMin = new BigNumber(best.toAmountMin).times(scaleFactor).toFixed(0);
    }

    const quote = {
      info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
      fromTokenInfo: {
        contractAddress: native(best.fromToken.address),
        networkId: p.fromNetworkId,
        decimals: best.fromToken.decimals,
        symbol: best.fromToken.symbol,
        name: best.fromToken.name,
        isNative: best.fromToken.address === '0x0000000000000000000000000000000000000000',
      },
      toTokenInfo: {
        contractAddress: native(best.toToken.address),
        networkId: p.toNetworkId,
        decimals: best.toToken.decimals,
        symbol: best.toToken.symbol,
        name: best.toToken.name,
        isNative: best.toToken.address === '0x0000000000000000000000000000000000000000',
      },
      fromAmount: best.fromAmount,
      toAmount: best.toAmount,
      toAmountMin: best.toAmountMin,
      instantRate: new BigNumber(best.toAmount).div(best.fromAmount).toString(),
      fee: {
        percentageFee: Number(process.env.BITRABO_FEE || 0.001),
        feeReceiver: process.env.BITRABO_FEE_RECEIVER,
        estimatedFeeFiatValue: '0',
      },
      isBest: true,
      receivedBest: true,
      estimatedTime: best.estimate?.etaSeconds || 180,
      allowanceResult: { isApproved: true },
      routesData: best.steps.map(s => ({
        name: s.toolDetails?.name || s.tool || 'Unknown',
        part: 100,
        subRoutes: [],
      })),
      quoteExtraData: {},
      kind: p.kind || 'sell',
      quoteResultCtx: best,
      toAmountSlippage: 0,
      gasFee: {
        gasPrice: '0',
        estimatedGas: '0',
        estimatedFee: '0',
        estimatedFeeFiatValue: '0',
      },
      otherFeeInfos: [],
      estimatedGas: '0',
      bridgeProvider: null,
      errorMessage: null,
      quoteId: uuidv4(),
    };

    res.json(ok([quote]));
  } catch (e) {
    console.error('Quote error:', e);
    res.json(ok([]));
  }
});

// ---------------- SSE EVENTS ----------------
app.get('/swap/v1/quote/events', async (req, res) => {
  try {
    const eventId = uuidv4();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    res.write(`data: {"totalQuoteCount":1,"eventId":"${eventId}"}\n\n`);

    const quotes = await axios.get(`http://127.0.0.1:${PORT}/swap/v1/quote`, {
      params: req.query,
    });

    const quoteData = quotes.data.data || [];
    quoteData.forEach(quote => {
      res.write(`data: {"data":[${JSON.stringify(quote)}]}\n\n`);
    });

    res.write('data: {"type":"done"}\n\n');
  } catch (e) {
    console.error('SSE error:', e);
    res.write('data: {"type":"error"}\n\n');
  } finally {
    res.end();
  }
});

// The rest of the routes remain the same as before

app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});
