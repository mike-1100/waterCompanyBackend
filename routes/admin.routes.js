const express = require("express");
const pool = require("../db/db");
const auth = require("../middleware/auth.middleware");
const role = require("../middleware/role.middleware");
const bcrypt = require("bcryptjs");

const router = express.Router();

// ---------------------- USER MANAGEMENT ----------------------
router.post("/users", auth, role("ADMIN"), async (req, res) => {
  const { name, email, password, role: userRole } = req.body;

  if (!name || !email || !password || !userRole) {
    return res.status(400).json({ error: "All fields required" });
  }

  if (!["PRODUCER", "INSPECTOR", "DISTRIBUTOR", "ADMIN"].includes(userRole)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  try {
    // Check if email already exists
    const [[existing]] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email],
    );

    if (existing) {
      return res.status(400).json({ error: "Email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate UUID
    const { v4: uuidv4 } = require("uuid");
    const userId = uuidv4();

    // Create user
    const [result] = await pool.query(
      "INSERT INTO users (uuid, name, email, password_hash, role, approved) VALUES (?, ?, ?, ?, ?, 1)",
      [userId, name, email, hashedPassword, userRole],
    );

    res.status(201).json({
      message: "User created successfully",
      userId: result.insertId,
      name,
      email,
      role: userRole,
    });
  } catch (err) {
    console.error("Create user error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all users (excluding passwords)
router.get("/users", auth, role("ADMIN"), async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, uuid, name, email, role, approved, created_at FROM users ORDER BY created_at DESC",
    );
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ---------------------- SYSTEM STATISTICS ----------------------
router.get("/stats", auth, role("ADMIN"), async (req, res) => {
  try {
    // Total users
    const [[{ totalUsers }]] = await pool.query(
      "SELECT COUNT(*) as totalUsers FROM users",
    );

    // Active batches (not SOLD or REJECTED)
    const [[{ activeBatches }]] = await pool.query(
      `SELECT COUNT(*) as activeBatches 
       FROM water_batches 
       WHERE status NOT IN ('SOLD', 'REJECTED')`,
    );

    // Pending reports
    const [[{ pendingReports }]] = await pool.query(
      "SELECT COUNT(*) as pendingReports FROM water_reports WHERE status = 'PENDING'",
    );

    // Total batches created
    const [[{ totalBatches }]] = await pool.query(
      "SELECT COUNT(*) as totalBatches FROM water_batches",
    );

    // Total water packs
    const [[{ totalPacks }]] = await pool.query(
      "SELECT COUNT(*) as totalPacks FROM water_packs",
    );

    // Status breakdown
    const [statusBreakdown] = await pool.query(
      `SELECT status, COUNT(*) as count 
       FROM water_batches 
       GROUP BY status`,
    );

    res.json({
      totalUsers,
      activeBatches,
      pendingReports,
      totalBatches,
      totalPacks,
      statusBreakdown,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// ---------------------- REPORTS MANAGEMENT ----------------------

// Get all reports
router.get("/reports", auth, role("ADMIN"), async (req, res) => {
  const { status } = req.query;

  try {
    let query = `
      SELECT 
        r.*,
        wb.status as batch_status,
        resolver.name as resolved_by_name
      FROM water_reports r
      LEFT JOIN water_batches wb ON r.batch_no = wb.batch_no
      LEFT JOIN users resolver ON r.resolved_by = resolver.id
    `;

    const params = [];

    // Only filter by status if it's provided and not "ALL"
    if (status && status !== "ALL") {
      query += " WHERE r.status = ?";
      params.push(status);
    }

    query += " ORDER BY r.reported_at DESC";

    const [reports] = await pool.query(query, params);
    res.json(reports);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// Update report status
router.patch("/reports/:id", auth, role("ADMIN"), async (req, res) => {
  const { status, admin_notes } = req.body;

  if (!["PENDING", "INVESTIGATING", "RESOLVED", "DISMISSED"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    const updateFields = ["status = ?"];
    const params = [status];

    if (admin_notes) {
      updateFields.push("admin_notes = ?");
      params.push(admin_notes);
    }

    if (status === "RESOLVED" || status === "DISMISSED") {
      updateFields.push("resolved_at = NOW()");
      updateFields.push("resolved_by = ?");
      params.push(req.user.id);
    }

    params.push(req.params.id);

    await pool.query(
      `UPDATE water_reports SET ${updateFields.join(", ")} WHERE id = ?`,
      params,
    );

    res.json({ message: "Report updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
