/**
 * AI SQL Assistant — local in-browser AI for the Custom SQL step.
 *
 * Injects a "Local AI" panel into the Custom SQL step dialog
 * (`.modal.step-dialog--large`). Lets you download and run one of three
 * in-browser providers — wllama (WASM), WebLLM (WebGPU), Transformers.js
 * (WebGPU/WASM) — entirely offline, then generate DuckDB SQL with the
 * current query/result as context.
 *
 * The panel is appended to the dialog element (not the React-rendered body),
 * so it survives React re-renders while the dialog is open. All panel state
 * lives in module-level variables and is rebuilt on each injection.
 *
 * @module ai-sql-assistant
 */

import {
  PROVIDERS,
  getModels,
  getProviderInfo,
  isModelInstalled,
  installModel,
  removeModel,
  generateSQL,
} from "./ai-local-providers.js?v=6";

/* ===================================================================
   State (module-level — survives React re-renders)
   =================================================================== */

const state = {
  providerId: localStorage.getItem("etl:ai_provider") || "wllama",
  modelId: localStorage.getItem("etl:ai_model") || null,
  generating: false,
  result: null,          // generated SQL text
  download: null,        // { modelId, progress, status, text }
  status: null,          // { text, isError }
  panelEl: null,         // the injected .etl-ai-local element
  dialogEl: null,        // the .modal.step-dialog--large element
};

/** SQL operation templates — click to fill the prompt with a request. */
const SQL_TEMPLATES = [
  { label: "Filter rows", prompt: 'Filter rows where "col" equals a specific value' },
  { label: "Aggregate", prompt: 'Group by "col" and count or sum the rows' },
  { label: "Top N", prompt: 'Show the top 10 rows ordered by "col" descending' },
  { label: "Deduplicate", prompt: "Remove duplicate rows" },
  { label: "Rename columns", prompt: 'Rename "old_col" to "new_col"' },
  { label: "Extract date", prompt: 'Extract the year and month from a date column "col"' },
  { label: "Sort", prompt: 'Sort the rows by "col" ascending' },
  { label: "Computed column", prompt: 'Add a computed column based on "col"' },
];

/* ===================================================================
   Prompt building
   =================================================================== */

/**
 * System prompt — mirrors the bundle's OM("sql", columns, "prev") so the
 * local model behaves like the existing remote AI Generate flow.
 */
export function buildSystemPrompt(columns) {
  const cols = columns && columns.length
    ? columns.map((c) => `"${c}"`).join(", ")
    : "(columns unknown — run a previous step first)";
  return [
    "You are a DuckDB SQL expert.",
    "Convert the user's request into a single DuckDB SELECT query.",
    "The previous step's result is available as the table/view `prev` — read from it, do not redefine it.",
    `Available columns in prev: ${cols}.`,
    "Return ONLY valid DuckDB SQL — no explanation, no markdown fences, no trailing semicolon.",
    "Prefer SELECT from prev. CTEs (WITH) and window functions are fine.",
  ].join(" ");
}

/**
 * User prompt — includes the current editor SQL and sample rows so the
 * model can write SQL that fits the actual data (agentic, one step only).
 */
export function buildUserPrompt({ request, currentSql, columns, sampleRows }) {
  const parts = [request];
  if (currentSql && currentSql.trim() && currentSql.trim() !== "SELECT * FROM prev") {
    parts.push(`\n\nCurrent SQL in the editor:\n\`\`\`sql\n${currentSql}\n\`\`\``);
  }
  if (columns && columns.length) {
    parts.push(`\n\nAvailable columns: ${columns.map((c) => `"${c}"`).join(", ")}`);
  }
  if (sampleRows && sampleRows.length) {
    parts.push(`\n\nSample data (first ${sampleRows.length} rows):\n${JSON.stringify(sampleRows)}`);
  }
  return parts.join("\n");
}

/* ===================================================================
   Context gathering
   =================================================================== */

/**
 * Get the CodeMirror 6 view from a .cm-content element.
 * Version-agnostic: reads the expando the view writes onto the DOM node, which
 * works for both the cmView (<=6.38) and cmTile (>=6.39) internal generations
 * without importing the CDN module.
 */
