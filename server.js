// server.js - Bitrabo Custom LI.FI Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig, getRoutes } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize LI.FI SDK with your integrator
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025,  // 0.25% real fee to your wallet
});

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.send('Bitrabo LI.FI Backend Live! Your Own Quotes 🚀');
});

// REGULAR QUOTE (fallback or for non-streaming)
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const params = req.query;
    const fromChainId = Number(params.fromNetworkId.replace('evm--', ''));
    const toChainId = Number(params.toNetworkId.replace('evm--', ''));
    const routes = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    if (!routes?.routes?.length) {
      return res.status(404).json({ code: 1, message: 'No routes found' });
    }

    const best = routes.routes[0];

    res.json({
      code: 0,
      data: [{
        quoteId: best.id,
        protocol: 'SWAP',
        info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)', providerLogo: 'https://docs.li.fi/img/logo.png' },
        fromTokenInfo: {
          networkId: params.fromNetworkId,
          contractAddress: best.fromToken.address,
          symbol: best.fromToken.symbol,
          decimals: best.fromToken.decimals,
          name: best.fromToken.name,
          logoURI: best.fromToken.logoURI,
          isNative: best.fromToken.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        },
        toTokenInfo: {
          networkId: params.toNetworkId,
          contractAddress: best.toToken.address,
          symbol: best.toToken.symbol,
          decimals: best.toToken.decimals,
          name: best.toToken.name,
          logoURI: best.toToken.logoURI,
          isNative: best.toToken.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        },
        fromAmount: best.fromAmount,
        toAmount: best.toAmount,
        minToAmount: best.toAmountMin,
        instantRate: new BigNumber(best.toAmount).dividedBy(best.fromAmount).toString(),
        allowanceResult: { isApproved: true },  // Assume approved for simplicity
        fee: { percentageFee: 0.25, protocolFees: 0 },
        isBest: true,
        receivedBest: true,
        estimatedTime: best.gasCostUSD ? Number(best.gasCostUSD) * 60 : 180,
        unSupportSlippage: false,
        autoSuggestedSlippage: 0.5,
        routesData: best.steps.map(step => ({
          amount: step.estimate.fromAmount,
          part: step.estimate.gasCosts[0]?.amountUSD || 0,
          subRoutes: step.toolDetails.name,
        })),
        quoteExtraData: {},
        kind: 'sell',
        quoteResultCtx: best,  // Save for build-tx
      }]
    });
  } catch (error) {
    console.error('Quote error:', error);
    res.status(404).json({ code: 1, message: 'Quote not found' });
  }
});

// SSE STREAMING QUOTE ( /swap/v1/quote/events - OneKey uses this for real-time)
app.get('/swap/v1/quote/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();  // Send headers

  try {
    const params = req.query;
    const fromChainId = Number(params.fromNetworkId.replace('evm--', ''));
    const toChainId = Number(params.toNetworkId.replace('evm--', ''));
    const routes = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    if (!routes?.routes?.length) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'No routes found' })}\n\n`);
      res.end();
      return;
    }

    const best = routes.routes[0];

    // Send message event with quote
    res.write(`data: ${JSON.stringify({
      type: 'message',
      data: JSON.stringify({
        code: 0,
        data: [{
          quoteId: best.id,
          info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)', providerLogo: 'https://docs.li.fi/img/logo.png' },
          fromTokenInfo: {
            networkId: params.fromNetworkId,
            contractAddress: best.fromToken.address,
            symbol: best.fromToken.symbol,
            decimals: best.fromToken.decimals,
            name: best.fromToken.name,
            logoURI: best.fromToken.logoURI,
            isNative: best.fromToken.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          },
          toTokenInfo: {
            networkId: params.toNetworkId,
            contractAddress: best.toToken.address,
            symbol: best.toToken.symbol,
            decimals: best.toToken.decimals,
            name: best.toToken.name,
            logoURI: best.toToken.logoURI,
            isNative: best.toToken.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          },
          fromAmount: best.fromAmount,
          toAmount: best.toAmount,
          minToAmount: best.toAmountMin,
          instantRate: new BigNumber(best.toAmount).dividedBy(best.fromAmount).toString(),
          allowanceResult: { isApproved: true },
          fee: { percentageFee: 0.25, protocolFees: 0 },
          isBest: true,
          receivedBest: true,
          estimatedTime: 180,
          unSupportSlippage: false,
          autoSuggestedSlippage: 0.5,
          routesData: best.steps.map(step => ({
            amount: step.estimate.fromAmount,
            part: step.estimate.gasCosts[0]?.amountUSD || 0,
            subRoutes: [[{ name: step.toolDetails.name }]],
          })),
          quoteExtraData: {},
          kind: 'sell',
          quoteResultCtx: best,
        }]
      })
    })}\n\n`);

    // Send done event to close stream
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('SSE quote error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Quote failed' })}\n\n`);
    res.end();
  }
});

// Proxy ALL OTHER /swap/v1/* to OneKey (for token details, networks, etc.)
app.use('/swap/v1', createProxyMiddleware({
  target: 'https://swap.onekeycn.com',
  changeOrigin: true,
  pathRewrite: { '^/swap/v1': '/v1' },
  onProxyReq: (proxyReq, req) => {
    console.log(`Proxy → ${req.method} ${req.url}`);
  },
}));

app.listen(PORT, () => {
  console.log(`Bitrabo LI.FI Backend running on port ${PORT}`);
});
