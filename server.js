// server.js - Bitrabo Full LI.FI Swap Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig, getQuote, getRoutes, executeRoute } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize LI.FI SDK with your integrator
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
  fee: 0.0025, // 0.25% — this is the REAL fee LI.FI will collect and pay to you
  // Optional: add your affiliate address if LI.FI requires it
});

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.send('Bitrabo Swap Backend Live! 🚀 (LI.FI Powered)');
});

// QUOTE ENDPOINT - OneKey calls this first
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const params = req.query;

    // Convert OneKey network format to chain ID
    const fromChainId = Number(params.fromNetworkId.replace('evm--', ''));
    const toChainId = Number(params.toNetworkId.replace('evm--', ''));

    // Get best route from LI.FI
    const routes = await getRoutes({
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
      // Your fee is already set globally via createConfig
    });

    if (!routes || routes.length === 0) {
      return res.json({ code: 1, message: 'No routes found' });
    }

    const bestRoute = routes[0]; // LI.FI returns best first

    // Format response exactly like OneKey expects
    const result = {
      code: 0,
      data: [
        {
          info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
          fromTokenInfo: {
            contractAddress: bestRoute.fromToken.address,
            networkId: params.fromNetworkId,
          },
          toTokenInfo: {
            contractAddress: bestRoute.toToken.address,
            networkId: params.toNetworkId,
          },
          fromAmount: bestRoute.fromAmount,
          toAmount: bestRoute.toAmount,
          toAmountMin: bestRoute.toAmountMin,
          instantRate: new BigNumber(bestRoute.toAmount)
            .dividedBy(bestRoute.fromAmount)
            .toString(),
          fee: {
            percentageFee: 0.25, // This shows in UI
          },
          estimatedTime: bestRoute.estimate.approvalAddress ? 300 : 180,
          isBest: true,
          routesData: bestRoute.steps.map(step => ({
            name: step.tool,
            part: step.estimate.gasCosts?.[0]?.amountUSD || 0,
          })),
          quoteResultCtx: bestRoute, // Store full route for build-tx
        }
      ]
    };

    res.json(result);
  } catch (error) {
    console.error('Quote error:', error);
    res.status(500).json({ code: 1, message: error.message || 'Quote failed' });
  }
});

// BUILD-TX ENDPOINT - OneKey calls this after user confirms
app.post('/swap/v1/build-tx', async (req, res) => {
  try {
    const { quoteResultCtx, userAddress, receivingAddress, slippagePercentage } = req.body;

    if (!quoteResultCtx) {
      return res.status(400).json({ code: 1, message: 'Missing quote context' });
    }

    // Execute the route
    const tx = await executeRoute({
      route: quoteResultCtx,
      fromAddress: userAddress || receivingAddress,
      toAddress: receivingAddress,
      slippage: Number(slippagePercentage) / 100 || 0.005,
    });

    res.json({
      code: 0,
      data: {
        result: {
          info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
          fromTokenInfo: quoteResultCtx.fromToken,
          toTokenInfo: quoteResultCtx.toToken,
          fromAmount: quoteResultCtx.fromAmount,
          toAmount: quoteResultCtx.toAmount,
        },
        tx: {
          to: tx.transactionRequest.to,
          data: tx.transactionRequest.data,
          value: tx.transactionRequest.value || '0',
          gasPrice: tx.transactionRequest.gasPrice,
          gasLimit: tx.transactionRequest.gasLimit,
        },
      }
    });
  } catch (error) {
    console.error('Build-tx error:', error);
    res.status(500).json({ code: 1, message: error.message || 'Build transaction failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Bitrabo LI.FI Swap Backend running on port ${PORT}`);
  console.log(`Integrator: ${process.env.BITRABO_INTEGRATOR || 'bitrabo'}`);
  console.log(`Fee: 0.25% → goes to your wallet!`);
});
