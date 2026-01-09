const axios = require('axios');

const API_KEY = process.env.ONEINCH_API_KEY;
const FEE_RECIPIENT = process.env.BITRABO_FEE_RECEIVER;
const FEE_PERCENT = 0.5; // 0.5% (1inch allows up to 3% usually)

async function getQuote(params) {
    try {
        const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
        
        // 1inch Swap API v6.0
        const url = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;

        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${API_KEY}` },
            params: {
                src: params.fromTokenAddress,
                dst: params.toTokenAddress,
                amount: params.fromTokenAmount,
                from: params.userAddress,
                slippage: 0.5,
                // --- FEE INJECTION ---
                fee: FEE_PERCENT, 
                referrer: FEE_RECIPIENT 
            }
        });

        const data = response.data;

        return {
            toAmount: data.dstAmount,
            tx: {
                to: data.tx.to,
                value: data.tx.value,
                data: data.tx.data,
                gasLimit: data.tx.gas
            }
        };
    } catch (e) {
        console.error("[1inch Error]", e.response?.data || e.message);
        return null;
    }
}

module.exports = { getQuote };