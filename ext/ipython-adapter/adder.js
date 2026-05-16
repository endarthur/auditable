// @gcu/ipython-adapter — IPython.display shim for adder cells.
//
// Most Jupyter notebooks open with `from IPython.display import display,
// HTML, Image, Markdown` and then mix rich output into their cells. The
// adapter exposes that surface inside adder so the import resolves and
// the rich-display calls render correctly. This is not a re-implementation
// of IPython — just enough glue for the rich-display protocol.
//
// Registered names: `IPython` (with `display` namespace), so the canonical
// `from IPython.display import HTML` form works directly. Adder's import
// machinery walks dotted paths through plain JS objects.
//
// Rendering: most wrappers (HTML, Markdown, SVG, Latex, Math, JSON) just
// expose `_repr_html_` — auditable's display() already handles that hook
// (cell-builtins/ui.js). Image returns a DOM <img> so it stays an
// editable element (downloadable, devtools-inspectable). display() and
// clear_output() need the active cell context; we capture it via the
// adder cell-hook side channel (window._adderCellHooks).

// ── HTML escape (minimal, for fallback contexts) ──
function _escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// auditable.renderMd is exposed by globals.js; fall back to a <pre>
// block if it's unavailable (e.g. node test, very old runtime).
function _renderMd(s) {
  const fn = typeof window !== 'undefined' && window.auditable?.renderMd;
  if (fn) return fn(s);
  return '<pre>' + _escHtml(s) + '</pre>';
}

// ── Active cell context (set by the adder cell hook) ──
//
// Stored on `window._ipythonActiveCtx` rather than module-level so that
// if the adapter happens to be loaded twice (different blob URLs created
// for the same source — auditable's loader sometimes does this), both
// module instances share the same active-context slot. Without this,
// the second instance's display() would see `null` because only the
// first instance's hook would be registered (the dedupe guard skips
// the second).
function _getActiveCtx() {
  return (typeof window !== 'undefined') ? window._ipythonActiveCtx : null;
}
function _setActiveCtx(ctx) {
  if (typeof window !== 'undefined') window._ipythonActiveCtx = ctx;
}

function _registerCellHook() {
  if (typeof window === 'undefined') return;
  window._adderCellHooks = window._adderCellHooks || [];
  // Skip if we've already registered (re-imports shouldn't add duplicates).
  if (window._adderCellHooks.some(h => h._ipythonAdapter)) return;
  window._adderCellHooks.push({
    _ipythonAdapter: true,
    before(_scope, cell) {
      _setActiveCtx(cell?._ctx || null);
      if (window._ipythonDebug) {
        console.log('[IPython] before hook — cell', cell?.id, 'ctx?', !!_getActiveCtx(), 'ctx.display?', typeof _getActiveCtx()?.display);
      }
      return null;
    },
    after() {
      if (window._ipythonDebug) {
        console.log('[IPython] after hook — clearing ctx');
      }
      _setActiveCtx(null);
    },
  });
}

// ── Wrapper classes — rich-display protocol ──

// HTML(s) — render raw HTML.
function HTML(s) {
  return {
    _repr_html_() { return String(s); },
    _ipython_kind_: 'HTML',
  };
}

// Markdown(s) — render markdown through auditable's md pipeline.
function Markdown(s) {
  return {
    _repr_html_() { return _renderMd(String(s)); },
    _ipython_kind_: 'Markdown',
  };
}

// SVG(s) — inline SVG markup or a URL.
function SVG(s) {
  return {
    _repr_html_() {
      const str = String(s);
      // If it looks like a URL, wrap as <img>; otherwise inline.
      if (/^(https?:|data:|\/|\.)/.test(str) && !str.includes('<svg')) {
        return `<img src="${_escHtml(str)}" alt="SVG" />`;
      }
      return str;
    },
    _ipython_kind_: 'SVG',
  };
}

