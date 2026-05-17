// Style palette — auditable-native dark by default. Mutated in place
// by `plt.style.use(name)` so all subsequent renders pick up the new
// palette. Per-Axes overrides (`_bgcolor`, `_textColor`, `_gridColor`,
// `_frameColor`) still win; this just changes the fallback colors used
// when an Axes doesn't override.
//
// Notebooks loaded from a .ipynb through @gcu/ipynb get an automatic
// `plt.style.use('default')` injected right after their
// `import matplotlib.pyplot` line, so they render with matplotlib's
// light defaults (matching what their authors saw in Jupyter). Native
// auditable cells keep the dark default unless they call style.use
// themselves.

export const _style = {
  bgcolor: '#1a1a1a',
  textColor: '#ccc',
  gridColor: '#333',
  frameColor: '#666',
  // figure-level background. Transparent on dark so the notebook's
  // dark bg shows through; an opaque off-white on the light palette so
  // dark text on the figure surface contrasts properly even when the
  // surrounding notebook is dark.
  figureFacecolor: 'transparent',
  // legend background (rgba for semi-transparent overlay)
  legendBg: 'rgba(30,30,30,0.85)',
  legendBorder: '#555',
};

const _DARK = {
  bgcolor: '#1a1a1a',
  textColor: '#ccc',
  gridColor: '#333',
  frameColor: '#666',
  figureFacecolor: 'transparent',
  legendBg: 'rgba(30,30,30,0.85)',
  legendBorder: '#555',
};

const _LIGHT = {
  bgcolor: '#ffffff',
  textColor: '#333333',
  gridColor: '#cccccc',
  frameColor: '#666666',
  // matplotlib's default figure facecolor is white; the surrounding
  // notebook bg is dark, so we make the figure an opaque card.
  figureFacecolor: '#fafafa',
  legendBg: 'rgba(255,255,255,0.9)',
  legendBorder: '#999999',
};

// matplotlib's style.use accepts a name (or list of names). We honor a
// small set: 'default' / 'classic' / 'matplotlib' → light palette;
// 'dark_background' → dark palette. Anything else is silently ignored
// (matplotlib itself ignores names it doesn't know in some contexts).
export function setStyle(name) {
  const names = Array.isArray(name) ? name : [name];
  for (const n of names) {
    const key = String(n || '').toLowerCase();
    if (key === 'default' || key === 'classic' || key === 'matplotlib' ||
        key === 'seaborn' || key === 'seaborn-whitegrid' ||
        key === 'ggplot' || key === 'bmh') {
      Object.assign(_style, _LIGHT);
    } else if (key === 'dark_background') {
      Object.assign(_style, _DARK);
    }
    // unknown style names: leave palette alone
  }
}
