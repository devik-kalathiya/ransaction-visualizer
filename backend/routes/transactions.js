const express = require("express");
const db = require("../db");
const sm = require("../services/stateMachine");
//const { explainState } = require("../services/aiExplain");
const { streamTransactionPdf, toJsonReport } = require("../services/exportReport");
const { explainState, askQuestion } = require("../services/aiExplain");

const router = express.Router();

const VALID_OPERATIONS = ["UPDATE Account", "READ Student", "INSERT Order", "DELETE Record", "Mixed Operations", "Imported Input"];
const MAX_IMPORTED_OPS = 60;
const VALID_ISOLATION = ["READ COMMITTED", "READ UNCOMMITTED", "REPEATABLE READ", "SERIALIZABLE"];
const VALID_SCENARIOS = ["success", "failure"];

const OPS_BY_OPERATION = {
  "UPDATE Account": ["READ(A)", "WRITE(A, 500)", "READ(B)", "WRITE(B, 300)"],
  "READ Student": ["READ(roll_no)", "READ(name)", "READ(marks)", "READ(attendance)"],
  "INSERT Order": ["READ(stock)", "WRITE(stock, -1)", "INSERT(order_row)", "WRITE(ledger)"],
  "DELETE Record": ["READ(record)", "CHECK(constraints)", "DELETE(record)", "WRITE(audit_log)"],
  "Mixed Operations": ["READ(A)", "WRITE(A, 100)", "INSERT(log_row)", "DELETE(temp_row)"],
};

// ---------- validation helpers ----------

function validateCreatePayload(body) {
  const errors = [];
  const txnCode = (body.txnCode || "").toString().trim();

  if (!txnCode) errors.push("txnCode is required.");
  if (txnCode.length > 20) errors.push("txnCode must be 20 characters or fewer.");
  if (txnCode && !/^[A-Za-z0-9_-]+$/.test(txnCode)) {
    errors.push("txnCode may only contain letters, numbers, hyphens and underscores.");
  }
  if (!VALID_OPERATIONS.includes(body.operation)) {
    errors.push(`operation must be one of: ${VALID_OPERATIONS.join(", ")}`);
  }
  // Optional: operation list imported from a user file (docx / csv / json / xlsx / image)
  if (body.operations !== undefined) {
    const ops = body.operations;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_IMPORTED_OPS) {
      errors.push(`operations must be an array of 1-${MAX_IMPORTED_OPS} strings.`);
    } else if (ops.some((o) => typeof o !== "string" || !o.trim() || o.length > 120)) {
      errors.push("each operation must be a non-empty string of at most 120 characters.");
    }
  }
  if (!VALID_ISOLATION.includes(body.isolation)) {
    errors.push(`isolation must be one of: ${VALID_ISOLATION.join(", ")}`);
  }
  if (!VALID_SCENARIOS.includes(body.scenario)) {
    errors.push(`scenario must be one of: ${VALID_SCENARIOS.join(", ")}`);
  }
  return errors;
}

function loadTransaction(id) {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
}

function loadEvents(id) {
  return db
    .prepare("SELECT * FROM transaction_events WHERE transaction_id = ? ORDER BY id ASC")
    .all(id);
}

function loadOps(id) {
  return db
    .prepare("SELECT * FROM transaction_operations WHERE transaction_id = ? ORDER BY seq ASC")
    .all(id);
}

function serialize(txn) {
  return {
    id: txn.id,
    txnCode: txn.txn_code,
    operation: txn.operation,
    isolation: txn.isolation,
    scenario: txn.scenario,
    currentState: txn.current_state,
    status: txn.status,
    createdAt: txn.created_at,
    updatedAt: txn.updated_at,
  };
}

function logEvent(txnId, fromState, toState, note) {
  db.prepare(
    "INSERT INTO transaction_events (transaction_id, from_state, to_state, note) VALUES (?, ?, ?, ?)"
  ).run(txnId, fromState, toState, note || null);
}

