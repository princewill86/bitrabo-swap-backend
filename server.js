require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createConfig } = require('@lifi/sdk');
const { getQuote } = require('@lifi/sdk');
const BigNumber = require('bignumber.js');

const app = express();
app.use(cors());
app.use(express.json());

// Correct v3+ init
createConfig({
  integrator: process.env.BITRABO_INTEGRATOR || 'bitrabo',
});

const PORT = process.env.PORT || 3000;

// Exact path from your trace
app.get('/swap/v1/quote/events', async (req, res) => {
  // For now, redirect to regular quote (events is SSE streaming — add later)
  res.redirect('/swap/v1/quote?' + new URLSearchParams(req.query).toString());
});

// Regular quote (main endpoint)
app.get('/swap/v1/quote', async (req, res) => {
  try {
    const params = req.query;

    const quote = await getQuote({
      fromChainId: Number(params.fromNetworkId.replace('evm--', '')),
      toChainId: Number(params.toNetworkId.replace('evm--', '')),
      fromTokenAddress: params.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromTokenAmount,
      fromAddress: params.userAddress,
      slippage: Number(params.slippagePercentage) / 100 || 0.005,
    });

    const result = {
      code: 0,
      data: [{
        info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
        fromTokenInfo: { contractAddress: quote.fromToken.address, networkId: params.fromNetworkId },
        toTokenInfo: { contractAddress: quote.toToken.address, networkId: params.toNetworkId },
        toAmount: quote.estimate.toAmount,
        instantRate: new BigNumber(quote.estimate.toAmount).dividedBy(params.fromTokenAmount).toString(),
        fee: { percentageFee: 0.25 },
        isBest: true,
      }]
    };

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ code: 1, message: 'Quote failed' });
  }
});

app.get('/', (req, res) => res.send('Bitrabo Swap Backend Live!'));

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
