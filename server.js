require('dotenv').config();
const express = require('express');
const cors = require('cors');
const BigNumber = require('bignumber.js');
const { createConfig, getRoutes, getTokens } = require('@lifi/sdk');

// --- CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize LiFi SDK
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
});

// Middleware
app.use(cors());
app.use(express.json());

// --- HELPERS ---

// 1. OneKey Response Wrapper (Crucial for "Unknown Error" fix)
const ok = (data) => ({ code: 0, data });

// 2. Network ID Parsers (OneKey uses "evm--1", LiFi uses 1)
const toLiFiChain = (oneKeyId) => {
  if (!oneKeyId) return 1; // default eth
  return parseInt(oneKeyId.replace('evm--', ''));
};

const toOneKeyChain = (lifiId) => `evm--${lifiId}`;

// 3. Shared Quote Logic (Used by both /quote and /quote/events)
async function fetchLiFiQuotes(params) {
  try {
    const fromChainId = toLiFiChain(params.fromNetworkId);
    const toChainId = toLiFiChain(params.toNetworkId);
    const fromTokenAddress = params.fromTokenAddress || '0x0000000000000000000000000000000000000000';
    const toTokenAddress = params.toTokenAddress || '0x0000000000000000000000000000000000000000';
    const slippage = params.slippagePercentage ? Number(params.slippagePercentage) / 100 : 0.005;

    // Call LiFi SDK
    const routesResponse = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress,
      toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage,
      options: {
        integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
        fee: Number(process.env.BITRABO_FEE || 0.0025), // 0.25% Application Fee
      }
    });

    if (!routesResponse.routes || routesResponse.routes.length === 0) {
      return [];
    }

    // Map LiFi Routes to OneKey Quote Structure
    return routesResponse.routes.map((route, index) => {
      const isBest = index === 0; // First result is best in LiFi
      
      return {
        info: {
          provider: 'lifi',
          providerName: 'Li.Fi (Bitrabo)',
          providerLogoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png'
        },
        fromTokenInfo: {
          networkId: params.fromNetworkId,
          contractAddress: route.fromToken.address,
          symbol: route.fromToken.symbol,
          name: route.fromToken.name,
          decimals: route.fromToken.decimals,
          logoURI: route.fromToken.logoURI,
          isNative: route.fromToken.address === '0x0000000000000000000000000000000000000000'
        },
        toTokenInfo: {
          networkId: params.toNetworkId,
          contractAddress: route.toToken.address,
          symbol: route.toToken.symbol,
          name: route.toToken.name,
          decimals: route.toToken.decimals,
          logoURI: route.toToken.logoURI,
          isNative: route.toToken.address === '0x0000000000000000000000000000000000000000'
        },
        fromAmount: route.fromAmount,
        toAmount: route.toAmount,
        toAmountMin: route.toAmountMin,
        instantRate: new BigNumber(route.toAmount).div(route.fromAmount).toString(),
        
        // OneKey uses routesData to visualize steps (Approve -> Swap -> Bridge)
        routesData: route.steps.map(step => ({
          name: step.toolDetails.name || step.tool,
          part: 100,
          subRoutes: [[{
            name: step.toolDetails.name || step.tool,
            part: 100
          }]]
        })),
        
        // CRITICAL: Pass the FULL LiFi route object as context.
        // We will need this in /build-tx to generate transaction data.
        quoteResultCtx: route, 
        
        kind: 'sell', // usually 'sell' (exact input)
        receivedBest: isBest,
        isBest: isBest,
        fee: {
          percentageFee: Number(process.env.BITRABO_FEE || 0.0025),
          feeReceiver: process.env.BITRABO_FEE_RECEIVER
        },
        estimatedTime: route.tags?.includes('RECOMMENDED') ? 60 : 120, // Dummy estimation
      };
    });

  } catch (error) {
    console.error("Quote Error:", error.message);
    return [];
  }
}

// --- ROUTES ---

/**
 * 1. GET /swap/v1/networks
 * Returns supported chains formatted for OneKey
 */
