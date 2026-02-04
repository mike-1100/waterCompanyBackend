// blockchainService.js
const { Web3 } = require("web3");
require("dotenv").config();
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const { v4: uuidv4 } = require("uuid");

// Contract ABI (from compiled Solidity contract)
const contractJson = require("../artifacts/contracts/WaterPackTracker.sol/WaterPackTracker.json");
const CONTRACT_ABI = contractJson.abi;

class BlockchainService {
  constructor() {
    // Connect to blockchain network
    // For development: Use Ganache or Hardhat local network
    // For testnet: Use Sepolia, Goerli, etc.
    this.web3 = new Web3(
      process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545",
    );

    // Contract address (deploy your contract first and add address here)
    this.contractAddress = process.env.CONTRACT_ADDRESS;

    // Admin wallet private key (NEVER commit this to git!)
    this.adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;

    if (!this.contractAddress) {
      throw new Error("Missing CONTACT_ADDRESS");
    }
    this.contract = new this.web3.eth.Contract(
      CONTRACT_ABI,
      this.contractAddress,
    );
  }

  convertBigIntsToStrings(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "bigint") return obj.toString();
    if (Array.isArray(obj))
      return obj.map((item) => this.convertBigIntsToStrings(item));
    if (typeof obj === "object") {
      const newObj = {};
      for (const key in obj) {
        newObj[key] = this.convertBigIntsToStrings(obj[key]);
      }
      return newObj;
    }
    return obj;
  }

  async getAccount() {
    const account = this.web3.eth.accounts.privateKeyToAccount(
      this.adminPrivateKey,
    );
    if (!this.web3.eth.accounts.wallet[account.address]) {
      this.web3.eth.accounts.wallet.add(account);
    }
    return account.address;
  }

  async generateSerials(quantity) {
    return Array.from({ length: quantity }, () => `WAT-${uuidv4()}`);
  }

  async buildMerkleTree(serials) {
    const leaves = serials.map((s) => keccak256(s));
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    return {
      tree,
      root: "0x" + tree.getRoot().toString("hex"),
    };
  }

  async getBatch(batch_no) {
    try {
      // Assuming your smart contract has a method getBatchDetails(batch_no)
      const batch = await this.contract.methods
        .getBatchDetails(batch_no)
        .call();
      return batch;
    } catch (error) {
      throw new Error(`Failed to get batch ${batch_no}: ${error.message}`);
    }
  }

  async createBatch(batch_no, quantity) {
    try {
      console.log("🔗 BlockchainService.createBatch called");
      console.log("   Batch No:", batch_no);
      console.log("   Quantity:", quantity);

      const account = await this.getAccount();
      console.log("✅ Account retrieved:", account);

      const serials = await this.generateSerials(quantity);
      console.log("✅ Serials generated:", serials.length);

      const { root } = await this.buildMerkleTree(serials);
      console.log("✅ Merkle root:", root);

      console.log("📡 Sending transaction to blockchain...");
      const receipt = await this.contract.methods
        .createBatch(batch_no, root, quantity)
        .send({ from: account, gas: 700000 });

      console.log("✅ Raw receipt received from blockchain:");
      console.log(
        JSON.stringify(
          receipt,
          (key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          2,
        ),
      );

      const safeReceipt = this.convertBigIntsToStrings(receipt);
      console.log("✅ Safe receipt after BigInt conversion:");
      console.log(JSON.stringify(safeReceipt, null, 2));

      const result = {
        transactionHash: safeReceipt.transactionHash,
        blockNumber: safeReceipt.blockNumber,
        batch_no,
        serials,
        merkleRoot: root,
      };

      console.log("📦 Returning result:");
      console.log(JSON.stringify(result, null, 2));

      return result;
    } catch (error) {
      console.error("❌ Blockchain transaction failed:", error);
      throw new Error(`Blockchain transaction failed: ${error.message}`);
    }
  }

  async approveBatch(batch_no) {
    try {
      const account = await this.getAccount();
      const tx = await this.contract.methods
        .approveBatch(batch_no)
        .send({ from: account, gas: 500000 });
      const receipt = await this.web3.eth.getTransactionReceipt(
        tx.transactionHash,
      );
      return {
        success: true,
        transactionHash: tx.transactionHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      throw new Error(`Approve batch failed ${err.message}`);
    }
  }

  async rejectBatch(batch_no, reason) {
    try {
      const account = await this.getAccount();

      const tx = await this.contract.methods
        .rejectBatch(batch_no, reason)
        .send({
          from: account,
          gas: 500000,
        });

      const receipt = await this.web3.eth.getTransactionReceipt(
        tx.transactionHash,
      );
      return {
        success: true,
        transactionHash: tx.transactionHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      throw new Error(`Reject failed: ${error.message}`);
    }
  }

  async distributeBatch(batch_no) {
    try {
      const account = await this.getAccount();
      const tx = await this.contract.methods
        .distributeBatch(batch_no)
        .send({ from: account, gas: 400000 });
      const receipt = await this.web3.eth.getTransactionReceipt(
        tx.transactionHash,
      );
      return {
        success: true,
        transactionHash: tx.transactionHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      throw new Error(`Distribute batch failed: ${err.message}`);
    }
  }

  async sellBatch(batch_no) {
    try {
      console.log("💰 sellBatch called for:", batch_no);

      const account = await this.getAccount();
      console.log("✅ Account:", account);

      // First, let's check the current status on-chain
      try {
        const batchDetails = await this.contract.methods
          .getBatchDetails(batch_no)
          .call();
        console.log("📦 Current batch details on blockchain:");
        console.log("   - Status:", batchDetails.status.toString());
        console.log("   - Exists:", batchDetails.exists);
        console.log("   - Total Units:", batchDetails.totalUnits.toString());
      } catch (err) {
        console.error("⚠️ Could not fetch batch details:", err.message);
      }

      // Try to call the function
      console.log("📡 Attempting to sell batch...");
      const tx = await this.contract.methods
        .sellBatch(batch_no)
        .send({ from: account, gas: 400000 });

      console.log("✅ Sell transaction succeeded!");

      const receipt = await this.web3.eth.getTransactionReceipt(
        tx.transactionHash,
      );
      return {
        success: true,
        transactionHash: tx.transactionHash,
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      console.error("❌ sellBatch detailed error:");
      console.error("   - Error message:", err.message);
      console.error("   - Error data:", err.data);
      console.error("   - Error reason:", err.reason);
      console.error("   - Full error:", JSON.stringify(err, null, 2));
      throw new Error(`Sell batch failed: ${err.message}`);
    }
  }

  async verifyWaterPack(serial, batch_no, serials) {
    // Build Merkle Tree from off-chain serials
    const { tree, root } = await this.buildMerkleTree(serials);

    // Generate Merkle proof for the specific serial
    const leaf = keccak256(serial);
    const proof = tree.getProof(leaf).map((x) => "0x" + x.data.toString("hex"));

    // Call the smart contract to verify using the batch's Merkle root
    //    Only the Merkle root is stored on-chain, serials are off-chain
    return await this.contract.methods
      .verifyWaterPack(serial, batch_no, proof)
      .call();
  }

  async verifyBatch(batch_no, serials = []) {
    const leaves = serials.map((s) => keccak256(s));
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });

    const results = {};
    for (const serial of serials) {
      const proof = tree
        .getProof(keccak256(serial))
        .map((x) => "0x" + x.data.toString("hex"));
      results[serial] = await this.contract.methods
        .verifyWaterPack(serial, batch_no, proof)
        .call();
    }
    return results;
  }

  async getTotalWaterPacks() {
    try {
      const total = await this.contract.methods.getTotalWaterPacks().call();
      return Number(total);
    } catch (error) {
      throw new Error(`Failed to get total: ${error.message}`);
    }
  }
}

module.exports = new BlockchainService();
