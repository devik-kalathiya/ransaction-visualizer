/* =========================================================
   TXN Studio — input-import.js
   The "Import input file" panel on the Simulator page.

   Reads .csv .tsv .json .xlsx/.xls .docx .txt/.sql .jpg/.png (OCR),
   or pasted text, converts it with InputParser into a schedule, and
   feeds the selected transaction into the existing simulator:

     • operation buffer  (Transaction operations panel)
     • Transaction ID, isolation level and scenario fields
     • lock panel + Lock manager view (lock-ui.js)

   Everything is read in the browser, so it works without the backend.
   docx / xlsx / OCR libraries are loaded from /vendor only when needed.
   ========================================================= */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_SIM_OPS = 30;
  const IMPORT_VALUE = "Imported Input";

  const DEFAULT_TEXT = "READ(A)\nWRITE(A, 500)\nREAD(B)\nWRITE(B, 300)";
  const DEFAULT_OPS = InputParser.parseText(DEFAULT_TEXT).ops;

  /* ---------- shared state, also read by script.js and lock-ui.js ---------- */
  const SimInput = {
    ops: DEFAULT_OPS,        // operations of the transaction being simulated
    active: false,           // true while an imported transaction drives the simulator
    schedule: null,          // full parsed schedule (all transactions)
    selectedTxn: null,
    fileName: "",
    labels() { return this.ops.map(InputParser.opLabel); },
  };
  window.SimInput = SimInput;

  /* ---------- lazy script loader ---------- */
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Could not load ${src}. Make sure the "vendor" folder is next to index.html.`));
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }
  const abs = p => new URL(p, document.baseURI).href;

  /* ---------- status line ---------- */
  function setStatus(kind, text) {
    const el = $("importStatus");
    if (!text) { el.classList.add("hidden"); return; }
    el.className = "import-status " + kind;
    el.innerHTML = (kind === "busy" ? '<span class="spinner"></span>' : "") + `<span>${esc(text)}</span>`;
  }

  /* =====================================================================
     READERS: file → { schedule, rawText? }
     ===================================================================== */

  function readAsText(file) { return file.text(); }
  function readAsBuffer(file) { return file.arrayBuffer(); }

  // small CSV parser (quotes, embedded commas / newlines)
  function csvToRows(text, delim) {
    const rows = [];
    let row = [], cell = "", q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = ""; rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function readCsv(file, delim) {
    const text = await readAsText(file);
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    // a ".csv" that is really plain lines ("T1: READ(A)") → treat as text
    if (!firstLine.includes(delim) && /[()]/.test(text)) return { schedule: InputParser.parseText(text) };
    return { schedule: InputParser.parseTable(csvToRows(text, delim)) };
  }

  async function readJson(file) {
    const text = await readAsText(file);
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error("This is not valid JSON: " + e.message); }
    return { schedule: InputParser.parseJson(data) };
  }

  async function readXlsx(file) {
    setStatus("busy", "Reading spreadsheet…");
    await loadScript("vendor/xlsx.full.min.js");
    const wb = XLSX.read(await readAsBuffer(file), { type: "array" });
    let best = null;
    const used = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false });
      const sched = InputParser.parseTable(rows);
      if (sched.ops.length) { used.push(name); if (!best) best = sched; }
    }
    if (!best) return { schedule: InputParser.parseTable([]) };
    if (used.length > 1) best.notes.push(`The workbook has ${used.length} sheets with data. Only the first one ("${used[0]}") was used.`);
    return { schedule: best };
  }

  async function readDocx(file) {
    setStatus("busy", "Reading Word document…");
    await loadScript("vendor/mammoth.browser.min.js");
    const res = await mammoth.convertToHtml({ arrayBuffer: await readAsBuffer(file) });
    const doc = new DOMParser().parseFromString(res.value, "text/html");

    // 1) tables
    const tableScheds = [...doc.querySelectorAll("table")].map(t => {
      const rows = [...t.querySelectorAll("tr")].map(tr => [...tr.children].map(td => cellText(td)));
      return InputParser.parseTable(rows);
    }).filter(s => s.ops.length);
    if (tableScheds.length) {
      const best = tableScheds.reduce((a, b) => (b.ops.length > a.ops.length ? b : a));
      if (tableScheds.length > 1) best.notes.push("The document has several tables. The largest one was used.");
      return { schedule: best };
    }

    // 2) paragraphs and lists, one line each
    const lines = [];
    doc.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre").forEach(el => {
      cellText(el).split("\n").forEach(l => lines.push(l));
    });
    const text = lines.join("\n");
    return { schedule: InputParser.parseText(text), rawText: text };
  }

  function cellText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll("br").forEach(b => b.replaceWith("\n"));
    c.querySelectorAll("p, li").forEach(p => p.append("\n"));
    return c.textContent.replace(/\n+$/, "").trim();
  }

  async function readImage(file) {
    setStatus("busy", "Loading text recognition (OCR)…");
    await loadScript("vendor/tesseract/tesseract.min.js");
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: abs("vendor/tesseract/worker.min.js"),
      corePath: abs("vendor/tesseract/core/"),
      langPath: abs("vendor/tesseract/lang"),
      logger: m => {
        if (m.status === "recognizing text") setStatus("busy", `Reading text from the image… ${Math.round((m.progress || 0) * 100)}%`);
      },
    });
    try {
      const { data } = await worker.recognize(file);
      const text = cleanOcr(data.text || "");
      return { schedule: InputParser.parseText(text), rawText: text, ocr: true };
    } finally {
      await worker.terminate();
    }
  }

  // light clean-up of typical OCR slips: T1 read as Tl / TI, brackets read as braces
  function cleanOcr(t) {
    return t
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/\bT[lIi|!](?=\s*[:\-)\s])/g, "T1")
      .replace(/\{/g, "(").replace(/\}/g, ")")
      .replace(/[ \t]+$/gm, "");
  }

  /* =====================================================================
     MAIN FLOW
     ===================================================================== */

  async function handleFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { setStatus("error", "That file is larger than 10 MB. Please use a smaller one."); return; }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    setStatus("busy", `Reading ${file.name}…`);
    try {
      let out;
      if (ext === "csv") out = await readCsv(file, ",");
      else if (ext === "tsv") out = await readCsv(file, "\t");
      else if (ext === "json") out = await readJson(file);
      else if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "ods") out = await readXlsx(file);
      else if (ext === "docx") out = await readDocx(file);
      else if (["txt", "sql", "md", "log", ""].includes(ext)) { const t = await readAsText(file); out = { schedule: InputParser.parseText(t), rawText: t }; }
      else if (/^image\//.test(file.type) || ["jpg", "jpeg", "png", "webp", "bmp", "gif"].includes(ext)) out = await readImage(file);
      else if (ext === "doc") throw new Error("Old .doc files are not supported. Save the document as .docx and try again.");
      else throw new Error(`.${ext} files are not supported. Use DOCX, CSV, JSON, XLSX, JPEG/PNG or TXT.`);
      ingest(out, file.name, ext);
    } catch (err) {
      console.error(err);
      setStatus("error", err.message || "Could not read that file.");
    }
  }

  function ingest(out, name, ext) {
    const sched = out.schedule;
    if (!sched.ops.length) {
      setStatus("error", "No transaction operations were found in " + name + ". Each line should look like  T1: READ(A)  or  T2: WRITE(B, 5).");
      if (out.rawText !== undefined) showResult(sched, name, out);       // let the user fix OCR / text
      return;
    }
    setStatus("", "");
    SimInput.schedule = sched;
    SimInput.fileName = name;
    SimInput.selectedTxn = sched.transactions[0].id;
    showResult(sched, name, out);
    applySelected(true);
  }

  /* ---------- results panel ---------- */
  function showResult(sched, name, out) {
    $("importResult").classList.remove("hidden");

    const items = new Set(sched.ops.filter(o => o.item).map(o => o.item));
    $("importSummary").innerHTML =
      `<span class="chip-info file"><b>${esc(name)}</b></span>` +
      `<span class="chip-info"><b>${sched.transactions.length}</b> transaction${sched.transactions.length === 1 ? "" : "s"}</span>` +
      `<span class="chip-info"><b>${sched.ops.length}</b> operations</span>` +
      `<span class="chip-info"><b>${items.size}</b> data item${items.size === 1 ? "" : "s"}</span>`;

    const sel = $("importTxnSelect");
    sel.innerHTML = sched.transactions.map(t =>
      `<option value="${esc(t.id)}">${esc(t.id)} (${t.ops.length} ops${t.isolation ? ", " + t.isolation : ""}${t.scenario === "failure" ? ", aborts" : ""})</option>`).join("");
    if (SimInput.selectedTxn) sel.value = SimInput.selectedTxn;

    // notes + warnings
    const notes = [].concat(sched.notes || [], (sched.warnings || []).map(w => "Skipped: " + w));
    const nb = $("importNotes");
    nb.innerHTML = notes.map(n => `<div>${esc(n)}</div>`).join("");
    nb.classList.toggle("hidden", !notes.length);

    // OCR / pasted text can be corrected by the user
    const ocr = $("ocrBox");
    if (out.rawText !== undefined) {
      ocr.classList.remove("hidden");
      $("ocrText").value = out.rawText;
      ocr.querySelector("summary").textContent = out.ocr
        ? "Recognized text (fix any OCR mistakes, then press Re-read)"
        : "Text read from the file (edit it if you like, then press Re-read)";
    } else ocr.classList.add("hidden");

    renderPreview();
  }

  function renderPreview() {
    const sched = SimInput.schedule;
    if (!sched) { $("importPreview").innerHTML = ""; return; }
    const iso = $("isolation").value;
    const rows = sched.ops.slice(0, 80).map((o, i) => {
      const m = LockSim.modeFor(o, iso);
      const lock = o.type === "COMMIT" || o.type === "ABORT" ? "" :
        m.mode ? `<b class="mode-badge ${m.mode === "X" ? "x" : "s"}">${m.mode}</b>${m.short ? "<small>short</small>" : ""}` : '<span class="muted">none</span>';
      return `<div class="ip-row ${o.txn === SimInput.selectedTxn ? "sel" : ""}"><span>${i + 1}</span><b>${esc(o.txn)}</b><code>${esc(InputParser.opLabel(o))}</code><span>${lock}</span></div>`;
    }).join("");
    $("importPreview").innerHTML =
      `<div class="ip-row ip-head"><span>#</span><span>Txn</span><span>Operation</span><span>Lock</span></div>` + rows +
      (sched.ops.length > 80 ? `<div class="ip-more">…and ${sched.ops.length - 80} more</div>` : "");
  }

  /* ---------- feed the chosen transaction into the simulator ---------- */
  function applySelected(fresh) {
    const sched = SimInput.schedule;
    const txn = sched.transactions.find(t => t.id === SimInput.selectedTxn) || sched.transactions[0];
    const own = txn.ops.map(i => sched.ops[i]);
    let simOps = own.filter(o => o.type !== "COMMIT" && o.type !== "ABORT");
    if (!simOps.length) {
      setStatus("error", `${txn.id} has no read/write operations to simulate.`);
      return;
    }
    let trimmed = false;
    if (simOps.length > MAX_SIM_OPS) { simOps = simOps.slice(0, MAX_SIM_OPS); trimmed = true; }

    SimInput.ops = simOps;
    SimInput.active = true;
    SimInput.selectedTxn = txn.id;

    // form fields
    const id = txn.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 20);
    $("txnId").value = id || "TXN-001";
    if (txn.isolation) $("isolation").value = txn.isolation;
    if (txn.scenario) $("scenario").value = txn.scenario;
    let opt = [...$("operation").options].find(o => o.value === IMPORT_VALUE);
    if (!opt) { opt = new Option("Imported input (file)", IMPORT_VALUE); $("operation").add(opt); }
    $("operation").value = IMPORT_VALUE;

    $("importBadge").textContent = "FILE IN USE";
    $("importBadge").className = "badge is-complete";
    if (trimmed) setStatus("info", `Only the first ${MAX_SIM_OPS} operations of ${txn.id} are shown in the simulator.`);

    renderOps();
    renderPreview();
    if (typeof resetSimulation === "function") resetSimulation();
    if (window.LockUI) LockUI.refreshIfVisible();
    if (fresh && typeof showToast === "function") showToast("success", "Input imported", `${txn.id}: ${simOps.length} operations loaded from ${SimInput.fileName}.`);
  }

  /* ---------- operation buffer (replaces the static rows, same markup) ---------- */
  function renderOps() {
    const iso = $("isolation").value;
    $("operationList").innerHTML = SimInput.ops.map((o, i) => {
      const m = LockSim.modeFor(o, iso);
      const tag = m.mode ? `<span class="lock-tag ${m.mode.toLowerCase()}" title="Lock needed by this operation">${m.mode}${m.short ? " short" : ""}</span>`
        : (m.none ? '<span class="lock-tag none">no lock</span>' : "");
      return `<div class="op-row"><span class="op-num">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="op-code"><code>${esc(InputParser.opLabel(o))}</code>${tag}</span>` +
        `<span class="op-status pending">PENDING</span></div>`;
    }).join("");
    $("opCount").textContent = SimInput.ops.length + (SimInput.ops.length === 1 ? " OP" : " OPS");
  }

  /* ---------- going back to the built-in operations ---------- */
  function useBuiltIn(keepFile) {
    SimInput.ops = DEFAULT_OPS;
    SimInput.active = false;
    renderOps();
    $("importBadge").textContent = keepFile ? "FILE LOADED" : "NO FILE";
    $("importBadge").className = "badge";
    if (typeof resetSimulation === "function") resetSimulation();
    if (window.LockUI) LockUI.refreshIfVisible();
  }

  function clearImport() {
    SimInput.schedule = null;
    SimInput.fileName = "";
    SimInput.selectedTxn = null;
    const opt = [...$("operation").options].find(o => o.value === IMPORT_VALUE);
    if (opt) opt.remove();
    $("operation").selectedIndex = 0;
    $("fileInput").value = "";
    $("importResult").classList.add("hidden");
    setStatus("", "");
    useBuiltIn(false);
  }

  /* =====================================================================
     EVENTS
     ===================================================================== */
  const dz = $("dropZone");
  $("fileInput").addEventListener("change", e => { const f = e.target.files[0]; if (f) handleFile(f); });
  dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); $("fileInput").click(); } });
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  // dropping anywhere else on the page must not navigate away from the app
  ["dragover", "drop"].forEach(ev => window.addEventListener(ev, e => { if (!dz.contains(e.target)) e.preventDefault(); }));

  $("togglePaste").addEventListener("click", () => {
    $("pasteBox").classList.toggle("hidden");
    if (!$("pasteBox").classList.contains("hidden")) $("pasteText").focus();
  });
  $("parsePasteBtn").addEventListener("click", () => {
    const t = $("pasteText").value;
    if (!t.trim()) { setStatus("error", "Paste some operations first."); return; }
    ingest({ schedule: InputParser.parseText(t), rawText: undefined }, "pasted text");
  });
  $("ocrReparseBtn").addEventListener("click", () => {
    const t = $("ocrText").value;
    ingest({ schedule: InputParser.parseText(t), rawText: t }, SimInput.fileName || "edited text");
  });

  $("importTxnSelect").addEventListener("change", e => { SimInput.selectedTxn = e.target.value; applySelected(false); });
  $("importClearBtn").addEventListener("click", clearImport);
  $("importLockViewBtn").addEventListener("click", () => {
    const btn = document.querySelector('.nav-item[data-view="locks"]');
    if (btn) btn.click();
  });

  // The lock tag on each operation depends on the isolation level
  $("isolation").addEventListener("change", () => {
    renderOps();
    renderPreview();
    if (typeof updateUI === "function") updateUI();
  });
  // Choosing one of the built-in operations goes back to the built-in operation list
  $("operation").addEventListener("change", () => {
    if (SimInput.active && $("operation").value !== IMPORT_VALUE) useBuiltIn(!!SimInput.schedule);
    else if (!SimInput.active && $("operation").value === IMPORT_VALUE && SimInput.schedule) applySelected(false);
  });

  /* ---------- first paint ---------- */
  renderOps();
  if (typeof updateUI === "function") updateUI();
})();
