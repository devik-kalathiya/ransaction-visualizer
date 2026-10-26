
process.env.DB_PATH = require("path").join(__dirname, "test.db");
const fs = require("fs");
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const http = require("http");

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function request(server, method, path, body) {
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* no body, e.g. 204 */
  }
  return { status: res.status, body: json };
}

async function main() {
  delete require.cache[require.resolve("../server.js")];
  // server.js calls app.listen itself; instead require the pieces directly
  // to get a handle we control for tests.
  const express = require("express");
  const cors = require("cors");
  const transactionsRouter = require("../routes/transactions");

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api/transactions", transactionsRouter);

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  console.log("\nTest 1: create a valid transaction");
  let r = await request(server, "POST", "/api/transactions", {
    txnCode: "TXN-TEST-1",
    operation: "UPDATE Account",
    isolation: "READ COMMITTED",
    scenario: "success",
  });
  assert(r.status === 201, "returns 201 Created");
  assert(r.body.transaction.currentState === "NEW", "starts in NEW state");
  assert(r.body.operations.length === 4, "seeds 4 operations for UPDATE Account");
  const id1 = r.body.transaction.id;

  console.log("\nTest 2: reject invalid payload");
  r = await request(server, "POST", "/api/transactions", {
    txnCode: "",
    operation: "NOT A REAL OP",
    isolation: "READ COMMITTED",
    scenario: "success",
  });
  assert(r.status === 400, "returns 400 for invalid input");
  assert(r.body.errors.length >= 2, "reports multiple validation errors");

  console.log("\nTest 3: valid transition NEW -> ACTIVE");
  r = await request(server, "POST", `/api/transactions/${id1}/transition`, { to: "ACTIVE" });
  assert(r.status === 200, "returns 200 OK");
  assert(r.body.transaction.currentState === "ACTIVE", "state advances to ACTIVE");

  console.log("\nTest 4: illegal transition is rejected");
  r = await request(server, "POST", `/api/transactions/${id1}/transition`, { to: "COMMITTED" });
  assert(r.status === 409, "returns 409 Conflict for ACTIVE -> COMMITTED");

  console.log("\nTest 5: happy path to COMMITTED then TERMINATED");
  await request(server, "POST", `/api/transactions/${id1}/transition`, { to: "PARTIALLY COMMITTED" });
  r = await request(server, "POST", `/api/transactions/${id1}/transition`, { to: "COMMITTED" });
  assert(r.body.transaction.currentState === "COMMITTED", "reaches COMMITTED");
  assert(r.body.transaction.status === "COMMITTED", "status mirrors COMMITTED state");
  r = await request(server, "POST", `/api/transactions/${id1}/transition`, { to: "TERMINATED" });
  assert(r.body.transaction.currentState === "TERMINATED", "reaches TERMINATED");

  console.log("\nTest 6: failure & rollback path");
  r = await request(server, "POST", "/api/transactions", {
    txnCode: "TXN-TEST-2",
    operation: "DELETE Record",
    isolation: "SERIALIZABLE",
    scenario: "failure",
  });
  const id2 = r.body.transaction.id;
  await request(server, "POST", `/api/transactions/${id2}/transition`, { to: "ACTIVE" });
  r = await request(server, "POST", `/api/transactions/${id2}/fail`);
  assert(r.body.transaction.currentState === "FAILED", "moves to FAILED on injected failure");
  r = await request(server, "POST", `/api/transactions/${id2}/transition`, { to: "ABORTED" });
  assert(r.body.transaction.currentState === "ABORTED", "moves to ABORTED");
  assert(
    r.body.operations.every((op) => op.op_status === "ROLLED_BACK"),
    "all operations marked ROLLED_BACK after abort"
  );

  console.log("\nTest 7: reset returns transaction to NEW");
  r = await request(server, "POST", `/api/transactions/${id2}/reset`);
  assert(r.body.transaction.currentState === "NEW", "reset returns to NEW");
  assert(r.body.events.length === 1, "event log cleared down to the reset event");

  console.log("\nTest 8: AI explanation endpoint (falls back without API key)");
  r = await request(server, "GET", `/api/transactions/${id2}/explain`);
  assert(r.status === 200, "returns 200 OK");
  assert(typeof r.body.explanation === "string" && r.body.explanation.length > 0, "returns non-empty explanation text");

  console.log("\nTest 9: history listing");
  r = await request(server, "GET", "/api/transactions");
  assert(r.status === 200 && Array.isArray(r.body.transactions), "returns a list of transactions");
  assert(r.body.transactions.length >= 2, "includes both test transactions");

  console.log("\nTest 10: 404 for unknown transaction");
  r = await request(server, "GET", "/api/transactions/999999");
  assert(r.status === 404, "returns 404 for a non-existent id");

  server.close();
  if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
  const walFile = process.env.DB_PATH + "-wal";
  const shmFile = process.env.DB_PATH + "-shm";
  [walFile, shmFile].forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
