/**
 * AI Setup — Local (browser) models.
 *
 * Adds a "Local (browser)" option to the React-rendered Provider dropdown in
 * the AI Setup modal (the React `_ne` component) and injects a matching card
 * so users can pick one of the three in-browser engines — wllama (WASM),
 * WebLLM (WebGPU), Transformers.js (WebGPU/WASM) — download a model with live
 * progress, and activate it for the AI Generate flow. Mirrors the ChatAI
 * offline-model picker UX (hardware "Recommended" tier, installed list).
 *
 * The card is shown only while the Provider dropdown is set to "Local
 * (browser)"; selecting a cloud provider hides it. The injected `<option>` is
 * re-added after every React re-render (React wipes foreign option nodes), and
 * the card is re-injected by a MutationObserver if React wipes it. All state
 * lives in module-level variables so it survives re-renders.
 *
 * When a local model is active (localStorage `etl:ai_provider`/`etl:ai_model`),
 * the native "Generate SQL" button in the Custom SQL dialog's AI Generate tab
 * is intercepted and routed to the local `generateSQL` instead of the bundle's
 * remote `aiGenerate`; the result streams into the existing Local AI panel.
 *
 * @module ai-setup-local
 */

import {
  PROVIDERS,
  getModels,
  getProviderInfo,
  isModelInstalled,
  installModel,
  removeModel,
  detectWebGPU,
  generateSQL,
} from "./ai-local-providers.js?v=6";
import {
  buildSystemPrompt,
  buildUserPrompt,
  getContextColumns,
  getSampleRows,
  getCurrentSql,
  setPanelResult,
  setPanelStatus,
} from "./ai-sql-assistant.js?v=8";

/* ===================================================================
   State (module-level — survives React re-renders)
   =================================================================== */

const state = {
  providerId: localStorage.getItem("etl:ai_provider") || "wllama",
  modelId: localStorage.getItem("etl:ai_model") || null,
  download: null,        // { modelId, progress, status, text }
  status: null,          // { text, isError }
  cardEl: null,          // the injected .etl-ai-setup-card element
  modalEl: null,         // the AI Setup modal's .modal element
  webgpu: false,         // detectWebGPU() result
  recommendedTier: null, // detectHardware() + recommendTier() result
  localSelected: false,  // whether the Provider dropdown shows "Local (browser)"
};

let generating = false; // guards the Generate SQL interceptor

/* ===================================================================
   Hardware detection + tier recommendation (ported from ChatAI webllm.js)
   =================================================================== */

async function detectHardware() {
  const info = {
    deviceMemory: navigator.deviceMemory || 4,
    hardwareConcurrency: navigator.hardwareConcurrency || 4,
    webgpu: false,
    webgpuName: "",
  };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        info.webgpu = true;
        info.webgpuName = adapter.name || "WebGPU adapter";
      }
    }
  } catch {}
  return info;
}

function recommendTier(hw) {
  const mem = hw.deviceMemory;
  if (mem >= 12 && hw.webgpu) return "large";
  if (mem >= 8) return "standard";
  if (mem >= 6) return "medium";
  if (mem >= 4) return "small";
  return "tiny";
}

/* ===================================================================
   Card injection
   =================================================================== */

/** Find the AI Setup modal: `.modal-overlay > .modal` whose header says "AI Setup". */
function findAiSetupModal() {
  const overlays = document.querySelectorAll(".modal-overlay");
  for (const overlay of overlays) {
    const modal = overlay.querySelector(":scope > .modal");
    if (!modal) continue;
    const header = modal.querySelector(".modal-header");
    if (header && (header.textContent || "").includes("AI Setup")) return modal;
  }
  return null;
}

/* ===================================================================
   Provider dropdown integration — add "Local (browser)" to the
   React-rendered Provider <select> in the AI Setup modal.
   =================================================================== */

function isAiSetupModal(modal) {
  const header = modal.querySelector(".modal-header");
  return !!(header && (header.textContent || "").includes("AI Setup"));
}

/** Find the React-rendered Provider <select> (the .step-field whose label is "Provider"). */
function findProviderSelect(modal) {
  const label = [...modal.querySelectorAll(".step-field-label")].find(
    (el) => (el.textContent || "").trim() === "Provider"
  );
  if (!label) return null;
  const field = label.closest(".step-field");
  return field ? field.querySelector("select.step-input") : null;
}

/** Append the "Local (browser)" option to the provider select (idempotent). */
function ensureLocalOption(select) {
  if (!select || select.querySelector('option[value="local"]')) return;
  const opt = document.createElement("option");
  opt.value = "local";
  opt.textContent = "Local (browser)";
  select.appendChild(opt);
}

