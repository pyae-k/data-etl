/**
 * Export Menu — replaces the left-panel Run-All button with an export
 * dropdown (CSV, JSON, Excel, SQL). Choosing a format opens a query-selection
 * dialog; the selected queries are re-run and packaged into a single .zip
 * (one file per query).
 *
 * Reads the query list / runs queries via window.__etlExport (exposed by the
 * bundle). Falls back to exporting the current result (window.__etlData) if
 * that API is missing.
 *
 * Independent of the React app: attaches a click handler to the button
 * React renders (.etl-export-btn) and survives re-renders via MutationObserver.
 *
 * @module export-menu
 */

(function () {
  'use strict';

  /* ===================================================================
     Format definitions
     =================================================================== */

  var FORMATS = [
    { id: 'csv', label: 'CSV (.csv)', icon: '📄' },
    { id: 'json', label: 'JSON (.json)', icon: '📦' },
    { id: 'excel', label: 'Excel (.xls)', icon: '📊' },
    { id: 'sql', label: 'SQL script (.sql)', icon: '🗄️' },
  ];

  var EXT = { csv: '.csv', json: '.json', excel: '.xls', sql: '.sql' };

  // Max rows materialized per query when re-running for export. Keeps the
  // in-memory CSV/JSON/Excel/SQL strings and the resulting .zip at a sane size.
  var EXPORT_ROW_LIMIT = 100000;

  /* ===================================================================
     State
     =================================================================== */

  var menuEl = null;      // the dropdown menu element
  var btnEl = null;       // the export button element
  var reattachTimer = null;
  var dialogEl = null;    // the query-selection dialog overlay
  var dialogState = { formatId: null, queries: [], running: false };

  /* ===================================================================
     Data access
     =================================================================== */

  function getData() {
    return window.__etlData || null;
  }

  /* ===================================================================
     File download helper
     =================================================================== */

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ===================================================================
     Format builders
     =================================================================== */

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    var s = String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(columns, rows) {
    var lines = [columns.map(function (c) { return csvEscape(c.name); }).join(',')];
    rows.forEach(function (row) {
      lines.push(row.map(csvEscape).join(','));
    });
    return '﻿' + lines.join('\r\n'); // BOM helps Excel open UTF-8 CSVs
  }

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * SpreadsheetML 2003 — a single-table XML workbook that Excel opens
   * natively. No external library needed; numeric cells are typed so the
   * file behaves like a real spreadsheet.
   */
  function toExcelXml(columns, rows) {
    var xml = '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
      'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Worksheet ss:Name="Data"><Table>';

    xml += '<Row>';
    columns.forEach(function (c) {
      xml += '<Cell><Data ss:Type="String">' + xmlEscape(c.name) + '</Data></Cell>';
    });
    xml += '</Row>';

    rows.forEach(function (row) {
      xml += '<Row>';
      row.forEach(function (value) {
        var s = value === null || value === undefined ? '' : String(value);
        var isNum = s !== '' && isFinite(s) && s.trim() !== '' && !/^0[0-9]/.test(s);
        xml += isNum
          ? '<Cell><Data ss:Type="Number">' + s + '</Data></Cell>'
          : '<Cell><Data ss:Type="String">' + xmlEscape(s) + '</Data></Cell>';
      });
      xml += '</Row>';
    });

    xml += '</Table></Worksheet></Workbook>';
    return xml;
  }

  function sqlQuote(value) {
    if (value === null || value === undefined) return 'NULL';
    var s = String(value);
    if (s !== '' && isFinite(s)) return s;
    return "'" + s.replace(/'/g, "''") + "'";
  }

  /** Generate a portable SQL dump (CREATE TABLE + INSERTs) from the result. */
  function toSql(columns, rows, tableName) {
    var table = tableName || 'export_data';
    var tableQ = '"' + String(table).replace(/"/g, '""') + '"';
    var colDefs = columns.map(function (c) {
      return '"' + String(c.name).replace(/"/g, '""') + '" VARCHAR';
    }).join(', ');

    var lines = [];
    lines.push('-- ETL Studio export — ' + new Date().toISOString());
    lines.push('CREATE TABLE IF NOT EXISTS ' + tableQ + ' (' + colDefs + ');');
    lines.push('');

    var colList = columns.map(function (c) {
      return '"' + String(c.name).replace(/"/g, '""') + '"';
    }).join(', ');

    if (rows.length === 0) {
      lines.push('-- No rows to export.');
    } else {
      rows.forEach(function (row) {
        var vals = row.map(sqlQuote).join(', ');
        lines.push('INSERT INTO ' + tableQ + ' (' + colList + ') VALUES (' + vals + ');');
      });
    }

    return lines.join('\n');
  }

  function buildFileContent(formatId, columns, rows, queryName) {
    switch (formatId) {
      case 'csv':
        return toCsv(columns, rows);
      case 'json':
        return JSON.stringify(rows, null, 2);
      case 'excel':
        return toExcelXml(columns, rows);
      case 'sql':
        return toSql(columns, rows, sanitizeFilename(queryName));
    }
    return '';
  }

  /* ===================================================================
     ZIP builder (STORE method, no compression)
     =================================================================== */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ===================================================================
     ZipCrypto (traditional PKWARE) encryption
     The only encryption Windows File Explorer and macOS Archive Utility
     can open without extra software. AES-256 (WinZip AES) is NOT
     supported by those default tools, so it is deliberately not used.
     =================================================================== */

  function initZipKeys(password) {
    var keys = [0x12345678, 0x23456789, 0x34567890];
    var bytes = new TextEncoder().encode(password);
    for (var i = 0; i < bytes.length; i++) updateZipKeys(keys, bytes[i]);
    return keys;
  }

  function updateZipKeys(keys, c) {
    keys[0] = (CRC_TABLE[(keys[0] ^ c) & 0xFF] ^ (keys[0] >>> 8)) >>> 0;
    keys[1] = (Math.imul((keys[1] + (keys[0] & 0xFF)) | 0, 134775813) + 1) >>> 0;
    keys[2] = (CRC_TABLE[(keys[2] ^ (keys[1] >>> 24)) & 0xFF] ^ (keys[2] >>> 8)) >>> 0;
  }

  function zipEncryptByte(keys, plain) {
    var temp = (keys[2] | 2) & 0xFFFF;
    var mask = ((temp * (temp ^ 1)) >>> 8) & 0xFF;
    var cipher = plain ^ mask;
    updateZipKeys(keys, plain);   // keys advance on the PLAINTEXT byte
    return cipher;
  }

  function makeEncryptionHeader(crc, keys) {
    var header = new Uint8Array(12);
    crypto.getRandomValues(header.subarray(0, 10));
    header[10] = (crc >>> 16) & 0xFF;   // high-order word of CRC-32, low byte first
    header[11] = (crc >>> 24) & 0xFF;
    for (var i = 0; i < 12; i++) header[i] = zipEncryptByte(keys, header[i]);
    return header;
  }

  function encryptZipData(data, keys) {
    var out = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) out[i] = zipEncryptByte(keys, data[i]);
    return out;
  }

  function dosDateTime(d) {
    return {
      time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
      date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
    };
  }

  /**
   * Build a ZIP archive (entries stored uncompressed). entries is an array of
   * { name: string, data: Uint8Array }. Filenames are UTF-8 (bit flag 0x0800).
   * When password is a non-empty string, every entry is encrypted with
   * ZipCrypto (traditional PKWARE) so default Windows/macOS unzip tools can
   * open it. Note: >4 GB archives would need ZIP64 — not a concern at
   * EXPORT_ROW_LIMIT.
   */
  function buildZip(entries, password) {
    var enc = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var now = new Date();
    var dt = dosDateTime(now);
    var useEncryption = typeof password === 'string' && password.trim().length > 0;

    entries.forEach(function (entry) {
      var nameBytes = enc.encode(entry.name);
      var crc = crc32(entry.data);
      var size = entry.data.length;
      var data = entry.data;
      var flag = 0x0800;            // general purpose flag: UTF-8 names
      var compSize = size;

      if (useEncryption) {
        var keys = initZipKeys(password);
        var header = makeEncryptionHeader(crc, keys);
        data = encryptZipData(entry.data, keys);
        flag |= 0x0001;             // bit 0: encrypted
        compSize = size + 12;       // + 12-byte encryption header
      }

      // Local file header (30 bytes + name)
      var lfh = new DataView(new ArrayBuffer(30));
      lfh.setUint32(0, 0x04034b50, true);   // signature "PK\x03\x04"
      lfh.setUint16(4, 20, true);           // version needed to extract
      lfh.setUint16(6, flag, true);
      lfh.setUint16(8, 0, true);            // compression method: STORE
      lfh.setUint16(10, dt.time, true);     // DOS time
      lfh.setUint16(12, dt.date, true);     // DOS date
      lfh.setUint32(14, crc, true);  // CRC-32 (real value — some unzip tools read the local header CRC for the ZipCrypto check bytes)
      lfh.setUint32(18, compSize, true);    // compressed size
      lfh.setUint32(22, size, true);        // uncompressed size
      lfh.setUint16(26, nameBytes.length, true);
      lfh.setUint16(28, 0, true);           // extra field length
      parts.push(lfh.buffer, nameBytes);
      if (useEncryption) parts.push(header);
      parts.push(data);

      // Central directory header (46 bytes + name)
      var cdh = new DataView(new ArrayBuffer(46));
      cdh.setUint32(0, 0x02014b50, true);   // signature "PK\x01\x02"
      cdh.setUint16(4, 20, true);           // version made by
      cdh.setUint16(6, 20, true);           // version needed to extract
      cdh.setUint16(8, flag, true);
      cdh.setUint16(10, 0, true);           // compression method: STORE
      cdh.setUint16(12, dt.time, true);     // DOS time
      cdh.setUint16(14, dt.date, true);     // DOS date
      cdh.setUint32(16, crc, true);         // CRC-32 (real value always)
      cdh.setUint32(20, compSize, true);    // compressed size
      cdh.setUint32(24, size, true);        // uncompressed size
      cdh.setUint16(28, nameBytes.length, true);
      cdh.setUint16(30, 0, true);           // extra field length
      cdh.setUint16(32, 0, true);           // comment length
      cdh.setUint16(34, 0, true);           // disk number start
      cdh.setUint16(36, 0, true);           // internal attributes
      cdh.setUint32(38, 0, true);           // external attributes
      cdh.setUint32(42, offset, true);      // local header offset
      central.push(cdh.buffer, nameBytes);

      offset += 30 + nameBytes.length + compSize;
    });

    var cdSize = 0;
    central.forEach(function (p) { cdSize += p.byteLength; });
    var cdOffset = offset;

    // End of central directory (22 bytes)
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);    // signature "PK\x05\x06"
    eocd.setUint16(4, 0, true);             // disk number
    eocd.setUint16(6, 0, true);             // disk with central directory
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdOffset, true);
    eocd.setUint16(20, 0, true);            // comment length

    parts.push.apply(parts, central);
    parts.push(eocd.buffer);

    return new Blob(parts, { type: 'application/zip' });
  }

  /* ===================================================================
     Filename helpers
     =================================================================== */

  function sanitizeFilename(name) {
    var s = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/\.+$/g, '').slice(0, 60);
    return s || 'query';
  }

  function uniqueName(base, used) {
    var n = base, i = 2;
    while (used[n]) n = base + '_' + (i++);
    used[n] = true;
    return n;
  }

  /* ===================================================================
     Dropdown menu
     =================================================================== */

  function closeMenu() {
    if (menuEl && menuEl.parentNode) {
      menuEl.parentNode.removeChild(menuEl);
    }
    menuEl = null;
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
  }

  function onDocumentMouseDown(e) {
    if (!menuEl || !btnEl) return;
    if (menuEl.contains(e.target) || btnEl.contains(e.target)) return;
    closeMenu();
  }

  function onDocumentKeyDown(e) {
    if (e.key === 'Escape') closeMenu();
  }

  /** Fallback: export the current (active) query's result as a single file. */
  function doExport(formatId) {
    var data = getData();
    if (!data || !data.columns || !data.rows || data.rows.length === 0) {
      window.alert('No data to export yet. Run a query first.');
      return;
    }

    var ts = new Date().toISOString().slice(0, 10);
    var base = 'etl_export_' + ts;
    var columns = data.columns;
    var rows = data.rows;

    switch (formatId) {
      case 'csv':
        download(base + '.csv', toCsv(columns, rows), 'text/csv;charset=utf-8');
        break;
      case 'json':
        download(base + '.json', JSON.stringify(rows, null, 2), 'application/json;charset=utf-8');
        break;
      case 'excel':
        download(base + '.xls', toExcelXml(columns, rows), 'application/vnd.ms-excel');
        break;
      case 'sql':
        download(base + '.sql', toSql(columns, rows), 'text/plain;charset=utf-8');
        break;
    }
    closeMenu();
  }

  function openMenu(btn) {
    closeMenu();

    var menu = document.createElement('div');
    menu.className = 'etl-export-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Export data as');

    FORMATS.forEach(function (fmt) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'etl-export-menu-item';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = '<span class="etl-export-menu-icon" aria-hidden="true">' + fmt.icon + '</span>' +
        '<span>' + fmt.label + '</span>';
      item.addEventListener('click', function () { openExportDialog(fmt.id); });
      menu.appendChild(item);
    });

    var rect = btn.getBoundingClientRect();
    menu.style.top = Math.round(rect.bottom + 6) + 'px';
    menu.style.left = Math.round(rect.left) + 'px';

    document.body.appendChild(menu);
    menuEl = menu;

    // Clamp within the viewport
    var mrect = menu.getBoundingClientRect();
    if (mrect.right > window.innerWidth - 8) {
      menu.style.left = Math.max(8, Math.round(window.innerWidth - mrect.width - 8)) + 'px';
    }

    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
  }

  /* ===================================================================
     Query-selection dialog
     =================================================================== */

  function openExportDialog(formatId) {
    closeMenu();
    closeExportDialog();

    // If the bundle API is missing, keep the app functional with the old
    // single-file export of the active query's result.
    if (!window.__etlExport) {
      doExport(formatId);
      return;
    }

    var queries = window.__etlExport.getQueries() || [];
    dialogState = { formatId: formatId, queries: queries, running: false };

    var overlay = document.createElement('div');
    overlay.className = 'etl-export-dialog-overlay';
    overlay.setAttribute('data-export-overlay', '');
    overlay.innerHTML =
      '<div class="etl-export-dialog" role="dialog" aria-modal="true" aria-labelledby="etl-export-dialog-title" data-export-dialog>' +
        '<h2 id="etl-export-dialog-title" class="etl-export-dialog-title">Export as ' + formatId.toUpperCase() + '</h2>' +
        '<p class="etl-export-dialog-subtitle">Select queries to include in the .zip</p>' +
        '<div class="etl-export-dialog-toolbar">' +
          '<button type="button" class="etl-export-dialog-link" data-select-all>Select all</button>' +
          '<button type="button" class="etl-export-dialog-link" data-unselect-all>Unselect all</button>' +
        '</div>' +
        '<label class="etl-export-dialog-password">' +
          '<span>Password (optional)</span>' +
          '<input type="password" class="etl-export-dialog-password-input" data-export-password autocomplete="new-password" placeholder="Encrypt the .zip">' +
        '</label>' +
        '<div class="etl-export-dialog-list" role="group" aria-label="Queries"></div>' +
        '<div class="etl-export-dialog-status" role="status" aria-live="polite" hidden></div>' +
        '<div class="etl-export-dialog-footer">' +
          '<button type="button" class="etl-export-dialog-cancel">Cancel</button>' +
          '<button type="button" class="etl-export-dialog-export" disabled>Export (0)</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    dialogEl = overlay;

    var list = overlay.querySelector('.etl-export-dialog-list');
    if (queries.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'etl-export-dialog-empty';
      empty.textContent = 'No queries to export.';
      list.appendChild(empty);
    } else {
      queries.forEach(function (q) {
        var canRun = q.enabled && q.enabledStepCount > 0;
        var label = document.createElement('label');
        label.className = 'etl-export-dialog-item' + (canRun ? '' : ' is-disabled');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'etl-export-dialog-checkbox';
        cb.value = q.id;
        cb.checked = !!q.active;
        cb.disabled = !canRun;
        cb.addEventListener('change', onCheckboxChange);
        var name = document.createElement('span');
        name.className = 'etl-export-dialog-item-name';
        name.textContent = q.name;
        var meta = document.createElement('span');
        meta.className = 'etl-export-dialog-item-meta';
        meta.textContent = canRun ? (q.enabledStepCount + ' steps') : (q.enabled ? 'No steps' : 'Disabled');
        label.appendChild(cb);
        label.appendChild(name);
        label.appendChild(meta);
        list.appendChild(label);
      });
    }

    overlay.querySelector('[data-select-all]').addEventListener('click', selectAll);
    overlay.querySelector('[data-unselect-all]').addEventListener('click', unselectAll);
    overlay.querySelector('.etl-export-dialog-cancel').addEventListener('click', closeExportDialog);
    overlay.querySelector('.etl-export-dialog-export').addEventListener('click', runExport);
    overlay.addEventListener('mousedown', onOverlayMouseDown);

    document.addEventListener('keydown', onDialogKeyDown, true);

    var first = list.querySelector('input:not(:disabled)');
    if (first) first.focus();

    updateExportCount();
  }

  function closeExportDialog() {
    if (dialogEl && dialogEl.parentNode) {
      dialogEl.parentNode.removeChild(dialogEl);
    }
    dialogEl = null;
    dialogState = { formatId: null, queries: [], running: false };
    document.removeEventListener('keydown', onDialogKeyDown, true);
    if (btnEl) btnEl.focus();
  }

  function onDialogKeyDown(e) {
    if (!dialogEl) return;
    if (e.key === 'Escape' && !dialogState.running) {
      e.preventDefault();
      closeExportDialog();
      return;
    }
    if (e.key === 'Tab') {
      var focusables = dialogEl.querySelectorAll('button:not(:disabled), input:not(:disabled)');
      if (focusables.length === 0) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onOverlayMouseDown(e) {
    if (dialogState.running) return;
    if (e.target === dialogEl) closeExportDialog();
  }

  function onCheckboxChange() {
    updateExportCount();
  }

  function countSelected() {
    if (!dialogEl) return 0;
    return dialogEl.querySelectorAll('.etl-export-dialog-checkbox:checked:not(:disabled)').length;
  }

  function updateExportCount() {
    if (!dialogEl) return;
    var btn = dialogEl.querySelector('.etl-export-dialog-export');
    if (!btn) return;
    var n = countSelected();
    btn.disabled = n === 0 || dialogState.running;
    btn.textContent = dialogState.running ? 'Exporting…' : 'Export (' + n + ')';
  }

  function selectAll() {
    if (!dialogEl) return;
    dialogEl.querySelectorAll('.etl-export-dialog-checkbox:not(:disabled)').forEach(function (cb) {
      cb.checked = true;
    });
    updateExportCount();
  }

  function unselectAll() {
    if (!dialogEl) return;
    dialogEl.querySelectorAll('.etl-export-dialog-checkbox:not(:disabled)').forEach(function (cb) {
      cb.checked = false;
    });
    updateExportCount();
  }

  function setStatus(text) {
    if (!dialogEl) return;
    var el = dialogEl.querySelector('.etl-export-dialog-status');
    if (el) {
      el.textContent = text;
      el.hidden = !text;
    }
  }

  function setDialogControlsDisabled(disabled) {
    if (!dialogEl) return;
    dialogEl.querySelectorAll('button, input').forEach(function (el) {
      el.disabled = disabled;
    });
    if (!disabled) updateExportCount();
  }

  async function runExport() {
    if (dialogState.running || !dialogEl) return;

    var passwordInput = dialogEl.querySelector('[data-export-password]');
    var password = passwordInput ? passwordInput.value : '';

    var cbs = dialogEl.querySelectorAll('.etl-export-dialog-checkbox:checked:not(:disabled)');
    var selected = Array.prototype.map.call(cbs, function (cb) {
      var q = dialogState.queries.find(function (x) { return x.id === cb.value; });
      return { id: cb.value, name: q ? q.name : cb.value };
    });
    if (selected.length === 0) return;

    dialogState.running = true;
    setDialogControlsDisabled(true);
    updateExportCount();
    setStatus('Running 1 of ' + selected.length + ': ' + selected[0].name);

    var results = [];
    var errors = [];

    // Run sequentially — the bundle reuses a single DuckDB connection, so
    // concurrent queries would conflict.
    for (var i = 0; i < selected.length; i++) {
      var item = selected[i];
      setStatus('Running ' + (i + 1) + ' of ' + selected.length + ': ' + item.name);
      try {
        var res = await window.__etlExport.runQuery(item.id, EXPORT_ROW_LIMIT);
        if (res && res.data && !res.error) {
          results.push({
            name: item.name,
            content: buildFileContent(dialogState.formatId, res.data.columns, res.data.rows, item.name),
            truncated: res.data.rows.length < res.data.rowCount,
            totalRows: res.data.rowCount
          });
        } else {
          errors.push({ name: item.name, error: (res && res.error) || 'No data returned' });
        }
      } catch (err) {
        errors.push({ name: item.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (results.length === 0) {
      setStatus('Export failed: ' + errors.map(function (e) { return e.name; }).join(', '));
      dialogState.running = false;
      setDialogControlsDisabled(false);
      return;
    }

    // Build the .zip — one file per query, plus an error log if any failed.
    var used = {};
    var entries = results.map(function (r) {
      return {
        name: uniqueName(sanitizeFilename(r.name), used) + EXT[dialogState.formatId],
        data: new TextEncoder().encode(r.content)
      };
    });

    if (errors.length > 0) {
      var errText = 'ETL Studio export errors — ' + new Date().toISOString() + '\n\n' +
        errors.map(function (e) { return 'Query "' + e.name + '": ' + e.error; }).join('\n');
      entries.push({ name: '_export_errors.txt', data: new TextEncoder().encode(errText) });
    }

    var zipBlob = buildZip(entries, password);
    var ts = new Date().toISOString().slice(0, 10);
    download('etl_export_' + ts + '.zip', zipBlob, 'application/zip');

    var summary = 'Exported ' + results.length + ' of ' + selected.length + ' queries.';
    if (errors.length > 0) {
      summary += ' ' + errors.length + ' failed: ' + errors.map(function (e) { return e.name; }).join(', ') + '.';
    }
    var trunc = results.filter(function (r) { return r.truncated; });
    if (trunc.length > 0) {
      summary += ' Truncated: ' + trunc.map(function (r) {
        return r.name + ' (' + r.totalRows.toLocaleString() + ' rows, exported first ' + EXPORT_ROW_LIMIT.toLocaleString() + ')';
      }).join('; ') + '.';
    }
    setStatus(summary);

    setTimeout(function () {
      closeExportDialog();
    }, 1500);
  }

  /* ===================================================================
     Bootstrap / integration
     =================================================================== */

  function attach(btn) {
    if (btn === btnEl) return;
    if (btnEl) {
      btnEl.removeEventListener('click', onClick);
    }
    btnEl = btn;
    btn.addEventListener('click', onClick);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (menuEl) {
      closeMenu();
    } else {
      openMenu(btnEl);
    }
  }

  function scan() {
    var btn = document.querySelector('.etl-export-btn');
    if (btn) {
      attach(btn);
      return true;
    }
    return false;
  }

  function init() {
    if (scan()) return;
    // React hasn't mounted yet — retry on a short interval.
    if (reattachTimer) clearInterval(reattachTimer);
    reattachTimer = setInterval(function () {
      if (scan()) {
        clearInterval(reattachTimer);
        reattachTimer = null;
      }
    }, 500);
  }

  // Re-attach if React replaces the button (class change is enough to signal
  // a re-render that may have swapped the node).
  var reattachObserver = new MutationObserver(function () {
    if (!btnEl || !document.body.contains(btnEl)) {
      btnEl = null;
      init();
    }
  });
  reattachObserver.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
