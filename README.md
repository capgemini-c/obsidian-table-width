# Table Width

Resize Markdown table columns in Obsidian without changing how the rest of the table looks.

- **Drag a border** between two columns: width moves from one column to the other, so the table keeps its total width. Dragging the table's right edge resizes the last column (and the table).
- **Double-click a border** to fit the column on its left to its longest line, without wrapping. The column to its right gives up the space; the table only grows if that column is already at its 40 px minimum.
- **Untouched tables stay as they are.** A table only switches to fixed column widths once you resize it.
- Long unbreakable text (URLs, inline code) wraps inside narrowed columns instead of spilling into the next one.

Works in Live Preview and Reading view. Widths are saved per note and table (keyed by the header row) and never modify the Markdown.

## Commands

- **Reset column widths in this note**: returns the note's tables to their normal layout.

## Install manually

Copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/table-width/`, then enable **Table Width** in Settings → Community plugins.
