const express = require("express");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/db");
const auth = require("../middleware/auth.middleware");
const role = require("../middleware/role.middleware");
const blockchainService = require("../blockchain/blockchainService");

const router = express.Router();

// ---------------------- CREATE WATER BATCH ----------------------
router.post("/", auth, role("PRODUCER", "ADMIN"), async (req, res) => {
  const { quantity, type } = req.body;

  if (!quantity || quantity < 1)
    return res.status(400).json({ error: "Invalid quantity" });

  if (!["BAG", "PACK"].includes(type))
    return res.status(400).json({ error: "Invalid water type" });

  const batch_no = `BAT-${uuidv4()}`;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    console.log("🔵 Starting transaction for batch:", batch_no);

    // 1️⃣ Generate serials off-chain
    const serials = await blockchainService.generateSerials(quantity);
    console.log("✅ Generated", serials.length, "serials");

    // 2️⃣ Build Merkle root
    const { root: merkleRoot } = await blockchainService.buildMerkleTree(
      serials,
    );
    console.log("✅ Merkle root generated:", merkleRoot);

    // 3️⃣ Insert batch into DB
    const [batchResult] = await conn.query(
      `INSERT INTO water_batches (batch_no, quantity, created_by, status, merkle_root)
       VALUES (?, ?, ?, 'CREATED', ?)`,
      [batch_no, quantity, req.user.id, merkleRoot],
    );
    console.log("✅ Batch inserted into DB with ID:", batchResult.insertId);

    // 4️⃣ Bulk insert water packs
    const values = serials.map((s) => [
      s,
      "CREATED",
      req.user.id,
      batch_no,
      type,
    ]);
    const [packsResult] = await conn.query(
      `INSERT INTO water_packs (serial_code, status, created_by, batch_no, type) VALUES ?`,
      [values],
    );
    console.log("✅ Inserted", packsResult.affectedRows, "water packs into DB");

    await conn.commit();
    console.log("✅ Database transaction committed successfully");

    // 5️⃣ Call blockchain via service (handles contract internally)
    let blockchainData = {};
    console.log("🔗 Starting blockchain transaction...");

    try {
      blockchainData = await blockchainService.createBatch(batch_no, quantity);
      console.log("✅ Blockchain transaction completed!");
      console.log(
        "📦 Full blockchain response:",
        JSON.stringify(blockchainData, null, 2),
      );
      console.log("🔑 Transaction Hash:", blockchainData.transactionHash);
      console.log("📍 Block Number:", blockchainData.blockNumber);
    } catch (bcError) {
      console.error("❌ Blockchain call failed for batch", batch_no);
      console.error("❌ Error message:", bcError.message);
      console.error("❌ Full error:", bcError);
      blockchainData = {}; // fallback so UI still gets response
    }

    // 6️⃣ Convert BigInts safely
    console.log("🔄 Converting BigInts to strings...");
    const safeBlockchainData =
      blockchainService.convertBigIntsToStrings(blockchainData);
    console.log(
      "✅ Safe blockchain data:",
      JSON.stringify(safeBlockchainData, null, 2),
    );

    // 7️⃣ Prepare response object
    const responseObject = {
      message: "Batch Created",
      batch_no,
      quantity,
      type,
      serials,
      merkleRoot,
      blockchain: safeBlockchainData.transactionHash || null,
      blockNumber: safeBlockchainData.blockNumber || null,
    };

    console.log("📤 Sending response to frontend:");
    console.log(JSON.stringify(responseObject, null, 2));

    // 8️⃣ Send response to frontend
    res.status(201).json(responseObject);
  } catch (err) {
    await conn.rollback();
    console.error("❌ CREATE BATCH ERROR:", err);
    console.error("❌ Error stack:", err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ---------------------- INSPECTOR QUEUES & ACTIONS ----------------------
// router.get(
//   "/createdUnits",
//   auth,
//   role("INSPECTOR", "ADMIN"),
//   async (req, res) => {
//     try {
//       const [rows] = await pool.query(
//         `SELECT id, serial_code, batch_no, status, produced_at
//        FROM water_packs
//        WHERE status = 'CREATED'
//        ORDER BY produced_at ASC`,
//       );
//       res.json(rows);
//     } catch (err) {
//       console.error(err);
//       res.status(500).json({ error: "Failed to fetch inspection queue" });
//     }
//   },
// );

router.get(
  "/createdBatch",
  auth,
  role("INSPECTOR", "ADMIN"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`
        SELECT 
          batch_no,
          quantity,
          status,
          created_at
        FROM water_batches
        WHERE status = 'CREATED'
        ORDER BY created_at ASC
      `);
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch created batches" });
    } finally {
      conn.release();
    }
  },
);

// Approve water pack (DB only)
// router.patch(
//   "/:serial/approve",
//   auth,
//   role("INSPECTOR", "ADMIN"),
//   async (req, res) => {
//     try {
//       const [rows] = await pool.query(
//         `SELECT * FROM water_packs WHERE serial_code = ?`,
//         [req.params.serial],
//       );

//       if (rows.length === 0) {
//         return res.status(404).json({ error: "Serial not found" });
//       }

//       const pack = rows[0];
//       if (pack.status !== "CREATED") {
//         return res
//           .status(400)
//           .json({ error: `Pack cannot be approved in status ${pack.status}` });
//       }

//       const [result] = await pool.query(
//         `UPDATE water_packs SET status = 'APPROVED', inspected_at = NOW() WHERE serial_code = ?`,
//         [req.params.serial],
//       );

//       res.json({
//         message: "Water pack approved (DB only)",
//         serial: req.params.serial,
//       });
//     } catch (err) {
//       console.error("Approve error:", err);
//       res.status(500).json({ error: err.message });
//     }
//   },
// );

// Approve entire batch
router.patch(
  "/batch/:batch_no/approve",
  auth,
  role("INSPECTOR", "ADMIN"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1️⃣ Fetch batch from DB
      const [[batch]] = await conn.query(
        `SELECT * FROM water_batches WHERE batch_no = ?`,
        [req.params.batch_no],
      );
      if (!batch) throw new Error("Batch not found in DB");
      if (batch.status !== "CREATED")
        throw new Error("Batch cannot be approved");

      // 2️⃣ Update batch status in DB
      await conn.query(
        `UPDATE water_batches SET status = 'APPROVED' WHERE batch_no = ?`,
        [req.params.batch_no],
      );
      await conn.query(
        `UPDATE water_packs SET status = 'APPROVED', inspected_at = NOW() WHERE batch_no = ?`,
        [req.params.batch_no],
      );

      // 3️⃣ Blockchain call (non-blocking)
      let blockchainResult = null;
      try {
        // Ensure batch exists on-chain before approving
        const onChainBatch = await blockchainService.getBatch(batch.batch_no);
        if (!onChainBatch.exists) {
          await blockchainService.createBatch(batch.batch_no, batch.quantity);
        }

        blockchainResult = await blockchainService.approveBatch(batch.batch_no);
      } catch (bcError) {
        console.warn(
          `Blockchain approve failed for batch ${batch.batch_no}:`,
          bcError.message,
        );
      }

      await conn.commit();
      res.json({
        message: `Batch ${batch.batch_no} approved`,
        batchStatus: "APPROVED",
        blockchain: blockchainService.convertBigIntsToStrings(blockchainResult),
      });
    } catch (err) {
      await conn.rollback();
      console.error("Approve batch error:", err);
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  },
);

// Reject water pack (DB only)
// router.patch(
//   "/:serial/reject",
//   auth,
//   role("INSPECTOR", "ADMIN"),
//   async (req, res) => {
//     try {
//       const { reason } = req.body;
//       if (!reason || reason.trim() === "") {
//         return res.status(400).json({ error: "Rejection reason is required" });
//       }

//       const [rows] = await pool.query(
//         `SELECT * FROM water_packs WHERE serial_code = ?`,
//         [req.params.serial],
//       );

//       if (rows.length === 0) {
//         return res.status(404).json({ error: "Serial not found" });
//       }

//       const pack = rows[0];
//       if (pack.status !== "CREATED") {
//         return res
//           .status(400)
//           .json({ error: `Pack cannot be rejected in status ${pack.status}` });
//       }

//       const [result] = await pool.query(
//         `UPDATE water_packs SET status = 'REJECTED', rejection_reason = ?, inspected_at = NOW() WHERE serial_code = ?`,
//         [reason, req.params.serial],
//       );

//       res.json({
//         message: "Water pack rejected (DB only)",
//         serial: req.params.serial,
//         reason,
//       });
//     } catch (err) {
//       console.error("Reject error:", err);
//       res.status(500).json({ error: err.message });
//     }
//   },
// );

// Reject water batch with partial handling
router.patch(
  "/batch/:batch_no/reject",
  auth,
  role("INSPECTOR", "ADMIN"),
  async (req, res) => {
    const { reason } = req.body;
    if (!reason?.trim())
      return res.status(400).json({ error: "Rejection reason required" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1️⃣ Fetch batch from DB
      const [[batch]] = await conn.query(
        `SELECT * FROM water_batches WHERE batch_no = ?`,
        [req.params.batch_no],
      );
      if (!batch) throw new Error("Batch not found in DB");
      if (batch.status !== "CREATED")
        throw new Error("Batch cannot be rejected");

      // 2️⃣ Update batch & packs in DB
      await conn.query(
        `UPDATE water_batches SET status = 'REJECTED', rejection_reason = ? WHERE batch_no = ?`,
        [reason, req.params.batch_no],
      );
      await conn.query(
        `UPDATE water_packs SET status = 'REJECTED', rejection_reason = ?, inspected_at = NOW() WHERE batch_no = ?`,
        [reason, req.params.batch_no],
      );

      // 3️⃣ Blockchain call (non-blocking)
      let blockchainResult = null;
      try {
        // Ensure batch exists on-chain
        const onChainBatch = await blockchainService.getBatch(batch.batch_no);
        if (!onChainBatch.exists) {
          await blockchainService.createBatch(batch.batch_no, batch.quantity);
        }

        blockchainResult = await blockchainService.rejectBatch(
          batch.batch_no,
          reason,
        );
      } catch (bcError) {
        console.warn(
          `Blockchain reject failed for batch ${batch.batch_no}:`,
          bcError.message,
        );
      }

      await conn.commit();
      res.json({
        message: `Batch ${batch.batch_no} rejected`,
        batchStatus: "REJECTED",
        blockchain: blockchainService.convertBigIntsToStrings(blockchainResult),
      });
    } catch (err) {
      await conn.rollback();
      console.error("Reject batch error:", err);
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  },
);

// ---------------------- DISTRIBUTOR QUEUES & ACTIONS ----------------------
router.get(
  "/approvedBatch",
  auth,
  role("DISTRIBUTOR", "ADMIN"),
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT batch_no, COUNT(*) AS approved_units
         FROM water_packs
         WHERE status = 'APPROVED'
         GROUP BY batch_no
         HAVING approved_units > 0
         ORDER BY batch_no ASC`,
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch distribute queue" });
    }
  },
);

router.patch(
  "/batch/:batch_no/distribute",
  auth,
  role("DISTRIBUTOR", "ADMIN"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[batch]] = await conn.query(
        `SELECT * FROM water_batches WHERE batch_no = ?`,
        [req.params.batch_no],
      );
      if (!batch) throw new Error("Batch not found");
      if (batch.status !== "APPROVED")
        throw new Error("Batch must be APPROVED before distribution");

      // Check if batch exists on blockchain, create if it doesn't
      let onChainBatch;
      try {
        onChainBatch = await blockchainService.getBatch(batch.batch_no);
        console.log("📦 Batch on-chain status:", onChainBatch);

        // If batch doesn't exist on-chain, create it
        if (!onChainBatch.exists || onChainBatch.quantity === "0") {
          console.log("⚠️ Batch not on blockchain, creating it first...");
          await blockchainService.createBatch(batch.batch_no, batch.quantity);

          // Then approve it on-chain to match DB state
          console.log("✅ Approving batch on blockchain...");
          await blockchainService.approveBatch(batch.batch_no);
        }
      } catch (bcError) {
        console.warn("⚠️ Blockchain check/creation failed:", bcError.message);
        // Try to create and approve anyway
        try {
          await blockchainService.createBatch(batch.batch_no, batch.quantity);
          await blockchainService.approveBatch(batch.batch_no);
        } catch (retryError) {
          console.error("❌ Retry failed:", retryError.message);
        }
      }

      // Now distribute on blockchain
      const tx = await blockchainService.distributeBatch(batch.batch_no);

      // Update database
      await conn.query(
        `UPDATE water_packs SET status = 'DISTRIBUTED', distributed_tx = ?, distributed_at = NOW() WHERE batch_no = ? AND status = 'APPROVED'`,
        [tx.transactionHash, batch.batch_no],
      );

      await conn.query(
        `UPDATE water_batches SET status = 'DISTRIBUTED' WHERE batch_no = ?`,
        [batch.batch_no],
      );

      await conn.commit();
      res.json({
        message: "Batch distributed",
        blockchain: blockchainService.convertBigIntsToStrings(tx),
      });
    } catch (err) {
      await conn.rollback();
      console.error("❌ Distribute batch error:", err);
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  },
);

router.get(
  "/distributedBatch",
  auth,
  role("DISTRIBUTOR", "ADMIN"),
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT batch_no, COUNT(*) AS distributed_units
         FROM water_packs
         WHERE status = 'DISTRIBUTED'
         GROUP BY batch_no
         ORDER BY batch_no ASC`,
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch sell queue" });
    }
  },
);

router.patch(
  "/batch/:batch_no/sell",
  auth,
  role("DISTRIBUTOR", "ADMIN"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[batch]] = await conn.query(
        `SELECT * FROM water_batches WHERE batch_no = ?`,
        [req.params.batch_no],
      );
      if (!batch) throw new Error("Batch not found");
      if (batch.status !== "DISTRIBUTED")
        throw new Error("Batch must be DISTRIBUTED before selling");

      const [[count]] = await conn.query(
        `SELECT COUNT(*) AS total
         FROM water_packs
         WHERE batch_no = ? AND status = 'DISTRIBUTED'`,
        [req.params.batch_no],
      );
      if (!count.total) throw new Error("No DISTRIBUTED units to sell");

      // Check and sync blockchain state
      let onChainBatch;
      try {
        onChainBatch = await blockchainService.getBatch(batch.batch_no);
        console.log("📦 On-chain batch status:", onChainBatch);

        // Convert BigInt status to number for comparison
        const blockchainStatus = Number(onChainBatch.status);
        const BLOCKCHAIN_STATUS = {
          CREATED: 0,
          INSPECTING: 1,
          APPROVED: 2,
          PARTIALLY_REJECTED: 3,
          REJECTED: 4,
          DISTRIBUTED: 5,
          SOLD: 6,
        };

        if (!onChainBatch.exists || onChainBatch.totalUnits === "0") {
          console.log(
            "⚠️ Batch doesn't exist on blockchain, creating full state...",
          );
          await blockchainService.createBatch(batch.batch_no, batch.quantity);
          await blockchainService.approveBatch(batch.batch_no);
          await blockchainService.distributeBatch(batch.batch_no);
        } else if (blockchainStatus < BLOCKCHAIN_STATUS.DISTRIBUTED) {
          console.log(
            `⚠️ Batch on blockchain is in status ${blockchainStatus}, need to sync to DISTRIBUTED...`,
          );

          // Sync to DISTRIBUTED state
          if (blockchainStatus < BLOCKCHAIN_STATUS.APPROVED) {
            console.log("  → Approving batch...");
            await blockchainService.approveBatch(batch.batch_no);
          }

          if (blockchainStatus < BLOCKCHAIN_STATUS.DISTRIBUTED) {
            console.log("  → Distributing batch...");
            await blockchainService.distributeBatch(batch.batch_no);
          }
        } else if (blockchainStatus === BLOCKCHAIN_STATUS.SOLD) {
          console.log("⚠️ Batch already sold on blockchain");
          // Update DB to match blockchain
          await conn.query(
            `UPDATE water_packs SET status = 'SOLD', sold_at = NOW() WHERE batch_no = ? AND status = 'DISTRIBUTED'`,
            [req.params.batch_no],
          );
          await conn.query(
            `UPDATE water_batches SET status = 'SOLD' WHERE batch_no = ?`,
            [req.params.batch_no],
          );
          await conn.commit();

          return res.json({
            message: `Batch ${req.params.batch_no} was already sold on blockchain`,
            soldUnits: count.total,
            batchStatus: "SOLD",
            blockchain: { note: "Already sold on blockchain" },
          });
        }
      } catch (bcError) {
        console.error("❌ Blockchain state check failed:", bcError);
        throw new Error(`Blockchain sync failed: ${bcError.message}`);
      }

      // Now sell on blockchain
      console.log("💰 Selling batch on blockchain...");
      const tx = await blockchainService.sellBatch(req.params.batch_no);
      console.log("✅ Sell transaction successful:", tx.transactionHash);

      const [result] = await conn.query(
        `UPDATE water_packs
         SET status = 'SOLD', sold_tx = ?, sold_at = NOW()
         WHERE batch_no = ? AND status = 'DISTRIBUTED'`,
        [tx.transactionHash, req.params.batch_no],
      );

      await conn.query(
        `UPDATE water_batches SET status = 'SOLD' WHERE batch_no = ?`,
        [req.params.batch_no],
      );

      await conn.commit();

      res.json({
        message: `Batch ${req.params.batch_no} sold successfully`,
        soldUnits: result.affectedRows,
        batchStatus: "SOLD",
        blockchain: blockchainService.convertBigIntsToStrings(tx),
      });
    } catch (err) {
      await conn.rollback();
      console.error("❌ Sell batch error:", err);
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  },
);