/** Show/hide the local card + Test connection button based on the dropdown value. */
function updateCardVisibility(select) {
  const isLocal = !!select && select.value === "local";
  if (state.cardEl) state.cardEl.style.display = isLocal ? "" : "none";
  const modal = select ? select.closest(".modal") : null;
  if (!modal) return;
  const testBtn = [...modal.querySelectorAll("button.primary")].find((b) => {
    const t = (b.textContent || "").trim();
    return t === "Test connection" || t === "Testing...";
  });
  if (testBtn) {
    testBtn.style.display = isLocal ? "none" : "";
    const wrap = testBtn.parentElement;
    if (wrap) wrap.style.display = isLocal ? "none" : "";
  }
}

/**
 * Keep the injected option + selection in sync after every React re-render.
 * `select.value === ""` means React's provider is "local" (the browser coerces
 * an unmatched controlled value to ""), so that branch re-selects it without
 * dispatching a change event (React's state is already "local").
 */
function syncProviderDropdown(modal) {
  const select = findProviderSelect(modal);
  if (!select) return;
  ensureLocalOption(select);
  if (state.localSelected) {
    if (select.value === "") {
      select.value = "local";
    } else if (select.value !== "local") {
      // React's provider is a cloud provider — force the dropdown to "local"
      // and dispatch a change so React's controlled state follows (hides the
      // cloud fields and persists provider:"local").
      select.value = "local";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (select.value === "") {
    // Stale persisted provider:"local" with no active model — keep "local"
    // selected so the card shows instead of a broken empty state.
    state.localSelected = true;
    select.value = "local";
  }
  updateCardVisibility(select);
}

function ensureCard() {
  const modal = findAiSetupModal();
  if (!modal) {
    if (state.cardEl) {
      state.cardEl = null;
      state.modalEl = null;
      state.download = null;
      state.status = null;
      state.localSelected = false;
    }
    return;
  }
  if (modal !== state.modalEl) {
    state.modalEl = modal;
    state.cardEl = null;
    state.download = null;
    state.status = null;
    // Default the Provider dropdown to "Local (browser)" when a local model
    // is active.
    state.localSelected = !!(localStorage.getItem("etl:ai_provider") && localStorage.getItem("etl:ai_model"));
  }
  // Keep the injected option + selection in sync on every observer callback,
  // even when the card already exists (React wipes the option on re-render).
  syncProviderDropdown(modal);
  if (state.cardEl && document.body.contains(state.cardEl)) return;
  const body = modal.querySelector(".step-dialog-body");
  if (!body) return;
  const card = buildCard();
  // Insert before the Temperature section so the card sits below the provider
  // fields and above the Temperature / Max-tokens controls.
  const tempLabel = [...body.querySelectorAll(".step-field-label")].find(
    (el) => (el.textContent || "").trim() === "Temperature"
  );
  const anchor = tempLabel ? tempLabel.closest("div") : null;
  if (anchor) body.insertBefore(card, anchor);
  else body.appendChild(card);
  state.cardEl = card;
  lastInstalledSig = "";
  renderCard();
  syncProviderDropdown(modal);
}

function buildCard() {
  const card = document.createElement("div");
  card.className = "etl-ai-setup-card";
  card.setAttribute("aria-label", "Local browser AI models");

  // Header
  const head = document.createElement("div");
  head.className = "etl-ai-setup-head";
  const title = document.createElement("span");
  title.className = "etl-ai-setup-title";
  title.textContent = "Local (browser)";
  const privacy = document.createElement("span");
  privacy.className = "etl-ai-setup-privacy";
  privacy.textContent = "🔒 Runs in your browser";
  head.appendChild(title);
  head.appendChild(privacy);
  card.appendChild(head);

  // Engine + model fields
  card.appendChild(buildField("Engine", buildProviderSelect()));
  card.appendChild(buildField("Model", buildModelSelect()));

  // Model meta (Recommended badge + params · size · ctx)
  const meta = document.createElement("div");
  meta.className = "etl-ai-setup-meta";
  card.appendChild(meta);

  // Hardware line
  const hw = document.createElement("div");
  hw.className = "etl-ai-setup-hw";
  card.appendChild(hw);

  // Progress
  const progress = document.createElement("div");
  progress.className = "etl-ai-setup-progress";
  progress.hidden = true;
  const bar = document.createElement("div");
  bar.className = "etl-ai-setup-progress-bar";
  const fill = document.createElement("div");
  fill.className = "etl-ai-setup-progress-fill";
  bar.appendChild(fill);
  const ptext = document.createElement("div");
  ptext.className = "etl-ai-setup-progress-text";
  progress.appendChild(bar);
  progress.appendChild(ptext);
  card.appendChild(progress);

  // Actions: install/remove + use
  const actions = document.createElement("div");
  actions.className = "etl-ai-setup-actions";
  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "etl-ai-setup-btn primary etl-ai-setup-install";
  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "etl-ai-setup-btn etl-ai-setup-use";
  actions.appendChild(installBtn);
  actions.appendChild(useBtn);
  card.appendChild(actions);

  // Installed-models summary
  const installed = document.createElement("div");
  installed.className = "etl-ai-setup-installed";
  card.appendChild(installed);

  // Status line
  const status = document.createElement("div");
  status.className = "etl-ai-setup-status";
  status.hidden = true;
  card.appendChild(status);

  // Wire events
  card.querySelector(".etl-ai-setup-provider").addEventListener("change", onProviderChange);
  card.querySelector(".etl-ai-setup-model").addEventListener("change", onModelChange);
  installBtn.addEventListener("click", onInstallClick);
  useBtn.addEventListener("click", onUseClick);
  installed.addEventListener("click", onRemoveClick);

  return card;
}

function buildField(labelText, control) {
  const field = document.createElement("div");
  field.className = "etl-ai-setup-field";
  const label = document.createElement("label");
  label.className = "etl-ai-setup-label";
  label.textContent = labelText;
  field.appendChild(label);
  field.appendChild(control);
  return field;
}

function buildProviderSelect() {
  const sel = document.createElement("select");
  sel.className = "etl-ai-setup-select etl-ai-setup-provider";
  sel.setAttribute("aria-label", "Local AI engine");
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
  sel.className = "etl-ai-setup-select etl-ai-setup-model";
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
   Card rendering (updates specific elements from state)
   =================================================================== */

function renderCard() {
  const card = state.cardEl;
  if (!card || !document.body.contains(card)) return;

  const provider = getProviderInfo(state.providerId);
  const models = getModels(state.providerId);
  const model = models.find((m) => m.id === state.modelId) || models[0] || null;
  if (model && !models.some((m) => m.id === state.modelId)) {
    state.modelId = model.id;
  }

  // Model select options (preserve selection)
  const modelSel = card.querySelector(".etl-ai-setup-model");
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

  // Meta line
  const meta = card.querySelector(".etl-ai-setup-meta");
  if (meta) {
    meta.innerHTML = "";
    if (model) {
      if (model.tier && model.tier === state.recommendedTier) {
        const badge = document.createElement("span");
        badge.className = "etl-ai-setup-recommended";
        badge.textContent = "Recommended";
        meta.appendChild(badge);
      }
      const parts = [];
      if (model.params) parts.push(model.params + " params");
      if (model.sizeMB) parts.push(formatSize(model.sizeMB));
      if (model.ctx) parts.push(model.ctx.toLocaleString() + " ctx");
      const line = document.createElement("span");
      line.textContent = parts.join(" · ");
      meta.appendChild(line);
    }
  }

  // Hardware line
  const hw = card.querySelector(".etl-ai-setup-hw");
  if (hw) {
    hw.innerHTML = "";
    hw.classList.remove("is-warn");
    if (model) {
      const hwParts = [];
      if (model.hardware && model.hardware.minMemoryGB) {
        hwParts.push("Requires " + model.hardware.minMemoryGB + " GB+ RAM");
      }
      if (provider.requiresWebGPU) hwParts.push("WebGPU required");
      else if (model.hardware && model.hardware.webgpu) hwParts.push("WebGPU recommended");
      hw.textContent = hwParts.join(" · ");
      if (provider.requiresWebGPU && !state.webgpu) {
        hw.classList.add("is-warn");
        hw.textContent += " — WebGPU not detected";
      }
    }
  }

  // Install button
  const installBtn = card.querySelector(".etl-ai-setup-install");
  if (installBtn && model) {
    const installed = isModelInstalled(state.providerId, model.id);
    const downloading = state.download && state.download.modelId === model.id &&
      state.download.status === "downloading";
    if (downloading) {
      installBtn.textContent = "Downloading…";
      installBtn.disabled = true;
      installBtn.classList.add("primary");
    } else if (installed) {
      installBtn.textContent = "Installed ✓ — click to remove";
      installBtn.classList.remove("primary");
      installBtn.disabled = false;
    } else {
      installBtn.textContent = "Download " + formatSize(model.sizeMB);
      installBtn.classList.add("primary");
      installBtn.disabled = false;
    }
  }

  // Progress
  const progress = card.querySelector(".etl-ai-setup-progress");
  const fill = card.querySelector(".etl-ai-setup-progress-fill");
  const ptext = card.querySelector(".etl-ai-setup-progress-text");
  if (state.download && state.download.status === "downloading") {
    progress.hidden = false;
    if (fill) fill.style.width = (state.download.progress || 0) + "%";
    if (ptext) ptext.textContent = state.download.text || "";
  } else {
    progress.hidden = true;
  }

  // Use button
  const useBtn = card.querySelector(".etl-ai-setup-use");
  if (useBtn && model) {
    const active = localStorage.getItem("etl:ai_provider") === state.providerId &&
      localStorage.getItem("etl:ai_model") === model.id;
    const installed = isModelInstalled(state.providerId, model.id);
    if (active) {
      useBtn.textContent = "Active ✓";
      useBtn.disabled = true;
      useBtn.classList.add("active");
    } else {
      useBtn.textContent = "Use this model";
      useBtn.disabled = !installed;
      useBtn.classList.remove("active");
    }
  }

  // Installed summary
  renderInstalled();

  // Status
  const status = card.querySelector(".etl-ai-setup-status");
  if (status) {
    if (state.status) {
      status.hidden = false;
      status.textContent = state.status.text;
      status.classList.toggle("is-error", !!state.status.isError);
    } else {
      status.hidden = true;
    }
  }
}

function formatSize(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  return mb + " MB";
}

let lastInstalledSig = "";

/** Rebuild the installed-models list only when the installed set changes. */
function renderInstalled() {
  const card = state.cardEl;
  if (!card) return;
  const wrap = card.querySelector(".etl-ai-setup-installed");
  if (!wrap) return;
  const models = getModels(state.providerId);
  const installed = models.filter((m) => isModelInstalled(state.providerId, m.id));
  const sig = installed.map((m) => m.id).join(",");
  if (sig === lastInstalledSig) return;
  lastInstalledSig = sig;
  wrap.innerHTML = "";
  if (installed.length === 0) {
    const empty = document.createElement("div");
    empty.className = "etl-ai-setup-installed-empty";
    empty.textContent = "No models installed for this engine.";
    wrap.appendChild(empty);
    return;
  }
  installed.forEach((m) => {
    const row = document.createElement("div");
    row.className = "etl-ai-setup-installed-row";
    const name = document.createElement("span");
    name.className = "etl-ai-setup-installed-name";
    name.textContent = m.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "etl-ai-setup-remove";
    rm.textContent = "✕";
    rm.title = 'Remove "' + m.name + '"';
    rm.setAttribute("aria-label", 'Remove "' + m.name + '"');
    rm.dataset.modelId = m.id;
    row.appendChild(name);
    row.appendChild(rm);
    wrap.appendChild(row);
  });
}

/* ===================================================================
   Actions
   =================================================================== */

function onProviderChange(e) {
  state.providerId = e.target.value;
  state.modelId = null;
  state.download = null;
  state.status = null;
  renderCard();
}

function onModelChange(e) {
  state.modelId = e.target.value;
  state.download = null;
  state.status = null;
  renderCard();
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
    renderCard();
    return;
  }
  state.download = { modelId: model.id, progress: 0, status: "downloading", text: "Starting…" };
  state.status = null; // clear any previous error while a new download runs
  renderCard();
  try {
    await installModel(state.providerId, model, (p) => {
      state.download = {
        modelId: model.id,
        progress: p.progress,
        status: "downloading",
        text: p.text,
      };
      renderCard();
    });
    state.download = null;
    setStatus("Model installed. Click 'Use this model' to activate it.");
  } catch (err) {
    state.download = null;
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
  renderCard();
}

function onUseClick() {
  const model = getModels(state.providerId).find((m) => m.id === state.modelId);
  if (!model) return;
  if (!isModelInstalled(state.providerId, model.id)) {
    setStatus("Download the model first.", true);
    return;
  }
  localStorage.setItem("etl:ai_provider", state.providerId);
  localStorage.setItem("etl:ai_model", state.modelId);
  setStatus("Active — the AI Generate tab will use this model.");
  renderCard();
}

async function onRemoveClick(e) {
  const btn = e.target.closest(".etl-ai-setup-remove");
  if (!btn) return;
  const modelId = btn.dataset.modelId;
  if (!modelId) return;
  const model = getModels(state.providerId).find((m) => m.id === modelId);
  if (!model) return;
  if (!window.confirm('Remove "' + model.name + '"? The downloaded model will be deleted.')) return;
  try {
    await removeModel(state.providerId, modelId);
    setStatus("Model removed.");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
  renderCard();
}

function setStatus(text, isError) {
  state.status = { text, isError: !!isError };
  renderCard();
}

/* ===================================================================
   Provider dropdown change tracking
   =================================================================== */

/**
 * Document-level capture listener. Fires before React's root-container
 * synthetic `onChange`, so `select.value` is the user's raw selection (React
 * has not re-rendered yet). Updates the local-card visibility to match.
 */
function onDocumentChange(e) {
  const select = e.target;
  if (!(select instanceof HTMLSelectElement)) return;
  if (!select.classList.contains("step-input")) return; // excludes the card's own selects
  const modal = select.closest(".modal");
  if (!modal || !isAiSetupModal(modal)) return;
  if (select !== findProviderSelect(modal)) return;
  state.localSelected = select.value === "local";
  updateCardVisibility(select);
}

/* ===================================================================
   Generate SQL interception
   =================================================================== */

/**
 * Document-level capture listener. Runs before React's root-container handlers,
 * so `stopImmediatePropagation` prevents the native `se` handler from firing.
 * Survives React re-renders of the button — no re-attachment needed.
 */
function onDocumentClick(e) {
  const btn = e.target.closest("button.primary");
  if (!btn) return;
  const text = (btn.textContent || "").trim();

  // "Test connection" is meaningless for in-browser models — its handler would
  // fall through to the Ollama branch and error. Show a helpful message instead.
  if (text === "Test connection" || text === "Testing...") {
    const modal = btn.closest(".modal");
    if (!modal || !isAiSetupModal(modal)) return;
    const select = findProviderSelect(modal);
    if (select && select.value === "local") {
      e.preventDefault();
      e.stopImmediatePropagation();
      setStatus("Local (browser) models run entirely in your browser — no connection test needed. Download and activate a model above.");
    }
    return;
  }

  if (text !== "Generate SQL") return;
  const dialog = btn.closest(".modal.step-dialog--large");
  if (!dialog) return;
  const providerId = localStorage.getItem("etl:ai_provider");
  const modelId = localStorage.getItem("etl:ai_model");
  if (!providerId || !modelId) {
    // No local model active. If the persisted provider is "local" (from the
    // AI Setup dropdown), route to the local flow so the user gets a helpful
    // message instead of an Ollama connection error.
    let settingsProvider = "ollama";
    try {
      settingsProvider = JSON.parse(localStorage.getItem("pwa_etl_ai_settings") || "{}").provider || "ollama";
    } catch {}
    if (settingsProvider !== "local") return; // native remote flow
    e.preventDefault();
    e.stopImmediatePropagation();
    if (generating) return;
    handleLocalGenerate(dialog, btn, providerId, modelId);
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  if (generating) return; // already generating — swallow the click
  handleLocalGenerate(dialog, btn, providerId, modelId);
}

async function handleLocalGenerate(dialog, btn, providerId, modelId) {
  if (generating) return;
  const model = getModels(providerId).find((m) => m.id === modelId);
  if (!model) {
    setPanelStatus("Model not found. Pick a model in AI Setup.", true);
    return;
  }
  if (!isModelInstalled(providerId, modelId)) {
    setPanelStatus("Download the model first (AI Setup → Local browser).", true);
    return;
  }
  const promptEl = dialog.querySelector("textarea.step-input");
  const request = promptEl ? promptEl.value.trim() : "";
  if (!request) return; // native button is disabled anyway
  const columns = getContextColumns(dialog);
  const sampleRows = getSampleRows();
  const currentSql = await getCurrentSql(dialog);
  const system = buildSystemPrompt(columns);
  const user = buildUserPrompt({ request, currentSql, columns, sampleRows });

  generating = true;
  const originalText = btn.textContent;
  btn.textContent = "Generating…";
  btn.disabled = true;
  try {
    const output = await generateSQL({
      providerId,
      modelId,
      system,
      user,
      onChunk: (text) => setPanelResult(text),
    });
    setPanelResult(output);
  } catch (err) {
    setPanelStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    generating = false;
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

/* ===================================================================
   Bootstrap — watch for the AI Setup modal
   =================================================================== */

let observer = null;

function init() {
  if (observer) return;
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("change", onDocumentChange, true);
  observer = new MutationObserver(() => {
    ensureCard();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // Resolve asynchronously; re-render the card if it's open.
  detectWebGPU().then((ok) => {
    state.webgpu = ok;
    if (state.cardEl) renderCard();
  });
  detectHardware().then((hw) => {
    state.recommendedTier = recommendTier(hw);
    if (state.cardEl) renderCard();
  });
  ensureCard();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
