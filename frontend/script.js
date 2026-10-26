/* =========================================================
   TXN Studio — Transaction States & Lifecycle Visualizer
   script.js

   1. State data            (unchanged from the original)
   2. Display-only data     (allowed transitions, reasons, explanations)
   3. Simulator variables
   4. Log + timeline
   5. Lifecycle diagram     (nodes, edges, moving token)
   6. UI update
   7. Core simulator logic  (transitionTo, nextStep, start, pause, reset, failure)
   8. Extras                (inspector, toasts, stage scaling, theme, events)

   Look for "BUG FIX" comments to see what changed in behaviour.
   ========================================================= */


/* ---------- 1. State data (original) ---------- */
const states = [
  {key:"NEW", symbol:"○", desc:"Transaction has been created and is ready to begin execution.", next:"ACTIVE", nextDesc:"The transaction begins executing its read/write operations. An error may send it to FAILED."},
  {key:"ACTIVE", symbol:"▶", desc:"The transaction is currently executing its read and write operations.", next:"PARTIALLY COMMITTED", nextDesc:"The final statement has executed. The transaction can proceed toward commit or fail."},
  {key:"PARTIALLY COMMITTED", symbol:"◐", desc:"The final statement has executed, but the commit is not yet durable.", next:"COMMITTED", nextDesc:"The DBMS can now complete the commit and make the changes durable."},
  {key:"COMMITTED", symbol:"✓", desc:"The transaction has successfully committed and its changes are durable.", next:"TERMINATED", nextDesc:"Resources are released and the completed transaction leaves the active system."},
  {key:"FAILED", symbol:"!", desc:"An error or failure prevents the transaction from completing normally.", next:"ABORTED", nextDesc:"The DBMS starts rollback to undo the transaction's changes."},
  {key:"ABORTED", symbol:"↩", desc:"The transaction has been rolled back and its changes have been undone.", next:"TERMINATED", nextDesc:"Locks and resources are released; the transaction lifecycle ends."},
  {key:"TERMINATED", symbol:"■", desc:"The transaction lifecycle has ended and its resources have been released.", next:"—", nextDesc:"No further transaction state exists."}
];


/* ---------- 2. Display-only data ---------- */

// Legal transitions out of each state. Used only for visual hints
// (dashed "possible next" arrows); the simulator logic is in section 7.
const TRANSITIONS = {
  "NEW": ["ACTIVE"],
  "ACTIVE": ["PARTIALLY COMMITTED", "FAILED"],
  "PARTIALLY COMMITTED": ["COMMITTED", "FAILED"],
  "COMMITTED": ["TERMINATED"],
  "FAILED": ["ABORTED"],
  "ABORTED": ["TERMINATED"],
  "TERMINATED": []
};

// The event that causes each transition ("why did it move?")
const EVENT_LABELS = {
  "NEW>ACTIVE": "Execution started",
  "ACTIVE>PARTIALLY COMMITTED": "Final statement executed",
  "PARTIALLY COMMITTED>COMMITTED": "Commit record written to stable storage",
  "COMMITTED>TERMINATED": "Transaction completed, locks released",
  "ACTIVE>FAILED": "Error detected during execution",
  "PARTIALLY COMMITTED>FAILED": "Failure before commit became durable",
  "FAILED>ABORTED": "Rollback performed using the log",
  "ABORTED>TERMINATED": "Locks and resources released"
};

// Short textbook explanations shown in the state information panel
const STATE_INFO = {
  "NEW": "The transaction has been created but has not started executing yet. (Many textbooks begin the lifecycle directly at ACTIVE.)",
  "ACTIVE": "The initial execution state: the transaction is performing its read/write operations. It stays here until the last statement runs or an error occurs.",
  "PARTIALLY COMMITTED": "The final statement has executed, but the changes may still be only in main-memory buffers. The commit is not yet durable, so a failure can still occur.",
  "COMMITTED": "The commit record has been safely written to stable storage. The changes are now permanent and survive system crashes.",
  "FAILED": "Normal execution can no longer proceed because of an error such as a logical error, deadlock, or system crash.",
  "ABORTED": "The transaction has been rolled back and the database is restored to its state before the transaction started. It may later be restarted or killed.",
  "TERMINATED": "The transaction has left the system, either after committing or after being aborted. Its locks and resources are released."
};

const SUN_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const LOG_ICONS = { "": "•", event: "→", success: "✓", error: "!", rollback: "↩" };


/* ---------- 3. Simulator variables ---------- */
let stateIndex = 0;
let timer = null;
let running = false;
let startTime = Date.now();
let logEntries = [];
let timelineEntries = [];

