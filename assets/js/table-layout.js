/**
 * Table Layout — content-aware fixed-width layout for ETL Studio preview tables.
 *
 * Shared engine for the React data-preview table and the diff-table overlay:
 *  - measures per-column content width (header + rendered cells)
 *  - applies fixed column widths via a scoped <style> element (:nth-child rules)
 *    so the layout survives React re-renders — the old <colgroup> approach was
 *    destroyed by React's reconciliation on every virtualizer scroll frame
 *  - pins columns from the left (sticky) with a right-click pin menu
 *  - adds drag + keyboard resize grips to column headers (::after + delegation)
 *  - adds keyboard cell navigation, click-to-activate, and truncation tooltips
 *  - shares user-resized widths between both tables and persists to localStorage
 *
 * Loaded as its own entry module AND imported by diff-table.js — the `?v=2`
 * query must match in both places so the module (and its React-table bootstrap)
 * executes exactly once.
 *
 * @module table-layout
 */

export const COL_WIDTHS_KEY = 'etl-preview-col-widths';
export const LIMITS = { text: { min: 80, max: 320 }, number: { min: 60, max: 200 } };

const PIN_KEY = 'etl-pinned-cols';
const ROW_H = 28; // fixed virtualized row height (matches the bundle's FG constant)

/* ------------------------------------------------------------------
   Width-override store — shared by both tables, persisted to localStorage.
   setWidthOverride updates memory only; saveWidthOverrides() persists
   (called on resize commit, not on every pointermove frame).
   ------------------------------------------------------------------ */

const overrideStore = new Map();

export function loadWidthOverrides() {
  try {
    const raw = localStorage.getItem(COL_WIDTHS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'number' && isFinite(v)) overrideStore.set(k, v);
      }
    }
  } catch (e) {
    /* private mode / corrupt JSON — fall back to in-memory only */
  }
}

export function saveWidthOverrides() {
  try {
    localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(Object.fromEntries(overrideStore)));
  } catch (e) {
    /* ignore — persistence is best-effort */
  }
}

export function getWidthOverride(colName) {
  return overrideStore.has(colName) ? overrideStore.get(colName) : null;
}

export function setWidthOverride(colName, px) {
  overrideStore.set(colName, Math.round(px));
}

/* ------------------------------------------------------------------
   Pin-count store — number of columns frozen from the left (min 1).
   The first column is always pinned.
   ------------------------------------------------------------------ */

let pinCount = 1;

function loadPinCount() {
  try {
    const v = parseInt(localStorage.getItem(PIN_KEY), 10);
    if (isFinite(v) && v >= 1) pinCount = v;
  } catch (e) {
    /* ignore */
  }
}

function savePinCount() {
  try {
    localStorage.setItem(PIN_KEY, String(pinCount));
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------
   Layout state — per-table, kept in a WeakMap so it's GC'd with the table.
   ------------------------------------------------------------------ */

const layoutStates = new WeakMap();   // table -> { widths, numeric, pinCount, tableClass, pinBg, pinTdZ, fixedWidths, container, showPinIndicator }
const boundListeners = new WeakMap(); // table -> [{ type, fn, capture }]
let activeCell = null;                // { row, col } for keyboard navigation
let lastHoveredTd = null;             // tooltip throttle
let appliedState = null;              // { table, container } for window-resize fill recompute

/* ------------------------------------------------------------------
   Classification
   ------------------------------------------------------------------ */

export function isNumericValue(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === 'NULL') return false;
  return !isNaN(parseFloat(s)) && isFinite(s);
}

export function getColumnSignature(table) {
  const ths = table.querySelectorAll('thead th');
  return Array.from(ths, (th) => th.textContent.trim());
}

/* ------------------------------------------------------------------
   Measurement
   ------------------------------------------------------------------ */

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Measure per-column content width from the header and the rendered cells.
 * Only the virtualized window of rows exists in the DOM, so this is a sample —
 * good enough for stable widths, and re-measured whenever the column set changes.
 * scrollWidth is content-based, so no forced reflow is needed (the old colgroup
 * zeroing + `void table.offsetWidth` is gone).
 *
 * @param {HTMLTableElement} table
 * @param {{fixedWidths?: Object<number,number>}} opts
 * @returns {{widths:number[], numeric:boolean[], headerW:number[], maxCellW:number[]}}
 */
export function measureColumns(table, opts) {
  opts = opts || {};
  const ths = table.querySelectorAll('thead th');
  const n = ths.length;
  if (n === 0) return { widths: [], numeric: [], headerW: [], maxCellW: [] };

  const headerW = [];
  const maxCellW = [];
  const numCount = [];
  const txtCount = [];
  for (let i = 0; i < n; i++) {
    headerW.push(Math.ceil(ths[i].scrollWidth));
    maxCellW.push(0);
    numCount.push(0);
    txtCount.push(0);
  }

  const tbody = table.querySelector('tbody');
  if (tbody) {
    tbody.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.children;
      for (let i = 0; i < n && i < cells.length; i++) {
        maxCellW[i] = Math.max(maxCellW[i], Math.ceil(cells[i].scrollWidth));
        const v = cells[i].textContent.trim();
        if (v === '' || v === 'NULL') continue;
        if (isNumericValue(v)) numCount[i]++; else txtCount[i]++;
      }
    });
  }

  const widths = [];
  const numeric = [];
  for (let i = 0; i < n; i++) {
    numeric[i] = numCount[i] > 0 && txtCount[i] === 0;
    const limits = numeric[i] ? LIMITS.number : LIMITS.text;
    let w;
    if (opts.fixedWidths && opts.fixedWidths[i] != null) {
      w = opts.fixedWidths[i];
    } else {
      const name = ths[i].textContent.trim();
      const override = getWidthOverride(name);
      const natural = Math.max(headerW[i], maxCellW[i]);
      w = override != null ? clamp(override, limits.min, limits.max) : clamp(natural, limits.min, limits.max);
    }
    widths.push(Math.round(w));
  }

  return { widths, numeric, headerW, maxCellW };
}

