// spy_onekey_tx.js
// 🕵️ SPY SCRIPT: Captures the EXACT format OneKey expects for build-tx
const axios = require('axios');

async function spyOnOneKey() {
    console.log("🕵️ SPYING: Fetching a Real Quote from OneKey...");
    
    // 1. Get a Quote (USDC -> ETH on Arbitrum)
    // We use a popular pair to ensure success
    const quoteUrl = "https://swap.onekeycn.com/swap/v1/quote?fromTokenAddress=0xaf88d065e77c8cc2239327c5edb3a432268e5831&toTokenAddress=0x0000000000000000000000000000000000000000&fromTokenAmount=10000000&fromNetworkId=evm--42161&toNetworkId=evm--42161&slippage=1&userAddress=0x5555555555555555555555555555555555555555";
    
    try {
        const quoteResp = await axios.get(quoteUrl);
        const quoteData = quoteResp.data.data[0]; // Get the first quote
        
        if (!quoteData) {
            console.error("❌ Failed to get a quote to test with.");
            return;
        }

        console.log("   ✅ Got Quote! Provider:", quoteData.info.provider);

        // 2. Call build-tx using this Quote
        console.log("\n🕵️ SPYING: Sending Quote to OneKey /build-tx...");
        
        const payload = {
            quoteResultCtx: quoteData.quoteResultCtx,
            userAddress: "0x5555555555555555555555555555555555555555"
        };

        const txResp = await axios.post("https://swap.onekeycn.com/swap/v1/build-tx", payload);
        
        console.log("\nStart ---------------------------------------------------");
        console.log("🔥 THE GOLDEN JSON (This is what the frontend wants):");
        console.log("---------------------------------------------------------");
        console.log(JSON.stringify(txResp.data, null, 2));
        console.log("---------------------------------------------------------End\n");
        
        console.log("🔍 COMPARE THIS JSON TO YOUR server.js '/build-tx' RESPONSE.");
        console.log("   Look closely at:");
        console.log("   1. Is 'value' a hex string (0x...) or decimal?");
        console.log("   2. Is it 'gas' or 'gasLimit'?");
        console.log("   3. Are there extra fields inside 'tx'?");

    } catch (e) {
        console.error("💥 Spy Failed:", e.message);
        if (e.response) console.error(e.response.data);
    }
}

spyOnOneKey();
