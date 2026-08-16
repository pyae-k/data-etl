/**
 * AI Local Providers — three in-browser LLM engines for the ETL Custom SQL step.
 *
 *  - wllama          : llama.cpp compiled to WebAssembly. Works on any device,
 *                      no WebGPU. GGUF weights are downloaded to IndexedDB so
 *                      inference is fully offline.
 *  - WebLLM (MLC-AI) : WebGPU-accelerated. Fastest, but REQUIRES WebGPU
 *                      (Chrome/Edge 113+). Weights cached by the library.
 *  - Transformers.js : Hugging Face ONNX runtime. Uses WebGPU when available,
 *                      falls back to WASM. Weights cached by the library.
 *
 * All three run entirely in the browser — no server, no API key. Model weights
 * are downloaded once and reused offline.
 *
 * @module ai-local-providers
 */

/* ===================================================================
   Provider metadata
   =================================================================== */

export const PROVIDERS = {
  wllama: {
    id: "wllama",
    label: "wllama (WASM)",
    requiresWebGPU: false,
    description: "llama.cpp in WebAssembly — works on any device",
  },
  webllm: {
    id: "webllm",
    label: "WebLLM (WebGPU)",
    requiresWebGPU: true,
    description: "MLC-AI — fastest, needs WebGPU (Chrome/Edge)",
  },
  transformers: {
    id: "transformers",
    label: "Transformers.js (WebGPU/WASM)",
    requiresWebGPU: false,
    description: "Hugging Face — WebGPU when available, WASM fallback",
  },
};

export function getProviderInfo(id) {
  return PROVIDERS[id] || PROVIDERS.wllama;
}

/* ===================================================================
   Model registries
   =================================================================== */

const WLLAMA_MODELS = [
  {
    id: "qwen2.5-0.5b",
    name: "Qwen2.5 0.5B",
    sizeMB: 491,
    params: "0.5B",
    ctx: 32768,
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    description: "Lightweight general chat with long context",
    tier: "small",
    hardware: { minMemoryGB: 4 },
  },
  {
    id: "llama-3.2-1b",
    name: "Llama 3.2 1B",
    sizeMB: 808,
    params: "1B",
    ctx: 8192,
    url: "https://huggingface.co/hugging-quants/Llama-3.2-1B-Instruct-Q4_K_M-GGUF/resolve/main/llama-3.2-1b-instruct-q4_k_m.gguf",
    description: "Strong instruction following, Meta's latest small model",
    tier: "medium",
    hardware: { minMemoryGB: 6 },
  },
  {
    id: "gemma-3-1b",
    name: "Gemma 3 1B",
    sizeMB: 700,
    params: "1B",
    ctx: 32768,
    url: "https://huggingface.co/google/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-q4_k_m.gguf",
    description: "Good all-rounder from Google",
    tier: "medium",
    hardware: { minMemoryGB: 6 },
  },
  {
    id: "qwen2.5-1.5b",
    name: "Qwen2.5 1.5B",
    sizeMB: 1120,
    params: "1.5B",
    ctx: 32768,
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    description: "Excellent reasoning for its size",
    tier: "standard",
    hardware: { minMemoryGB: 8 },
  },
  {
    id: "deepseek-r1-1.5b",
    name: "DeepSeek R1 Distill 1.5B",
    sizeMB: 1120,
    params: "1.5B",
    ctx: 32768,
    url: "https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
    description: "Reasoning-focused, chain-of-thought",
    tier: "standard",
    hardware: { minMemoryGB: 8 },
  },
  {
    id: "llama-3.2-3b",
    name: "Llama 3.2 3B",
    sizeMB: 2020,
    params: "3B",
    ctx: 8192,
    url: "https://huggingface.co/hugging-quants/Llama-3.2-3B-Instruct-Q4_K_M-GGUF/resolve/main/llama-3.2-3b-instruct-q4_k_m.gguf",
    description: "Best speed/quality tradeoff in the catalog",
    tier: "large",
    hardware: { minMemoryGB: 12 },
  },
  {
    id: "phi-3.5-mini",
    name: "Phi-3.5 Mini 3.8B",
    sizeMB: 2390,
    params: "3.8B",
    ctx: 131072,
    url: "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
    description: "Massive 128K context, Microsoft's best small model",
    tier: "large",
    hardware: { minMemoryGB: 12, webgpu: true },
  },
];