let visited = ["NEW"];          // states actually visited in this run (BUG FIX 1)
let traversed = [];             // edges ("FROM>TO") actually travelled
let lastAction = "Transaction created";
let failureTimeouts = [];       // pending failure-chain timers (BUG FIX 3)
let failureInProgress = false;  // blocks a second failure chain (BUG FIX 4)

/* ---------- Backend integration state ---------- */
let backendTxnId = null;   // id of the current run on the backend, once created
let backendOnline = false;
let aiLive = false;        // true when the backend reports an Anthropic API key is configured
let askEntries = [];       // {question, answer, source} shown in the Ask AI thread

let hoverState = null;          // state under the mouse (inspector)
let pinnedState = null;         // state clicked by the user (inspector)
let lastShownKey = null;        // used to trigger the status "bump" animation

const $ = id => document.getElementById(id);
const nodeEls = [...document.querySelectorAll(".node")];
const edgeGroups = [...document.querySelectorAll(".edge-group")];

function current(){ return states[stateIndex]; }

function nowTime(){
  return new Date().toLocaleTimeString([], {hour12:false});
}

// Escape text before inserting it with innerHTML
function esc(text){
  return String(text).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function nodeByKey(key){ return nodeEls.find(n => n.dataset.state === key); }
function iconFor(key){ return nodeByKey(key).querySelector(".node-icon").innerHTML; }


/* ---------- 4. Log + timeline ---------- */
function addLog(message, type=""){
  logEntries.push({time:nowTime(), message, type});
  renderLog(true);
}

function renderLog(animateLast=false){
  const list = $("logList");
  const items = logEntries.slice(-40);
  if(items.length === 0){
    list.innerHTML = '<div class="log-empty">No events yet. Press Start or Next state.</div>';
    return;
  }
  list.innerHTML = items.map((x, i) => {
    const fresh = animateLast && i === items.length - 1 ? " fresh" : "";
    return `<div class="log-item ${x.type}${fresh}">
      <span class="log-icon">${LOG_ICONS[x.type] || "•"}</span>
      <span class="log-message">${esc(x.message)}</span>
      <span class="log-time">${x.time}</span>
    </div>`;
  }).join("");
  list.scrollTop = list.scrollHeight;   // auto-scroll to the newest event
}

function addTimeline(title, detail){
  timelineEntries.push({time:nowTime(), title, detail});
  renderTimeline();
}

function renderTimeline(){
  if(timelineEntries.length === 0){
    $("timeline").innerHTML = '<div class="timeline-empty">The timeline fills in as the transaction runs.</div>';
    return;
  }
  $("timeline").innerHTML = timelineEntries.map(x => {
    // Colour the dot by state when the title is a state name
    const isState = states.some(s => s.key === x.title);
    const stateAttr = isState ? ` data-state="${x.title}"` : "";
    return `<div class="timeline-item"${stateAttr}><div class="timeline-time">${x.time}</div><div class="timeline-title">${esc(x.title)}</div><div class="timeline-detail">${esc(x.detail)}</div></div>`;
  }).join("");
}


/* ---------- 5. Lifecycle diagram ---------- */

function updateNodes(){
  const cur = current().key;
  const nextKeys = TRANSITIONS[cur];
  nodeEls.forEach(n => {
    const key = n.dataset.state;
    n.classList.remove("current","done","error-current","possible","idle");

    if(key === cur){
      if(key === "FAILED" || key === "ABORTED") n.classList.add("error-current");
      else n.classList.add("current");
    }
    // BUG FIX 1: originally "done" meant index < stateIndex, which marked
    // COMMITTED as done while in FAILED. Now only visited states are done.
    else if(visited.includes(key)) n.classList.add("done");

    if(nextKeys.includes(key)) n.classList.add("possible");
    if(key !== cur && !visited.includes(key) && !nextKeys.includes(key)) n.classList.add("idle");
    n.classList.toggle("pinned", key === pinnedState);
  });
}

function updateEdges(){
  const cur = current().key;
  const failed = visited.includes("FAILED");
  edgeGroups.forEach(g => {
    const edge = g.dataset.edge;
    const from = edge.split(">")[0];
    g.classList.toggle("done", traversed.includes(edge));
    g.classList.toggle("next", from === cur);
    g.classList.toggle("after-fail", failed && edge === "ABORTED>TERMINATED");
  });
}

/* --- Moving transaction token --- */
const token = $("txnToken");
let tokenFrame = null;
let tokenDelay = null;

function nodeCenter(key){
  const n = nodeByKey(key);
  return { x: Number(n.style.getPropertyValue("--x")), y: Number(n.style.getPropertyValue("--y")) };
}

// Where the token "parks": on the top border of a node
function restPoint(key){
  const c = nodeCenter(key);
  return { x: c.x, y: c.y - 46 };
}

function setToken(p){
  token.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
}

function cancelTokenAnimation(){
  cancelAnimationFrame(tokenFrame);
  clearTimeout(tokenDelay);
  edgeGroups.forEach(g => g.classList.remove("flowing"));
  token.classList.remove("moving");
}

// Animate the token along the SVG arrow from one state to the next
function moveToken(fromKey, toKey){
  cancelTokenAnimation();
  const group = edgeGroups.find(g => g.dataset.edge === fromKey + ">" + toKey);

  if(!group){                       // no arrow (e.g. reset) → just glide there
    token.classList.add("glide");
    setToken(restPoint(toKey));
    return;
  }

  const path = group.querySelector(".edge");
  const length = path.getTotalLength();
  const start = path.getPointAtLength(0);

  // Step 1: glide to the start of the arrow
  group.classList.add("flowing");
  token.classList.add("glide", "moving");
  setToken(start);

  // Step 2: follow the arrow frame by frame
  tokenDelay = setTimeout(() => {
    token.classList.remove("glide");
    const t0 = performance.now();
    const duration = 520;

    const step = now => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      setToken(path.getPointAtLength(length * eased));

      if(t < 1){
        tokenFrame = requestAnimationFrame(step);
      } else {
        // Step 3: park on the new state and pop its icon
        token.classList.add("glide");
        token.classList.remove("moving");
        group.classList.remove("flowing");
        setToken(restPoint(toKey));
        arrive(toKey);
      }
    };
    tokenFrame = requestAnimationFrame(step);
  }, 160);
}

