const axios = require('axios');

const API_KEY = process.env.CHANGEHERO_API_KEY;

async function getQuote(params) {
    try {
        // ChangeHero usually requires Ticker symbols (BTC, ETH), not addresses.
        // You might need a token map if params only has addresses.
        // Assuming params has symbols from your frontend request if available, 
        // or we default to a simple lookup or skip if we can't map.
        
        const fromSymbol = params.fromTokenInfo?.symbol; // You need to ensure these are passed
        const toSymbol = params.toTokenInfo?.symbol;

        if (!fromSymbol || !toSymbol) return null;

        const url = `https://api.changehero.io/v2/exchange-amount`;
        
        const response = await axios.get(url, {
            params: {
                api_key: API_KEY,
                from: fromSymbol.toLowerCase(),
                to: toSymbol.toLowerCase(),
                amount: ethers.formatUnits(params.fromTokenAmount, params.fromTokenInfo.decimals) // They usually take human readable numbers
            }
        });

        const data = response.data;
        
        // ChangeHero gives you a rate. To get the transaction, you essentially "Deposit" to them.
        // We simulate the transaction as a transfer to their hot wallet (if they provide one in a 'create transaction' endpoint)
        // Or if this is just a rate check:
        
        // NOTE: Actual Swap requires hitting their "create transaction" endpoint which returns a deposit address.
        // For the QUOTE phase, we just return the rate.
        
        return {
            toAmount: ethers.parseUnits(data.estimated_amount, params.toTokenInfo.decimals).toString(),
            tx: null // We build this in the /build-tx phase by calling createTransaction
        };
    } catch (e) {
        return null;
    }
}

module.exports = { getQuote };