const axios = require('axios');

// Config
const INTEGRATOR = process.env.LIFI_INTEGRATOR || 'bitrabo';
const FEE_PERCENT = 0.005; // 0.5% (Matches your other providers)
const FEE_WALLET = process.env.BITRABO_FEE_RECEIVER; 

async function getQuote(params) {
    try {
        const fromChain = parseInt(params.fromNetworkId.replace('evm--', ''));
        const toChain = parseInt(params.toNetworkId.replace('evm--', ''));
        
        // Li.Fi API URL
        const url = 'https://li.fi/v1/quote';

        const response = await axios.get(url, {
            params: {
                fromChain: fromChain,
                toChain: toChain,
                fromToken: params.fromTokenAddress,
                toToken: params.toTokenAddress,
                fromAmount: params.fromTokenAmount,
                fromAddress: params.userAddress,
                slippage: 0.005, // 0.5% slippage
                // --- FEE INJECTION ---
                integrator: INTEGRATOR,
                fee: FEE_PERCENT,
                referrer: FEE_WALLET
            }
        });

        const data = response.data;

        // Normalize response to match your server's standard format
        return {
            toAmount: data.estimate.toAmount,
            estimatedGas: data.estimate.gasCosts?.[0]?.amount || 500000,
            // Li.Fi returns the transaction object directly in the quote response
            tx: {
                to: data.transactionRequest.to,
                value: data.transactionRequest.value,
                data: data.transactionRequest.data,
                gasLimit: data.transactionRequest.gasLimit
            }
        };

    } catch (e) {
        // If Li.Fi bans us (429), we return null so the main server can use the Mock fallback
        console.error("[Li.Fi Error]", e.response?.data?.message || e.message);
        return null;
    }
}

module.exports = { getQuote };