function arrive(key){
  const n = nodeByKey(key);
  n.classList.remove("arrive");
  void n.offsetWidth;               // restart the CSS animation
  n.classList.add("arrive");
}


/* ---------- 6. UI update ---------- */

/* How many operations of the buffer have run for a given state.
   With the built-in 4 operations this is the original 2 (ACTIVE) / 4 (PARTIALLY COMMITTED);
   with an imported file it scales to the file's operation count. */
function opCount(){
  return window.SimInput ? SimInput.ops.length : 4;
}
function opsAt(stateKey){
  const n = opCount();
  if(stateKey === "ACTIVE") return Math.ceil(n / 2);
  if(stateKey === "PARTIALLY COMMITTED") return n;
  return 0;
}
function executedCount(){
  let executed = 0;
  if(visited.includes("ACTIVE")) executed = opsAt("ACTIVE");
  if(visited.includes("PARTIALLY COMMITTED")) executed = opsAt("PARTIALLY COMMITTED");
  return executed;
}

function updateOperations(){
  const rows = [...document.querySelectorAll(".op-row")];

  // How many operations had run before the transaction stopped
  const executed = executedCount();

  // BUG FIX 2: after ABORTED → TERMINATED the rows used to flip back to
  // EXECUTED. A rolled-back transaction now stays rolled back.
  const rolledBack = visited.includes("ABORTED");
  const failedNow = current().key === "FAILED";

  rows.forEach((row, i) => {
    const status = row.querySelector(".op-status");
    let cls, text;
    if(rolledBack){
      cls = i < executed ? "rollback" : "skipped";
      text = i < executed ? "ROLLED BACK" : "NOT RUN";
    } else if(i < executed){
      cls = "executed"; text = "EXECUTED";
    } else if(failedNow){
      cls = "skipped"; text = "HALTED";
    } else {
      cls = "pending"; text = "PENDING";
    }

    if(status.textContent !== text && text !== "PENDING"){
      row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
    }
    status.className = "op-status " + cls;
    status.textContent = text;
  });
}

// Enable / disable buttons depending on what is valid right now
function updateButtons(){
  const key = current().key;
  const busy = failureInProgress;
  $("startBtn").disabled = running || busy;
  $("nextBtn").disabled  = busy || ["FAILED","ABORTED","TERMINATED"].includes(key);
  $("pauseBtn").disabled = !running;
  $("failBtn").disabled  = busy || !["NEW","ACTIVE","PARTIALLY COMMITTED"].includes(key);
  $("startLabel").textContent = key === "TERMINATED" ? "Run again" : "Start";
}