const WEBLLM_MODELS = [
  {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 Coder 0.5B",
    sizeMB: 500,
    params: "0.5B",
    ctx: 4096,
    hardware: { minMemoryGB: 1, webgpu: true },
  },
  {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 Coder 1.5B",
    sizeMB: 1200,
    params: "1.5B",
    ctx: 4096,
    hardware: { minMemoryGB: 2, webgpu: true },
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2.5 1.5B",
    sizeMB: 1200,
    params: "1.5B",
    ctx: 4096,
    hardware: { minMemoryGB: 2, webgpu: true },
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 1B",
    sizeMB: 800,
    params: "1B",
    ctx: 4096,
    hardware: { minMemoryGB: 1.5, webgpu: true },
  },
];

const TRANSFORMERS_MODELS = [
  {
    id: "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
    name: "Qwen2.5 Coder 0.5B",
    sizeMB: 400,
    params: "0.5B",
    ctx: 32768,
    hardware: { minMemoryGB: 1 },
  },
  {
    id: "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
    name: "Qwen2.5 Coder 1.5B",
    sizeMB: 1000,
    params: "1.5B",
    ctx: 32768,
    hardware: { minMemoryGB: 2 },
  },
  {
    id: "onnx-community/Qwen2.5-1.5B-Instruct",
    name: "Qwen2.5 1.5B",
    sizeMB: 1000,
    params: "1.5B",
    ctx: 32768,
    hardware: { minMemoryGB: 2 },
  },
  {
    id: "onnx-community/Llama-3.2-1B-Instruct-q4f16",
    name: "Llama 3.2 1B",
    sizeMB: 800,
    params: "1B",
    ctx: 8192,
    hardware: { minMemoryGB: 1.5 },
  },
];

const MODEL_REGISTRY = {
  wllama: WLLAMA_MODELS,
  webllm: WEBLLM_MODELS,
  transformers: TRANSFORMERS_MODELS,
};

export function getModels(providerId) {
  return MODEL_REGISTRY[providerId] || WLLAMA_MODELS;
}

/* ===================================================================
   Installed-model tracking (localStorage)
   =================================================================== */

const INSTALLED_KEY = "etl:ai_installed";

function getInstalledMap() {
  try {
    return JSON.parse(localStorage.getItem(INSTALLED_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveInstalledMap(map) {
  try {
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(map));
  } catch {}
}

export function isModelInstalled(providerId, modelId) {
  const map = getInstalledMap();
  return !!(map[providerId] && map[providerId][modelId]);
}

function markInstalled(providerId, modelId) {
  const map = getInstalledMap();
  if (!map[providerId]) map[providerId] = {};
  map[providerId][modelId] = { installedAt: Date.now() };
  saveInstalledMap(map);
}

function unmarkInstalled(providerId, modelId) {
  const map = getInstalledMap();
  if (map[providerId]) {
    delete map[providerId][modelId];
    if (Object.keys(map[providerId]).length === 0) delete map[providerId];
  }
  saveInstalledMap(map);
}

/* ===================================================================
   IndexedDB blob storage (wllama GGUF weights)
   =================================================================== */

const DB_NAME = "etl-ai-models";
const DB_VERSION = 2;
const STORE_NAME = "model-blobs";
const CHUNK_STORE = "model-chunks";

function openModelDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getModelBlob(modelId) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(modelId);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror = () => reject(req.error);
  });
}

