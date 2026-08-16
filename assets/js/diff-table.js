/**
 * Diff Table — step-difference preview module for ETL Studio.
 *
 * Compares the current step's output with the previous step's output and
 * renders a color-coded diff table showing added, removed, and changed rows.
 *
 * Creates its own toggle bar at the top of the center panel — no dependency
 * on the React table's toolbar.
 *
 * @module diff-table
 */

import { applyTableLayout, detachResizeHandles } from './table-layout.js?v=3';

/* ===================================================================
   Diff computation
   =================================================================== */

/**
 * Compare two datasets and produce a structured diff.
 *
 * @param {Array<Array<string>>} oldRows - Rows from the previous step
 * @param {Array<Array<string>>} newRows - Rows from the current step
 * @returns {{ added: Array<Array<string>>, removed: Array<Array<string>>, changed: Array<{row: Array<string>, changes: Object}>, unchanged: Array<Array<string>> }}
 */
function computeDiff(oldRows, newRows) {
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  if (!oldRows || oldRows.length === 0) {
    return { added: newRows || [], removed: [], changed: [], unchanged: [] };
  }
  if (!newRows || newRows.length === 0) {
    return { added: [], removed: oldRows || [], changed: [], unchanged: [] };
  }

  const oldMap = new Map();
  oldRows.forEach((row, idx) => {
    const key = _rowKey(row);
    if (!oldMap.has(key)) oldMap.set(key, []);
    oldMap.get(key).push({ row, idx });
  });

  const matchedOld = new Set();

  newRows.forEach((row) => {
    const key = _rowKey(row);
    const candidates = oldMap.get(key);

    if (candidates && candidates.length > 0) {
      const match = candidates.find((c) => !matchedOld.has(c.idx));
      if (match) {
        matchedOld.add(match.idx);
        const changes = _cellChanges(match.row, row);
        if (Object.keys(changes).length > 0) {
          changed.push({ row, changes });
        } else {
          unchanged.push(row);
        }
      } else {
        added.push(row);
      }
    } else {
      added.push(row);
    }
  });

  oldRows.forEach((row, idx) => {
    if (!matchedOld.has(idx)) {
      removed.push(row);
    }
  });

  return { added, removed, changed, unchanged };
}

function _rowKey(row) {
  if (!row || row.length === 0) return '';
  const first = (row[0] || '').trim();
  if (first) return first;
  return row.map((c) => (c || '').trim()).join('|');
}

function _cellChanges(oldRow, newRow) {
  const changes = {};
  const len = Math.max(oldRow.length, newRow.length);
  for (let i = 0; i < len; i++) {
    const oldVal = (oldRow[i] || '').trim();
    const newVal = (newRow[i] || '').trim();
    if (oldVal !== newVal) {
      changes[i] = { old: oldVal, new: newVal };
    }
  }
  return changes;
}

/* ===================================================================
   Step Data Cache
   =================================================================== */

class StepDataCache {
  constructor() {
    this._cache = new Map();
    this._currentStepId = null;
  }

  setCurrent(stepId, data) {
    const prev = this._currentStepId !== null
      ? (this._cache.get(this._currentStepId) || null)
      : null;
    this._currentStepId = stepId;
    if (data) {
      this._cache.set(stepId, data);
    }
    return prev;
  }

  get(stepId) {
    return this._cache.get(stepId) || null;
  }

  getCurrentStepId() {
    return this._currentStepId;
  }

  clear() {
    this._cache.clear();
    this._currentStepId = null;
  }
}

/* ===================================================================
   Diff Table Rendering
   =================================================================== */