function updateUI(){
  const s = current();
  const txn = $("txnId").value || "TXN-001";

  // Header metrics
  $("heroTxn").textContent = txn;
  $("heroState").textContent = s.key;
  $("heroState").dataset.state = s.key;
  $("heroMode").textContent = $("scenario").value === "failure" ? "FAILURE" : "SUCCESS";

  // Current status card
  $("currentName").textContent = s.key;
  $("currentDesc").textContent = s.desc;
  $("stateSymbol").innerHTML = iconFor(s.key);
  $("statusPanel").dataset.state = s.key;
  $("statusTxn").textContent = txn;
  $("statusAction").textContent = lastAction;
  $("statusOp").textContent = $("operation").value;
  $("statusIso").textContent = $("isolation").value;

  // Transition guide
  $("nextState").textContent = s.next;
  $("nextState").dataset.state = s.next;
  $("nextDesc").textContent = s.nextDesc;
  $("transitionCode").textContent = s.key + " → " + s.next;
  const others = TRANSITIONS[s.key].filter(k => k !== s.next);
  $("nextAlt").innerHTML = others.length
    ? "Also possible: " + others.map(k => `<span class="chip" data-state="${k}">${k}</span>`).join("")
    : "";

  // Progress (original values)
  let progress = 0;
  if(s.key==="NEW") progress=0;
  if(s.key==="ACTIVE") progress=25;
  if(s.key==="PARTIALLY COMMITTED") progress=50;
  if(s.key==="COMMITTED") progress=75;
  if(s.key==="TERMINATED") progress=100;
  if(s.key==="FAILED") progress=60;
  if(s.key==="ABORTED") progress=82;
  $("progressBar").style.width = progress + "%";
  $("progressText").textContent = progress + "%";

  // Run badge (spinner while running / rolling back)
  const badge = $("runBadge");
  badge.className = "badge";
  if(failureInProgress){ badge.textContent = "ROLLING BACK"; badge.classList.add("is-rolling"); }
  else if(running){ badge.textContent = "RUNNING"; badge.classList.add("is-running"); }
  else if(s.key === "TERMINATED"){ badge.textContent = "COMPLETE"; badge.classList.add("is-complete"); }
  else badge.textContent = "READY";

  // Token colour + label
  $("tokenLabel").textContent = txn;
  let tone = "";
  if(s.key === "FAILED" || s.key === "ABORTED" || (s.key === "TERMINATED" && visited.includes("ABORTED"))) tone = "error";
  else if(s.key === "COMMITTED") tone = "success";
  else if(s.key === "TERMINATED") tone = "done";
  token.dataset.tone = tone;

  // Recovery log graphic: commit writes to the log, rollback reads from it
  const disk = $("logDisk");
  disk.classList.toggle("commit", s.key === "COMMITTED");
  disk.classList.toggle("undo", s.key === "ABORTED");
  $("diskNote").textContent =
    s.key === "COMMITTED" ? "commit record forced" :
    s.key === "ABORTED" ? "undo from log" : "stable storage";

  // Small "bump" animation when the state changes
  if(lastShownKey !== s.key){
    const panel = $("statusPanel");
    panel.classList.remove("bump"); void panel.offsetWidth; panel.classList.add("bump");
    lastShownKey = s.key;
  }

  updateNodes(); updateEdges(); updateOperations(); updateButtons();
  if(!hoverState) refreshInspector();
  updateAskContext();
  // Lock panel follows the lifecycle (lock-ui.js)
  if(window.LockUI) LockUI.syncSimulator({ visited, key: s.key, executed: executedCount() });
}


/* ---------- 7. Core simulator logic ---------- */

function transitionTo(index, source="manual"){
  if(index<0 || index>=states.length) return;
  const prevKey = current().key;
  stateIndex = index;
  const s = current();

  // Remember the path the transaction actually took
  if(!visited.includes(s.key)) visited.push(s.key);
  const edgeKey = prevKey + ">" + s.key;
  const reason = EVENT_LABELS[edgeKey];
  if(reason){
    traversed.push(edgeKey);
    lastAction = reason;
  }

  updateUI();
  moveToken(prevKey, s.key);

  const detail = source==="failure" ? "Failure path / recovery state" : "Lifecycle transition executed";
  if(reason) addLog(reason, "event");
  const logType = s.key==="FAILED" ? "error" : s.key==="ABORTED" ? "rollback" : (s.key==="COMMITTED"||s.key==="TERMINATED" ? "success" : "");
  addLog(`State changed → ${s.key}`, logType);
  addTimeline(s.key, reason ? `${reason} — ${detail}` : detail);

  if(s.key==="ACTIVE") markOps(opsAt("ACTIVE"));
  if(s.key==="PARTIALLY COMMITTED") markOps(opsAt("PARTIALLY COMMITTED"));
  if(s.key==="COMMITTED"){
    addLog("Commit successful. Changes are now durable.","success");
    showToast("success", "Transaction committed successfully", `${$("txnId").value || "TXN-001"}: changes are now durable.`);
    flashPanel("flash-success");
  }
  if(s.key==="FAILED"){
    showToast("error", "Transaction failed", "Error detected. The DBMS will now roll back.");
    flashPanel("flash-error");
  }
  if(s.key==="ABORTED"){
    addLog("Rollback completed. All transaction changes were undone.","rollback");
    showToast("rollback", "Rollback complete", "The database is restored to its state before the transaction.");
  }
  if(s.key==="TERMINATED") stopSimulation();

  syncTransitionToBackend(prevKey, s.key, detail);
  hideAiPanel();
}