/* ------------------------------------------------------------------
   Scoped style — the layout is written as :nth-child rules in a <style>
   element in <head>, so React re-renders (which destroy anything inside
   the table) can't touch it. Widths use !important to beat the bundle's
   inline `width:auto` on th; with table-layout:fixed the first row's th
   widths determine the column widths, so td rules aren't needed for sizing.
   ------------------------------------------------------------------ */

function getTableId(table) {
  return table.classList.contains('preview-table') ? 'preview' : 'diff';
}

function getOrCreateStyle(id) {
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  return style;
}

function syncLayoutStyle(table, state) {
  const n = state.widths.length;
  if (n === 0) return;
  const containerWidth = state.container && state.container.clientWidth ? state.container.clientWidth : 0;

  // Last column absorbs leftover container width so a narrow table still fills
  // the panel; when the columns are wider than the container it scrolls.
  const applied = [];
  let others = 0;
  for (let i = 0; i < n - 1; i++) {
    applied.push(state.widths[i]);
    others += state.widths[i];
  }
  const lastFill = Math.max(0, containerWidth - others);
  const lastCol = Math.max(state.widths[n - 1], lastFill);
  applied.push(lastCol);
  const total = others + lastCol;

  table.style.width = total + 'px';
  table.style.minWidth = '100%';

  const style = getOrCreateStyle('etl-layout-cols-' + getTableId(table));
  const rules = [];
  const cls = state.tableClass;

  // Column widths — th rules drive the table's fixed layout. For the React
  // preview table the virtualized tbody is display:block with absolutely
  // positioned rows, so its cells are NOT part of the table's column model
  // and would size to their own content (header/body misalignment). Force
  // each row to flex and give the cells the same explicit widths so body
  // cells align with the header columns. line-height centers the text in the
  // 28px row (ROW_H - 2*4px td vertical padding).
  const isPreview = cls === 'preview-table';
  for (let i = 0; i < n; i++) {
    rules.push('.' + cls + ' thead th:nth-child(' + (i + 1) + '){width:' + applied[i] + 'px!important}');
    if (isPreview) {
      rules.push('.' + cls + ' tbody td:nth-child(' + (i + 1) + '){width:' + applied[i] + 'px!important}');
    }
  }
  if (isPreview) {
    rules.push('.' + cls + ' tbody tr{display:flex!important;width:100%!important;align-items:stretch}');
    rules.push('.' + cls + ' tbody td{display:block;box-sizing:border-box;flex-shrink:0;line-height:20px}');
  }

  // Numeric alignment + monospace
  state.numeric.forEach((isNum, i) => {
    if (isNum) {
      rules.push('.' + cls + ' tbody td:nth-child(' + (i + 1) + '){text-align:right;font-variant-numeric:tabular-nums;font-family:var(--font-mono)}');
    }
  });

  // Pinned columns (sticky from the left). The React table needs an opaque
  // background so scrolled content never bleeds through; the diff table uses
  // inherit so its row tints show through the pinned cells.
  const pc = Math.min(state.pinCount, n);
  let left = 0;
  for (let i = 0; i < pc; i++) {
    rules.push('.' + cls + ' thead th:nth-child(' + (i + 1) + '),.' + cls + ' tbody td:nth-child(' + (i + 1) + '){position:sticky;left:' + left + 'px}');
    rules.push('.' + cls + ' thead th:nth-child(' + (i + 1) + '){z-index:2}');
    const extra = state.pinBg === 'inherit'
      ? ''
      : ';background:' + state.pinBg + ';border-bottom:1px solid var(--color-border)';
    rules.push('.' + cls + ' tbody td:nth-child(' + (i + 1) + '){z-index:' + state.pinTdZ + extra + '}');
    if (state.showPinIndicator) {
      rules.push('.' + cls + ' thead th:nth-child(' + (i + 1) + ')::before{content:"📌";font-size:10px;margin-right:4px;opacity:.7}');
    }
    left += applied[i];
  }

  style.textContent = rules.join('\n');
  layoutStates.set(table, state);
}

