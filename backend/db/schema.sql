-- TXN Studio schema
-- One row per simulated transaction "run"
CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_code      TEXT NOT NULL,             -- user-facing id, e.g. TXN-001
    operation     TEXT NOT NULL,             -- UPDATE Account / READ Student / ...
    isolation     TEXT NOT NULL,             -- READ COMMITTED / SERIALIZABLE / ...
    scenario      TEXT NOT NULL,             -- success | failure
    current_state TEXT NOT NULL DEFAULT 'NEW',
    status        TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS | COMMITTED | TERMINATED | ABORTED
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every state transition / event for a transaction (also powers the Timeline view)
CREATE TABLE IF NOT EXISTS transaction_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    from_state     TEXT,
    to_state       TEXT NOT NULL,
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Buffered read/write operations belonging to a transaction
CREATE TABLE IF NOT EXISTS transaction_operations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    op_code        TEXT NOT NULL,            -- READ(A), WRITE(A,500) ...
    op_status      TEXT NOT NULL DEFAULT 'PENDING' -- PENDING | EXECUTED | ROLLED_BACK
);

-- Cached AI-generated explanations so we don't re-call the API for the same state
CREATE TABLE IF NOT EXISTS ai_explanations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    state          TEXT NOT NULL,
    explanation    TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_txn ON transaction_events(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ops_txn ON transaction_operations(transaction_id);
