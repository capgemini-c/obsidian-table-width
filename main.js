const { Plugin, MarkdownView } = require('obsidian');

const ZONE = 5; // px either side of a column border that counts as "on the border"
const MIN = 40; // smallest column width, px

const headerKey = (table) =>
  Array.from(table.rows[0].cells, (c) => c.textContent.replace(/\s+/g, ' ').trim()).join('|');

module.exports = class TableWidth extends Plugin {
  async onload() {
    this.data = Object.assign({ files: {} }, await this.loadData());

    this.registerDomEvent(document, 'pointermove', (e) => this.onMove(e));
    this.registerDomEvent(document, 'pointerdown', (e) => this.onDown(e), { capture: true });
    this.registerDomEvent(document, 'pointerup', () => this.onUp());
    this.registerDomEvent(document, 'pointercancel', () => this.onUp());
    this.registerDomEvent(document, 'dblclick', (e) => this.onDouble(e), { capture: true });
    // Keep Live Preview from entering cell editing when a border is clicked.
    for (const type of ['mousedown', 'click']) {
      this.registerDomEvent(document, type, (e) => this.swallow(e), { capture: true });
    }

    // Obsidian re-renders tables (scrolling, editing, mode switch); re-apply saved widths.
    const observer = new MutationObserver(() => this.restore());
    observer.observe(this.app.workspace.containerEl, { childList: true, subtree: true });
    this.register(() => observer.disconnect());
    this.app.workspace.onLayoutReady(() => this.restore());

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
    const cell = e.target.closest?.('th, td');
    const table = cell && cell.closest('table');
    if (!table || !this.pathOf(table)) return null;
    const r = cell.getBoundingClientRect();
    if (r.right - e.clientX <= ZONE) return { table, i: cell.cellIndex };
    if (e.clientX - r.left <= ZONE && cell.cellIndex > 0) return { table, i: cell.cellIndex - 1 };
    return null;
  }

  widths(table) {
    return table._tw ? table._tw.slice() : Array.from(table.rows[0].cells, (c) => c.getBoundingClientRect().width);
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

  swallow(e) {
    if (this.suppressClick || this.border(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  onMove(e) {
    if (this.drag) return this.dragTo(e.clientX);
    document.body.classList.toggle('tw-col-resize', !!this.border(e));
  }

  onDown(e) {
    this.suppressClick = false;
    const b = e.button === 0 && this.border(e);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    this.drag = { ...b, x: e.clientX, cols: this.widths(b.table), moved: false };
    document.body.classList.add('tw-dragging');
  }

  onDouble(e) {
    const b = this.border(e);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    this.fit(b.table, b.i);
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
    const cols = this.widths(table);
    const want = Math.ceil(Math.max(MIN, ...Array.from(table.rows, (row) => this.lineWidth(row.cells[i]))));
    if (i + 1 < cols.length) cols[i + 1] = Math.max(MIN, cols[i + 1] - (want - cols[i]));
    cols[i] = want;
    this.apply(table, cols);
    this.save(table);
  }

  // Width of the cell's longest line with wrapping switched off, plus its padding.
  lineWidth(cell) {
    if (!cell) return 0;
    cell.classList.add('tw-measure');
    const rects = [];
    const range = document.createRange();
    const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      if (!walk.currentNode.textContent.trim()) continue;
      range.selectNodeContents(walk.currentNode);
      rects.push(...range.getClientRects());
    }
    const cellLeft = cell.getBoundingClientRect().left;
    cell.classList.remove('tw-measure');
    if (!rects.length) return 0;
    const left = Math.min(...rects.map((q) => q.left));
    const right = Math.max(...rects.map((q) => q.right));
    // Text starts after the cell's left padding; assume the same padding on the right.
    return right - left + 2 * Math.max(0, left - cellLeft) + 1;
  }

  save(table) {
    const path = this.pathOf(table);
    if (!path) return;
    (this.data.files[path] = this.data.files[path] || {})[headerKey(table)] = table._tw;
    this.saveData(this.data);
  }

  restore() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const saved = leaf.view.file && this.data.files[leaf.view.file.path];
      if (saved) leaf.view.containerEl.querySelectorAll('table').forEach((t) => this.restoreTable(t, saved));
    }
  }

  restoreTable(table, saved) {
    const cols = table.rows.length && saved[headerKey(table)];
    if (!cols || cols.length !== table.rows[0].cells.length || this.drag?.table === table) return;
    if (!this.intact(table, cols)) this.apply(table, cols);
  }

  intact(table, cols) {
    return table._tw?.join() === cols.join() && table.classList.contains('tw-frozen') &&
      !!table.querySelector(':scope > colgroup');
  }
};