function renderDiffTable(container, diff, columns) {
  const existing = container.querySelector('.diff-table-wrap');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.className = 'diff-table-wrap';

  // Summary bar
  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  const parts = [];
  if (diff.added.length > 0) parts.push(`<span class="diff-summary-added">+${diff.added.length} added</span>`);
  if (diff.removed.length > 0) parts.push(`<span class="diff-summary-removed">−${diff.removed.length} removed</span>`);
  if (diff.changed.length > 0) parts.push(`<span class="diff-summary-changed">~${diff.changed.length} changed</span>`);
  if (diff.unchanged.length > 0) parts.push(`<span class="diff-summary-unchanged">${diff.unchanged.length} unchanged</span>`);
  summary.innerHTML = parts.join(' · ') || 'No changes';
  wrap.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'diff-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const indicatorTh = document.createElement('th');
  indicatorTh.className = 'diff-indicator';
  indicatorTh.textContent = '';
  headerRow.appendChild(indicatorTh);

  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  const rowOrder = [
    { rows: diff.removed, cls: 'diff-row-removed', indicator: '−' },
    { rows: diff.changed.map((c) => c.row), cls: 'diff-row-changed', indicator: '~', changes: diff.changed },
    { rows: diff.added, cls: 'diff-row-added', indicator: '+' },
    { rows: diff.unchanged, cls: 'diff-row-unchanged', indicator: '' },
  ];

  rowOrder.forEach((group) => {
    group.rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');
      tr.className = group.cls;

      const indTd = document.createElement('td');
      indTd.className = 'diff-indicator';
      indTd.textContent = group.indicator;
      tr.appendChild(indTd);

      columns.forEach((col, colIdx) => {
        const td = document.createElement('td');
        td.textContent = row[colIdx] || '';

        if (group.changes) {
          const change = group.changes.find((c) => c.row === row);
          if (change && change.changes[colIdx]) {
            td.classList.add('diff-cell-changed');
            td.title = `Old: ${change.changes[colIdx].old}\nNew: ${change.changes[colIdx].new}`;
            td.setAttribute('data-old-value', change.changes[colIdx].old);
          }
        }

        if (row[colIdx] && !isNaN(parseFloat(row[colIdx])) && isFinite(row[colIdx])) {
          td.setAttribute('data-type', 'number');
        }

        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  // Content-aware fixed column widths, pinned columns, resize grips.
  // The 32px status indicator column is fixed and never resized; the
  // indicator + first data column are pinned so row state stays visible
  // while scrolling horizontally.
  applyTableLayout(table, { container: wrap, react: false, fixedWidths: { 0: 32 }, pinCount: 2 });
}

function removeDiffTable(container) {
  const existing = container.querySelector('.diff-table-wrap');
  if (existing) {
    detachResizeHandles(existing.querySelector('table'));
    existing.remove();
  }
}

/* ===================================================================
   Bootstrap / Integration
   =================================================================== */

function initDiffMode(panelEl, options) {
  options = options || {};

  const cache = new StepDataCache();
  let diffMode = false;
  let toggleBar = null;
  let toggleBtn = null;
  let barObserver = null;

  /** Extract current table data from the React table DOM. */
  function captureTableData() {
    const table = panelEl.querySelector('table');
    if (!table) return null;

    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) return null;

    const columns = [];
    thead.querySelectorAll('th').forEach((th) => {
      columns.push(th.textContent.trim());
    });

    const rows = [];
    tbody.querySelectorAll('tr').forEach((tr) => {
      const row = [];
      tr.querySelectorAll('td').forEach((td) => {
        row.push(td.textContent.trim());
      });
      if (row.length > 0) rows.push(row);
    });

    return { columns, rows };
  }

  /** Detect the current step ID from the step list.
      Step cards live in the right panel, not the center panel — querying
      the center panel always returned null, which broke the diff. */
  function detectStepId() {
    const activeStep = document.querySelector('.right-panel .step-card.active');
    if (activeStep) {
      return activeStep.querySelector('.step-card-name')?.textContent?.trim() ||
        Array.from(document.querySelectorAll('.right-panel .step-card')).indexOf(activeStep);
    }
    return null;
  }

  /** Compute and render the diff. */
  function showDiff() {
    const currentData = captureTableData();
    if (!currentData) return;

    const stepId = detectStepId();
    const prevData = stepId !== null ? cache.setCurrent(stepId, currentData) : null;

    if (prevData && prevData.columns && prevData.rows) {
      const diff = computeDiff(prevData.rows, currentData.rows);
      renderDiffTable(panelEl, diff, currentData.columns);
    } else {
      const existing = panelEl.querySelector('.diff-table-wrap');
      if (existing) existing.remove();
      const wrap = document.createElement('div');
      wrap.className = 'diff-table-wrap';
      wrap.innerHTML = '<div class="diff-summary">Select a previous step to compare, or add another step after this one.</div>';
      panelEl.appendChild(wrap);
    }
  }

  /** Hide the diff and restore the React table. */
  function hideDiff() {
    removeDiffTable(panelEl);
    const table = panelEl.querySelector('table');
    if (table) table.style.display = '';
  }

  /** Toggle diff mode on/off. */
  function toggle() {
    diffMode = !diffMode;
    if (toggleBtn) toggleBtn.classList.toggle('active', diffMode);

    if (diffMode) {
      const table = panelEl.querySelector('table');
      if (table) table.style.display = 'none';
      showDiff();
    } else {
      hideDiff();
    }

    if (options.onToggle) options.onToggle(diffMode);
  }

  /** Create the toggle bar at the top of the center panel. */
  function createToggleBar() {
    if (toggleBar && document.body.contains(toggleBar)) return;
    if (toggleBar && toggleBar.parentNode) {
      toggleBar.parentNode.removeChild(toggleBar);
    }

    const bar = document.createElement('div');
    bar.className = 'diff-toolbar';

    const label = document.createElement('span');
    label.className = 'diff-toolbar-label';
    label.textContent = 'Step diff';
    bar.appendChild(label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diff-toggle-btn';
    btn.setAttribute('aria-label', 'Toggle diff view');
    btn.setAttribute('title', 'Toggle diff view');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v18M3 12h18M8 8l8 8M16 8l-8 8"/>
      </svg>
      <span>Compare with previous step</span>
    `;
    if (diffMode) btn.classList.add('active');
    btn.addEventListener('click', toggle);
    bar.appendChild(btn);

    panelEl.insertBefore(bar, panelEl.firstChild);
    toggleBar = bar;
    toggleBtn = btn;
  }

  // Initial setup
  createToggleBar();

  // Watch for toggle bar being removed (React re-renders)
  barObserver = new MutationObserver(() => {
    if (!toggleBar || !document.body.contains(toggleBar)) {
      createToggleBar();
    }
  });
  barObserver.observe(panelEl, { childList: true, subtree: true });

  // Watch for step changes to cache data
  const stepObserver = new MutationObserver(() => {
    const stepId = detectStepId();
    if (stepId !== null && stepId !== cache.getCurrentStepId()) {
      const data = captureTableData();
      if (data) cache.setCurrent(stepId, data);
    }
    if (!toggleBar || !document.body.contains(toggleBar)) {
      createToggleBar();
    }
  });
  stepObserver.observe(panelEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  return {
    destroy() {
      if (barObserver) barObserver.disconnect();
      if (stepObserver) stepObserver.disconnect();
      if (toggleBar && toggleBar.parentNode) {
        toggleBar.parentNode.removeChild(toggleBar);
      }
      hideDiff();
      cache.clear();
    },
    toggle,
    isActive() { return diffMode; },
  };
}

/* ===================================================================
   Module-level bootstrap
   =================================================================== */

(function () {
  'use strict';

  const panel = document.querySelector('.center-panel');
  if (!panel) return;

  let diffInstance = null;

  function init() {
    if (diffInstance) {
      diffInstance.destroy();
    }
    diffInstance = initDiffMode(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init on React re-renders
  const reinitObserver = new MutationObserver(() => {
    const bar = panel.querySelector('.diff-toolbar');
    if (!bar) {
      init();
    }
  });
  reinitObserver.observe(panel, { childList: true, subtree: true });
})();
