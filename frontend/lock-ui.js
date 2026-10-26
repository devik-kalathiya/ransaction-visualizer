/* =========================================================
   TXN Studio — lock-ui.js
   Two lock visualisations:

   1. Simulator panel  — locks held by the ONE transaction that the
      lifecycle map is running (follows state changes).
   2. Lock manager view — replays the WHOLE schedule (all transactions)
      step by step: schedule grid, lock table, wait-for graph, deadlock.

   Uses: InputParser, LockSim, SimInput (input-import.js) and the
   helpers from script.js (addLog, esc, $).
   ========================================================= */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const escHtml = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ICON_LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const ICON_OPEN = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
  const ICON_NONE = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" stroke-dasharray="3 3"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke-dasharray="3 3"/></svg>';

  const ISO_RULE = {
    "READ UNCOMMITTED": "READ UNCOMMITTED: reads take no lock. Writes still take X locks held to the end.",
    "READ COMMITTED": "READ COMMITTED: a read takes an S lock and releases it right after the read. Writes hold X to the end.",
    "REPEATABLE READ": "REPEATABLE READ: S locks from reads are held to the end, so a re-read gives the same value.",
    "SERIALIZABLE": "SERIALIZABLE: S and X locks held to the end (real DBMSs also add range / predicate locks).",
  };

  /* ===================================================================
     1.  SIMULATOR PANEL
     =================================================================== */
  let prevStatus = {};

  function resetLog() { prevStatus = {}; }

  function syncSimulator(ctx) {
    if (!window.LockSim || !window.SimInput) return;
    const iso = $("isolation").value;
    const view = LockSim.singleTxnLocks(SimInput.ops, iso, ctx.executed, ctx.visited, ctx.key);

    // table
    if (!view.rows.length) {
      $("lockTable").innerHTML = '<div class="lock-empty">This transaction touches no data items, so there is nothing to lock.</div>';
    } else {
      $("lockTable").innerHTML = '<div class="lock-row lock-head"><span></span><span>Item</span><span>Lock</span><span>Status</span></div>' +
        view.rows.map(r => {
          const cls = statusClass(r.status);
          const icon = cls === "held" ? ICON_LOCK : (cls === "released" || cls === "early" ? ICON_OPEN : ICON_NONE);
          const modeBadge = r.mode ? `<b class="mode-badge ${r.mode === "X" ? "x" : "s"}">${r.mode}</b>` :
            `<b class="mode-badge none">—</b>`;
          const planned = r.plannedMode && r.mode !== r.plannedMode ? `<small>will need ${r.plannedMode}</small>` : "";
          return `<div class="lock-row ${cls}">
            <span class="lock-icon">${icon}</span>
            <code>${escHtml(r.item)}</code>
            <span class="lock-mode">${modeBadge}${planned}</span>
            <span class="lock-status">${escHtml(r.status)}</span>
          </div>`;
        }).join("");
    }

    // phase
    const phaseIdx = /GROWING/.test(view.phase) ? 0 : /LOCK POINT|ROLLING/.test(view.phase) ? 1 : /SHRINKING/.test(view.phase) ? 2 : -1;
    $("lockPhaseBadge").textContent = view.phase;
    $("lockPhaseBadge").className = "badge" + (view.phase === "ROLLING BACK" ? " is-rolling" : phaseIdx === 0 ? " is-running" : phaseIdx === 2 ? " is-complete" : "");
    document.querySelectorAll("#phaseBar .phase-step").forEach(el => {
      const i = Number(el.dataset.i);
      el.classList.toggle("active", i === phaseIdx);
      el.classList.toggle("passed", phaseIdx > i);
      el.classList.toggle("rolling", view.phase === "ROLLING BACK" && i === 1);
    });
    $("phaseNote").textContent = view.phaseNote;
    $("lockRule").textContent = ISO_RULE[iso] || "";

    const warn = $("lockWarn");
    if (view.violations.length) { warn.textContent = view.violations.join(". ") + "."; warn.classList.remove("hidden"); }
    else warn.classList.add("hidden");

    // activity-log lines when a lock is taken or let go
    view.rows.forEach(r => {
      const before = prevStatus[r.item];
      if (before === r.status) return;
      prevStatus[r.item] = r.status;
      if (typeof addLog !== "function") return;
      if (r.status === "HELD") addLog(`${r.mode}-lock acquired on ${r.item}`, "event");
      else if (r.status === "RELEASED") addLog(`Lock on ${r.item} released`, "success");
      else if (r.status === "RELEASED AFTER READ") addLog(`S-lock on ${r.item} released right after the read`, "");
    });
  }

  function statusClass(st) {
    if (st.startsWith("HELD")) return "held";
    if (st === "RELEASED") return "released";
    if (st.startsWith("RELEASED")) return "early";
    if (st === "NO LOCK") return "nolock";
    return "pending";
  }

  /* ===================================================================
     2.  LOCK MANAGER VIEW  (multi-transaction replay)
     =================================================================== */
  const DEMO_TEXT = `T1: WRITE(A, 100)
T2: WRITE(B, 200)
T3: READ(C)
T1: WRITE(B, 150)
T2: WRITE(A, 250)
T1: COMMIT
T3: COMMIT`;

  let run = null;          // result of LockSim.runSchedule
  let stepIdx = 0;
  let playTimer = null;
  let usingDemo = true;

  function currentSchedule() {
    if (window.SimInput && SimInput.schedule && SimInput.schedule.ops.length) { usingDemo = false; return SimInput.schedule; }
    usingDemo = true;
    return InputParser.parseText(DEMO_TEXT);
  }

  function buildRun() {
    stopPlay();
    const sched = currentSchedule();
    run = LockSim.runSchedule(sched, $("isolation").value);
    run.sched = sched;
    stepIdx = 0;
  }

  function showView() {
    buildRun();
    renderView();
  }

  function refreshIfVisible() {
    if ($("locksView") && $("locksView").classList.contains("active-view")) showView();
  }

  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    const l = $("lvPlayLabel"); if (l) l.textContent = "Play";
  }

  function go(i) {
    stepIdx = Math.max(0, Math.min(run.steps.length - 1, i));
    renderView();
  }

  function togglePlay() {
    if (playTimer) { stopPlay(); return; }
    if (stepIdx >= run.steps.length - 1) stepIdx = 0;
    $("lvPlayLabel").textContent = "Pause";
    renderView();
    playTimer = setInterval(() => {
      if (stepIdx >= run.steps.length - 1) { stopPlay(); return; }
      go(stepIdx + 1);
      if (stepIdx >= run.steps.length - 1) stopPlay();
    }, 1500);
  }

  function renderView() {
    if (!run) return;
    const st = run.steps[stepIdx];
    const sched = run.sched;

    $("lvSource").textContent = usingDemo
      ? "Built-in demo schedule (a classic deadlock). Import a file on the Simulator page to replay your own."
      : `From your imported file${window.SimInput && SimInput.fileName ? ": " + SimInput.fileName : ""}`;

    /* summary chips */
    const isoList = [...new Set(Object.values(run.isolation))];
    $("lvSummary").innerHTML = [
      `<span class="chip-info"><b>${run.tx.length}</b> transactions</span>`,
      `<span class="chip-info"><b>${run.ops.length}</b> operations</span>`,
      `<span class="chip-info"><b>${run.items.length}</b> data items</span>`,
      `<span class="chip-info ${run.stats.blocks ? "warn" : ""}"><b>${run.stats.blocks}</b> lock waits</span>`,
      `<span class="chip-info ${run.stats.deadlocks ? "bad" : ""}"><b>${run.stats.deadlocks}</b> deadlock${run.stats.deadlocks === 1 ? "" : "s"}</span>`,
      `<span class="chip-info">${isoList.map(escHtml).join(" / ")}</span>`,
    ].join("");

    /* explanation line */
    const ex = $("lvExplain");
    ex.className = "lv-explain " + st.kind;
    ex.innerHTML = `<span class="lv-step-no">Step ${stepIdx} / ${run.steps.length - 1}</span><p>${escHtml(st.text)}</p>`;

    /* buttons */
    $("lvPrev").disabled = stepIdx === 0;
    $("lvNext").disabled = stepIdx >= run.steps.length - 1;

    /* ---- schedule grid ---- */
    const executed = new Set(st.executed), skipped = new Set(st.skipped), blockedNow = new Set(st.blockedOps);
    const waitedAll = new Set(run.waited);
    const head = `<div class="sg-row sg-head" style="--cols:${run.tx.length}"><span class="sg-no">#</span>` +
      run.tx.map(t => {
        const state = st.states[t];
        return `<span class="sg-txn" data-s="${state}"><b>${escHtml(t)}</b><i class="state-pill ${state}">${state}</i><small>${escHtml(run.isolation[t])}</small></span>`;
      }).join("") + "</div>";
    const body = run.ops.map((op, i) => {
      const cells = run.tx.map(t => {
        if (t !== op.txn) return "<span></span>";
        let cls = "future";
        if (i < st.cursor) {
          if (executed.has(i)) cls = "done" + (waitedAll.has(i) ? " waited" : "");
          else if (skipped.has(i)) cls = "skipped";
          else if (blockedNow.has(i)) cls = "blocked";
          else cls = "queued";
        }
        if (st.opIdx === i) cls += " now";
        return `<span class="sg-cell ${cls}"><code>${escHtml(InputParser.opLabel(op))}</code></span>`;
      }).join("");
      return `<div class="sg-row ${i === st.cursor - 1 ? "sg-current" : ""}" style="--cols:${run.tx.length}"><span class="sg-no">${i + 1}</span>${cells}</div>`;
    }).join("");
    $("lvSchedule").innerHTML = head + body +
      `<div class="sg-legend"><span><i class="done"></i>ran</span><span><i class="blocked"></i>waiting for a lock</span><span><i class="queued"></i>queued</span><span><i class="skipped"></i>skipped (aborted)</span><span><i class="future"></i>not reached</span></div>`;

    /* ---- lock table ---- */
    $("lvLocks").innerHTML = '<div class="lt-row lt-head"><span>Item</span><span>Held by</span><span>Waiting</span></div>' +
      st.locks.map(l => {
        const holders = l.holders.length ? l.holders.map(h => `<b class="mode-badge ${h.mode === "X" ? "x" : "s"}">${h.mode}</b><em>${escHtml(h.txn)}</em>`).join("") : '<span class="muted">free</span>';
        const waiters = l.waiters.length ? l.waiters.map(w => `<b class="mode-badge wait ${w.mode === "X" ? "x" : "s"}">${w.mode}?</b><em>${escHtml(w.txn)}</em>`).join("") : '<span class="muted">—</span>';
        return `<div class="lt-row ${l.waiters.length ? "contended" : l.holders.length ? "locked" : ""}"><code>${escHtml(l.item)}</code><span class="lt-cell">${holders}</span><span class="lt-cell">${waiters}</span></div>`;
      }).join("") || '<div class="lock-empty">No data items.</div>';

    /* ---- wait-for graph ---- */
    $("lvGraph").innerHTML = graphSvg(run.tx, st);

    /* ---- event list ---- */
    $("lvLog").innerHTML = run.steps.map((s, i) =>
      `<button type="button" class="lv-ev ${s.kind} ${i === stepIdx ? "current" : ""} ${i > stepIdx ? "future" : ""}" data-i="${i}">
         <span class="lv-ev-no">${i}</span><span class="lv-ev-text">${escHtml(s.text)}</span></button>`).join("");
    const cur = $("lvLog").querySelector(".current");
    if (cur) $("lvLog").scrollTop = Math.max(0, cur.offsetTop - $("lvLog").clientHeight / 2);
  }

  function graphSvg(tx, st) {
    const W = 360, H = tx.length > 4 ? 250 : 190, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 38;
    const pos = {};
    tx.forEach((t, i) => {
      const a = (tx.length === 2 ? Math.PI : -Math.PI / 2) + (2 * Math.PI * i) / tx.length;
      pos[t] = tx.length === 1 ? { x: cx, y: cy } : { x: cx + R * 1.25 * Math.cos(a), y: cy + R * Math.sin(a) };
    });
    const inCycle = (a, b) => st.cycle && st.cycle.includes(a) && st.cycle.includes(b);
    const itemOf = (a, b) => {
      const l = st.locks.find(x => x.waiters.some(w => w.txn === a) && x.holders.some(h => h.txn === b));
      return l ? l.item : "";
    };

    let edges = "";
    st.waitFor.forEach(([a, b]) => {
      const p = pos[a], q = pos[b];
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const sx = p.x + ux * 24, sy = p.y + uy * 24, ex = q.x - ux * 27, ey = q.y - uy * 27;
      const bend = 26;
      const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
      const bad = inCycle(a, b);
      edges += `<path d="M${sx.toFixed(1)} ${sy.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" class="wf-edge ${bad ? "cycle" : ""}" marker-end="url(#wfArrow${bad ? "Bad" : ""})"/>`;
      edges += `<text x="${(mx + (sx + ex) / 2) / 2 + 0}" y="${(my + (sy + ey) / 2) / 2 - 3}" class="wf-label" text-anchor="middle">${escHtml(itemOf(a, b))}</text>`;
    });

    const nodes = tx.map(t => {
      const p = pos[t];
      return `<g class="wf-node ${st.states[t]}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="21"/><text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle">${escHtml(t.length > 5 ? t.slice(0, 5) : t)}</text></g>`;
    }).join("");

    const empty = st.waitFor.length === 0 ? `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="wf-empty">No transaction is waiting for another right now</text>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" class="wf-svg" role="img" aria-label="Wait-for graph">
      <defs>
        <marker id="wfArrow" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="wf-arrow"/></marker>
        <marker id="wfArrowBad" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="wf-arrow bad"/></marker>
      </defs>${edges}${nodes}${empty}</svg>`;
  }

  /* events */
  $("lvPrev").onclick = () => { stopPlay(); go(stepIdx - 1); };
  $("lvNext").onclick = () => { stopPlay(); go(stepIdx + 1); };
  $("lvPlay").onclick = togglePlay;
  $("lvReset").onclick = () => { stopPlay(); go(0); };
  $("lvLog").addEventListener("click", e => {
    const b = e.target.closest(".lv-ev");
    if (b) { stopPlay(); go(Number(b.dataset.i)); }
  });
  $("openLockView").onclick = () => {
    const btn = document.querySelector('.nav-item[data-view="locks"]');
    if (btn) btn.click();
  };
  document.addEventListener("keydown", e => {
    if (!$("locksView").classList.contains("active-view")) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowRight") { stopPlay(); go(stepIdx + 1); }
    if (e.key === "ArrowLeft") { stopPlay(); go(stepIdx - 1); }
  });
  // isolation changes how locks behave, so replay again
  $("isolation").addEventListener("change", refreshIfVisible);

  window.LockUI = { syncSimulator, resetLog, showView, refreshIfVisible };
})();
