const { Plugin, MarkdownView } = require('obsidian');

const ZONE = 5; // px either side of a column border that counts as "on the border"
const MIN = 40; // smallest column width, px
const DOUBLE_MS = 400;

const headerKey = (table) =>
  Array.from(table.rows[0].cells, (c) => c.textContent.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()).join('|');

module.exports = class TableWidth extends Plugin {
  async onload() {
    this.data = Object.assign({ files: {} }, await this.loadData());
    this.drag = null;
    this.lastDown = null;
    this.suppressClick = false;

    this.registerDomEvent(document, 'pointermove', (e) => this.onMove(e));
    this.registerDomEvent(document, 'pointerdown', (e) => this.onDown(e), { capture: true });
    this.registerDomEvent(document, 'pointerup', () => this.onUp());
    this.registerDomEvent(document, 'pointercancel', () => this.onUp());
    // Keep Live Preview from entering cell editing when the border is clicked.
    for (const type of ['mousedown', 'click', 'dblclick']) {
      this.registerDomEvent(document, type, (e) => {
        if (this.drag || (type === 'click' && this.suppressClick) || this.border(e)) {
          this.suppressClick = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }, { capture: true });
    }

    // Obsidian re-renders tables (scrolling, editing, mode switch); re-apply saved widths.
    const observer = new MutationObserver(() => this.restore());
    observer.observe(this.app.workspace.containerEl, { childList: true, subtree: true });
    this.register(() => observer.disconnect());
    this.app.workspace.onLayoutReady(() => this.restore());

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!this.data.files[oldPath]) return;
      this.data.files[file.path] = this.data.files[oldPath];
      delete this.data.files[oldPath];
      this.saveData(this.data);
    }));

    this.addCommand({
      id: 'reset-note',
      name: 'Reset column widths in this note',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (checking) return true;
        delete this.data.files[view.file.path];
        this.saveData(this.data);
        view.containerEl.querySelectorAll('table').forEach((t) => this.unfreeze(t));
        return true;
      },
    });
  }

  onunload() {
    document.querySelectorAll('table').forEach((t) => t._tw && this.unfreeze(t));
    document.body.classList.remove('tw-col-resize', 'tw-dragging');
  }

  pathOf(table) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view.file && leaf.view.containerEl.contains(table)) return leaf.view.file.path;
    }
    return null;
  }

  // The column border under the pointer: { table, i } where i is the column left of the border.
  border(e) {
    const cell = e.target instanceof Element && e.target.closest('th, td');
    if (!cell) return null;
    const table = cell.closest('table');
    if (!table || !table.rows.length || !this.pathOf(table)) return null;
    const r = cell.getBoundingClientRect();
    const n = table.rows[0].cells.length;
    let i = -1;
    if (r.right - e.clientX <= ZONE) i = cell.cellIndex;
    else if (e.clientX - r.left <= ZONE && cell.cellIndex > 0) i = cell.cellIndex - 1;
    return i >= 0 && i < n ? { table, i } : null;
  }

  measure(table) {
    return Array.from(table.rows[0].cells, (c) => c.getBoundingClientRect().width);
  }

  apply(table, cols) {
    cols = cols.map(Math.round);
    let cg = table.querySelector(':scope > colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      cg.dataset.tw = '1';
      table.prepend(cg);
    }
    while (cg.children.length < cols.length) cg.appendChild(document.createElement('col'));
    cols.forEach((w, k) => (cg.children[k].style.width = w + 'px'));
    table.classList.add('tw-frozen');
    table.style.width = cols.reduce((a, b) => a + b, 0) + 'px';
    table._tw = cols;
  }

  unfreeze(table) {
    const cg = table.querySelector(':scope > colgroup[data-tw]');
    if (cg) cg.remove();
    table.classList.remove('tw-frozen');
    table.style.width = '';
    delete table._tw;
  }

  onMove(e) {
    if (this.drag) return this.dragTo(e.clientX);
    document.body.classList.toggle('tw-col-resize', !!this.border(e));
  }

  onDown(e) {
    this.suppressClick = false;
    if (e.button !== 0) return;
    const b = this.border(e);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    const last = this.lastDown;
    this.lastDown = { table: b.table, i: b.i, t: now };
    if (last && last.table === b.table && last.i === b.i && now - last.t < DOUBLE_MS) {
      this.lastDown = null;
      return this.fit(b.table, b.i);
    }
    const cols = b.table._tw ? b.table._tw.slice() : this.measure(b.table);
    this.drag = { table: b.table, i: b.i, x: e.clientX, cols, moved: false };
    document.body.classList.add('tw-dragging');
  }

  // Inner border: width moves between the two adjacent columns, table width unchanged.
  // Outer (last) border: the last column grows or shrinks the table.
  dragTo(x) {
    const d = this.drag;
    const dx = x - d.x;
    if (!dx && !d.moved) return;
    d.moved = true;
    const c = d.cols.slice();
    if (d.i === c.length - 1) {
      c[d.i] = Math.max(MIN, d.cols[d.i] + dx);
    } else {
      const pair = d.cols[d.i] + d.cols[d.i + 1];
      c[d.i] = Math.min(Math.max(MIN, d.cols[d.i] + dx), pair - MIN);
      c[d.i + 1] = pair - c[d.i];
    }
    this.apply(d.table, c);
  }

  onUp() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    document.body.classList.remove('tw-dragging');
    if (d.moved) {
      this.suppressClick = true;
      this.save(d.table);
    }
  }

  // Fit column i to its longest unwrapped line, taking the space from the column to its right.
  // The table only grows when that neighbour is already at MIN (or i is the last column).
  fit(table, i) {
    const cols = table._tw ? table._tw.slice() : this.measure(table);
    const want = this.natural(table, i);
    if (i + 1 < cols.length) cols[i + 1] = Math.max(MIN, cols[i + 1] - (want - cols[i]));
    cols[i] = want;
    this.apply(table, cols);
    this.save(table);
  }

  natural(table, i) {
    let w = MIN;
    const range = document.createRange();
    for (const row of table.rows) {
      const cell = row.cells[i];
      if (!cell) continue;
      cell.classList.add('tw-measure');
      const box = cell.getBoundingClientRect();
      let left = Infinity;
      let right = -Infinity;
      const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (!t.textContent.trim()) continue;
        range.selectNodeContents(t);
        for (const q of range.getClientRects()) {
          left = Math.min(left, q.left);
          right = Math.max(right, q.right);
        }
      }
      cell.classList.remove('tw-measure');
      // Text starts after the cell's left padding; assume the same padding on the right.
      if (right > left) w = Math.max(w, right - left + 2 * Math.max(0, left - box.left) + 1);
    }
    return Math.ceil(w);
  }

  save(table) {
    const path = this.pathOf(table);
    if (!path || !table._tw) return;
    (this.data.files[path] = this.data.files[path] || {})[headerKey(table)] = table._tw;
    this.saveData(this.data);
  }

  restore() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const saved = leaf.view.file && this.data.files[leaf.view.file.path];
      if (!saved) continue;
      for (const table of leaf.view.containerEl.querySelectorAll('table')) {
        if (!table.rows.length || (this.drag && this.drag.table === table)) continue;
        const cols = saved[headerKey(table)];
        if (!cols || cols.length !== table.rows[0].cells.length) continue;
        const intact = table._tw && table._tw.join() === cols.join() &&
          table.classList.contains('tw-frozen') && table.querySelector(':scope > colgroup');
        if (!intact) this.apply(table, cols);
      }
    }
  }
};