function markOps(count){
  [...document.querySelectorAll(".op-row")].forEach((row,i)=>{
    const status=row.querySelector(".op-status");
    if(i<count){status.className="op-status executed";status.textContent="EXECUTED";}
  });
}

function nextStep(){
  if(failureInProgress) return;
  if(current().key==="ACTIVE" && $("scenario").value==="failure"){
    injectFailure(); return;
  }
  if(stateIndex<3) transitionTo(stateIndex+1);
  else if(stateIndex===3) transitionTo(6);
  else if(stateIndex===6) stopSimulation();
}

function startSimulation(){
  if(running || failureInProgress) return;
  if(stateIndex===3) transitionTo(6);
  if(stateIndex>=4) resetSimulation();
  running=true;
  lastAction="Automatic playback started";
  addLog("Simulation started.");
  addTimeline("Simulation started","Automatic lifecycle playback");
  updateUI();
  timer=setInterval(()=>{
    if($("scenario").value==="failure" && current().key==="ACTIVE"){ injectFailure(); return; }
    if(stateIndex<3){ transitionTo(stateIndex+1); }
    else if(stateIndex===3){ transitionTo(6); }
    else stopSimulation();
  },1600);
}

function stopSimulation(){
  running=false;
  if(timer){clearInterval(timer);timer=null}
  updateUI();
}

function pauseSimulation(){
  if(!running){ addLog("Simulation is already paused."); return; }
  stopSimulation();
  lastAction="Playback paused";
  addLog("Simulation paused.");
  updateUI();
}

function resetSimulation(){
  stopSimulation();
  // BUG FIX 3: cancel a failure chain that is still waiting to run
  failureTimeouts.forEach(clearTimeout);
  failureTimeouts=[];
  failureInProgress=false;

  stateIndex=0;
  visited=["NEW"];
  traversed=[];
  lastAction="Transaction created";
  logEntries=[]; timelineEntries=[];
  addLog("Transaction created and reset to NEW.");
  addTimeline("NEW","Transaction initialized");

  cancelTokenAnimation();
  token.classList.add("glide");
  setToken(restPoint("NEW"));
  if(window.LockUI) LockUI.resetLog();
  updateUI();

  hideAiPanel();
  createBackendTransaction();
}

// Helper so every failure-chain timer can be cancelled by reset
function schedule(fn, ms){
  failureTimeouts.push(setTimeout(fn, ms));
}

function injectFailure(){
  // BUG FIX 4: ignore extra presses while a failure chain is already running
  if(failureInProgress) return;
  stopSimulation();
  if(!["ACTIVE","PARTIALLY COMMITTED","NEW"].includes(current().key)) return;

  failureInProgress=true;
  lastAction="Failure injected";
  addLog(`Failure occurred while in ${current().key === "NEW" ? "ACTIVE" : current().key}.`, "error");

  if(current().key==="NEW") transitionTo(1,"failure");
  schedule(()=>{
    transitionTo(4,"failure");
    schedule(()=>transitionTo(5,"failure"),900);
    schedule(()=>{ failureInProgress=false; transitionTo(6,"failure"); },1800);
  },150);
}


/* ---------- 7b. Backend integration (best-effort; simulator works fully offline) ---------- */