app.get('/swap/v1/networks', async (req, res) => {
  try {
    const data = await getTokens(); // LiFi getTokens includes chain data
    const chainIds = Object.keys(data.tokens || {});
    
    const networks = chainIds.map(id => ({
      networkId: toOneKeyChain(id),
      name: `EVM ${id}`, // Ideally map this to real names if needed
      shortcode: 'ETH',
      logoURI: '',
      supportCrossChainSwap: true,
      supportSingleSwap: true,
      supportLimit: false,
      defaultSelectToken: []
    }));

    res.json(ok(networks));
  } catch (e) {
    res.json(ok([]));
  }
});

/**
 * 2. GET /swap/v1/tokens
 * Returns token list for a specific network
 */
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { networkId, keywords } = req.query;
    const lifiChainId = toLiFiChain(networkId);
    
    const data = await getTokens({ chains: [lifiChainId] });
    let tokens = data.tokens[lifiChainId] || [];

    // Filter by keyword if provided
    if (keywords) {
      const lowerK = keywords.toLowerCase();
      tokens = tokens.filter(t => 
        t.name.toLowerCase().includes(lowerK) || 
        t.symbol.toLowerCase().includes(lowerK)
      );
    }

    const mappedTokens = tokens.slice(0, 100).map(t => ({
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      contractAddress: t.address,
      logoURI: t.logoURI,
      networkId: networkId,
      isNative: t.address === '0x0000000000000000000000000000000000000000',
      price: t.priceUSD || '0'
    }));

    res.json(ok(mappedTokens));
  } catch (e) {
    res.json(ok([]));
  }
});

/**
 * 3. GET /swap/v1/quote
 * Standard fetch for quotes (non-streaming)
 */
app.get('/swap/v1/quote', async (req, res) => {
  const quotes = await fetchLiFiQuotes(req.query);
  res.json(ok(quotes));
});

/**
 * 4. GET /swap/v1/quote/events
 * Server-Sent Events (SSE) for real-time quoting
 */
app.get('/swap/v1/quote/events', async (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const quotes = await fetchLiFiQuotes(req.query);
    
    // Send data in SSE format: data: JSONString\n\n
    res.write(`data: ${JSON.stringify(quotes)}\n\n`);
    
    // Send "done" event to close the stream on frontend
    res.write(`data: {"type":"done"}\n\n`);
  } catch (e) {
    console.error("SSE Error", e);
    res.write(`data: {"type":"error", "message": "Failed to fetch quotes"}\n\n`);
  } finally {
    res.end();
  }
});

/**
 * 5. POST /swap/v1/build-tx
 * Generates the UNSIGNED transaction data
 */
app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    // quoteResultCtx is the raw LiFi route object we saved in the quote step
    const { quoteResultCtx, userAddress } = req.body;

    if (!quoteResultCtx) {
      return res.json({ code: 500, message: "Missing quote context" });
    }

    // In LiFi, the first step contains the immediate transaction info needed
    // for the user to sign (e.g., Approve Token or Swap).
    const step = quoteResultCtx.steps[0];
    const txRequest = step.transactionRequest;

    if (!txRequest) {
      // If transactionRequest is missing, we might need to fetch it (rare for single swap)
      return res.json({ code: 500, message: "Could not generate transaction data" });
    }

    // Map to OneKey BuildTx Response
    const buildTxResponse = {
      result: {
        info: {
          provider: 'lifi',
          providerName: 'Li.Fi (Bitrabo)'
        }
      },
      // This is the RAW transaction OneKey will sign
      tx: {
        to: txRequest.to,
        value: txRequest.value ? new BigNumber(txRequest.value).toFixed() : '0',
        data: txRequest.data,
        gas: txRequest.gasLimit ? new BigNumber(txRequest.gasLimit).toFixed() : undefined, // Optional
        from: userAddress
      }
    };

    res.json(ok(buildTxResponse));

  } catch (e) {
    console.error("Build Tx Error:", e);
    res.json({ code: 500, message: e.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Bitrabo Swap Backend running on port ${PORT}`);
});