function touch(txnId, state, status) {
  db.prepare(
    "UPDATE transactions SET current_state = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(state, status, txnId);
}

function statusForState(state) {
  if (state === "COMMITTED") return "COMMITTED";
  if (state === "ABORTED") return "ABORTED";
  if (state === "TERMINATED") return "TERMINATED";
  return "IN_PROGRESS";
}

// ---------- routes ----------

// POST /api/transactions -> create + seed operation buffer
router.post("/", (req, res) => {
  const errors = validateCreatePayload(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const { txnCode, operation, isolation, scenario } = req.body;

  const info = db
    .prepare(
      "INSERT INTO transactions (txn_code, operation, isolation, scenario, current_state, status) VALUES (?, ?, ?, ?, 'NEW', 'IN_PROGRESS')"
    )
    .run(txnCode, operation, isolation, scenario);

  const txnId = info.lastInsertRowid;
  const opCodes = Array.isArray(req.body.operations)
    ? req.body.operations.map((o) => o.trim())
    : OPS_BY_OPERATION[operation] || OPS_BY_OPERATION["UPDATE Account"];
  const insertOp = db.prepare(
    "INSERT INTO transaction_operations (transaction_id, seq, op_code, op_status) VALUES (?, ?, ?, 'PENDING')"
  );
  opCodes.forEach((code, idx) => insertOp.run(txnId, idx + 1, code));

  logEvent(txnId, null, "NEW", "Transaction created and initialized.");

  const txn = loadTransaction(txnId);
  res.status(201).json({
    transaction: serialize(txn),
    operations: loadOps(txnId),
    events: loadEvents(txnId),
  });
});

// GET /api/transactions -> history list (most recent first)
router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db
    .prepare("SELECT * FROM transactions ORDER BY id DESC LIMIT ?")
    .all(limit);
  res.json({ transactions: rows.map(serialize) });
});

// GET /api/transactions/:id -> full detail (for resuming / timeline / ops)
router.get("/:id", (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });
  res.json({
    transaction: serialize(txn),
    operations: loadOps(txn.id),
    events: loadEvents(txn.id),
  });
});

// POST /api/transactions/:id/transition  { to: "ACTIVE" }
router.post("/:id/transition", (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });

  const to = req.body.to;
  if (!to) return res.status(400).json({ error: "'to' state is required." });

  if (!sm.isValidTransition(txn.current_state, to)) {
    return res.status(409).json({
      error: `Illegal transition: ${txn.current_state} -> ${to}.`,
      allowed: sm.ALLOWED_TRANSITIONS[txn.current_state] || [],
    });
  }

  const note = req.body.note || "Lifecycle transition executed.";
  logEvent(txn.id, txn.current_state, to, note);
  touch(txn.id, to, statusForState(to));

  // Reflect operation buffer progress for the common "happy path" states.
  // first half of the operation buffer runs while ACTIVE (2 of 4 for the built-in lists)
  if (to === "ACTIVE") markOps(txn.id, Math.ceil(loadOps(txn.id).length / 2));
  if (to === "PARTIALLY COMMITTED") markOps(txn.id, "ALL", "EXECUTED");
  if (to === "ABORTED") markOps(txn.id, "ALL", "ROLLED_BACK");

  const updated = loadTransaction(txn.id);
  res.json({
    transaction: serialize(updated),
    operations: loadOps(txn.id),
    events: loadEvents(txn.id),
  });
});

function markOps(txnId, count, statusOverride) {
  const ops = loadOps(txnId);
  ops.forEach((op, i) => {
    const shouldMark = count === "ALL" || i < count;
    if (!shouldMark) return;
    const status = statusOverride || "EXECUTED";
    db.prepare("UPDATE transaction_operations SET op_status = ? WHERE id = ?").run(status, op.id);
  });
}

