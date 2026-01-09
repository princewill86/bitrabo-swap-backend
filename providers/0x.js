const axios = require('axios');

const API_KEY = process.env.ZEROX_API_KEY; 
const MY_FEE_WALLET = process.env.BITRABO_FEE_RECEIVER;

async function getQuote(params) {
    try {
        const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
        
        // 0x API Call
        const response = await axios.get('https://api.0x.org/swap/v1/price', {
            headers: { '0x-api-key': API_KEY },
            params: {
                sellToken: params.fromTokenAddress,
                buyToken: params.toTokenAddress,
                sellAmount: params.fromTokenAmount,
                buyTokenPercentageFee: 0.005, // 0.5% Fee
                feeRecipient: MY_FEE_WALLET   // <--- YOU GET PAID
            }
        });

        return {
            toAmount: response.data.buyAmount,
            estimatedGas: response.data.estimatedGas,
            tx: null 
        };
    } catch (e) {
        return null;
    }
}

module.exports = { getQuote };