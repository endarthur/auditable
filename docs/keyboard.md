# Keyboard Shortcuts

Auditable uses a modal editing model inspired by Vim. Press **Escape** to enter
**command mode**, where single keys perform structural operations. Press
**Enter** or click a cell to enter **edit mode**, where you write code or text.

## Command Mode

Press **Escape** to enter command mode. The selected cell is highlighted with a
blue left border.

### Navigation & Editing

| Key | Action |
|-----|--------|
| `j` / `Down` | Select cell below |
| `k` / `Up` | Select cell above |
| `Enter` | Edit selected cell |

### Cell Operations

| Key | Action |
|-----|--------|
| `a` | Insert cell above |
| `b` | Insert cell below |
| `d d` | Delete cell (press `d` twice) |
| `z` | Undo delete |
| `c` | Copy cell |
| `v` | Paste cell below |
| `x` | Cut cell |

### Cell Type Conversion

| Key | Action |
|-----|--------|
| `m` | Convert to markdown |
| `y` | Convert to code |
| `s` | Convert to CSS |
| `t` | Convert to HTML |

### View Controls

| Key | Action |
|-----|--------|
| `h` | Collapse / expand cell |
| `l` | Toggle line numbers |
| `p` | Presentation mode |
| `e` | Toggle split view (editor) |

## Edit Mode

Active when a cell's editor has focus.

| Key | Action |
|-----|--------|
| `Escape` | Exit to command mode |
| `Ctrl+Enter` | Run cell |
| `Shift+Enter` | Run cell and advance to next |
| `Ctrl+/` | Toggle comment |
| `Tab` | Indent |
| `Shift+Tab` | Unindent |

!!! tip "Run and advance"
    **Shift+Enter** is the most common way to work through a notebook — it
    executes the current cell and moves focus to the next one, creating a new
    cell at the end if needed.

## Global Shortcuts

These work regardless of mode.

| Key | Action |
|-----|--------|
| `F1` | Toggle help overlay |
| `Ctrl+S` | Save notebook |
| `Ctrl+Shift+Enter` | Toggle autorun |
| `Ctrl+F` | Find in notebook |
| `Ctrl+H` | Find and replace |

!!! note "Ctrl+S on `file://`"
    Auditable intercepts Ctrl+S before the browser can open its "Save Page As"
    dialog, so keyboard saving works even on `file://` URLs.

## Quick Reference

```
Command mode (Esc)          Edit mode               Global
─────────────────           ─────────               ──────
j/k  navigate cells         Ctrl+Enter   run        Ctrl+S   save
a/b  insert above/below     Shift+Enter  run+next   Ctrl+Shift+Enter  autorun
dd   delete cell            Ctrl+/       comment    Ctrl+F   find
z    undo delete            Tab          indent     Ctrl+H   replace
c/v  copy/paste             Shift+Tab    unindent   F1       help
x    cut                    Esc          exit
m/y/s/t  convert type
h    collapse/expand
l    line numbers
p    presentation
e    split view
```