function getCmView(cmContent) {
  if (!cmContent) return null;
  return cmContent.cmView?.rootView?.view ?? cmContent.cmTile?.root?.view ?? null;
}

/** Read the current SQL from the CodeMirror editor in the dialog. */
export async function getCurrentSql(dialog) {
  dialog = dialog || state.dialogEl;
  if (!dialog) return "";
  const cmContent = dialog.querySelector(".cm-content");
  if (!cmContent) return "";
  const view = getCmView(cmContent);
  if (view) return view.state.doc.toString();
  // Fallback: CDN findFromDOM (same generation as the bundle).
  try {
    const { EditorView } = await import(
      "https://cdn.jsdelivr.net/npm/@codemirror/view@6.36.0/+esm"
    );
    const v = EditorView.findFromDOM(cmContent);
    if (v) return v.state.doc.toString();
  } catch (e) {
    /* CDN unavailable — fall through to textContent */
  }
  return cmContent.textContent || "";
}

/** Read the selected columns from the AI tab's column selector. */
export function getContextColumns(dialog) {
  dialog = dialog || state.dialogEl;
  if (!dialog) return [];
  const cols = [];
  // Checked checkboxes in the AI tab's column multiselect.
  dialog.querySelectorAll(".column-multiselect .step-checkbox input:checked").forEach((cb) => {
    const label = cb.closest(".step-checkbox");
    const span = label && label.querySelector("span");
    const name = span ? span.textContent.trim() : "";
    if (name && !cols.includes(name)) cols.push(name);
  });
  // Fall back to the current result's columns.
  if (cols.length === 0 && window.__etlData && Array.isArray(window.__etlData.columns)) {
    window.__etlData.columns.forEach((c) => {
      const name = typeof c === "string" ? c : c && c.name;
      if (name && !cols.includes(name)) cols.push(name);
    });
  }
  return cols;
}

/** Read sample rows from the current result (window.__etlData). */
export function getSampleRows() {
  const data = window.__etlData;
  if (!data || !Array.isArray(data.rows) || data.rows.length === 0) return [];
  const cols = Array.isArray(data.columns)
    ? data.columns.map((c) => (typeof c === "string" ? c : c && c.name))
    : [];
  return data.rows.slice(0, 5).map((row) => {
    const obj = {};
    row.forEach((v, i) => {
      obj[cols[i] || "col" + i] = v;
    });
    return obj;
  });
}

/* ===================================================================
   Panel injection
   =================================================================== */

function findDialog() {
  return document.querySelector(".modal.step-dialog--large");
}