// ---------------------- PUBLIC VERIFICATION ----------------------
router.get("/verify/:serial", async (req, res) => {
  try {
    const [[pack]] = await pool.query(
      `SELECT * FROM water_packs WHERE serial_code = ?`,
      [req.params.serial],
    );

    if (!pack) {
      return res.status(404).json({ error: "Water pack not found" });
    }

    // Fetch batch info
    const [[batch]] = await pool.query(
      `SELECT batch_no, merkle_root, status FROM water_batches WHERE batch_no = ?`,
      [pack.batch_no],
    );

    if (!batch) {
      return res.status(404).json({ error: "Batch not found" });
    }

    // Fetch all serials for Merkle proof
    const [batchSerials] = await pool.query(
      `SELECT serial_code FROM water_packs WHERE batch_no = ?`,
      [pack.batch_no],
    );
    const serials = batchSerials.map((r) => r.serial_code);

    // Try blockchain verification with detailed error handling
    let verified = false;
    let blockchainError = null;

    try {
      console.log(
        "🔍 Attempting blockchain verification for:",
        pack.serial_code,
      );
      console.log("   Batch:", pack.batch_no);
      console.log("   Total serials in batch:", serials.length);

      verified = await blockchainService.verifyWaterPack(
        pack.serial_code,
        pack.batch_no,
        serials,
      );

      console.log("✅ Blockchain verification result:", verified);
    } catch (err) {
      blockchainError = err.message;
      console.error("❌ Blockchain verification failed:", err.message);
      console.error("   Full error:", err);
      // Don't fail the entire request - continue with DB-based verification
    }

    // Determine safety status - prioritize DB state over blockchain verification
    let safetyStatus = "UNKNOWN";
    let message = "";

    // If blockchain verification failed but pack is in good state in DB, trust DB
    if (pack.status === "REJECTED") {
      safetyStatus = "UNSAFE";
      message = pack.rejection_reason || "This water pack failed inspection.";
    } else if (pack.status === "SOLD") {
      safetyStatus = "SAFE";
      message = "This water pack has been sold and is safe for consumption.";
    } else if (pack.status === "DISTRIBUTED") {
      safetyStatus = "SAFE";
      message = "This water pack has been distributed and is safe for use.";
    } else if (pack.status === "APPROVED") {
      // APPROVED is SAFE even if blockchain verification fails
      // (blockchain might not have the batch yet if approval just happened)
      safetyStatus = "SAFE";
      message =
        "This water pack passed inspection and is safe for consumption.";
    } else if (pack.status === "CREATED") {
      safetyStatus = "SUSPICIOUS";
      message = "This water pack is produced but not yet inspected.";
    } else if (!verified && !pack.status) {
      // Only mark as UNRECOGNIZED if truly not in our system
      safetyStatus = "UNRECOGNIZED";
      message = "This water pack could not be verified.";
    }

    res.json({
      verified,
      safetyStatus,
      message,
      batch_no: pack.batch_no,
      blockchainError: blockchainError || null, // Include error for debugging
      lifecycle: {
        serial_code: pack.serial_code,
        status: pack.status,
        rejection_reason: pack.rejection_reason || null,
        produced_at: pack.produced_at,
        inspected_at: pack.inspected_at,
        distributed_at: pack.distributed_at,
        sold_at: pack.sold_at,
        distributed_tx: pack.distributed_tx || null,
        sold_tx: pack.sold_tx || null,
      },
    });
  } catch (err) {
    console.error("❌ Verification endpoint error:", err);
    res.status(500).json({
      error: "Failed to verify water pack",
      details: err.message,
    });
  }
});

