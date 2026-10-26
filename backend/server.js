require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const transactionsRouter = require("./routes/transactions");
const quizRouter = require("./routes/quiz");
const { STATES, ALLOWED_TRANSITIONS } = require("./services/stateMachine");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Simple request log - helpful for demos/viva.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);

  // Extra-visible log specifically for PDF export requests.
  if (req.url.includes("/export") && req.url.includes("format=pdf")) {
    console.log(`>>> PDF EXPORT REQUESTED: ${req.url}`);
  }

  next();
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "txn-studio-backend", time: new Date().toISOString() });
});

// Reference data the frontend can pull instead of hardcoding, if desired.
app.get("/api/reference/states", (req, res) => {
  res.json({ states: STATES, transitions: ALLOWED_TRANSITIONS });
});

app.use("/api/transactions", transactionsRouter);
app.use("/api/quiz", quizRouter);
// Optional: serve the frontend as static files from the same server,
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));

// 404 handler for unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`TXN Studio backend listening on http://localhost:${PORT}`);
});