function ensurePanel() {
  const dialog = findDialog();
  if (!dialog) return;
  if (dialog !== state.dialogEl) {
    state.dialogEl = dialog;
    state.panelEl = null;
    state.result = null;
    state.download = null;
    state.status = null;
    // Pick up the model selected in AI Setup (Local browser card).
    state.providerId = localStorage.getItem("etl:ai_provider") || "wllama";
    state.modelId = localStorage.getItem("etl:ai_model") || null;
  }
  if (state.panelEl && document.body.contains(state.panelEl)) return;
  dialog.classList.add("etl-ai-active");
  const panel = buildPanel();
  dialog.appendChild(panel);
  state.panelEl = panel;
  renderPanel();
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.className = "etl-ai-local";
  panel.setAttribute("aria-label", "Local AI SQL assistant");

  // Header
  const head = document.createElement("div");
  head.className = "etl-ai-local-head";
  const title = document.createElement("span");
  title.className = "etl-ai-local-title";
  title.textContent = "Local AI";
  const privacy = document.createElement("span");
  privacy.className = "etl-ai-privacy";
  privacy.textContent = "🔒 Runs in your browser — better for privacy";
  head.appendChild(title);
  head.appendChild(privacy);
  panel.appendChild(head);

  // Provider field
  panel.appendChild(buildField("Provider", buildProviderSelect()));
  // Model field
  panel.appendChild(buildField("Model", buildModelSelect()));

  // Model meta
  const meta = document.createElement("div");
  meta.className = "etl-ai-model-meta";
  panel.appendChild(meta);

  // Progress
  const progress = document.createElement("div");
  progress.className = "etl-ai-progress";
  progress.hidden = true;
  const bar = document.createElement("div");
  bar.className = "etl-ai-progress-bar";
  const fill = document.createElement("div");
  fill.className = "etl-ai-progress-fill";
  bar.appendChild(fill);
  const ptext = document.createElement("div");
  ptext.className = "etl-ai-progress-text";
  progress.appendChild(bar);
  progress.appendChild(ptext);
  panel.appendChild(progress);

  // Install / remove button
  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "etl-ai-btn etl-ai-install";
  panel.appendChild(installBtn);

  // Column quick-insert
  const colsWrap = document.createElement("div");
  colsWrap.className = "etl-ai-columns";
  const colsLabel = document.createElement("div");
  colsLabel.className = "etl-ai-columns-label";
  colsLabel.textContent = "Columns (click to add to prompt)";
  const colsList = document.createElement("div");
  colsList.className = "etl-ai-columns-list";
  colsWrap.appendChild(colsLabel);
  colsWrap.appendChild(colsList);
  panel.appendChild(colsWrap);

  // SQL template quick-insert
  const tplWrap = document.createElement("div");
  tplWrap.className = "etl-ai-columns";
  const tplLabel = document.createElement("div");
  tplLabel.className = "etl-ai-columns-label";
  tplLabel.textContent = "SQL templates (click to fill prompt)";
  const tplList = document.createElement("div");
  tplList.className = "etl-ai-columns-list etl-ai-templates-list";
  tplWrap.appendChild(tplLabel);
  tplWrap.appendChild(tplList);
  panel.appendChild(tplWrap);

  // Generate button
  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.className = "etl-ai-btn primary etl-ai-generate";
  genBtn.textContent = "Generate with Local AI";
  panel.appendChild(genBtn);

  // Status line
  const status = document.createElement("div");
  status.className = "etl-ai-status";
  status.hidden = true;
  panel.appendChild(status);

  // Result
  const result = document.createElement("div");
  result.className = "etl-ai-result";
  result.hidden = true;
  const rhead = document.createElement("div");
  rhead.className = "etl-ai-result-head";
  const rtitle = document.createElement("span");
  rtitle.className = "etl-ai-result-title";
  rtitle.textContent = "Generated SQL";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "etl-ai-btn ghost etl-ai-copy";
  copyBtn.textContent = "Copy";
  rhead.appendChild(rtitle);
  rhead.appendChild(copyBtn);
  const rsql = document.createElement("pre");
  rsql.className = "etl-ai-result-sql";
  const ractions = document.createElement("div");
  ractions.className = "etl-ai-result-actions";
  const insertBtn = document.createElement("button");
  insertBtn.type = "button";
  insertBtn.className = "etl-ai-btn primary etl-ai-insert";
  insertBtn.textContent = "Insert into editor";
  ractions.appendChild(insertBtn);
  result.appendChild(rhead);
  result.appendChild(rsql);
  result.appendChild(ractions);
  panel.appendChild(result);

  // Wire events
  panel.querySelector(".etl-ai-provider").addEventListener("change", onProviderChange);
  panel.querySelector(".etl-ai-model").addEventListener("change", onModelChange);
  installBtn.addEventListener("click", onInstallClick);
  genBtn.addEventListener("click", onGenerateClick);
  copyBtn.addEventListener("click", onCopyClick);
  insertBtn.addEventListener("click", onInsertClick);
  colsList.addEventListener("click", onColumnClick);
  tplList.addEventListener("click", onTemplateClick);

  return panel;
}

function buildField(labelText, control) {
  const field = document.createElement("div");
  field.className = "etl-ai-field";
  const label = document.createElement("label");
  label.className = "etl-ai-field-label";
  label.textContent = labelText;
  field.appendChild(label);
  field.appendChild(control);
  return field;
}