// Image(data, format, width, height, ...) — produce a DOM <img>.
// In IPython, data can be: a URL (path or http), bytes (PNG/JPEG/...),
// or a filename. Bytes need to be encoded as a data URL.
function Image(data, opts = {}) {
  // opts may be a plain object — adder kwargs land in the trailing arg
  // (sklearn-style); accept either shape.
  const { format, width, height, embed, url: optUrl, filename, alt } = (opts && typeof opts === 'object') ? opts : {};
  let src;
  if (typeof data === 'string') {
    // URL, path, or data URL — pass through.
    src = data;
  } else if (optUrl) {
    src = optUrl;
  } else if (filename) {
    src = filename;
  } else if (data && data.length !== undefined) {
    // Bytes (Uint8Array, ArrayBuffer, or array-of-bytes).
    const bytes = data instanceof Uint8Array
      ? data
      : (data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
    const mime = format ? `image/${format}` : 'image/png';
    // Base64-encode.
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    src = `data:${mime};base64,${typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')}`;
  } else {
    src = '';
  }

  // Return a DOM <img> in browser (so display routes via nodeType); in
  // node tests, fall back to _repr_html_ since there's no DOM.
  if (typeof document !== 'undefined') {
    const img = document.createElement('img');
    img.src = src;
    if (width != null) img.width = Number(width);
    if (height != null) img.height = Number(height);
    if (alt != null) img.alt = String(alt);
    return img;
  }
  return {
    _repr_html_() {
      const w = width != null ? ` width="${Number(width)}"` : '';
      const h = height != null ? ` height="${Number(height)}"` : '';
      const a = alt != null ? ` alt="${_escHtml(alt)}"` : '';
      return `<img src="${_escHtml(src)}"${w}${h}${a} />`;
    },
    _ipython_kind_: 'Image',
  };
}

// Latex(s) / Math(s) — render via markdown's math support if available,
// otherwise as inline $...$ / $$...$$ wrapped text. auditable's renderMd
// passes math through unchanged; downstream KaTeX/MathJax (if loaded by
// the notebook) will pick it up.
function Latex(s) {
  return {
    _repr_html_() { return _renderMd('$$' + String(s) + '$$'); },
    _ipython_kind_: 'Latex',
  };
}
function Math(s) {
  return {
    _repr_html_() { return _renderMd('$$' + String(s) + '$$'); },
    _ipython_kind_: 'Math',
  };
}

// JSON(d) — pretty-printed JSON. IPython shows a collapsible tree;
// here we settle for a <pre>.
function JSONDisplay(data) {
  return {
    _repr_html_() {
      let text;
      try { text = JSON.stringify(data, null, 2); }
      catch { text = String(data); }
      return '<pre style="white-space:pre-wrap">' + _escHtml(text) + '</pre>';
    },
    _ipython_kind_: 'JSON',
  };
}

// Pretty(s) / Code(s) — minimal, fall through to <pre>.
function Pretty(s) {
  return {
    _repr_html_() { return '<pre>' + _escHtml(String(s)) + '</pre>'; },
    _ipython_kind_: 'Pretty',
  };
}
function Code(s, opts = {}) {
  const lang = (opts && opts.language) || '';
  return {
    _repr_html_() {
      const cls = lang ? ` class="language-${_escHtml(lang)}"` : '';
      return `<pre><code${cls}>${_escHtml(String(s))}</code></pre>`;
    },
    _ipython_kind_: 'Code',
  };
}

// IFrame(src, width, height) — embeds a URL.
function IFrame(src, width = 800, height = 400) {
  return {
    _repr_html_() {
      return `<iframe src="${_escHtml(String(src))}" width="${Number(width)}" height="${Number(height)}" frameborder="0"></iframe>`;
    },
    _ipython_kind_: 'IFrame',
  };
}

// ── Imperative API ──

// display(*args, **kwargs) — render each argument as if it were the
// last expression of a cell. adder cells already have a builtin
// `display` from the cell context; this version is what `from
// IPython.display import display` rebinds to. Routes to the active
// cell's ctx.display.
function display(...args) {
  // The trailing arg may be a kwargs object (adder convention) — discard
  // it for now (display_id, etc. aren't implemented).
  if (args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object'
      && args[args.length - 1]._kw) {
    args.pop();
  }
  const ctx = _getActiveCtx();
  if (!ctx) {
    // Best-effort fallback: log so notebooks running outside an active
    // cell (test harness, eager-eval) don't silently swallow.
    if (typeof console !== 'undefined') console.log('[IPython display fallback]', ...args);
    return;
  }
  ctx.display(...args);
}

// clear_output(wait=False) — wipes the current cell output. `wait` is
// IPython-specific (defer clear until next output); auditable runs
// each cell to completion before rendering, so the wait flag is a no-op.
function clear_output(_wait = false) {
  const ctx = _getActiveCtx();
  if (!ctx || !ctx.outputEl) return;
  ctx.outputEl.innerHTML = '';
}

// display_html / display_markdown / display_image — convenience wrappers
// IPython exposes alongside display(). Pass through to display() with
// the appropriate wrapper.
function display_html(s) { display(HTML(s)); }
function display_markdown(s) { display(Markdown(s)); }
function display_svg(s) { display(SVG(s)); }
function display_latex(s) { display(Latex(s)); }
function display_json(d) { display(JSONDisplay(d)); }
function display_pretty(s) { display(Pretty(s)); }

// publish_display_data({'text/html': '...', 'text/plain': '...'}) —
// MIME bundle. We pick the richest available type.
function publish_display_data(bundle) {
  if (!bundle || typeof bundle !== 'object') return;
  if (bundle['text/html']) display(HTML(bundle['text/html']));
  else if (bundle['text/markdown']) display(Markdown(bundle['text/markdown']));
  else if (bundle['image/svg+xml']) display(SVG(bundle['image/svg+xml']));
  else if (bundle['image/png'] || bundle['image/jpeg']) {
    const mime = bundle['image/png'] ? 'png' : 'jpeg';
    const b64 = bundle['image/' + (mime === 'png' ? 'png' : 'jpeg')];
    display({ _repr_html_() { return `<img src="data:image/${mime};base64,${b64}" />`; } });
  } else if (bundle['text/plain']) display(bundle['text/plain']);
}

// ── IPython top-level: get_ipython() ──
//
// Libraries call this to detect notebook environment. We return a stub
// shell object that's truthy and exposes the most commonly-checked
// attributes. Real magics aren't supported (stripped at .ipynb import
// time anyway); run_line_magic logs a warning.

const _shell = {
  has_trait() { return false; },
  config: {},
  display_pub: { publish: publish_display_data },
  kernel: { do_one_iteration() {} },
  // Library probes:
  __class__: { __name__: 'ZMQInteractiveShell' },
  run_line_magic(name, _arg) {
    if (typeof console !== 'undefined') console.warn(`IPython magic ignored: %${name}`);
  },
  run_cell_magic(name, _arg, _body) {
    if (typeof console !== 'undefined') console.warn(`IPython cell magic ignored: %%${name}`);
  },
  showtraceback() {},
  register_magic_function() {},
};

function get_ipython() { return _shell; }

// ── Module assembly ──

const displayNamespace = {
  display, display_html, display_markdown, display_svg, display_latex,
  display_json, display_pretty, publish_display_data,
  clear_output,
  HTML, Markdown, SVG, Image, Latex, Math, Pretty, Code, IFrame,
  JSON: JSONDisplay,
};

const coreDisplayNamespace = { ...displayNamespace };

const _module = {
  display: displayNamespace,
  core: {
    display: coreDisplayNamespace,
    display_functions: { display, clear_output, publish_display_data },
  },
  get_ipython,
  // Top-level conveniences (some libraries import these directly).
  HTML, Markdown, SVG, Image, Latex, Math, JSON: JSONDisplay,
};

// ── Registration ──

_registerCellHook();

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/ipython-adapter',
      version: '0.1.0',
      description: 'IPython.display shim for adder cells',
      exports: { IPython: _module },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['IPython'] = _module;
  }
}

export { _module as ipythonAdapter };
