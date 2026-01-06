require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { LiFi } = require('@lifi/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// Correct initialization for LI.FI SDK v3+
const lifi = new LiFi({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
});

const PORT = process.env.PORT || 3000;

// /v1/quote endpoint (mirrors OneKey)
app.get('/v1/quote', async (req, res) => {
  try {
    const params = req.query;

    // Map OneKey params to LI.FI
    const quote = await lifi.getQuote({
      fromChainId: Number(params.fromNetworkId.replace('evm--', '')),
      toChainId: Number(params.toNetworkId.replace('evm--', '')),
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    // Format response like OneKey
    const result = {
      code: 0,
      data: [{
        info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
        fromTokenInfo: { contractAddress: quote.fromToken.address, networkId: params.fromNetworkId },
        toTokenInfo: { contractAddress: quote.toToken.address, networkId: params.toNetworkId },
        toAmount: quote.estimate.toAmount,
        instantRate: new BigNumber(quote.estimate.toAmount).div(params.fromTokenAmount).toString(),
        fee: { percentageFee: 0.25 },
        isBest: true,
        // Add more fields as needed
      }]
    };

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ code: 1, message: error.message || 'Quote failed' });
  }
});

// Health check
app.get('/', (req, res) => res.send('Bitrabo Swap Backend Live!'));

app.listen(PORT, () => console.log(`Bitrabo backend on port ${PORT}`));
