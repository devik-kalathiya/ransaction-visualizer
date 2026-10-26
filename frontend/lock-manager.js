/* =========================================================
   TXN Studio — lock-manager.js
   Pure lock logic (no DOM) used by the lock visualisations.

   Rules (strict two-phase locking, like most textbooks / real DBMSs):
     READ                → S (shared) lock
     WRITE/INSERT/DELETE → X (exclusive) lock
     LOCK-S / LOCK-X     → explicit lock request from the input file
     locks are held until COMMIT / ABORT (released when the txn ends)

   Isolation level changes how READ locks behave:
     READ UNCOMMITTED → reads take no lock at all
     READ COMMITTED   → S lock is released right after the read ("short" lock)
     REPEATABLE READ  → S lock held to the end
     SERIALIZABLE     → S lock held to the end (+ predicate / range locks in real DBMSs)

   Compatibility:   S+S ok     S+X blocked     X+X blocked
   ========================================================= */
(function (root) {
  "use strict";

  const DATA_OPS = ["READ", "WRITE", "INSERT", "DELETE"];

  /* What lock does this operation need under this isolation level? */
  function modeFor(op, isolation) {
    if (op.type === "LOCK_S") return { mode: "S", short: false, explicit: true };
    if (op.type === "LOCK_X") return { mode: "X", short: false, explicit: true };
    if (!DATA_OPS.includes(op.type)) return { mode: null, short: false };
    if (op.lockMode) return { mode: op.lockMode, short: false, explicit: true };
    if (op.type === "READ") {
      if (isolation === "READ UNCOMMITTED") return { mode: null, short: false, none: true };
      if (isolation === "READ COMMITTED") return { mode: "S", short: true };
      return { mode: "S", short: false };
    }
    return { mode: "X", short: false };
  }

  const stronger = (a, b) => (a === "X" || b === "X" ? "X" : a || b || null);

  /* ------------------------------------------------------------------
     A) ONE transaction, used by the lifecycle simulator panel.
        ops      = the operation buffer of the selected transaction
        executed = how many of them have run so far
     ------------------------------------------------------------------ */
  function singleTxnLocks(ops, isolation, executed, visited, currentKey) {
    // distinct data items in order of first appearance
    const items = [];
    const planned = {};
    ops.forEach(o => {
      if (!o.item) return;
      if (!items.includes(o.item)) items.push(o.item);
      const m = modeFor(o, isolation);
      if (m.mode) planned[o.item] = stronger(planned[o.item], m.mode);
      else if (!(o.item in planned)) planned[o.item] = null;
    });

    // simulate the executed prefix
    const held = {};            // item → mode currently held
    const shortOnly = {};       // item → true when only released-after-read locks were used
    const unlocked = {};        // item → true when explicitly unlocked
    const violations = [];
    let shrinking = false;
    ops.slice(0, executed).forEach(o => {
      if (!o.item) return;
      if (o.type === "UNLOCK") { delete held[o.item]; unlocked[o.item] = true; shrinking = true; return; }
      const m = modeFor(o, isolation);
      if (!m.mode) return;
      if (shrinking && !m.short) violations.push(`${o.type.replace("_", "-")}(${o.item}) after an UNLOCK breaks two-phase locking`);
      if (m.short) { if (!held[o.item]) shortOnly[o.item] = true; return; }
      held[o.item] = stronger(held[o.item], m.mode);
      delete shortOnly[o.item];
      delete unlocked[o.item];
    });

    const terminated = visited.includes("TERMINATED");
    const aborted = visited.includes("ABORTED");
    const started = visited.includes("ACTIVE");

    const rows = items.map(item => {
      let status, mode = planned[item];
      if (planned[item] === null) { status = "NO LOCK"; mode = null; }
      else if (held[item]) {
        mode = held[item];
        status = terminated ? "RELEASED" : (aborted ? "HELD · ROLLBACK" : "HELD");
        if (terminated) status = "RELEASED";
      } else if (unlocked[item]) { status = "RELEASED EARLY"; }
      else if (shortOnly[item]) { status = "RELEASED AFTER READ"; }
      else { status = started ? "PENDING" : "NOT YET"; }
      return { item, mode, status, plannedMode: planned[item] };
    });

    let phase, phaseNote;
    if (!started) { phase = "NOT STARTED"; phaseNote = "No locks yet. Locks are requested as operations run."; }
    else if (terminated) { phase = "SHRINKING · DONE"; phaseNote = "Transaction ended, so every lock was released together."; }
    else if (currentKey === "FAILED" || currentKey === "ABORTED") { phase = "ROLLING BACK"; phaseNote = "Locks stay held while the log undoes the changes, so nobody sees half-done data."; }
    else if (currentKey === "COMMITTED") { phase = "LOCK POINT · HOLDING"; phaseNote = "Committed. Strict 2PL keeps locks until the transaction terminates."; }
    else if (currentKey === "PARTIALLY COMMITTED") { phase = "LOCK POINT"; phaseNote = "All locks are acquired. Nothing more will be requested."; }
    else { phase = "GROWING"; phaseNote = "Acquiring locks as operations execute. No lock is released yet."; }

    return { rows, phase, phaseNote, violations, isolation };
  }

  /* ------------------------------------------------------------------
     B) MANY transactions, used by the Lock manager view.
        Replays the schedule under strict 2PL and records one "step"
        per event so the UI can step forward and backward.
     ------------------------------------------------------------------ */
  function runSchedule(sched, defaultIso) {
    const ops = sched.ops;
    const tx = sched.transactions.map(t => t.id);
    const iso = {};
    sched.transactions.forEach(t => { iso[t.id] = t.isolation || defaultIso || "REPEATABLE READ"; });

    const firstIdx = {};
    ops.forEach((o, i) => { if (!(o.txn in firstIdx)) firstIdx[o.txn] = i; });

    const items = [];
    ops.forEach(o => { if (o.item && !items.includes(o.item)) items.push(o.item); });

    const locks = {};                     // item → { txn: mode }
    items.forEach(i => { locks[i] = {}; });
    const state = {};                     // NEW | ACTIVE | WAITING | COMMITTED | ABORTED
    const backlog = {};
    tx.forEach(t => { state[t] = "NEW"; backlog[t] = []; });
    const blocked = {};                   // txn → { idx, item, mode }
    const blockSeq = [];
    const executed = new Set();
    const skipped = new Set();
    const waited = new Set();             // op indexes that had to wait
    const steps = [];
    const stats = { blocks: 0, deadlocks: 0, victims: [] };
    let cursor = 0;

    const label = i => root.InputParser.opLabel(ops[i]);

    function conflicts(item, txn, mode) {
      const out = [];
      Object.keys(locks[item] || {}).forEach(h => {
        if (h === txn) return;
        if (mode === "X" || locks[item][h] === "X") out.push(h);
      });
      return out;
    }
    function waitEdges() {
      const e = [];
      Object.keys(blocked).forEach(t => {
        const b = blocked[t];
        conflicts(b.item, t, b.mode).forEach(h => e.push([t, h]));
      });
      return e;
    }
    function snapshot() {
      return items.map(item => ({
        item,
        holders: Object.keys(locks[item]).map(t => ({ txn: t, mode: locks[item][t] })),
        waiters: Object.keys(blocked).filter(t => blocked[t].item === item).map(t => ({ txn: t, mode: blocked[t].mode })),
      }));
    }
    function step(kind, txn, text, opIdx, cycle) {
      steps.push({
        kind, txn, text, opIdx: opIdx == null ? null : opIdx, cursor,
        locks: snapshot(),
        states: Object.assign({}, state),
        waitFor: waitEdges(),
        cycle: cycle || null,
        executed: [...executed], skipped: [...skipped], blockedOps: Object.keys(blocked).map(t => blocked[t].idx),
      });
    }
    function releaseAll(t) { items.forEach(i => { delete locks[i][t]; }); }

    /* Try to run one operation. Returns false when it had to block. */
    function attempt(idx, resumed) {
      const op = ops[idx], t = op.txn;
      const pre = resumed ? "Unblocked: " : "";
      if (state[t] === "NEW" || state[t] === "WAITING") state[t] = "ACTIVE";

      if (op.type === "COMMIT") {
        releaseAll(t); state[t] = "COMMITTED"; executed.add(idx);
        step("commit", t, `${pre}${t} COMMIT. Changes are durable and every lock it held is released.`, idx);
        return true;
      }
      if (op.type === "ABORT") {
        releaseAll(t); state[t] = "ABORTED"; executed.add(idx);
        step("abort", t, `${pre}${t} ABORT. Changes rolled back from the log and its locks are released.`, idx);
        return true;
      }
      if (op.type === "UNLOCK") {
        const had = locks[op.item] && locks[op.item][t];
        if (had) delete locks[op.item][t];
        executed.add(idx);
        step("unlock", t, `${t} UNLOCK(${op.item}). ${had ? `${had}-lock released early (this starts the shrinking phase).` : "It held no lock on that item."}`, idx);
        return true;
      }

      const m = modeFor(op, iso[t]);
      if (!m.mode) {
        executed.add(idx);
        step("exec", t, `${pre}${t} ${label(idx)} runs with no lock (READ UNCOMMITTED never takes read locks, so a dirty read is possible).`, idx);
        return true;
      }
      const c = conflicts(op.item, t, m.mode);
      if (c.length) {
        blocked[t] = { idx, item: op.item, mode: m.mode };
        blockSeq.push(t);
        state[t] = "WAITING";
        waited.add(idx);
        stats.blocks++;
        const heldBy = c.map(h => `${h} holds ${locks[op.item][h]}`).join(", ");
        step("block", t, `${t} ${label(idx)} needs an ${m.mode}-lock on ${op.item}, but ${heldBy}. ${t} must wait.`, idx);
        return false;
      }
      const prev = locks[op.item][t];
      if (m.short) {
        executed.add(idx);
        step(resumed ? "grant" : "exec", t, `${pre}${t} ${label(idx)}: S-lock on ${op.item} granted, then released right after the read (READ COMMITTED).`, idx);
        return true;
      }
      locks[op.item][t] = stronger(prev, m.mode);
      executed.add(idx);
      const upgrade = prev === "S" && m.mode === "X";
      step(resumed ? "grant" : "exec", t,
        `${pre}${t} ${label(idx)}: ${upgrade ? "lock upgraded S to X" : m.mode + "-lock granted"} on ${op.item}.`, idx);
      return true;
    }

    function drain(t) {
      while (backlog[t].length && !blocked[t] && state[t] !== "ABORTED" && state[t] !== "COMMITTED") {
        const i = backlog[t].shift();
        if (!attempt(i, false)) checkDeadlock();
      }
    }

    function wake() {
      let progress = true;
      while (progress) {
        progress = false;
        for (const t of [...blockSeq]) {
          const b = blocked[t];
          if (!b || conflicts(b.item, t, b.mode).length) continue;
          delete blocked[t];
          blockSeq.splice(blockSeq.indexOf(t), 1);
          attempt(b.idx, true);
          drain(t);
          progress = true;
          break;
        }
      }
    }

    function findCycle() {
      const edges = waitEdges();
      const adj = {};
      edges.forEach(([a, b]) => { (adj[a] = adj[a] || []).push(b); });
      const visiting = [], done = new Set();
      let found = null;
      function dfs(n) {
        if (found) return;
        if (visiting.includes(n)) { found = visiting.slice(visiting.indexOf(n)); return; }
        if (done.has(n)) return;
        visiting.push(n);
        (adj[n] || []).forEach(dfs);
        visiting.pop();
        done.add(n);
      }
      Object.keys(adj).forEach(dfs);
      return found;
    }

    function checkDeadlock() {
      let cycle;
      while ((cycle = findCycle())) {
        stats.deadlocks++;
        const victim = cycle.reduce((a, b) => (firstIdx[b] > firstIdx[a] ? b : a));
        stats.victims.push(victim);
        step("deadlock", victim, `Deadlock! ${cycle.concat(cycle[0]).join(" waits for ")}. Nobody can continue. The DBMS picks ${victim} (the youngest) as the victim.`, null, cycle);
        // abort the victim
        const b = blocked[victim];
        delete blocked[victim];
        if (blockSeq.includes(victim)) blockSeq.splice(blockSeq.indexOf(victim), 1);
        if (b) skipped.add(b.idx);
        backlog[victim].forEach(i => skipped.add(i));
        backlog[victim] = [];
        releaseAll(victim);
        state[victim] = "ABORTED";
        step("abort", victim, `${victim} is rolled back and its locks are released, which lets the others continue.`, null);
        wake();
      }
    }

    /* ---- replay ---- */
    step("start", null, `${tx.length} transaction${tx.length === 1 ? "" : "s"}, ${ops.length} operations, strict two-phase locking. Press Next to replay the schedule.`, null);

    ops.forEach((op, idx) => {
      cursor = idx + 1;
      const t = op.txn;
      if (state[t] === "ABORTED" || state[t] === "COMMITTED") {
        skipped.add(idx);
        step("skip", t, `${t} already ${state[t] === "ABORTED" ? "aborted" : "committed"}. ${label(idx)} is skipped.`, idx);
        return;
      }
      if (state[t] === "NEW") state[t] = "ACTIVE";
      if (blocked[t]) {
        backlog[t].push(idx);
        waited.add(idx);
        step("queue", t, `${t} is still waiting, so ${label(idx)} is queued behind its blocked operation.`, idx);
        return;
      }
      const ok = attempt(idx, false);
      if (!ok) checkDeadlock();
      else if (["COMMIT", "ABORT", "UNLOCK"].includes(op.type)) wake();
    });

    // transactions that never said COMMIT end with an implicit commit
    cursor = ops.length;
    let again = true;
    while (again) {
      again = false;
      for (const t of tx) {
        if ((state[t] === "ACTIVE" || state[t] === "NEW") && !blocked[t] && backlog[t].length === 0) {
          releaseAll(t); state[t] = "COMMITTED";
          step("commit", t, `${t} reaches the end of the schedule (implicit COMMIT). Its locks are released.`, null);
          wake();
          again = true;
          break;
        }
      }
    }

    return { steps, tx, ops, items, isolation: iso, waited: [...waited], stats };
  }

  const api = { modeFor, singleTxnLocks, runSchedule };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  else root.LockSim = api;
})(typeof window !== "undefined" ? window : globalThis);
