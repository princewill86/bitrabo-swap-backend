require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig, getRoutes, getTokens } = require('@lifi/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. Logger (So we know what's happening)
app.use((req, res, next) => {
  console.log(`>> Request: ${req.method} ${req.url}`);
  next();
});

// 2. OneKey Response Wrapper
const ok = (data) => ({ code: 0, data });

// --- DISCOVERY ENDPOINTS (The ones causing 404) ---

// Checks if the network is supported.
// NOTE: We handle BOTH with and without /swap/v1 to be safe.
const checkSupportHandler = (req, res) => {
  // Always say "Yes, Available"
  res.json(ok([{ status: 'available', networkId: req.query.networkId }]));
};
app.get('/swap/v1/check-support', checkSupportHandler);
app.get('/check-support', checkSupportHandler); // Fallback

// Lists the providers (LiFi)
const providerListHandler = (req, res) => {
  res.json(ok([
    {
      provider: 'lifi',
      name: 'Bitrabo',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/logo.png',
      status: 'available',
      priority: 1
    }
  ]));
};
app.get('/swap/v1/providers/list', providerListHandler);
app.get('/providers/list', providerListHandler); // Fallback

// Config for Gas (Native Swaps)
const configHandler = (req, res) => {
  res.json(ok({
    networkId: req.query.networkId,
    reserveGas: '21000',
    minValue: '0'
  }));
};
app.get('/swap/v1/native-token-config', configHandler);
app.get('/native-token-config', configHandler); // Fallback

// --- DATA ENDPOINTS ---

// Get Networks
app.get('/swap/v1/networks', async (req, res) => {
  // Hardcoded fallback list to ensure UI loads even if LiFi fails
  const networks = [
    { networkId: 'evm--1', name: 'Ethereum', shortcode: 'ETH', supportCrossChainSwap: true, supportSingleSwap: true },
    { networkId: 'evm--56', name: 'BNB Chain', shortcode: 'BSC', supportCrossChainSwap: true, supportSingleSwap: true },
    { networkId: 'evm--137', name: 'Polygon', shortcode: 'MATIC', supportCrossChainSwap: true, supportSingleSwap: true },
    { networkId: 'evm--42161', name: 'Arbitrum', shortcode: 'ARB', supportCrossChainSwap: true, supportSingleSwap: true },
    { networkId: 'evm--10', name: 'Optimism', shortcode: 'OP', supportCrossChainSwap: true, supportSingleSwap: true }
  ];
  res.json(ok(networks));
});

// Get Tokens (Simple Proxy to LiFi)
app.get('/swap/v1/tokens', async (req, res) => {
  try {
    const { getTokens } = require('@lifi/sdk');
    const { tokens } = await getTokens();
    // Default to ETH tokens if network not found
    const chainId = req.query.networkId ? parseInt(req.query.networkId.replace('evm--', '')) : 1;
    const list = tokens[chainId] || tokens[1] || [];
    
    // Map to OneKey format
    const mapped = list.slice(0, 50).map(t => ({
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      contractAddress: t.address,
      logoURI: t.logoURI,
      networkId: req.query.networkId,
      isNative: t.address === '0x0000000000000000000000000000000000000000'
    }));
    res.json(ok(mapped));
  } catch (e) {
    console.error(e);
    res.json(ok([]));
  }
});

// START
app.listen(PORT, () => {
  console.log(`Bitrabo Mirror Running on ${PORT}`);
});
