const axios = require('axios');

const FEE_ACCOUNT = process.env.JUPITER_FEE_ACCOUNT; // Your Referral Public Key
const FEE_BPS = 50; // 0.5% (Basis Points)

async function getQuote(params) {
    try {
        // Only run if Solana
        if (!params.fromNetworkId.includes('sol')) return null;

        const url = `https://quote-api.jup.ag/v6/quote`;
        
        const response = await axios.get(url, {
            params: {
                inputMint: params.fromTokenAddress,
                outputMint: params.toTokenAddress,
                amount: params.fromTokenAmount,
                slippageBps: 50,
                // --- FEE INJECTION ---
                platformFeeBps: FEE_BPS 
                // Note: You must also pass your feeAccount in the 'swap' POST request later
            }
        });

        const data = response.data;

        return {
            toAmount: data.outAmount,
            // Jupiter returns a transaction in the NEXT step (/swap), not quote.
            // We return data to pass to build-tx.
            jupiterQuote: data 
        };
    } catch (e) {
        return null;
    }
}

module.exports = { getQuote };