async function putModelBlob(modelId, blob) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put({ id: modelId, blob, storedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteModelBlob(modelId) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(modelId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* --- Streaming chunk storage (keeps download memory bounded) ---------- */

/** Chunk keys are `${modelId}:${paddedIndex}` so a range query returns them in order. */
function chunkKey(modelId, index) {
  return modelId + ":" + String(index).padStart(6, "0");
}

function chunkRange(modelId) {
  return IDBKeyRange.bound(modelId + ":", modelId + ":~");
}

/** Write a batch of chunks in one transaction. */
function putModelChunks(db, modelId, startIndex, chunks) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    chunks.forEach((c, i) => store.put({ id: chunkKey(modelId, startIndex + i), data: c }));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Remove any partial chunks for a model (called before a fresh download). */
function clearModelChunks(db, modelId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    tx.objectStore(CHUNK_STORE).delete(chunkRange(modelId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Concatenate all stored chunks into a single Blob (in order). */
function assembleModelBlob(db, modelId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const req = tx.objectStore(CHUNK_STORE).getAll(chunkRange(modelId));
    req.onsuccess = () => resolve(new Blob(req.result.map((r) => r.data)));
    req.onerror = () => reject(req.error);
  });
}

/* ===================================================================
   Storage quota check
   =================================================================== */

async function checkStorageQuota(requiredBytes) {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const estimate = await navigator.storage.estimate();
  const available = estimate.quota - estimate.usage;
  if (available < requiredBytes) {
    throw new Error(
      "Not enough storage: need " + formatBytes(requiredBytes) +
      ", only " + formatBytes(available) + " available. Free up space and try again."
    );
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

/* ===================================================================
   Hardware detection
   =================================================================== */

export async function detectWebGPU() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    }
  } catch {}
  return false;
}

/* ===================================================================
   Download helper (wllama GGUF → IndexedDB)
   =================================================================== */

async function downloadToBlob(model, onProgress) {
  await checkStorageQuota(model.sizeMB * 1024 * 1024);
  const resp = await fetch(model.url);
  if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + resp.statusText);
  const total = parseInt(resp.headers.get("content-length") || "0", 10);
  const reader = resp.body.getReader();
  const db = await openModelDB();
  await clearModelChunks(db, model.id);
  let received = 0;
  let index = 0;
  let batch = [];
  let batchBytes = 0;
  const startTime = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    batch.push(value);
    batchBytes += value.length;
    received += value.length;
    // Flush to IndexedDB every ~8 MB so memory stays bounded during the download.
    if (batchBytes >= 8 * 1024 * 1024) {
      await putModelChunks(db, model.id, index, batch);
      index += batch.length;
      batch = [];
      batchBytes = 0;
    }
    const elapsed = (Date.now() - startTime) / 1000;
    let speed = 0, eta = 0;
    if (elapsed >= 0.5) {
      speed = received / elapsed;
      if (total > 0) eta = (total - received) / speed;
    }
    onProgress?.({
      progress: total > 0 ? Math.round((received / total) * 100) : 0,
      text: formatBytes(received) + " / " + (total > 0 ? formatBytes(total) : "?") +
        (speed > 0 ? " · " + formatBytes(speed) + "/s" : "") +
        (eta > 0 ? " · " + Math.ceil(eta) + "s left" : ""),
    });
  }
  if (batch.length) {
    await putModelChunks(db, model.id, index, batch);
  }
  const blob = await assembleModelBlob(db, model.id);
  await putModelBlob(model.id, blob);
  await clearModelChunks(db, model.id);
  return blob;
}

/* ===================================================================
   Loaded-model singletons (one per provider)
   =================================================================== */

let wllamaInstance = null;
let wllamaLoadedId = null;
let webllmEngine = null;
let webllmLoadedId = null;
let transformersPipeline = null;
let transformersLoadedId = null;

async function getWllama() {
  if (!wllamaInstance) {
    const { Wllama } = await import(
      "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.5.1/esm/index.js"
    );
    // pathConfig["default"] must point at the wllama WASM binary — the worker
    // resolves "wllama.wasm" from it. Without it, loadModel throws
    // '"default" is missing from pathConfig'.
    wllamaInstance = new Wllama({
      default: "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.5.1/esm/wasm/wllama.wasm",
    });
  }
  return wllamaInstance;
}

async function unloadWllama() {
  if (wllamaInstance) {
    try { wllamaInstance.exit(); } catch {}
    wllamaInstance = null;
  }
  wllamaLoadedId = null;
}

async function unloadWebllm() {
  if (webllmEngine) {
    try { webllmEngine.unload(); } catch {}
    webllmEngine = null;
  }
  webllmLoadedId = null;
}

async function unloadTransformers() {
  if (transformersPipeline) {
    try { transformersPipeline.dispose(); } catch {}
    transformersPipeline = null;
  }
  transformersLoadedId = null;
}

/* ===================================================================
   Install / remove
   =================================================================== */

/**
 * Download a model so it is available offline.
 * - wllama: streams the GGUF into IndexedDB.
 * - webllm / transformers: create the engine/pipeline once (weights land in
 *   the library's own cache), then unload to free memory.
 */
export async function installModel(providerId, model, onProgress) {
  if (providerId === "wllama") {
    await downloadToBlob(model, onProgress);
    markInstalled(providerId, model.id);
    return;
  }

  if (providerId === "webllm") {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser. Use wllama or Transformers.js instead.");
    }
    const { CreateMLCEngine } = await import(
      "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm"
    );
    const engine = await CreateMLCEngine(model.id, {
      initProgressCallback: (p) => {
        onProgress?.({
          progress: Math.round((p.progress || 0) * 100),
          text: p.text || "Downloading…",
        });
      },
    });
    try { engine.unload(); } catch {}
    markInstalled(providerId, model.id);
    return;
  }

  // transformers.js
  const { pipeline } = await import(
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1"
  );
  const device = await pickTransformersDevice();
  const gen = await pipeline("text-generation", model.id, {
    device,
    dtype: device === "webgpu" ? "q4f16" : "q4",
    progress_callback: (p) => {
      if (p.status === "progress") {
        onProgress?.({
          progress: Math.round(p.progress || 0),
          text: (p.file || "model") + " · " + formatBytes(p.loaded || 0) +
            " / " + (p.total ? formatBytes(p.total) : "?"),
        });
      } else if (p.status === "done") {
        onProgress?.({ progress: 100, text: "Downloaded " + (p.file || "model") });
      }
    },
  });
  try { gen.dispose(); } catch {}
  markInstalled(providerId, model.id);
}

