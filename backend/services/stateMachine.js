/**
 * Transaction State Simulator - core state machine.
 *
 * States: NEW -> ACTIVE -> PARTIALLY COMMITTED -> COMMITTED -> TERMINATED
 *                    \-> FAILED -> ABORTED -> TERMINATED
 *
 * This mirrors the client-side simulator in frontend/script.js so the
 * backend can validate/replay the same lifecycle and remain the source
 * of truth once wired up (the frontend can run "offline" without the
 * backend, or defer to these endpoints - see frontend/api-client.js).
 */

const STATES = [
  {
    key: "NEW",
    desc: "Transaction has been created and is ready to begin execution.",
    next: "ACTIVE",
  },
  {
    key: "ACTIVE",
    desc: "The transaction is currently executing its read and write operations.",
    next: "PARTIALLY COMMITTED",
  },
  {
    key: "PARTIALLY COMMITTED",
    desc: "The final statement has executed, but the commit is not yet durable.",
    next: "COMMITTED",
  },
  {
    key: "COMMITTED",
    desc: "The transaction has successfully committed and its changes are durable.",
    next: "TERMINATED",
  },
  {
    key: "FAILED",
    desc: "An error, deadlock, or crash prevents the transaction from completing normally.",
    next: "ABORTED",
  },
  {
    key: "ABORTED",
    desc: "The transaction has been rolled back and its changes have been undone.",
    next: "TERMINATED",
  },
  {
    key: "TERMINATED",
    desc: "The transaction lifecycle has ended and its resources have been released.",
    next: null,
  },
];

// Explicit allowed-transition table -> used for server-side validation.
// This is what "Transition Rules" in the UI documents.
const ALLOWED_TRANSITIONS = {
  NEW: ["ACTIVE"],
  ACTIVE: ["PARTIALLY COMMITTED", "FAILED"],
  "PARTIALLY COMMITTED": ["COMMITTED", "FAILED"],
  COMMITTED: ["TERMINATED"],
  FAILED: ["ABORTED"],
  ABORTED: ["TERMINATED"],
  TERMINATED: [],
};

function getStateInfo(key) {
  return STATES.find((s) => s.key === key) || null;
}

function isValidTransition(from, to) {
  return Boolean(ALLOWED_TRANSITIONS[from] && ALLOWED_TRANSITIONS[from].includes(to));
}

function isTerminal(key) {
  return key === "TERMINATED";
}

module.exports = {
  STATES,
  ALLOWED_TRANSITIONS,
  getStateInfo,
  isValidTransition,
  isTerminal,
};