async function checkBackend(){
  const res = await TxnApi.health();
  backendOnline = !!(res && res.ok);
  aiLive = backendOnline && !!(res.body && res.body.aiEnabled);

  const dot = $("liveDot"), text = $("connectionText"), detail = $("connectionDetail");
  if(backendOnline){
    dot.style.background = "var(--green)"; dot.style.boxShadow = "0 0 8px var(--green)";
    text.textContent = "Backend connected";
    detail.textContent = aiLive ? "Live AI enabled · runs persisted" : "Runs persisted · AI using built-in answers";
  } else {
    dot.style.background = "var(--red)"; dot.style.boxShadow = "0 0 8px var(--red)";
    text.textContent = "Offline mode";
    detail.textContent = "Running local-only simulation (no backend found)";
  }
  $("askModeBadge").textContent = backendOnline ? (aiLive ? "LIVE AI" : "BUILT-IN") : "OFFLINE";
}

async function createBackendTransaction(){
  backendTxnId = null;
  askEntries = [];
  renderAskThread();
  if(!backendOnline){ updateAskContext(); return; }

  const payload = {
    txnCode: $("txnId").value || "TXN-001",
    operation: $("operation").value,
    isolation: $("isolation").value,
    scenario: $("scenario").value,
  };
  // Imported input: send the real operation list so the backend stores it
  if(window.SimInput && SimInput.active) payload.operations = SimInput.labels();
  const res = await TxnApi.createTransaction(payload);
  if(res && res.ok){
    backendTxnId = res.body.transaction.id;
  } else if(res && res.body && res.body.errors){
    addLog("Backend validation: " + res.body.errors.join(" "), "error");
  }
  updateAskContext();
}

async function syncTransitionToBackend(fromState, toState, note){
  if(!backendOnline || !backendTxnId) return;
  if(toState === "FAILED" && fromState === "ACTIVE"){
    await TxnApi.fail(backendTxnId);
    return;
  }
  const res = await TxnApi.transition(backendTxnId, toState, note);
  if(res && !res.ok && !res.networkError){
    addLog(`Backend sync skipped: ${res.error}`, "");
  }
}

/* --- AI Explain panel --- */

function hideAiPanel(){
  $("aiPanel").classList.add("hidden");
  $("aiSourceBadge").textContent = "—";
  $("aiPanelText").textContent = 'Press "AI explain" to get a plain-language explanation of the current state.';
}

async function explainCurrentState(){
  $("aiPanel").classList.remove("hidden");
  if(!backendOnline || !backendTxnId){
    $("aiSourceBadge").textContent = "OFFLINE";
    $("aiPanelText").textContent = "AI explain needs the backend running (npm start in /backend). " +
      "Local description: " + current().desc;
    return;
  }
  $("aiSourceBadge").textContent = "LOADING…";
  $("aiPanelText").textContent = "Asking the AI explainer…";
  const res = await TxnApi.explain(backendTxnId);
  if(res && res.ok){
    $("aiSourceBadge").textContent =
      res.body.source === "ai" ? "CLAUDE" : (res.body.source === "cache" ? "CACHED" : "BUILT-IN");
    $("aiPanelText").textContent = res.body.explanation;
  } else {
    $("aiSourceBadge").textContent = "ERROR";
    $("aiPanelText").textContent = "Could not fetch an explanation right now. " + current().desc;
  }
}

/* --- Ask AI view --- */

function updateAskContext(){
  const el = $("askContext");
  if(!el) return;
  if(!backendOnline){
    el.textContent = "Backend offline — start it to ask the AI tutor.";
    return;
  }
  const txnCode = $("txnId").value || "TXN-001";
  el.textContent = `Context: ${txnCode} · ${$("operation").value} · ${$("isolation").value} · currently ${current().key}`;
}

function renderAskThread(){
  const el = $("askThread");
  if(!el) return;
  if(!askEntries.length){
    el.innerHTML = '<p class="ask-empty">No questions yet. Pick a suggestion below or type your own.</p>';
    return;
  }
  el.innerHTML = askEntries.map(e => `
    <div class="ask-turn">
      <div class="ask-q"><span class="ask-role">YOU</span>${esc(e.question)}</div>
      <div class="ask-a">
        <span class="ask-role ai">AI<i class="ask-src">${esc(e.source)}</i></span>
        <div class="ask-answer">${esc(e.answer).replace(/\n/g,"<br>")}</div>
      </div>
    </div>
  `).join("");
  el.scrollTop = el.scrollHeight;
}