async function pickTransformersDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {}
  return "wasm";
}

/** Remove a downloaded model and free memory. */
export async function removeModel(providerId, modelId) {
  if (providerId === "wllama") {
    await deleteModelBlob(modelId);
    if (wllamaLoadedId === modelId) await unloadWllama();
  } else if (providerId === "webllm") {
    if (webllmLoadedId === modelId) await unloadWebllm();
  } else {
    if (transformersLoadedId === modelId) await unloadTransformers();
  }
  unmarkInstalled(providerId, modelId);
}

/* ===================================================================
   Generate SQL
   =================================================================== */

/**
 * Run a chat completion on the selected local model.
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.modelId
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {(text: string) => void} [opts.onChunk]  called with the full text so far
 * @returns {Promise<string>} the generated SQL
 */
export async function generateSQL({ providerId, modelId, system, user, onChunk }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const settings = readAiSettings();
  const maxTokens = settings.maxTokens || 1024;
  const temperature = settings.temperature ?? 0.1;

  if (providerId === "wllama") {
    return generateWllama(modelId, messages, { maxTokens, temperature, onChunk });
  }
  if (providerId === "webllm") {
    return generateWebllm(modelId, messages, { maxTokens, temperature, onChunk });
  }
  return generateTransformers(modelId, messages, { maxTokens, temperature, onChunk });
}

function readAiSettings() {
  try {
    return JSON.parse(localStorage.getItem("pwa_etl_ai_settings") || "{}");
  } catch {
    return {};
  }
}

async function generateWllama(modelId, messages, { maxTokens, temperature, onChunk }) {
  const model = WLLAMA_MODELS.find((m) => m.id === modelId) || WLLAMA_MODELS[0];
  let wllama = await getWllama();
  if (!wllama.isModelLoaded() || wllamaLoadedId !== modelId) {
    if (wllamaLoadedId && wllamaLoadedId !== modelId) await unloadWllama();
    wllama = await getWllama();
    const blob = await getModelBlob(modelId);
    if (!blob) throw new Error("Model not downloaded. Install it first.");
    await wllama.loadModel([blob], {
      n_ctx: model.ctx || 4096,
      n_threads: navigator.hardwareConcurrency || 4,
    });
    wllamaLoadedId = modelId;
  }

  // createChatCompletion is async: with stream:true and no onData it returns a
  // Promise resolving to an async generator. Must await before for-await.
  const stream = await wllama.createChatCompletion({
    messages,
    max_tokens: maxTokens,
    temperature,
    top_p: 0.9,
    top_k: 40,
    stream: true,
  });

  let content = "";
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) {
      content += delta;
      onChunk?.(content);
    }
  }
  return content;
}

async function generateWebllm(modelId, messages, { maxTokens, temperature, onChunk }) {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this browser. Use wllama or Transformers.js instead.");
  }
  const { CreateMLCEngine } = await import(
    "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm"
  );
  let engine = webllmEngine;
  if (!engine || webllmLoadedId !== modelId) {
    if (webllmLoadedId && webllmLoadedId !== modelId) await unloadWebllm();
    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (p) => {
        onChunk?.("Loading model… " + Math.round((p.progress || 0) * 100) + "%");
      },
    });
    webllmEngine = engine;
    webllmLoadedId = modelId;
  }

  const reply = await engine.chat.completions.create({
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  });

  let content = "";
  for await (const chunk of reply) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) {
      content += delta;
      onChunk?.(content);
    }
  }
  return content;
}

async function generateTransformers(modelId, messages, { maxTokens, temperature, onChunk }) {
  const { pipeline, TextStreamer } = await import(
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1"
  );
  let generator = transformersPipeline;
  if (!generator || transformersLoadedId !== modelId) {
    if (transformersLoadedId && transformersLoadedId !== modelId) await unloadTransformers();
    const device = await pickTransformersDevice();
    generator = await pipeline("text-generation", modelId, {
      device,
      dtype: device === "webgpu" ? "q4f16" : "q4",
      progress_callback: (p) => {
        if (p.status === "progress") {
          onChunk?.("Loading model… " + Math.round(p.progress || 0) + "%");
        }
      },
    });
    transformersPipeline = generator;
    transformersLoadedId = modelId;
  }

  let content = "";
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => {
      content += text;
      onChunk?.(content);
    },
  });

  await generator(messages, {
    max_new_tokens: maxTokens,
    do_sample: false,
    temperature,
    streamer,
  });
  return content;
}