// ---------------------- PUBLIC REPORTING ----------------------
router.post("/report", async (req, res) => {
  const { batch_no, serial_code, reason, reported_by_name, reported_by_email } = req.body;

  if (!reason || reason.trim() === "") {
    return res.status(400).json({ error: "Reason is required" });
  }

  try {
    // Verify batch exists if provided
    if (batch_no) {
      const [[batch]] = await pool.query(
        "SELECT batch_no FROM water_batches WHERE batch_no = ?",
        [batch_no]
      );
      if (!batch) {
        return res.status(404).json({ error: "Batch not found" });
      }
    }

    // Verify serial exists if provided
    if (serial_code) {
      const [[pack]] = await pool.query(
        "SELECT serial_code FROM water_packs WHERE serial_code = ?",
        [serial_code]
      );
      if (!pack) {
        return res.status(404).json({ error: "Serial code not found" });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO water_reports (batch_no, serial_code, reason, reported_by_name, reported_by_email) 
       VALUES (?, ?, ?, ?, ?)`,
      [
        batch_no || null, 
        serial_code || null, 
        reason, 
        reported_by_name || "Anonymous",
        reported_by_email || null
      ]
    );

    res.status(201).json({
      message: "Report submitted successfully",
      reportId: result.insertId,
    });
  } catch (err) {
    console.error("Report submission error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------- BLOCKCHAIN STATS ----------------------
router.get("/stats", async (req, res) => {
  try {
    const total = await blockchainService.getTotalWaterPacks();
    res.json({
      totalWaterPacks: blockchainService.convertBigIntsToStrings(total),
      blockchainNetwork: process.env.BLOCKCHAIN_NETWORK || "localhost",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
