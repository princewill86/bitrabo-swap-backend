require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { LiFi } = require('@li.fi/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const lifi = new LiFi({
  integrator: process.env.BITRABO_INTEGRATOR,
});

const PORT = process.env.PORT || process.env.PORT || 3000;

// /v1/quote (mirrors OneKey)
app.get('/v1/quote', async (req, res) => {
  try {
    const quote = await lifi.getQuote({
      fromChain: req.query.fromNetworkId.replace('evm--', ''),
      toChain: req.query.toNetworkId.replace('evm--', ''),
      fromToken: req.query.fromTokenAddress || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      toToken: req.query.toTokenAddress,
      fromAmount: req.query.fromTokenAmount,
      fromAddress: req.query.userAddress,
      slippage: req.query.slippagePercentage / 100,
      fee: process.env.BITRABO_FEE,  // Your fee
    });

    // Format as OneKey expects (IFetchQuoteResult[])
    const result = [{
      info: { provider: 'lifi', providerName: 'LI.FI (Bitrabo)' },
      fromTokenInfo: { contractAddress: quote.fromToken.address, networkId: req.query.fromNetworkId },
      toTokenInfo: { contractAddress: quote.toToken.address, networkId: req.query.toNetworkId },
      toAmount: quote.estimate.toAmount,
      instantRate: quote.estimate.toAmount / req.query.fromTokenAmount,
      fee: { percentageFee: Number(process.env.BITRABO_FEE) * 100 },
      isBest: true,
      // Add more fields as needed
    }];

    res.json({ code: 0, data: result });
  } catch (error) {
    res.status(500).json({ code: 1, message: error.message });
  }
});

// Health
app.get('/', (req, res) => res.send('Bitrabo Swap Backend Live!'));

app.listen(PORT, () => console.log(`Bitrabo backend on port ${PORT}`));