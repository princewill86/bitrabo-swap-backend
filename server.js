require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig } = require('@lifi/sdk');
const { getQuote } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize LI.FI SDK config (required once)
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
});

const PORT = process.env.PORT || 3000;

// /v1/quote endpoint
app.get('/v1/quote', async (req, res) => {
  try {
    const params = req.query;

    // Call getQuote directly (no instance needed)
    const quote = await getQuote({
      fromChainId: Number(params.fromNetworkId.replace('evm--', '')),
      toChainId: Number(params.toNetworkId.replace('evm--', '')),
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',  // Native token
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    // Simple response (mirrors OneKey structure)
    const result = {
      code: 0,
      data: [{
        info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
        fromTokenInfo: { contractAddress: quote.fromToken.address, networkId: params.fromNetworkId },
        toTokenInfo: { contractAddress: quote.toToken.address, networkId: params.toNetworkId },
        toAmount: quote.estimate.toAmount,
        instantRate: new BigNumber(quote.estimate.toAmount).dividedBy(params.fromTokenAmount).toString(),
        fee: { percentageFee: 0.25 },  // Your fee (LI.FI deducts it)
        isBest: true,
      }]
    };

    res.json(result);
  } catch (error) {
    console.error('Quote error:', error);
    res.status(500).json({ code: 1, message: error.message || 'Failed to get quote' });
  }
});

// Health check
app.get('/', (req, res) => res.send('Bitrabo Swap Backend Live!'));

app.listen(PORT, () => console.log(`Bitrabo backend running on port ${PORT}`));