async function sendAskQuestion(questionText){
  const input = $("askInput");
  const question = (questionText !== undefined ? questionText : input.value).trim();
  if(!question) return;

  input.value = "";

  if(!backendOnline || !backendTxnId){
    askEntries.push({
      question,
      answer: "Ask AI needs the backend running. Start it with `npm start` in the backend folder, then reload this page.",
      source: "OFFLINE"
    });
    renderAskThread();
    return;
  }

  askEntries.push({ question, answer: "Thinking…", source: "…" });
  renderAskThread();

  input.disabled = true;
  $("askSendBtn").disabled = true;

  const res = await TxnApi.ask(backendTxnId, question);
  const turn = askEntries[askEntries.length - 1];

  if(res && res.ok){
    turn.answer = res.body.answer;
    turn.source = res.body.source === "ai" ? "CLAUDE" : "BUILT-IN";
  } else {
    turn.answer = (res && res.error) ? `Could not get an answer: ${res.error}` : "Could not get an answer right now.";
    turn.source = "ERROR";
  }

  input.disabled = false;
  $("askSendBtn").disabled = false;
  renderAskThread();
  input.focus();
}

function clearAskThread(){
  askEntries = [];
  renderAskThread();
  if(backendOnline && backendTxnId) TxnApi.clearQuestions(backendTxnId);
}

function switchToAskView(){
  document.querySelectorAll(".nav-item").forEach(x=>x.classList.remove("active"));
  const btn = document.querySelector('.nav-item[data-view="ask"]');
  if(btn) btn.classList.add("active");
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active-view"));
  $("askView").classList.add("active-view");
  updateAskContext();
  renderAskThread();
  $("askInput").focus();
}

/* --- Export & history --- */

function exportCurrentTransaction(format){
  if(!backendOnline || !backendTxnId){
    addLog("Export needs the backend running - start it and try again.", "error");
    return;
  }
  window.open(TxnApi.exportUrl(backendTxnId, format), "_blank");
  addLog(`${format.toUpperCase()} report requested from backend.`, "success");
}

async function renderHistory(){
  const listEl = $("historyList");
  if(!backendOnline){
    listEl.innerHTML = '<p class="history-empty">Backend is offline — start it (npm start in /backend) to see saved runs.</p>';
    return;
  }
  const res = await TxnApi.history(25);
  if(!res || !res.ok || !res.body.transactions.length){
    listEl.innerHTML = '<p class="history-empty">No transactions recorded yet. Run a simulation to populate history.</p>';
    return;
  }
  listEl.innerHTML = res.body.transactions.map(t => `
    <div class="history-row">
      <div class="history-main">
        <b>${esc(t.txnCode)}</b>
        <span class="history-op">${esc(t.operation)} · ${esc(t.isolation)}</span>
      </div>
      <div class="history-meta">
        <span class="history-state" data-state="${esc(t.currentState)}">${esc(t.currentState)}</span>
        <span class="history-time">${esc(t.updatedAt)}</span>
        <a class="text-btn" href="${TxnApi.exportUrl(t.id,'pdf')}" target="_blank">PDF</a>
        <a class="text-btn" href="${TxnApi.exportUrl(t.id,'json')}" target="_blank">JSON</a>
      </div>
    </div>
  `).join("");
}


/* ---------- 8. Extras ---------- */

/* --- State information panel --- */
function renderInspector(key, tag){
  const box = $("inspector");
  if(box.dataset.state !== key){
    box.classList.remove("swap"); void box.offsetWidth; box.classList.add("swap");
  }
  box.dataset.state = key;
  $("inspectorIcon").innerHTML = iconFor(key);
  $("inspectorName").textContent = key;
  $("inspectorTag").textContent = tag;
  $("inspectorDesc").textContent = STATE_INFO[key];

  const from = Object.keys(TRANSITIONS).filter(k => TRANSITIONS[k].includes(key));
  const to = TRANSITIONS[key];
  $("inspectorFlow").innerHTML =
    `<span>Entered from: <b>${from.join(", ") || "— (start)"}</b></span>` +
    `<span>Can move to: <b>${to.join(", ") || "— (end of lifecycle)"}</b></span>`;
}

function refreshInspector(){
  if(pinnedState) renderInspector(pinnedState, pinnedState === current().key ? "Current state (pinned)" : "Pinned — click again to unpin");
  else renderInspector(current().key, "Current state");
}

nodeEls.forEach(n => {
  const key = n.dataset.state;
  const show = () => { hoverState = key; renderInspector(key, key === current().key ? "Current state" : "State information"); };
  const hide = () => { hoverState = null; refreshInspector(); };
  n.addEventListener("mouseenter", show);
  n.addEventListener("mouseleave", hide);
  n.addEventListener("focus", show);
  n.addEventListener("blur", hide);
  n.addEventListener("click", () => {
    pinnedState = pinnedState === key ? null : key;
    hoverState = null;
    updateNodes();
    refreshInspector();
  });
});

