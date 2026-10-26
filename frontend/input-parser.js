/* =========================================================
   TXN Studio — input-parser.js
   Turns text / table rows / JSON into one common "schedule":

     {
       transactions: [{ id, isolation?, scenario?, ops: [opIndex…] }],
       ops:          [{ txn, type, item, value, lockMode?, raw }],
       warnings:     [string],   // lines that could not be understood
       notes:        [string],   // things the parser decided for the user
       interleaved:  boolean     // false = ops came as per-transaction lists
     }

   op.type is one of:
     READ WRITE INSERT DELETE LOCK_S LOCK_X UNLOCK COMMIT ABORT

   No DOM access in this file, so it can also be tested in Node.
   File reading (docx / xlsx / image OCR) lives in input-import.js.
   ========================================================= */
(function (root) {
  "use strict";

  const ISOLATION_LEVELS = ["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"];

  /* ---------- small helpers ---------- */

  // "lock-s", "Lock S", "LOCK_S" → "LOCKS"
  const squash = s => String(s).toUpperCase().replace(/[\s_\-]+/g, "");

  const OP_WORDS = {
    READ: "READ", READS: "READ", R: "READ", SELECT: "READ", GET: "READ",
    WRITE: "WRITE", WRITES: "WRITE", W: "WRITE", UPDATE: "WRITE", SET: "WRITE", PUT: "WRITE",
    INSERT: "INSERT", I: "INSERT", ADD: "INSERT",
    DELETE: "DELETE", D: "DELETE", REMOVE: "DELETE",
    LOCKS: "LOCK_S", SLOCK: "LOCK_S", LS: "LOCK_S", SHAREDLOCK: "LOCK_S", LOCKSHARED: "LOCK_S", RLOCK: "LOCK_S", READLOCK: "LOCK_S",
    LOCKX: "LOCK_X", XLOCK: "LOCK_X", LX: "LOCK_X", EXCLUSIVELOCK: "LOCK_X", LOCKEXCLUSIVE: "LOCK_X", WLOCK: "LOCK_X", WRITELOCK: "LOCK_X",
    LOCK: "LOCK",
    UNLOCK: "UNLOCK", U: "UNLOCK", RELEASE: "UNLOCK",
    COMMIT: "COMMIT", C: "COMMIT",
    ABORT: "ABORT", ROLLBACK: "ABORT", A: "ABORT",
  };

  function normalizeOpWord(word) {
    return OP_WORDS[squash(word)] || null;
  }

  function normIso(text) {
    if (!text) return null;
    const t = String(text).toUpperCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    return ISOLATION_LEVELS.find(l => l === t) || null;
  }

  function normScenario(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    if (/fail|abort|rollback|error|crash/.test(t)) return "failure";
    if (/succe|commit|ok|normal/.test(t)) return "success";
    return null;
  }

  const cleanItem = s => (s == null ? "" : String(s).trim().replace(/^["'`\[]+|["'`\]]+$/g, ""));

  function makeOp(txn, type, item, value, raw, lockMode) {
    const op = { txn: txn || "", type, item: cleanItem(item), value: value == null ? "" : String(value).trim(), raw: raw || "" };
    if (lockMode) op.lockMode = lockMode;
    return op;
  }

  /* Pretty label used everywhere in the UI, e.g. WRITE(A, 500) */
  function opLabel(op) {
    switch (op.type) {
      case "COMMIT": return "COMMIT";
      case "ABORT": return "ABORT";
      case "LOCK_S": return `LOCK-S(${op.item})`;
      case "LOCK_X": return `LOCK-X(${op.item})`;
      case "UNLOCK": return `UNLOCK(${op.item})`;
      default: {
        const arg = op.item + (op.value !== "" ? `, ${op.value}` : "");
        return `${op.type}(${arg})`;
      }
    }
  }

  /* ---------- 1. one line of text → 0..n ops ---------- */

  const SHORT_TOKEN = /^([rwcau])(\d+)(?:[(\[]\s*([^)\]]*?)\s*[)\]])?$/i;   // r1(A) w2(B) c1 a2
  const VERB_RE = new RegExp(
    "\\b(LOCK[\\s_-]?S|LOCK[\\s_-]?X|S[\\s_-]?LOCK|X[\\s_-]?LOCK|SHARED[\\s_-]?LOCK|EXCLUSIVE[\\s_-]?LOCK|UNLOCK|" +
    "READS?|WRITES?|INSERT|DELETE|UPDATE|SELECT|COMMIT|ABORT|ROLLBACK|RELEASE|LOCK|[RWU](?=\\s*[(\\[]))\\b", "i");

  const SKIP_LINE = /^(begin|start\s+transaction|begin\s+transaction|end|schedule|step|time|txn|transaction)\b[\s:]*$/i;

  function parseLine(rawLine, ctx) {
    let line = String(rawLine).replace(/ /g, " ").trim();
    if (!line) return { ops: [] };

    // comments
    line = line.replace(/\s*(--|\/\/|#).*$/, "").trim();
    if (!line) return { ops: [] };

    // numbering such as "1." / "3)" / "Step 2:"
    line = line.replace(/^(?:step\s*)?\d+\s*[.):]\s+/i, "").trim();
    if (!line) return { ops: [] };

    // meta lines: isolation / scenario
    let m = line.match(/^(?:([A-Za-z][\w-]*)\s+)?isolation(?:\s+level)?\s*[:=]\s*(.+)$/i);
    if (m) {
      const iso = normIso(m[2]);
      return iso ? { meta: { isolation: iso }, metaTxn: m[1] || "" } : { ops: [], warning: `Unknown isolation level "${m[2].trim()}"` };
    }
    m = line.match(/^(?:scenario|mode|outcome)\s*[:=]\s*(.+)$/i);
    if (m) {
      const sc = normScenario(m[1]);
      return sc ? { meta: { scenario: sc } } : { ops: [], warning: `Unknown scenario "${m[1].trim()}"` };
    }

    // heading: "Transaction T1:" / "TXN-002" / "T1:" on its own
    m = line.match(/^(?:transaction|txn|tx)\s*[:#]?\s*([A-Za-z0-9_-]+)\s*:?$/i) || line.match(/^([A-Za-z]{1,4}[-_]?\d+)\s*:$/);
    if (m && !normalizeOpWord(m[1])) return { heading: m[1] };

    if (SKIP_LINE.test(line)) return { ops: [] };
    if (/^(begin|start)(\s+transaction)?\s*;?$/i.test(line)) return { ops: [] };
    // "T1: BEGIN"
    if (/^[A-Za-z0-9_-]+\s*[:\-]\s*(begin|start)\b.*$/i.test(line)) return { ops: [] };

    // --- shorthand schedule: r1(A) w1(A) r2(A) c1 ------------------------
    const tokens = line.split(/[\s;,]+(?![^()\[\]]*[)\]])/).filter(Boolean);
    if (tokens.length && tokens.every(t => SHORT_TOKEN.test(t))) {
      const ops = tokens.map(t => {
        const [, letter, num, arg] = t.match(SHORT_TOKEN);
        const type = normalizeOpWord(letter);
        const args = arg ? arg.split(",") : [];
        return makeOp("T" + num, type, args[0], args[1], t);
      });
      return { ops };
    }

    // --- verbose form: [T1:] READ(A) / T1 WRITE A 500 / SQL --------------
    const v = line.match(VERB_RE);
    if (!v) return { ops: [], warning: `Could not understand: "${rawLine.trim().slice(0, 60)}"` };

    let before = line.slice(0, v.index).replace(/[\s:|,\-–>]+$/, "").trim();
    let after = line.slice(v.index + v[0].length).trim();
    let verb = squash(v[1]).replace(/^(SHAREDLOCK)$/, "LOCKS").replace(/^(EXCLUSIVELOCK)$/, "LOCKX");
    let type = normalizeOpWord(verb);
    if (!type) return { ops: [], warning: `Could not understand: "${rawLine.trim().slice(0, 60)}"` };

    // transaction name = whatever stands before the verb ("T1", "TXN-001", "Txn 2")
    let txn = "";
    before = before.replace(/^(\S+)\s+(?:requests?|acquires?|takes?|gets?|obtains?|places?|puts?|performs?|does|executes?|releases?|issues?)$/i, "$1");
    if (before) {
      const t = before.replace(/^(?:transaction|txn|tx)[\s:#]*/i, m2 => m2).trim();
      if (/^[A-Za-z][A-Za-z0-9_-]*(?:\s+\d+)?$/.test(t) && !normalizeOpWord(t)) txn = t.replace(/\s+/g, "");
    }

    // SQL-ish: SELECT .. FROM t / INSERT INTO t / DELETE FROM t / UPDATE t SET ..
    let item = "", value = "";
    const sqlItem =
      /^(?:SELECT)/i.test(v[1]) ? (after.match(/\bFROM\s+([\w.]+)/i) || [])[1] :
      /^INSERT/i.test(v[1]) ? (after.match(/^INTO\s+([\w.]+)/i) || [])[1] :
      /^DELETE/i.test(v[1]) && /^FROM\b/i.test(after) ? (after.match(/^FROM\s+([\w.]+)/i) || [])[1] :
      /^UPDATE/i.test(v[1]) && /^[\w.]+\s+SET\b/i.test(after) ? (after.match(/^([\w.]+)\s+SET/i) || [])[1] : null;

    let lockMode = null;
    if (sqlItem) {
      item = sqlItem;
      const setPart = after.match(/\bSET\s+(.+?)(?:\s+WHERE\b|;|$)/i);
      if (setPart) value = setPart[1].trim();
    } else if (type === "COMMIT" || type === "ABORT") {
      // nothing to read
    } else {
      // arguments in brackets or free words
      let argText = after.replace(/^[\s:]+/, "");
      const withLock = argText.match(/\s+(?:with|using|under|in)\s+(shared|exclusive|s|x)(?:\s+(?:lock|mode))?\s*$/i);
      if (withLock) { lockMode = /^s/i.test(withLock[1]) ? "S" : "X"; argText = argText.slice(0, withLock.index); }
      argText = argText.replace(/^(?:(?:on|of|for|in|to|the|item|data|data\s+item|variable|object)\s+)+/i, "");
      const par = argText.match(/^[(\[]\s*(.*?)\s*[)\]]?\s*;?$/);
      if (par) argText = par[1];
      argText = argText.replace(/[;)]+$/, "");
      const args = argText.split(/\s*,\s*|\s+/).filter(Boolean);
      if (type === "LOCK") {
        const modeTok = args.find(a => /^(s|x|shared|exclusive)$/i.test(a));
        if (modeTok) {
          type = /^s/i.test(modeTok) ? "LOCK_S" : "LOCK_X";
          args.splice(args.indexOf(modeTok), 1);
        } else {
          type = "LOCK_X";   // a bare LOCK is treated as exclusive
        }
      }
      item = args[0] || "";
      value = args.slice(1).join(", ");
      if (/^(READS?|SELECT)$/i.test(v[1]) === false) { /* keep value as typed */ }
    }

    if (!item && type !== "COMMIT" && type !== "ABORT") {
      return { ops: [], warning: `No data item found in: "${rawLine.trim().slice(0, 60)}"` };
    }
    return { ops: [makeOp(txn, type, item, value, rawLine.trim(), lockMode)] };
  }

  /* ---------- 2. build a schedule from parsed pieces ---------- */

  class Builder {
    constructor(defaultTxn) {
      this.defaultTxn = defaultTxn || "T1";
      this.ops = [];
      this.meta = {};               // per txn: { isolation, scenario }
      this.globalMeta = {};
      this.warnings = [];
      this.notes = [];
      this.heading = "";            // current "Transaction T1:" heading
      this.sawHeadingBlocks = false;
      this.sawExplicitPrefix = false;
    }
    add(op) {
      if (!op.txn) {
        op.txn = this.heading || this.defaultTxn;
        if (this.heading) this.sawHeadingBlocks = true;
      } else {
        this.sawExplicitPrefix = true;
      }
      this.ops.push(op);
    }
    setMeta(meta, txn) {
      const target = txn ? (this.meta[txn] = this.meta[txn] || {}) : (this.heading ? (this.meta[this.heading] = this.meta[this.heading] || {}) : this.globalMeta);
      Object.assign(target, meta);
    }
    feedLine(line) {
      const r = parseLine(line, this);
      if (r.heading) { this.heading = r.heading; return; }
      if (r.meta) { this.setMeta(r.meta, r.metaTxn); return; }
      if (r.warning) this.warnings.push(r.warning);
      (r.ops || []).forEach(o => this.add(o));
    }
    finish() {
      if (this.ops.length === 0) {
        return { transactions: [], ops: [], warnings: this.warnings, notes: this.notes, interleaved: true };
      }

      // Transactions in order of first appearance
      const order = [];
      this.ops.forEach(o => { if (!order.includes(o.txn)) order.push(o.txn); });
      Object.keys(this.meta).forEach(t => { if (!order.includes(t) && this.ops.length === 0) order.push(t); });

      let ops = this.ops;
      let interleaved = true;

      // Per-transaction blocks (heading style, JSON op-lists): no real interleaving given → round-robin
      if (order.length > 1 && this.sawHeadingBlocks && !this.sawExplicitPrefix) {
        ops = roundRobin(ops, order);
        interleaved = false;
        this.notes.push("The file lists each transaction separately, so operations were interleaved round-robin (T1, T2, T1, T2 …) to show concurrency.");
      }

      const transactions = order.map(id => ({
        id,
        isolation: (this.meta[id] && this.meta[id].isolation) || this.globalMeta.isolation || null,
        scenario: (this.meta[id] && this.meta[id].scenario) || this.globalMeta.scenario || null,
        ops: [],
      }));
      ops.forEach((o, i) => transactions.find(t => t.id === o.txn).ops.push(i));

      // An ABORT operation in the file means the failure scenario for that transaction
      transactions.forEach(t => {
        if (!t.scenario && t.ops.some(i => ops[i].type === "ABORT")) t.scenario = "failure";
      });

      return { transactions, ops, warnings: this.warnings.slice(0, 8), notes: this.notes, interleaved, globalMeta: this.globalMeta };
    }
  }

  function roundRobin(ops, order) {
    const lists = order.map(t => ops.filter(o => o.txn === t));
    const out = [];
    for (let i = 0; lists.some(l => i < l.length); i++) lists.forEach(l => { if (i < l.length) out.push(l[i]); });
    return out;
  }

  /* ---------- 3. plain text (txt, sql, docx paragraphs, OCR output, pasted) ---------- */

  function parseText(text, opts) {
    const b = new Builder(opts && opts.defaultTxn);
    String(text).split(/\r?\n|;\s*(?=[A-Za-z]\w*\s*[:(])/).forEach(l => b.feedLine(l));
    return b.finish();
  }

  /* ---------- 4. tables (csv rows, xlsx sheets, docx tables, json rows) ---------- */

  // header name → field
  const HEADER_FIELDS = {
    txn: ["txn", "txnid", "txncode", "transaction", "transactionid", "tid", "tx", "trans", "t", "xact", "id", "name"],
    op: ["op", "operation", "action", "type", "statement", "stmt", "command", "cmd", "query", "sql", "opcode"],
    item: ["item", "data", "dataitem", "object", "resource", "table", "variable", "var", "target", "record", "row", "key", "column", "entity"],
    value: ["value", "val", "amount", "newvalue", "arg", "args", "param", "params", "detail", "details"],
    lock: ["lock", "locktype", "lockmode", "mode"],
    isolation: ["isolation", "isolationlevel", "level"],
    scenario: ["scenario", "outcome", "result", "status"],
    step: ["step", "time", "seq", "sequence", "order", "no", "slno", "sno", "index", "tick"],
  };

  function fieldOf(headerCell) {
    const k = squash(headerCell).toLowerCase();
    for (const f of Object.keys(HEADER_FIELDS)) if (HEADER_FIELDS[f].includes(k)) return f;
    return null;
  }

  function parseTable(rows, opts) {
    const b = new Builder(opts && opts.defaultTxn);
    rows = rows.map(r => (Array.isArray(r) ? r : [r])).filter(r => r.some(c => String(c == null ? "" : c).trim() !== ""));
    if (!rows.length) return b.finish();


    // Grid-style schedule: one column per transaction, one row per time step
    //   Time | T1      | T2
    //   1    | R(A)    |
    //   2    |         | W(A)
    const TXN_HEAD = /^(?:t|tx|txn|trans(?:action)?)[\s_#-]*\d+$/i;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const heads = rows[i].map(c => String(c == null ? "" : c).trim());
      if (heads.filter(h => TXN_HEAD.test(h)).length >= 2) {
        rows.slice(i + 1).forEach(r => {
          heads.forEach((h, c) => {
            if (!TXN_HEAD.test(h)) return;
            const cell = r[c] == null ? "" : String(r[c]).trim();
            if (!cell) return;
            cell.split(/\n|;/).forEach(piece => b.feedLine(h.replace(/\s+/g, "") + " " + piece));
          });
        });
        b.notes.push("Read as a schedule grid (one column per transaction).");
        return b.finish();
      }
    }

    // find the header row (≥2 recognised names; or 1 name among the first 3 rows when the table is wide)
    let headerAt = -1, cols = null;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const fields = rows[i].map(c => fieldOf(c == null ? "" : c));
      const hits = fields.filter(Boolean).length;
      const hasOpLike = fields.includes("op") || fields.includes("item");
      if (hits >= 2 && hasOpLike) { headerAt = i; cols = fields; break; }
    }

    if (headerAt === -1) {
      // no header: treat each row as a line of text ("T1 | READ | A")
      rows.forEach(r => b.feedLine(r.map(c => (c == null ? "" : String(c))).filter(c => c.trim() !== "").join(" ")));
      return b.finish();
    }

    const idx = f => cols.indexOf(f);
    let data = rows.slice(headerAt + 1).map((r, order) => ({ r, order }));
    if (idx("step") !== -1) {
      const num = x => parseFloat(String(x[idx("step")]));
      if (data.every(d => !isNaN(num(d.r)))) {
        data.sort((a, c) => num(a.r) - num(c.r) || a.order - c.order);
        b.notes.push("Rows were ordered by the Step/Time column.");
      }
    }

    data.forEach(({ r }) => {
      const get = f => (idx(f) === -1 || r[idx(f)] == null ? "" : String(r[idx(f)]).trim());
      const txn = get("txn");
      const opCell = get("op");
      const item = get("item");
      const value = get("value");
      const lock = get("lock");

      // meta columns apply to the transaction
      const iso = normIso(get("isolation")), sc = normScenario(get("scenario"));
      if (txn && (iso || sc)) b.setMeta(Object.assign({}, iso ? { isolation: iso } : {}, sc ? { scenario: sc } : {}), txn);

      if (!opCell && !item) return;

      // the op cell may hold a complete statement: "WRITE(A, 500)", "UPDATE acc SET ..."
      const word = opCell.split(/[\s(]/)[0];
      const type = normalizeOpWord(word);
      const fullStatement = /[(\s]/.test(opCell) && (opCell.includes("(") || /\bFROM\b|\bINTO\b|\bSET\b/i.test(opCell) || !item);
      if (fullStatement || !type) {
        const parsed = parseLine((txn ? txn + " " : "") + opCell + (item && !opCell.includes("(") && !fullStatement ? " " + item : ""));
        if (parsed.ops && parsed.ops.length) {
          parsed.ops.forEach(o => { if (!o.txn && txn) o.txn = txn; b.add(o); });
          return;
        }
        if (!type) { b.warnings.push(`Row not understood: ${r.filter(Boolean).join(" | ").slice(0, 60)}`); return; }
      }

      let finalType = type;
      let lockMode = null;
      if (finalType === "LOCK") {
        const modeWord = opCell.split(/[\s_-]+/)[1] || "";
        finalType = /^(s|shared)/i.test(lock || modeWord) ? "LOCK_S" : "LOCK_X";
      }
      if (lock && ["READ", "WRITE", "INSERT", "DELETE"].includes(finalType)) {
        if (/^(s|shared)/i.test(lock)) lockMode = "S";
        else if (/^(x|exclusive)/i.test(lock)) lockMode = "X";
      }
      if (!item && finalType !== "COMMIT" && finalType !== "ABORT") {
        b.warnings.push(`Row has no data item: ${r.filter(Boolean).join(" | ").slice(0, 60)}`);
        return;
      }
      b.add(makeOp(txn, finalType, item, value, r.join(" | "), lockMode));
    });

    const sched = b.finish();
    return sched;
  }

  /* ---------- 5. JSON ---------- */

  const TXN_KEYS = ["id", "txn", "txnid", "txncode", "transaction", "transactionid", "tid", "name"];
  const OPS_KEYS = ["operations", "ops", "steps", "statements", "actions", "schedule", "sequence"];

  function lowerKeys(obj) {
    const out = {};
    Object.keys(obj).forEach(k => { out[squash(k).toLowerCase()] = obj[k]; });
    return out;
  }
  const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined) return o[k]; return undefined; };

  function parseJson(data, opts) {
    const b = new Builder(opts && opts.defaultTxn);

    function addOpEntry(entry, txn) {
      if (entry == null) return;
      if (typeof entry === "string") {
        const r = parseLine((txn ? txn + " " : "") + entry);
        if (r.warning) b.warnings.push(r.warning);
        (r.ops || []).forEach(o => { if (!o.txn && txn) o.txn = txn; b.add(o); });
        return;
      }
      if (Array.isArray(entry)) {      // [txn, op, item, value]
        const sub = parseTable([entry], opts);
        sub.ops.forEach(o => b.add(o));
        return;
      }
      const e = lowerKeys(entry);
      // build a one-row table so header logic is shared
      const rowTxn = String(pick(e, TXN_KEYS) ?? txn ?? "");
      const op = pick(e, HEADER_FIELDS.op), item = pick(e, HEADER_FIELDS.item), value = pick(e, HEADER_FIELDS.value);
      const lock = pick(e, ["lock", "locktype", "lockmode"]);
      const iso = normIso(pick(e, HEADER_FIELDS.isolation)), sc = normScenario(pick(e, HEADER_FIELDS.scenario));
      if (rowTxn && (iso || sc)) b.setMeta(Object.assign({}, iso ? { isolation: iso } : {}, sc ? { scenario: sc } : {}), rowTxn);
      if (op === undefined) { b.warnings.push("JSON entry without an operation field was skipped."); return; }
      const sub = parseTable(
        [["txn", "op", "item", "value", "lock"], [rowTxn, String(op), item ?? "", value ?? "", lock ?? ""]], opts);
      sub.ops.forEach(o => b.add(o));
      sub.warnings.forEach(w => b.warnings.push(w));
    }

    function handleTxnObject(t, fallbackId) {
      const e = lowerKeys(t);
      const id = String(pick(e, TXN_KEYS) ?? fallbackId ?? "");
      const iso = normIso(e.isolation ?? e.isolationlevel), sc = normScenario(e.scenario ?? e.outcome);
      if (id && (iso || sc)) b.setMeta(Object.assign({}, iso ? { isolation: iso } : {}, sc ? { scenario: sc } : {}), id);
      const list = pick(e, OPS_KEYS);
      b.heading = id;
      b.sawHeadingBlocks = true;       // per-transaction list → no interleaving info
      (Array.isArray(list) ? list : []).forEach(x => addOpEntry(x, id));
      b.heading = "";
    }

    function walk(node) {
      if (Array.isArray(node)) {
        const objs = node.filter(x => x && typeof x === "object" && !Array.isArray(x));
        const hasNested = objs.length && objs.every(x => pick(lowerKeys(x), OPS_KEYS) !== undefined && pick(lowerKeys(x), HEADER_FIELDS.op) === undefined);
        if (hasNested) node.forEach((t, i) => handleTxnObject(t, "T" + (i + 1)));
        else node.forEach(x => addOpEntry(x));
        return;
      }
      if (node && typeof node === "object") {
        const e = lowerKeys(node);
        const iso = normIso(e.isolation ?? e.isolationlevel), sc = normScenario(e.scenario);
        if (iso) b.globalMeta.isolation = iso;
        if (sc) b.globalMeta.scenario = sc;

        const txList = e.transactions ?? e.txns ?? e.transaction_list;
        if (Array.isArray(txList)) { walk(txList); return; }
        if (txList && typeof txList === "object") {       // { T1:[…], T2:[…] }
          Object.keys(txList).forEach(k => handleTxnObject(Array.isArray(txList[k]) ? { id: k, ops: txList[k] } : Object.assign({ id: k }, txList[k]), k));
          return;
        }
        const list = pick(e, OPS_KEYS);
        if (Array.isArray(list)) {
          if (pick(e, TXN_KEYS) !== undefined && !list.some(x => x && typeof x === "object" && pick(lowerKeys(x), TXN_KEYS) !== undefined)) handleTxnObject(node);
          else walk(list);
          return;
        }
        // object keyed by txn id whose values are arrays
        const keys = Object.keys(node);
        if (keys.length && keys.every(k => Array.isArray(node[k]) || ["isolation", "scenario"].includes(k.toLowerCase()))) {
          keys.filter(k => Array.isArray(node[k])).forEach(k => handleTxnObject({ id: k, ops: node[k] }, k));
          return;
        }
        addOpEntry(node);
      }
    }

    walk(data);
    return b.finish();
  }

  /* ---------- public API ---------- */
  const api = { parseText, parseTable, parseJson, opLabel, normIso, normScenario, ISOLATION_LEVELS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InputParser = api;
})(typeof window !== "undefined" ? window : globalThis);