function buildProviderSelect() {
  const sel = document.createElement("select");
  sel.className = "etl-ai-select etl-ai-provider";
  sel.setAttribute("aria-label", "Local AI provider");
  for (const id of Object.keys(PROVIDERS)) {
    const info = PROVIDERS[id];
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info.label;
    if (id === state.providerId) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function buildModelSelect() {
  const sel = document.createElement("select");
  sel.className = "etl-ai-select etl-ai-model";
  sel.setAttribute("aria-label", "Local AI model");
  const models = getModels(state.providerId);
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === state.modelId) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

/* ===================================================================
   Panel rendering (rebuilds from state after every change)
   =================================================================== */

function renderPanel() {
  const panel = state.panelEl;
  if (!panel) return;

  const provider = getProviderInfo(state.providerId);
  const models = getModels(state.providerId);
  const model = models.find((m) => m.id === state.modelId) || models[0] || null;
  if (model && !models.some((m) => m.id === state.modelId)) {
    state.modelId = model.id;
    localStorage.setItem("etl:ai_model", model.id);
  }

  // Model select options
  const modelSel = panel.querySelector(".etl-ai-model");
  if (modelSel) {
    const current = modelSel.value;
    modelSel.innerHTML = "";
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === state.modelId) opt.selected = true;
      modelSel.appendChild(opt);
    });
    if (current && models.some((m) => m.id === current)) modelSel.value = current;
  }

  // Model meta
  const meta = panel.querySelector(".etl-ai-model-meta");
  if (meta && model) {
    const hw = model.hardware || {};
    const parts = [];
    if (model.params) parts.push(model.params + " params");
    if (model.sizeMB) parts.push(formatSize(model.sizeMB));
    if (model.ctx) parts.push(model.ctx.toLocaleString() + " ctx");
    meta.innerHTML = "";
    const line = document.createElement("span");
    line.textContent = parts.join(" · ");
    meta.appendChild(line);
    const hwLine = document.createElement("span");
    hwLine.className = "etl-ai-hw";
    const hwParts = [];
    if (hw.minMemoryGB) hwParts.push(hw.minMemoryGB + " GB+ RAM");
    if (provider.requiresWebGPU) hwParts.push("WebGPU required");
    else if (hw.webgpu) hwParts.push("WebGPU recommended");
    hwLine.textContent = hwParts.join(" · ");
    meta.appendChild(hwLine);
  }

  // Install button
  const installBtn = panel.querySelector(".etl-ai-install");
  if (installBtn && model) {
    const installed = isModelInstalled(state.providerId, model.id);
    const downloading = state.download && state.download.modelId === model.id &&
      state.download.status === "downloading";
    if (downloading) {
      installBtn.textContent = "Downloading…";
      installBtn.disabled = true;
    } else if (installed) {
      installBtn.textContent = "Installed ✓ — click to remove";
      installBtn.classList.remove("primary");
    } else {
      installBtn.textContent = "Download " + formatSize(model.sizeMB);
      installBtn.classList.add("primary");
      installBtn.disabled = false;
    }
  }

  // Progress
  const progress = panel.querySelector(".etl-ai-progress");
  const fill = panel.querySelector(".etl-ai-progress-fill");
  const ptext = panel.querySelector(".etl-ai-progress-text");
  if (state.download && state.download.status === "downloading") {
    progress.hidden = false;
    if (fill) fill.style.width = (state.download.progress || 0) + "%";
    if (ptext) ptext.textContent = state.download.text || "";
  } else {
    progress.hidden = true;
  }

  // Column buttons + templates
  renderColumns();
  renderTemplates();

  // Generate button
  const genBtn = panel.querySelector(".etl-ai-generate");
  if (genBtn) {
    const installed = model && isModelInstalled(state.providerId, model.id);
    genBtn.disabled = state.generating || !installed;
    genBtn.textContent = state.generating ? "Generating…" : "Generate with Local AI";
  }

  // Status
  const status = panel.querySelector(".etl-ai-status");
  if (status) {
    if (state.status) {
      status.hidden = false;
      status.textContent = state.status.text;
      status.classList.toggle("is-error", !!state.status.isError);
    } else {
      status.hidden = true;
    }
  }

  // Result
  const result = panel.querySelector(".etl-ai-result");
  const rsql = panel.querySelector(".etl-ai-result-sql");
  if (result && rsql) {
    if (state.result) {
      result.hidden = false;
      rsql.textContent = state.result;
    } else {
      result.hidden = true;
    }
  }
}

