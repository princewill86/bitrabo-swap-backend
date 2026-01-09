const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.OKX_API_KEY;
const SECRET_KEY = process.env.OKX_SECRET_KEY;
const PASSPHRASE = process.env.OKX_PASSPHRASE;
const PROJECT_ID = process.env.OKX_PROJECT_ID; 

// Helper to sign OKX requests
function sign(timestamp, method, requestPath, body) {
    const preHash = timestamp + method + requestPath + (body ? JSON.stringify(body) : '');
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    return hmac.update(preHash).digest('base64');
}

async function getQuote(params) {
    try {
        const chainId = parseInt(params.fromNetworkId.replace('evm--', ''));
        const path = `/api/v5/dex/aggregator/swap?chainId=${chainId}&amount=${params.fromTokenAmount}&fromTokenAddress=${params.fromTokenAddress}&toTokenAddress=${params.toTokenAddress}&slippage=0.005&userWalletAddress=${params.userAddress}`;
        
        // Fee params often vary by agreement, but standard is:
        // &feePercent=0.005&feeRecipient=YOUR_WALLET
        // Note: Check your specific OKX integration docs, they sometimes require whitelisting.
        
        const timestamp = new Date().toISOString();
        const signature = sign(timestamp, 'GET', path, null);

        const response = await axios.get(`https://www.okx.com${path}`, {
            headers: {
                'OK-ACCESS-KEY': API_KEY,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': PASSPHRASE,
                'X-Simulated-Trading': '0'
            }
        });

        const data = response.data.data[0]; // OKX returns array

        if (!data || !data.tx) return null;

        return {
            toAmount: data.toTokenAmount,
            estimatedGas: data.tx.gas,
            tx: {
                to: data.tx.to,
                value: data.tx.value,
                data: data.tx.data,
                gasLimit: data.tx.gas
            }
        };
    } catch (e) {
        console.error("[OKX Error]", e.response?.data || e.message);
        return null;
    }
}

module.exports = { getQuote };