/* ------------------------------------------------------------------
   Resize
   ------------------------------------------------------------------ */

function currentColWidth(table, index) {
  const st = layoutStates.get(table);
  if (st && st.widths[index] != null) return st.widths[index];
  const ths = table.querySelectorAll('thead th');
  if (ths[index]) return ths[index].getBoundingClientRect().width;
  return 0;
}

function setColWidth(table, index, w) {
  const st = layoutStates.get(table);
  if (!st) return;
  st.widths[index] = w;
  syncLayoutStyle(table, st);
}

function applyWidth(table, index, w) {
  const st = layoutStates.get(table);
  if (!st) return;
  const limits = st.numeric[index] ? LIMITS.number : LIMITS.text;
  w = clamp(Math.round(w), limits.min, limits.max);
  setColWidth(table, index, w);
  const ths = table.querySelectorAll('thead th');
  const th = ths[index];
  const name = th ? th.textContent.trim() : String(index);
  setWidthOverride(name, w);
  return w;
}

/**
 * Re-run the last-column fill after a window resize. Regenerates the scoped
 * style from the stored layout state with the new container width.
 */
export function recomputeFill(table, container) {
  const st = layoutStates.get(table);
  if (!st) return;
  st.container = container || st.container;
  syncLayoutStyle(table, st);
}

/* ------------------------------------------------------------------
   Keyboard navigation
   ------------------------------------------------------------------ */

function getRowCount(table) {
  const tbody = table.querySelector('tbody');
  if (!tbody) return 0;
  if (table.classList.contains('preview-table')) {
    const h = parseFloat(tbody.style.height);
    if (isFinite(h) && h > 0) return Math.round(h / ROW_H);
  }
  return tbody.querySelectorAll('tr').length;
}

function pageRows(table) {
  const st = layoutStates.get(table);
  const container = st && st.container;
  const h = container && container.clientHeight ? container.clientHeight : 0;
  return Math.max(1, Math.floor(h / ROW_H));
}

function rowFromTr(tr, table) {
  if (table.classList.contains('preview-table')) {
    const m = /translateY\(([-\d.]+)px\)/.exec(tr.style.transform || '');
    if (m) return Math.round(parseFloat(m[1]) / ROW_H);
  }
  const tbody = tr.parentElement;
  return tbody ? Array.prototype.indexOf.call(tbody.children, tr) : -1;
}

function findActiveCell(table) {
  if (!activeCell) return null;
  const tbody = table.querySelector('tbody');
  if (!tbody) return null;
  const trs = tbody.querySelectorAll('tr');
  for (const tr of trs) {
    if (rowFromTr(tr, table) === activeCell.row) {
      return tr.children[activeCell.col] || null;
    }
  }
  return null;
}

function focusActiveCell(table) {
  const cell = findActiveCell(table);
  if (!cell) return;
  table.querySelectorAll('td.cell-active').forEach((td) => {
    if (td !== cell) { td.classList.remove('cell-active'); td.removeAttribute('tabindex'); }
  });
  cell.classList.add('cell-active');
  cell.tabIndex = -1;
  cell.focus({ preventScroll: true });
}