function formatSize(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  return mb + " MB";
}

let lastColumnsSig = "";

/** Rebuild the column quick-insert buttons only when the column list changes. */
function renderColumns() {
  const panel = state.panelEl;
  if (!panel) return;
  const colsList = panel.querySelector(".etl-ai-columns-list");
  if (!colsList) return;
  const cols = getContextColumns();
  const sig = JSON.stringify(cols);
  if (sig === lastColumnsSig) return;
  lastColumnsSig = sig;
  colsList.innerHTML = "";
  cols.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "etl-ai-col-btn";
    btn.textContent = c;
    btn.title = 'Add "' + c + '" to the prompt';
    colsList.appendChild(btn);
  });
}

/**
 * Rebuild the SQL template buttons. SQL_TEMPLATES is a constant, so this only
 * needs to run once — the guard prevents the MutationObserver from re-triggering
 * itself (rebuilding the list mutates the DOM, which fires the observer again).
 */
function renderTemplates() {
  const panel = state.panelEl;
  if (!panel) return;
  const tplList = panel.querySelector(".etl-ai-templates-list");
  if (!tplList) return;
  if (tplList.childElementCount === SQL_TEMPLATES.length) return; // already built
  tplList.innerHTML = "";
  SQL_TEMPLATES.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "etl-ai-col-btn";
    btn.textContent = t.label;
    btn.title = t.prompt;
    tplList.appendChild(btn);
  });
}

/* ===================================================================
   Actions
   =================================================================== */

function onProviderChange(e) {
  state.providerId = e.target.value;
  state.modelId = null;
  localStorage.setItem("etl:ai_provider", state.providerId);
  localStorage.removeItem("etl:ai_model");
  state.result = null;
  state.download = null;
  state.status = null;
  renderPanel();
}

function onModelChange(e) {
  state.modelId = e.target.value;
  localStorage.setItem("etl:ai_model", state.modelId);
  state.result = null;
  state.download = null;
  state.status = null;
  renderPanel();
}

async function onInstallClick() {
  const model = getModels(state.providerId).find((m) => m.id === state.modelId);
  if (!model) return;
  if (isModelInstalled(state.providerId, model.id)) {
    if (!window.confirm('Remove "' + model.name + '"? The downloaded model will be deleted.')) return;
    try {
      await removeModel(state.providerId, model.id);
      setStatus("Model removed.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
    renderPanel();
    return;
  }
  state.download = { modelId: model.id, progress: 0, status: "downloading", text: "Starting…" };
  state.status = null; // clear any previous error while a new download runs
  renderPanel();
  try {
    await installModel(state.providerId, model, (p) => {
      state.download = {
        modelId: model.id,
        progress: p.progress,
        status: "downloading",
        text: p.text,
      };
      renderPanel();
    });
    state.download = null;
    setStatus("Model installed. You can now generate SQL offline.");
  } catch (err) {
    state.download = null;
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
  renderPanel();
}

async function onGenerateClick() {
  if (state.generating) return;
  const model = getModels(state.providerId).find((m) => m.id === state.modelId);
  if (!model) return;
  if (!isModelInstalled(state.providerId, model.id)) {
    setStatus("Download the model first.", true);
    return;
  }

  // Read the prompt from the AI tab's textarea (switching to it if needed).
  await ensureAiTab();
  const promptEl = getPromptEl();
  const request = promptEl ? promptEl.value.trim() : "";
  if (!request) {
    setStatus("Describe the SQL you want in the prompt box first.", true);
    return;
  }

  const columns = getContextColumns();
  const sampleRows = getSampleRows();
  const currentSql = await getCurrentSql();
  const system = buildSystemPrompt(columns);
  const user = buildUserPrompt({ request, currentSql, columns, sampleRows });

  state.generating = true;
  state.result = null;
  state.status = null;
  renderPanel();

  try {
    const output = await generateSQL({
      providerId: state.providerId,
      modelId: model.id,
      system,
      user,
      onChunk: (text) => {
        state.result = text;
        renderPanel();
      },
    });
    state.result = output;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    state.generating = false;
    renderPanel();
  }
}

function onCopyClick() {
  if (!state.result) return;
  navigator.clipboard.writeText(state.result).then(() => {
    setStatus("Copied to clipboard.");
  }).catch(() => {
    setStatus("Copy failed — select the text manually.", true);
  });
}

async function onInsertClick() {
  if (!state.result) return;
  const dialog = state.dialogEl;
  if (!dialog) return;
  const cmContent = dialog.querySelector(".cm-content");
  if (!cmContent) {
    setStatus("Could not find the SQL editor.", true);
    return;
  }
  const replace = (view) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: state.result },
    });
    setStatus("Inserted into the editor.");
  };
  // Primary: version-agnostic expando read (no CDN import needed).
  const view = getCmView(cmContent);
  if (view) {
    replace(view);
    return;
  }
  // Fallback: CDN findFromDOM (same generation as the bundle).
  try {
    const { EditorView } = await import(
      "https://cdn.jsdelivr.net/npm/@codemirror/view@6.36.0/+esm"
    );
    const v = EditorView.findFromDOM(cmContent);
    if (v) {
      replace(v);
      return;
    }
  } catch (e) {
    /* CDN unavailable — fall through */
  }
  setStatus("Could not insert — select the SQL and paste it manually.", true);
}