/* --- Toast notifications --- */
function showToast(type, title, message){
  const icons = { success: "✓", error: "!", rollback: "↩" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-icon">${icons[type]}</div><div><b>${esc(title)}</b><span>${esc(message)}</span></div>`;
  $("toastStack").appendChild(el);
  setTimeout(() => el.classList.add("leaving"), 2600);
  setTimeout(() => el.remove(), 3000);
}

function flashPanel(cls){
  const p = $("lifecyclePanel");
  p.classList.add(cls);
  setTimeout(() => p.classList.remove(cls), 1100);
}

/* --- Scale the 1100×440 diagram to fit the available width --- */
function fitStage(){
  const available = $("stageWrap").clientWidth - 24;
  const scale = Math.max(0.62, Math.min(1.12, available / 1100));
  $("stage").style.transform = `scale(${scale})`;
  $("stageSizer").style.width = (1100 * scale) + "px";
  $("stageSizer").style.height = (440 * scale) + "px";
}
window.addEventListener("resize", fitStage);

/* --- Clock --- */
function updateClock(){
  const d=new Date();
  $("clock").textContent=d.toLocaleTimeString([], {hour12:false});
}
setInterval(updateClock,1000); updateClock();

/* --- Button + input events (same handlers as before) --- */
$("startBtn").onclick=startSimulation;
$("nextBtn").onclick=nextStep;
$("pauseBtn").onclick=pauseSimulation;
$("failBtn").onclick=injectFailure;
$("resetBtn").onclick=resetSimulation;
$("clearLog").onclick=()=>{logEntries=[];renderLog()};
$("scenario").onchange=()=>{
  const failure=$("scenario").value==="failure";
  $("heroMode").textContent=failure?"FAILURE":"SUCCESS";
  addLog(`Scenario selected: ${failure?"Failure & rollback":"Successful transaction"}.`);
};
$("txnId").oninput=()=>updateUI();
$("operation").onchange=()=>updateUI();
$("isolation").onchange=()=>updateUI();

/* --- AI explain / export / history buttons --- */
$("explainBtn").onclick=explainCurrentState;
$("askMoreBtn").onclick=switchToAskView;
$("exportPdfBtn").onclick=()=>exportCurrentTransaction("pdf");
$("exportJsonBtn").onclick=()=>exportCurrentTransaction("json");
$("refreshHistory").onclick=renderHistory;

/* --- Ask AI buttons --- */
$("askSendBtn").onclick=()=>sendAskQuestion();
$("askInput").addEventListener("keydown", e=>{
  if(e.key==="Enter"){ e.preventDefault(); sendAskQuestion(); }
});
$("clearAsk").onclick=clearAskThread;
document.querySelectorAll("#askSuggestions .chip-btn").forEach(chip=>{
  chip.onclick=()=>sendAskQuestion(chip.dataset.q);
});

/* --- Sidebar navigation --- */
document.querySelectorAll(".nav-item[data-view]").forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll(".nav-item").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
    const view=btn.dataset.view;
    document.querySelectorAll(".view").forEach(x=>x.classList.remove("active-view"));
    $(view+"View").classList.add("active-view");
    if(view==="simulator") fitStage();
    if(view==="history") renderHistory();
    if(view==="locks" && window.LockUI) LockUI.showView();
    if(view==="ask"){ updateAskContext(); renderAskThread(); $("askInput").focus(); }
  }
});

/* --- Theme toggle (dark is the default) --- */
function updateThemeIcon(){
  $("themeBtn").innerHTML = document.body.classList.contains("light") ? MOON_ICON : SUN_ICON;
}
$("themeBtn").onclick=()=>{
  document.body.classList.toggle("light");
  updateThemeIcon();
};
updateThemeIcon();

/* --- Help modal --- */
$("helpBtn").onclick=()=>$("helpModal").classList.remove("hidden");
$("closeHelp").onclick=()=>$("helpModal").classList.add("hidden");
$("helpModal").onclick=e=>{if(e.target.id==="helpModal")$("helpModal").classList.add("hidden")};

/* --- Keyboard shortcuts --- */
document.addEventListener("keydown",e=>{
  // BUG FIX 5: don't trigger shortcuts while typing in the form
  const tag = e.target.tagName;
  if(tag==="INPUT" || tag==="SELECT" || tag==="TEXTAREA") return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(e.key==="Escape") $("helpModal").classList.add("hidden");
  if(e.key===" "){e.preventDefault(); nextStep();}
  if(e.key.toLowerCase()==="f") injectFailure();
  if(e.key.toLowerCase()==="r") resetSimulation();
});

/* --- Start --- */
fitStage();
checkBackend().then(resetSimulation);