/** Re-apply the active-cell ring after React re-renders rows on scroll. */
function restoreActiveCell(table) {
  if (!activeCell) return;
  const cell = findActiveCell(table);
  if (!cell) return;
  table.querySelectorAll('td.cell-active').forEach((td) => {
    if (td !== cell) { td.classList.remove('cell-active'); td.removeAttribute('tabindex'); }
  });
  cell.classList.add('cell-active');
  cell.tabIndex = -1;
}

function moveTo(table, row, col) {
  const st = layoutStates.get(table);
  if (!st) return;
  const nCols = st.widths.length;
  const nRows = getRowCount(table);
  row = Math.max(0, Math.min(nRows - 1, row));
  col = Math.max(0, Math.min(nCols - 1, col));
  activeCell = { row, col };

  // Scroll the container so the target row is visible (rows are fixed-height).
  const container = st.container || table.parentElement;
  if (container) {
    const top = row * ROW_H;
    const bottom = (row + 1) * ROW_H;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
  }

  // Double-rAF: let React render the newly-virtualized rows before focusing.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => focusActiveCell(table));
  });
}

function handleNavKey(e, table) {
  const st = layoutStates.get(table);
  if (!st) return;
  const nCols = st.widths.length;
  const nRows = getRowCount(table);
  let r = activeCell ? activeCell.row : 0;
  let c = activeCell ? activeCell.col : 0;
  let moved = false;

  switch (e.key) {
    case 'ArrowRight': c = Math.min(nCols - 1, c + 1); moved = true; break;
    case 'ArrowLeft': c = Math.max(0, c - 1); moved = true; break;
    case 'ArrowDown': r = Math.min(nRows - 1, r + 1); moved = true; break;
    case 'ArrowUp': r = Math.max(0, r - 1); moved = true; break;
    case 'Home':
      if (e.ctrlKey || e.metaKey) { r = 0; c = 0; } else { c = 0; }
      moved = true; break;
    case 'End':
      if (e.ctrlKey || e.metaKey) { r = nRows - 1; c = nCols - 1; } else { c = nCols - 1; }
      moved = true; break;
    case 'PageDown': r = Math.min(nRows - 1, r + pageRows(table)); moved = true; break;
    case 'PageUp': r = Math.max(0, r - pageRows(table)); moved = true; break;
  }
  if (moved) {
    e.preventDefault();
    moveTo(table, r, c);
  }
}

/* ------------------------------------------------------------------
   Pin menu — a small overlay (mirrors the export-menu pattern). A context
   menu is used instead of header buttons because React destroys anything
   appended inside the table on every scroll re-render.
   ------------------------------------------------------------------ */

let pinMenuEl = null;

function showPinMenu(table, index, x, y) {
  closePinMenu();
  const st = layoutStates.get(table);
  if (!st) return;
  const isPinned = index < st.pinCount;

  const menu = document.createElement('div');
  menu.className = 'etl-pin-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Column pinning');

  function addItem(label, fn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.addEventListener('click', () => { closePinMenu(); fn(); });
    menu.appendChild(btn);
  }

  if (!isPinned) {
    addItem('Pin up to column ' + (index + 1), () => {
      pinCount = index + 1;
      savePinCount();
      st.pinCount = pinCount;
      syncLayoutStyle(table, st);
    });
  } else {
    addItem('Unpin from column ' + (index + 1), () => {
      pinCount = Math.max(1, index);
      savePinCount();
      st.pinCount = pinCount;
      syncLayoutStyle(table, st);
    });
  }
  if (st.pinCount > 1) {
    addItem('Reset (pin first column)', () => {
      pinCount = 1;
      savePinCount();
      st.pinCount = 1;
      syncLayoutStyle(table, st);
    });
  }

  document.body.appendChild(menu);
  pinMenuEl = menu;

  menu.style.top = Math.round(y) + 'px';
  menu.style.left = Math.round(x) + 'px';
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    menu.style.left = Math.max(8, Math.round(window.innerWidth - rect.width - 8)) + 'px';
  }
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.top = Math.max(8, Math.round(window.innerHeight - rect.height - 8)) + 'px';
  }

  document.addEventListener('mousedown', onPinMenuDocMouseDown, true);
  document.addEventListener('keydown', onPinMenuDocKeyDown, true);
}