async function onColumnClick(e) {
  const btn = e.target.closest(".etl-ai-col-btn");
  if (!btn) return;
  await ensureAiTab();
  const promptEl = getPromptEl();
  if (!promptEl) return;
  const name = btn.textContent;
  const quoted = '"' + name + '"';
  const cur = promptEl.value;
  const sep = cur && !cur.endsWith(" ") ? " " : "";
  promptEl.value = cur + sep + quoted;
  promptEl.focus();
  promptEl.dispatchEvent(new Event("input", { bubbles: true }));
}

async function onTemplateClick(e) {
  const btn = e.target.closest(".etl-ai-templates-list .etl-ai-col-btn");
  if (!btn) return;
  await ensureAiTab();
  const promptEl = getPromptEl();
  if (!promptEl) return;
  const tpl = SQL_TEMPLATES.find((t) => t.label === btn.textContent);
  if (!tpl) return;
  promptEl.value = tpl.prompt;
  promptEl.focus();
  promptEl.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The AI Generate tab's prompt textarea inside the dialog. */
function getPromptEl() {
  const dialog = state.dialogEl;
  if (!dialog) return null;
  return dialog.querySelector("textarea.step-input");
}

/**
 * Switch the dialog to the AI Generate tab if it isn't already active, so the
 * panel's prompt-dependent controls work from either tab. Returns a promise
 * that resolves after React has rendered the tab.
 */
async function ensureAiTab() {
  const dialog = state.dialogEl;
  if (!dialog) return;
  if (dialog.querySelector("textarea.step-input")) return;
  const btn = [...dialog.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes("AI Generate")
  );
  if (btn) {
    btn.click();
    await new Promise((r) => setTimeout(r, 50));
  }
}

function setStatus(text, isError) {
  state.status = { text, isError: !!isError };
  renderPanel();
}

/**
 * Set the panel's generated SQL result (used by the AI Setup interceptor).
 * The panel's Copy/Insert buttons read `state.result`, so results produced by
 * the interceptor get the same Copy/Insert behavior as panel-generated ones.
 */
export function setPanelResult(sql) {
  state.result = sql;
  renderPanel();
}

/** Set the panel's status line (used by the AI Setup interceptor). */
export function setPanelStatus(text, isError) {
  setStatus(text, isError);
}

/* ===================================================================
   Bootstrap — watch for the Custom SQL dialog
   =================================================================== */

let observer = null;

function init() {
  if (observer) return;
  observer = new MutationObserver(() => {
    const dialog = findDialog();
    if (dialog) {
      ensurePanel();
      // Keep column/template buttons in sync as the dialog re-renders.
      renderColumns();
      renderTemplates();
    } else if (state.panelEl) {
      // Dialog closed — clear state.
      state.dialogEl = null;
      state.panelEl = null;
      state.result = null;
      state.download = null;
      state.status = null;
      lastColumnsSig = "";
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ensurePanel();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
