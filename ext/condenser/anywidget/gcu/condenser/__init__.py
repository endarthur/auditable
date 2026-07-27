"""gcu-condenser — block models, drillholes and big point clouds in a notebook.

The renderer is @gcu/condenser, the same streaming engine behind micro
(gentropic.org/micro): quantize -> Morton order -> shuffled-prefix LOD ->
eye-dome lighting. Block models draw as REAL boxes (instanced ray-traced
impostors with per-face lighting and correct occlusion), drillholes as
desurveyed capsules, clouds as EDL-lit splats -- all co-registered in one
local frame, all progressive, straight from numpy columns.

    import gcu.condenser as cd

    cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")        # on its own
    cd.view(                                                  # …or stacked
        cd.blocks(df, value="FE", name="model"),
        cd.drillholes(collar, survey, assay, value="AU"),
        cd.points(topo_x, topo_y, topo_z, name="topo", sectioned=False),
        section={"axis": "y", "position": 8200500, "thickness": 25},
    )

Click anything: `w.selection` is `{'layer', 'name', 'row'}` and the row is the
index in the table you passed, so a pick round-trips into pandas.

Posture: no network, no WASM, no kernel round trip while you navigate. The ES
module is bundled into this package; nothing is fetched at runtime.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import anywidget
import numpy as np
import traitlets

__version__ = "0.2.0"
__all__ = ["Viewer", "Layer", "view", "points", "blocks", "drillholes", "export_html"]

_STATIC = pathlib.Path(__file__).parent / "static" / "widget.js"
_U16MAX = 65535

# wire dtype tags -- mirrored by src/widget.js's TYPES table
_TAG = {
    np.dtype(np.float64): "f64",
    np.dtype(np.float32): "f32",
    np.dtype(np.uint32): "u32",
    np.dtype(np.uint16): "u16",
    np.dtype(np.uint8): "u8",
}


# ── the wire ────────────────────────────────────────────────────────────────
def _pack(header: dict, cols: dict) -> bytes:
    """Columns -> one atomic blob:  'CDNS' | u32 ver | u32 headerLen | header | body.

    Offsets are RELATIVE TO THE BODY START, which both sides derive the same way
    ((12 + headerLen) rounded up to 8) -- that keeps the header self-describing
    without its offsets depending on its own length. One blob (not a trait per
    column) makes a data change atomic: the header can never describe buffers
    that have not landed yet.
    """
    body = bytearray()
    layout = {}
    for name, arr in cols.items():
        tag = _TAG.get(arr.dtype)
        if tag is None:
            raise TypeError(f"gcu-condenser: column {name!r} has unsupported dtype {arr.dtype}")
        body.extend(b"\0" * (-len(body) % 8))  # 8-align every column (f64 needs it)
        layout[name] = {"off": len(body), "len": int(arr.size), "type": tag}
        body.extend(np.ascontiguousarray(arr).tobytes())

    head = dict(header)
    head["cols"] = layout
    hb = json.dumps(head, separators=(",", ":")).encode("utf-8")
    out = bytearray(b"CDNS")
    out.extend(np.uint32(2).tobytes())
    out.extend(np.uint32(len(hb)).tobytes())
    out.extend(hb)
    out.extend(b"\0" * (-len(out) % 8))  # body start == (12 + headerLen) rounded to 8
    out.extend(body)
    return bytes(out)


# ── column plumbing ─────────────────────────────────────────────────────────
def _col(src, spec, name, n=None):
    """Resolve a column: an array, or a column NAME when `src` is a table."""
    if spec is None:
        return None
    if isinstance(spec, str):
        if src is None:
            raise TypeError(f"gcu-condenser: {name}={spec!r} is a column name, but no table was given")
        try:
            return np.asarray(src[spec])
        except Exception as e:  # pandas/polars/dict all land here with their own words
            raise KeyError(f"gcu-condenser: no column {spec!r} in the table ({e})") from e
    a = np.asarray(spec)
    if n is not None and a.size != n:
        raise ValueError(f"gcu-condenser: {name} has {a.size} values, expected {n}")
    return a


def _f64(a):
    return np.ascontiguousarray(a, dtype=np.float64)


def _codes(values):
    """Any categorical column -> (u8 codes, labels). >256 distinct folds the tail
    into a last '(other)' code; a viewer must not fail on a messy column."""
    vals = np.asarray(values)
    labels, codes = np.unique(vals, return_inverse=True)
    if labels.size > 256:
        codes = np.minimum(codes, 255)
        labels = np.concatenate([labels[:255].astype(object), np.array(["(other)"], dtype=object)])
    return codes.astype(np.uint8), [str(v) for v in labels]


def _ids(*cols):
    """Shared BHID factorization across collar/survey/interval tables. The codes
    ride the wire as u32 (strings do not); the engine only needs them to JOIN,
    and equal codes join exactly like equal names."""
    allv = np.concatenate([np.asarray(c).astype(str) for c in cols])
    labels, codes = np.unique(allv, return_inverse=True)
    out, at = [], 0
    for c in cols:
        k = np.asarray(c).size
        out.append(codes[at:at + k].astype(np.uint32))
        at += k
    return out, [str(v) for v in labels]


# ── lattices ────────────────────────────────────────────────────────────────
def _axis_from_centroids(v, name):
    """Regular lattice (origin, pitch, count) from resident centroids.

    numpy holds the whole column, so exact unique-and-diff beats the engine's
    streaming inferAxis (built to sweep while holding nothing) -- a different
    situation, not a duplicated algorithm.
    """
    u = np.unique(v[np.isfinite(v)])
    if u.size == 0:
        raise ValueError(f"gcu-condenser: axis {name} has no finite values")
    if u.size == 1:
        return float(u[0]), 1.0, 1
    pitch = float(np.min(np.diff(u)))
    if pitch <= 0:
        raise ValueError(f"gcu-condenser: axis {name} has a zero pitch")
    count = int(round(float(u[-1] - u[0]) / pitch)) + 1
    off = (u - u[0]) / pitch
    if np.max(np.abs(off - np.round(off))) > 1e-3:
        raise ValueError(
            f"gcu-condenser: {name} centroids are not on a regular lattice. "
            "Pass size=(dx, dy, dz) if this is a sub-blocked model, or use "
            "gcu.condenser.points(...) to view the centroids."
        )
    if count > _U16MAX:
        raise ValueError(f"gcu-condenser: axis {name} needs {count} cells (max {_U16MAX})")
    return float(u[0]), pitch, count


def _axis_subblocked(v, size, name):
    """Lattice for a SUB-BLOCKED axis: the pitch is the finest block, and every
    centroid -- parent and child -- must land on that fine lattice.

    Real models often sit half a fine cell off (an even subdivision puts a parent
    centroid on a fine-cell BOUNDARY), so a half-pitch lattice is tried before
    giving up. That is the same constraint micro carries; when it cannot be met
    the honest answer is points, not a silently wrong grid.
    """
    finite = np.isfinite(v)
    lo = float(np.min(v[finite]))
    hi = float(np.max(v[finite]))
    fine = float(np.min(size[finite])) if size is not None else None
    if not fine or fine <= 0:
        raise ValueError(f"gcu-condenser: axis {name} has a non-positive block size")
    for pitch in (fine, fine / 2):
        off = (v[finite] - lo) / pitch
        if np.max(np.abs(off - np.round(off))) < 1e-3:
            count = int(round((hi - lo) / pitch)) + 1
            if count > _U16MAX:
                raise ValueError(
                    f"gcu-condenser: sub-blocked axis {name} needs {count} fine cells "
                    f"(max {_U16MAX}). Use points(...) for this model."
                )
            return lo, pitch, count
    raise ValueError(
        f"gcu-condenser: sub-blocked axis {name} is not on a common fine lattice "
        "(the sub-division is not a whole multiple). Use gcu.condenser.points(...)."
    )


# ── the layer ───────────────────────────────────────────────────────────────
class Layer(traitlets.HasTraits):
    """One dataset in a :class:`Viewer` — its data plus its own style.

    Build one with :func:`blocks`, :func:`points` or :func:`drillholes`. Every
    style trait below is live: set it and the view updates with no re-send.
    """

    name = traitlets.Unicode("").tag(style=True)
    visible = traitlets.Bool(True).tag(style=True)
    #: 'z' (elevation) | 'value' | 'category' | 'rgb' | 'flat'
    color = traitlets.Unicode("z").tag(style=True)
    #: viridis | magma | turbo | greys | spectral | fire
    ramp = traitlets.Unicode("viridis").tag(style=True)
    #: [lo, hi] clamp for the colour scale, [] = the data range
    clip = traitlets.List(traitlets.Float(), default_value=[]).tag(style=True)
    #: [lo, hi] cutoff on the value column — how you see inside a solid model
    threshold = traitlets.List(traitlets.Float(), default_value=[]).tag(style=True)
    #: 'isolate' hides what is outside the threshold, 'dim' greys it
    filter_mode = traitlets.Unicode("isolate").tag(style=True)
    #: screen-door see-through, 1.0 = solid
    opacity = traitlets.Float(1.0).tag(style=True)
    point_size = traitlets.Float(2.5).tag(style=True)
    #: draw a block model as points (a fast overview of a huge model)
    as_points = traitlets.Bool(False).tag(style=True)
    block_edges = traitlets.Bool(False).tag(style=True)
    #: drillhole capsule radius, in world units
    radius = traitlets.Float(1.5).tag(style=True)
    #: True | False (exempt — keep it whole while others are cut) | 'front' | 'behind'
    sectioned = traitlets.Any(True).tag(style=True)
    #: the row index of the last pick on THIS layer, or -1
    selected = traitlets.Int(-1)

    @property
    def selected_rows(self):
        """Rows selected on this layer by the rectangle/lasso tools, as a
        numpy array of indices into the table you passed (empty if none)."""
        return getattr(self, "_sel", np.zeros(0, dtype=np.uint32))

    def __init__(self, kind, cols, extra, categories=None, **kw):
        self._sel = np.zeros(0, dtype=np.uint32)
        self._kind = kind
        self._cols = cols                      # name -> np.ndarray (world coords, unframed)
        self._extra = extra                    # per-layer header bits
        self.categories = categories or []
        self._viewer = None
        self._auto = None
        super().__init__(**kw)
        self.observe(self._on_style, names=[n for n, t in self.traits().items() if t.metadata.get("style")])

    # style changes push into the viewer's styles list (no data crosses)
    def _on_style(self, _change=None):
        v = self._viewer
        if v is not None:
            v._push_styles()

    def _style(self):
        return {n: getattr(self, n) for n, t in self.traits().items() if t.metadata.get("style")}

    @property
    def count(self):
        return int(self._extra.get("count", 0))

    def __repr__(self):
        return f"<Layer {self._kind} {self.name or ''} n={self.count}>"

    # a bare layer in a cell displays as a one-layer viewer
    def _viewer_for_display(self):
        if self._auto is None:
            self._auto = view(self)
        return self._auto

    def _repr_mimebundle_(self, **kw):
        return self._viewer_for_display()._repr_mimebundle_(**kw)


# ── the widget ──────────────────────────────────────────────────────────────
class Viewer(anywidget.AnyWidget):
    """The 3D view. Build it with :func:`view` (or display a Layer directly)."""

    _esm = _STATIC

    _payload = traitlets.Bytes(b"").tag(sync=True)
    _styles = traitlets.List(traitlets.Dict(), default_value=[]).tag(sync=True)
    _fit = traitlets.Int(0).tag(sync=True)
    _view = traitlets.Dict(default_value={}).tag(sync=True)
    _sel_rows = traitlets.Bytes(b"").tag(sync=True)
    #: False = select the visible surface (what the ID buffer sees); True =
    #: select THROUGH, catching everything in the swept volume behind it too
    select_through = traitlets.Bool(False).tag(sync=True)
    _clear_sel = traitlets.Int(0).tag(sync=True)
    #: the last measurement: {'from', 'to', 'distance', 'dx','dy','dz',
    #: 'bearing', 'plunge'} — {} until you measure something
    measurement = traitlets.Dict(default_value={}).tag(sync=True)

    #: {'axis': 'x'|'y'|'z', 'position': v, 'thickness': t} or
    #: {'normal': [x,y,z], 'position': v, 'thickness': t}; {} or None = off
    section = traitlets.Dict(allow_none=True, default_value=None).tag(sync=True)
    background = traitlets.Unicode("#121212").tag(sync=True)
    height = traitlets.Int(460).tag(sync=True)
    #: the in-view toolbar (pick · knife · layers · views · snapshot). Turn it
    #: off for a clean figure.
    toolbar = traitlets.Bool(True).tag(sync=True)
    edl = traitlets.Bool(True).tag(sync=True)
    edl_strength = traitlets.Float(1.0).tag(sync=True)
    #: elements drawn per frame before the progressive pass continues
    budget = traitlets.Int(3_000_000).tag(sync=True)
    #: the last pick: {'layer': i, 'name': str, 'row': int} — {} for none
    selection = traitlets.Dict(default_value={}).tag(sync=True)

    def __init__(self, layers, **kw):
        self.layers = list(layers)
        self._syncing = False
        super().__init__(**kw)
        for i, ly in enumerate(self.layers):
            ly._viewer = self
            if not ly.name:
                ly.name = f"{ly._kind}-{i + 1}"
        self._repack()
        self._push_styles()
        self.observe(self._on_selection, names="selection")
        self.observe(self._on_styles, names="_styles")
        self.observe(self._on_sel_rows, names="_sel_rows")

    # ── data ──
    def _repack(self):
        """Pack every layer into ONE blob against ONE shared frame.

        The frame is the union-bbox centre: layers MUST share it or they render
        offset from each other, and a local origin is also what keeps mine-grid
        coordinates off the float32 wall on the GPU (@gcu/frame).
        """
        mins = np.array([np.inf, np.inf, np.inf])
        maxs = np.array([-np.inf, -np.inf, -np.inf])
        for ly in self.layers:
            b = ly._extra.get("bbox")
            if b:
                mins = np.minimum(mins, np.array(b[:3]))
                maxs = np.maximum(maxs, np.array(b[3:]))
        if not np.all(np.isfinite(mins)):
            mins = np.zeros(3)
            maxs = np.ones(3)
        frame = ((mins + maxs) / 2).tolist()

        cols, heads = {}, []
        for i, ly in enumerate(self.layers):
            head = dict(ly._extra)
            head["kind"] = ly._kind
            head["cols"] = {}
            for cname, arr in ly._cols.items():
                key = f"L{i}_{cname}"
                cols[key] = arr
                head["cols"][cname] = key
            heads.append(head)
        self._payload = _pack({"frame": frame, "layers": heads}, cols)

    def _push_styles(self):
        if self._syncing:
            return
        self._styles = [ly._style() for ly in self.layers]

    def _on_styles(self, change):
        """The toolbar edits styles in the browser — mirror them onto the Layer
        objects so `w["topo"].visible` agrees with what you just clicked."""
        self._syncing = True
        try:
            for ly, st in zip(self.layers, change["new"] or []):
                for k, v in st.items():
                    if ly.has_trait(k) and getattr(ly, k) != v:
                        setattr(ly, k, v)
        finally:
            self._syncing = False

    def _on_sel_rows(self, change):
        """Decode the packed region selection onto the Layers.

        Wire layout (little-endian, mirrored by src/widget.js's packSelection):
            u32 nLayers, then per layer: u32 layerIndex, u32 count, u32[count] rows
        Bytes, not JSON -- a marquee over a big model can select a million rows.
        """
        raw = change["new"] or b""
        for ly in self.layers:
            ly._sel = np.zeros(0, dtype=np.uint32)
        if len(raw) < 4:
            return
        head = np.frombuffer(raw, dtype=np.uint32)
        n, at = int(head[0]), 1
        for _ in range(n):
            if at + 1 >= head.size:
                break
            li, count = int(head[at]), int(head[at + 1])
            at += 2
            rows = head[at:at + count]
            at += count
            if 0 <= li < len(self.layers):
                self.layers[li]._sel = np.array(rows, dtype=np.uint32)

    @property
    def selected_rows(self):
        """{layer name: row indices} for every layer with a region selection."""
        return {ly.name: ly.selected_rows for ly in self.layers if ly.selected_rows.size}

    def clear_selection(self):
        """Drop the rectangle/lasso selection everywhere."""
        self._clear_sel += 1

    def copy(self):
        """An INDEPENDENT viewer over the same data.

        Views of one Viewer share its state -- that is what makes `w.cut(...)`
        update a cell further up, and it also means two displays of `w` can
        never differ. When you want two panels side by side (cut vs uncut, plan
        vs section), take a copy: the payload bytes are reused, so this costs a
        widget, not a re-pack.
        """
        clone = Viewer.__new__(Viewer)
        layers = []
        for ly in self.layers:
            l2 = Layer(ly._kind, ly._cols, ly._extra, ly.categories, **ly._style())
            layers.append(l2)
        Viewer.__init__(clone, layers,
                        section=self.section, background=self.background, height=self.height,
                        toolbar=self.toolbar, edl=self.edl, edl_strength=self.edl_strength,
                        budget=self.budget, select_through=self.select_through)
        clone._payload = self._payload                     # same bytes, no re-pack
        clone._view = dict(self._view)
        return clone

    def _on_selection(self, change):
        sel = change["new"] or {}
        idx = sel.get("layer", -1)
        for i, ly in enumerate(self.layers):
            ly.selected = int(sel.get("row", -1)) if i == idx else -1

    # ── convenience ──
    # NB: the mutators below return None ON PURPOSE. A notebook displays a
    # cell's value, so `return self` would build a SECOND live view of the same
    # widget for every `w.cut(...)` — a second WebGL context, and two views
    # sharing one state that then appear to contradict each other. Chaining is
    # not worth that; `cd.view(..., section=...)` covers the one-liner.
    def add(self, layer):
        """Add a layer and re-pack (the shared frame is recomputed)."""
        layer._viewer = self
        if not layer.name:
            layer.name = f"{layer._kind}-{len(self.layers) + 1}"
        self.layers.append(layer)
        self._repack()
        self._push_styles()

    def remove(self, key):
        self.layers.pop(self._index(key))
        self._repack()
        self._push_styles()

    def _index(self, key):
        if isinstance(key, int):
            return key
        for i, ly in enumerate(self.layers):
            if ly.name == key:
                return i
        raise KeyError(f"gcu-condenser: no layer named {key!r}")

    def __getitem__(self, key):
        return self.layers[self._index(key)]

    def __len__(self):
        return len(self.layers)

    def fit(self):
        """Re-frame the camera on the data."""
        self._fit += 1

    def look(self, view="iso", ortho=None):
        """Point the camera: 'plan' | 'north' | 'south' | 'east' | 'west' | 'iso'.

        A section is only readable when you look ALONG it, so this is the usual
        companion to :meth:`cut` -- and `ortho=True` (parallel projection) is
        what makes a section measurable rather than merely suggestive.
        """
        v = {"name": view, "n": int(self._view.get("n", 0)) + 1}
        if ortho is not None:
            v["ortho"] = bool(ortho)
        self._view = v

    def cut(self, axis=None, position=None, thickness=10.0, normal=None):
        """Set the section plane. ``cut()`` with no arguments clears it."""
        if axis is None and normal is None:
            self.section = None
        else:
            s = {"position": float(position or 0), "thickness": float(thickness)}
            if normal is not None:
                s["normal"] = [float(v) for v in normal]
            else:
                s["axis"] = axis
            self.section = s

    @property
    def selected_row(self):
        """The picked row index, or None."""
        r = (self.selection or {}).get("row", -1)
        return None if r is None or r < 0 else int(r)

    def __repr__(self):
        return f"<Viewer {len(self.layers)} layer(s): {', '.join(l.name for l in self.layers)}>"


def view(*layers, **kwargs) -> Viewer:
    """Stack layers into one view (they share a frame, so they co-register)."""
    flat = []
    for l in layers:
        flat.extend(l if isinstance(l, (list, tuple)) else [l])
    return Viewer(flat, **kwargs)


# ── constructors ────────────────────────────────────────────────────────────
def _value_and_cat(src, value, category, n, cols, extra, kind):
    labels = []
    val = _col(src, value, "value", n)
    if val is not None:
        vf = _f64(val)
        finite = vf[np.isfinite(vf)]
        lo = float(finite.min()) if finite.size else 0.0
        hi = float(finite.max()) if finite.size else 1.0
        extra["value_range"] = [lo, hi]
        cols["value"] = vf
        if kind == "points":
            # the points pipeline colours from its u16 intensity channel: map the
            # value onto it so `hi` lands on 65535 and the ramp spans the data
            span = hi - lo if hi > lo else 1.0
            q = np.clip((vf - lo) / span, 0.0, 1.0)
            q[~np.isfinite(vf)] = 0.0
            cols["value_u16"] = (q * 65535.0 + 0.5).astype(np.uint16)
    cat = _col(src, category, "category", n)
    if cat is not None:
        codes, labels = _codes(cat)
        cols["cat"] = codes
        extra["cat_n"] = len(labels)
        extra["cat_labels"] = labels
    return (val is not None), labels


def export_html(viewer, path, title="condenser", offline_note=True):
    """Write a standalone HTML file that still works with **no kernel**.

    Everything this widget does interactively — orbit, pick, knife, section
    scrub, layers, selection, snapshot — runs in the browser, so an exported
    view stays live. Only the write-backs to Python (`selection`,
    `selected_rows`, `measurement`) have nowhere to land.

    ``drop_defaults=False`` is not optional here and is the reason this helper
    exists: ipywidgets drops any trait whose value equals its default, and
    anywidget's ``_esm`` (the widget's own JavaScript) *is* its default — so the
    stock call silently produces a file containing no code and renders nothing.

    The page loads the ipywidgets html-manager from a CDN, so **viewing needs
    network** even though the data is embedded. For a notebook export the same
    applies, and nbconvert lets you point that elsewhere::

        jupyter nbconvert --to html nb.ipynb \
            --HTMLExporter.jupyter_widgets_base_url=./vendor/
    """
    from ipywidgets.embed import embed_minimal_html

    path = pathlib.Path(path)
    embed_minimal_html(str(path), views=[viewer], drop_defaults=False, title=title)
    if offline_note:
        size = path.stat().st_size
        print(f"{path} ({size / 1024 / 1024:.1f} MiB) — self-contained data; "
              "the widget runtime still loads from a CDN, so viewing needs network.")
    return path


def _resolve(src, x, y, z):
    """The first positional is either a table or the x column itself."""
    if src is not None and isinstance(src, (np.ndarray, list, tuple)):
        return None, src, x, y
    if src is not None and not hasattr(src, "__getitem__"):
        raise TypeError(
            "gcu-condenser: the first argument should be a DataFrame or the x array "
            "(or pass x=, y=, z= explicitly)"
        )
    return src, x, y, z


def points(src=None, x="x", y="y", z="z", value=None, category=None, rgb=None, **kw) -> Layer:
    """A point cloud.

        cd.points(x, y, z, value=grade)
        cd.points(df, x="X", y="Y", z="Z", category="ROCK")
    """
    src, x, y, z = _resolve(src, x, y, z)
    xa = _col(src, x, "x")
    if xa is None:
        raise TypeError("gcu-condenser: x, y and z are required")
    n = int(np.asarray(xa).size)
    xf, yf, zf = _f64(xa), _f64(_col(src, y, "y", n)), _f64(_col(src, z, "z", n))
    cols = {"x": xf, "y": yf, "z": zf}
    extra: dict[str, Any] = {"count": n}
    has_val, labels = _value_and_cat(src, value, category, n, cols, extra, "points")

    col_rgb = _col(src, rgb, "rgb", None)
    if col_rgb is not None:
        a = np.asarray(col_rgb)
        if a.ndim != 2 or a.shape[1] != 3 or a.shape[0] != n:
            raise ValueError("gcu-condenser: rgb must be an (n, 3) array of 0-255 bytes")
        cols["rgb"] = np.ascontiguousarray(a, dtype=np.uint8).reshape(-1)

    extra["bbox"] = [float(np.nanmin(xf)), float(np.nanmin(yf)), float(np.nanmin(zf)),
                     float(np.nanmax(xf)), float(np.nanmax(yf)), float(np.nanmax(zf))]
    kw.setdefault("color", "value" if has_val else ("category" if "cat" in cols else "z"))
    return Layer("points", cols, extra, labels, **kw)


def blocks(src=None, x="x", y="y", z="z", value=None, category=None, size=None, **kw) -> Layer:
    """A block model — drawn as real boxes on the inferred lattice.

    Block size comes from the centroid spacing. For a SUB-BLOCKED model pass
    ``size=(dx, dy, dz)`` (column names or arrays); every distinct size becomes
    a palette entry and each block renders at its true dimensions.

        cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")
        cd.blocks(df, value="CU", size=("DIMX", "DIMY", "DIMZ"))
    """
    src, x, y, z = _resolve(src, x, y, z)
    xa = _col(src, x, "x")
    if xa is None:
        raise TypeError("gcu-condenser: x, y and z are required")
    n = int(np.asarray(xa).size)
    xf, yf, zf = _f64(xa), _f64(_col(src, y, "y", n)), _f64(_col(src, z, "z", n))
    cols = {"x": xf, "y": yf, "z": zf}
    extra: dict[str, Any] = {"count": n}
    has_val, labels = _value_and_cat(src, value, category, n, cols, extra, "blocks")

    if size is None:
        axes = [list(_axis_from_centroids(a, nm)) for a, nm in ((xf, "x"), (yf, "y"), (zf, "z"))]
    else:
        if len(size) != 3:
            raise ValueError("gcu-condenser: size must be (dx, dy, dz)")
        # a NUMBER is a constant size; anything else (a column name or an
        # array) goes through _col. np.isscalar is a trap here -- it answers
        # True for a str, which would send a column NAME to float().
        dims = [np.full(n, float(s)) if isinstance(s, (int, float, np.number))
                else _f64(_col(src, s, f"size[{i}]", n))
                for i, s in enumerate(size)]
        axes = [list(_axis_subblocked(a, d, nm)) for a, d, nm in
                ((xf, dims[0], "x"), (yf, dims[1], "y"), (zf, dims[2], "z"))]
        # palette of HALF-dims, keyed by the distinct (dx, dy, dz) triples
        trip = np.stack(dims, axis=1)
        uniq, codes = np.unique(trip, axis=0, return_inverse=True)
        if uniq.shape[0] > 256:
            raise ValueError(
                f"gcu-condenser: {uniq.shape[0]} distinct block sizes (max 256). "
                "Round the size columns, or use gcu.condenser.points(...)."
            )
        cols["dim"] = codes.astype(np.uint8)
        extra["dim_palette"] = (uniq / 2.0).tolist()
        extra["sub_blocked"] = True

    extra["axes"] = axes
    half = [a[1] / 2 for a in axes]
    extra["bbox"] = [float(np.nanmin(xf)) - half[0], float(np.nanmin(yf)) - half[1], float(np.nanmin(zf)) - half[2],
                     float(np.nanmax(xf)) + half[0], float(np.nanmax(yf)) + half[1], float(np.nanmax(zf)) + half[2]]
    kw.setdefault("color", "value" if has_val else ("category" if "cat" in cols else "z"))
    return Layer("blocks", cols, extra, labels, **kw)


def drillholes(collar, survey, intervals, bhid="BHID", x="X", y="Y", z="Z", eoh=None,
               depth="DEPTH", az="AZ", dip="DIP", frm="FROM", to="TO",
               value=None, category=None, method="minimumCurvature",
               dip_convention="auto", **kw) -> Layer:
    """Drillholes from the usual three tables — desurveyed to capsule segments.

    The desurvey runs in the browser through **@gcu/drillhole**, the same
    minimum-curvature code micro uses, so a hole lands in exactly the same place
    in both. `value`/`category` colour the intervals; a pick returns the
    INTERVAL ROW.

        cd.drillholes(collars, surveys, assays, value="AU")
    """
    cb = _col(collar, bhid, "collar bhid")
    sb = _col(survey, bhid, "survey bhid")
    ib = _col(intervals, bhid, "interval bhid")
    if cb is None or sb is None or ib is None:
        raise TypeError("gcu-condenser: collar, survey and interval tables all need a BHID column")
    (cbc, sbc, ibc), hole_names = _ids(cb, sb, ib)

    n = int(np.asarray(ib).size)
    cx = _f64(_col(collar, x, "collar x"))
    cy = _f64(_col(collar, y, "collar y"))
    cz = _f64(_col(collar, z, "collar z"))
    cols = {
        "c_bhid": cbc, "c_x": cx, "c_y": cy, "c_z": cz,
        "s_bhid": sbc,
        "s_depth": _f64(_col(survey, depth, "survey depth")),
        "s_az": _f64(_col(survey, az, "survey az")),
        "s_dip": _f64(_col(survey, dip, "survey dip")),
        "i_bhid": ibc,
        "i_from": _f64(_col(intervals, frm, "interval from")),
        "i_to": _f64(_col(intervals, to, "interval to")),
    }
    if eoh is not None:
        cols["c_eoh"] = _f64(_col(collar, eoh, "collar eoh"))
    extra: dict[str, Any] = {"count": n, "method": method, "dip_convention": dip_convention,
                             "holes": len(hole_names)}
    if len(hole_names) <= 5000:
        extra["hole_names"] = hole_names   # the pick readout names the hole
    has_val, labels = _value_and_cat(intervals, value, category, n, cols, extra, "blocks")

    # a generous bbox from collars + total depth; the exact one comes back from
    # the desurvey in the browser, this only has to seed the shared frame
    reach = float(np.nanmax(cols["i_to"])) if n else 0.0
    extra["bbox"] = [float(np.nanmin(cx)) - reach, float(np.nanmin(cy)) - reach, float(np.nanmin(cz)) - reach,
                     float(np.nanmax(cx)) + reach, float(np.nanmax(cy)) + reach, float(np.nanmax(cz))]
    kw.setdefault("color", "value" if has_val else ("category" if "cat" in cols else "z"))
    lay = Layer("drillholes", cols, extra, labels, **kw)
    lay.hole_names = hole_names
    return lay