function closePinMenu() {
  if (pinMenuEl && pinMenuEl.parentNode) pinMenuEl.parentNode.removeChild(pinMenuEl);
  pinMenuEl = null;
  document.removeEventListener('mousedown', onPinMenuDocMouseDown, true);
  document.removeEventListener('keydown', onPinMenuDocKeyDown, true);
}

function onPinMenuDocMouseDown(e) {
  if (pinMenuEl && !pinMenuEl.contains(e.target)) closePinMenu();
}

function onPinMenuDocKeyDown(e) {
  if (e.key === 'Escape') closePinMenu();
}

/* ------------------------------------------------------------------
   Interactions — delegated listeners on the table element. They survive
   React re-renders because React reuses the table element across scrolls
   (only the tbody's tr children change).
   ------------------------------------------------------------------ */

function addDelegated(table, type, fn, capture) {
  table.addEventListener(type, fn, capture);
  let list = boundListeners.get(table);
  if (!list) { list = []; boundListeners.set(table, list); }
  list.push({ type, fn, capture });
}

function bindTableInteractions(table, opts) {
  if (table.dataset.layoutBound === '1') return;
  table.dataset.layoutBound = '1';

  let drag = null;

  function limitsFor(index) {
    const st = layoutStates.get(table);
    return st && st.numeric[index] ? LIMITS.number : LIMITS.text;
  }

  function onPointerDown(e) {
    const th = e.target.closest('th');
    if (!th) return;
    const ths = table.querySelectorAll('thead th');
    const index = Array.prototype.indexOf.call(ths, th);
    if (index < 0) return;
    const st = layoutStates.get(table);
    if (st && st.fixedWidths && st.fixedWidths[index] != null) return; // e.g. diff indicator
    const rect = th.getBoundingClientRect();
    if (e.clientX < rect.right - 8) return; // not on the grip
    e.preventDefault();
    drag = { index, startX: e.clientX, startW: currentColWidth(table, index) };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.body.classList.add('col-resizing');
  }

  function onPointerMove(e) {
    if (!drag) return;
    applyWidth(table, drag.index, drag.startW + (e.clientX - drag.startX));
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.body.classList.remove('col-resizing');
    saveWidthOverrides(); // commit on release, not per-frame
  }

  function onPointerUp() { endDrag(); }
  function onPointerCancel() { endDrag(); }

  function onContextMenu(e) {
    const th = e.target.closest('th');
    if (!th) return;
    const ths = table.querySelectorAll('thead th');
    const index = Array.prototype.indexOf.call(ths, th);
    if (index < 0) return;
    e.preventDefault();
    showPinMenu(table, index, e.clientX, e.clientY);
  }

  function onKeyDown(e) {
    const target = e.target;
    const th = target.closest ? target.closest('th') : null;
    if (th && table.contains(th)) {
      // Header focused — resize keys (and ArrowDown to jump into the body)
      const ths = table.querySelectorAll('thead th');
      const index = Array.prototype.indexOf.call(ths, th);
      if (index >= 0) {
        const st = layoutStates.get(table);
        const fixed = st && st.fixedWidths && st.fixedWidths[index] != null;
        if (!fixed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
          e.preventDefault();
          const cur = currentColWidth(table, index);
          const limits = limitsFor(index);
          let next = null;
          if (e.key === 'ArrowLeft') next = cur - 8;
          else if (e.key === 'ArrowRight') next = cur + 8;
          else if (e.key === 'Home') next = limits.min;
          else if (e.key === 'End') next = limits.max;
          if (next != null) { applyWidth(table, index, next); saveWidthOverrides(); }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveTo(table, 0, index);
          return;
        }
      }
    }
    // Body / table — cell navigation
    if (target === table || (target.closest && target.closest('td'))) {
      handleNavKey(e, table);
    }
  }

  function onClick(e) {
    const th = e.target.closest('th');
    if (th && table.contains(th)) {
      th.focus({ preventScroll: true }); // enables keyboard resize
      return;
    }
    const td = e.target.closest('td');
    if (!td) return;
    const tr = td.parentElement;
    const r = rowFromTr(tr, table);
    const c = Array.prototype.indexOf.call(tr.children, td);
    if (r >= 0 && c >= 0) {
      activeCell = { row: r, col: c };
      focusActiveCell(table);
    }
  }

  function onMouseOver(e) {
    const td = e.target.closest('td');
    if (!td) return;
    if (td === lastHoveredTd) return;
    lastHoveredTd = td;
    if (td.scrollWidth > td.clientWidth + 1) {
      td.title = (td.textContent || '').trim();
    } else {
      td.removeAttribute('title');
    }
  }

  addDelegated(table, 'pointerdown', onPointerDown);
  addDelegated(table, 'contextmenu', onContextMenu);
  addDelegated(table, 'keydown', onKeyDown);
  addDelegated(table, 'click', onClick);
  addDelegated(table, 'mouseover', onMouseOver);
}