// POST /api/transactions/:id/fail -> convenience: force ACTIVE/PARTIAL -> FAILED
router.post("/:id/fail", (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });

  if (!["ACTIVE", "PARTIALLY COMMITTED", "NEW"].includes(txn.current_state)) {
    return res.status(409).json({
      error: `Cannot inject a failure from state ${txn.current_state}.`,
    });
  }

  if (txn.current_state === "NEW") {
    logEvent(txn.id, "NEW", "ACTIVE", "Auto-advanced to ACTIVE before failure injection.");
    touch(txn.id, "ACTIVE", "IN_PROGRESS");
  }

  logEvent(txn.id, "ACTIVE", "FAILED", "Failure injected by user (simulated error/deadlock/crash).");
  touch(txn.id, "FAILED", "IN_PROGRESS");
  markOps(txn.id, "ALL", "EXECUTED");

  const updated = loadTransaction(txn.id);
  res.json({
    transaction: serialize(updated),
    operations: loadOps(txn.id),
    events: loadEvents(txn.id),
  });
});

// POST /api/transactions/:id/reset -> wipe events/ops, back to NEW
router.post("/:id/reset", (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });

  db.prepare("DELETE FROM transaction_events WHERE transaction_id = ?").run(txn.id);
  db.prepare("UPDATE transaction_operations SET op_status = 'PENDING' WHERE transaction_id = ?").run(txn.id);
  touch(txn.id, "NEW", "IN_PROGRESS");
  logEvent(txn.id, null, "NEW", "Transaction reset to NEW.");

  const updated = loadTransaction(txn.id);
  res.json({
    transaction: serialize(updated),
    operations: loadOps(txn.id),
    events: loadEvents(txn.id),
  });
});

// GET /api/transactions/:id/explain -> AI-assisted explanation of current state
router.get("/:id/explain", async (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });

  // Serve from cache if we already explained this exact state for this txn.
  const cached = db
    .prepare(
      "SELECT * FROM ai_explanations WHERE transaction_id = ? AND state = ? ORDER BY id DESC LIMIT 1"
    )
    .get(txn.id, txn.current_state);

  if (cached && req.query.fresh !== "true") {
    return res.json({ explanation: cached.explanation, source: "cache" });
  }

  const result = await explainState({
    txnCode: txn.txn_code,
    operation: txn.operation,
    isolation: txn.isolation,
    scenario: txn.scenario,
    state: txn.current_state,
  });

  db.prepare(
    "INSERT INTO ai_explanations (transaction_id, state, explanation) VALUES (?, ?, ?)"
  ).run(txn.id, txn.current_state, result.explanation);

  res.json(result);
});
// POST /api/transactions/:id/ask  { question: "..." }
router.post("/:id/ask", async (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });

  const question = (req.body.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "'question' is required." });
  if (question.length > 500) return res.status(400).json({ error: "Question must be 500 characters or fewer." });

  const result = await askQuestion(
    {
      txnCode: txn.txn_code,
      operation: txn.operation,
      isolation: txn.isolation,
      scenario: txn.scenario,
      state: txn.current_state,
    },
    question
  );

  res.json(result);
});
// GET /api/transactions/:id/export?format=pdf|json
router.get("/:id/export", (req, res) => {
  console.log(`>>> Export route hit for transaction id=${req.params.id}, format=${req.query.format}`);

  const txn = loadTransaction(req.params.id);
  if (!txn) {
    console.log(`>>> Export failed: no transaction with id=${req.params.id}`);
    return res.status(404).json({ error: "Transaction not found." });
  }

  const events = loadEvents(txn.id);
  const ops = loadOps(txn.id);
  const format = (req.query.format || "pdf").toLowerCase();

  res.setHeader("Cache-Control", "no-store");

  if (format === "json") {
    console.log(">>> Sending JSON export.");
    res.setHeader("Content-Disposition", `attachment; filename="${txn.txn_code}-report.json"`);
    return res.json(toJsonReport(txn, events, ops));
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${txn.txn_code}-report.pdf"`);
  console.log(">>> Streaming PDF now...");
  streamTransactionPdf(res, txn, events, ops);
  console.log(">>> PDF stream call finished (this logs immediately - streaming happens async).");
});

// DELETE /api/transactions/:id -> remove from history
router.delete("/:id", (req, res) => {
  const txn = loadTransaction(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found." });
  db.prepare("DELETE FROM transactions WHERE id = ?").run(txn.id);
  res.status(204).end();
});

module.exports = router;