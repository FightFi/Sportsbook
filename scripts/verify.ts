import { ethers } from "ethers";
import hre from "hardhat";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Verification script for Sportsbook contracts on BSC
 * 
 * This script verifies the deployed contracts on BSCScan
 * 
 * Usage:
 *   npx hardhat run scripts/verify.ts --network bscTestnet
 *   npx hardhat run scripts/verify.ts --network bsc
 * 
 * Required environment variables:
 *   - BSCSCAN_API_KEY (API key from BSCScan)
 *   - IMPLEMENTATION_ADDRESS (address of the Sportsbook implementation)
 *   - PROXY_ADDRESS (address of the ERC1967Proxy)
 *   - INIT_DATA (optional, initialization data if needed)
 */

async function main() {
  // Get network info
  const networkName = process.env.HARDHAT_NETWORK || (hre.network as any)?.name || "bscTestnet";
  
  // Get provider from hardhat config
  const rpcUrl = process.env.BSC_TESTNET_RPC_URL || process.env.BSC_RPC_URL || 
    (networkName === "bscTestnet" ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed1.binance.org");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  console.log(`Verifying contracts on network: ${networkName} (chainId: ${network.chainId})`);

  // Get contract addresses from environment
  const implementationAddress = process.env.IMPLEMENTATION_ADDRESS;
  const proxyAddress = process.env.PROXY_ADDRESS;
  const initData = process.env.INIT_DATA || "";

  if (!implementationAddress) {
    throw new Error("IMPLEMENTATION_ADDRESS environment variable is required");
  }

  if (!proxyAddress) {
    throw new Error("PROXY_ADDRESS environment variable is required");
  }

  const bscscanApiKey = process.env.BSCSCAN_API_KEY;
  if (!bscscanApiKey) {
    throw new Error("BSCSCAN_API_KEY environment variable is required for verification");
  }

  console.log(`\nConfiguration:`);
  console.log(`  Implementation: ${implementationAddress}`);
  console.log(`  Proxy: ${proxyAddress}`);
  if (initData) {
    console.log(`  Init Data: ${initData}`);
  }

  // Verify implementation
  console.log(`\n1. Verifying implementation contract...`);
  try {
    // @ts-ignore - verify task is added by @nomicfoundation/hardhat-verify plugin
    await hre.run("verify:verify", {
      address: implementationAddress,
      constructorArguments: [],
    });
    console.log(`   ✅ Implementation verified successfully!`);
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    if (errorMessage.includes("Already Verified") || errorMessage.includes("already verified")) {
      console.log(`   ℹ️  Implementation already verified`);
    } else {
      console.log(`   ⚠️  Failed to verify implementation: ${errorMessage}`);
      console.log(`   You can verify manually with:`);
      console.log(`   npx hardhat verify --network ${networkName} ${implementationAddress}`);
    }
  }

  // Verify proxy
  console.log(`\n2. Verifying proxy contract...`);
  try {
    // For proxy verification, we need to provide constructor arguments
    // The proxy constructor takes (implementation, initData)
    const constructorArgs = initData 
      ? [implementationAddress, initData]
      : [implementationAddress, "0x"];

    // @ts-ignore - verify task is added by @nomicfoundation/hardhat-verify plugin
    await hre.run("verify:verify", {
      address: proxyAddress,
      constructorArguments: constructorArgs,
    });
    console.log(`   ✅ Proxy verified successfully!`);
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    if (errorMessage.includes("Already Verified") || errorMessage.includes("already verified")) {
      console.log(`   ℹ️  Proxy already verified`);
    } else {
      console.log(`   ⚠️  Failed to verify proxy: ${errorMessage}`);
      console.log(`   You can verify manually with:`);
      console.log(`   npx hardhat verify --network ${networkName} ${proxyAddress} ${implementationAddress} ${initData || "0x"}`);
    }
  }

  console.log(`\n✅ Verification process complete!`);
  const explorerUrl = networkName === "bscTestnet" 
    ? `https://testnet.bscscan.com/address/${proxyAddress}`
    : `https://bscscan.com/address/${proxyAddress}`;
  console.log(`\nView contracts on BSCScan:`);
  console.log(`  Implementation: ${explorerUrl.replace(proxyAddress, implementationAddress)}`);
  console.log(`  Proxy: ${explorerUrl}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