/**
 * Remove all delegated listeners, layout state, and the scoped <style> for a
 * table. Idempotent — safe to call repeatedly.
 */
export function detachResizeHandles(table) {
  if (!table) return;
  const listeners = boundListeners.get(table);
  if (listeners) {
    listeners.forEach((l) => table.removeEventListener(l.type, l.fn, l.capture));
    boundListeners.delete(table);
  }
  delete table.dataset.layoutBound;
  delete table.dataset.layoutSig;
  layoutStates.delete(table);
  const style = document.getElementById('etl-layout-cols-' + getTableId(table));
  if (style) style.remove();
}

/* ------------------------------------------------------------------
   Orchestration
   ------------------------------------------------------------------ */

/**
 * Idempotent layout pass. Short-circuits when the table is already laid out
 * for the current column set, so virtualization scrolls are near-no-ops.
 */
export function applyTableLayout(table, opts) {
  opts = opts || {};
  const sig = JSON.stringify(getColumnSignature(table));
  if (table.dataset.layoutSig === sig && table.dataset.layoutBound === '1') {
    return; // already laid out for this schema
  }

  if (opts.react) table.classList.add('preview-table');
  table.classList.add('tbl-layout');

  const measured = measureColumns(table, opts);
  if (measured.widths.length === 0) return;

  const n = measured.widths.length;
  const pc = opts.pinCount != null ? opts.pinCount : Math.min(pinCount, n);
  const container = opts.container || table.parentElement;

  const state = {
    widths: measured.widths,
    numeric: measured.numeric,
    pinCount: pc,
    tableClass: opts.react ? 'preview-table' : 'diff-table',
    pinBg: opts.react ? 'var(--color-bg)' : 'inherit',
    pinTdZ: opts.react ? 0 : 1,
    fixedWidths: opts.fixedWidths || null,
    container,
    showPinIndicator: !!opts.react,
  };

  syncLayoutStyle(table, state);
  bindTableInteractions(table, opts);

  if (opts.react) {
    table.tabIndex = 0;
    table.setAttribute('role', 'grid');
  }
  table.querySelectorAll('thead th').forEach((th) => { th.tabIndex = -1; });

  table.dataset.layoutSig = sig;
  table.dataset.layoutBound = '1';
  appliedState = { table, container };
}

/* ------------------------------------------------------------------
   React-table bootstrap
   ------------------------------------------------------------------ */

/**
 * Watch the center panel and lay out the React data-preview table whenever it
 * appears, re-renders, or becomes visible again (e.g. after diff mode is off).
 */
export function initPreviewTable() {
  let raf = 0;
  let lastTable = null;
  let lastVisible = false;

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  }

  function apply() {
    const panel = document.querySelector('.center-panel');
    if (!panel) return;
    const table = panel.querySelector('table:not(.diff-table)');
    if (!table) return;

    if (table !== lastTable) {
      lastTable = table;
      lastVisible = false;
    }
    const visible = table.getClientRects().length > 0;
    if (!visible) {
      lastVisible = false;
      return; // hidden (diff mode) or not laid out yet
    }
    if (!lastVisible) {
      // Just became visible — force a re-apply so width overrides made in the
      // diff table are picked up (the scoped style persists across display:none).
      delete table.dataset.layoutSig;
    }
    lastVisible = true;

    applyTableLayout(table, { container: table.parentElement, react: true });
    restoreActiveCell(table);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  // Keep the last-column fill correct when the window resizes.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (appliedState && appliedState.table && document.body.contains(appliedState.table)) {
        recomputeFill(appliedState.table, appliedState.container);
      }
    });
  });

  apply();
}

/* ------------------------------------------------------------------
   Module body — runs once (ES module caching)
   ------------------------------------------------------------------ */

loadWidthOverrides();
loadPinCount();
initPreviewTable();
