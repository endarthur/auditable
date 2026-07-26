"""gcu-condenser — block models and big point clouds in a Jupyter notebook.

The renderer is @gcu/condenser, the same streaming engine behind micro
(gentropic.org/micro): quantize -> Morton order -> shuffled-prefix LOD ->
eye-dome lighting, with block models drawn as REAL boxes (instanced ray-traced
impostors, per-face lighting, correct occlusion) rather than glyphed cubes.
That is the point of this widget: a few million blocks or points render
progressively, straight from numpy columns, with no decimation pass and no
mesh conversion.

    import numpy as np, gcu_condenser as cd
    cd.blocks(x, y, z, value=fe, color="value")     # a block model
    cd.points(x, y, z, value=grade)                 # a cloud
    cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")   # or a DataFrame

Click an element and `w.selected` is its ROW INDEX in the arrays you passed --
the record index is the join key, so a pick round-trips back into pandas.

Posture: no network, no WASM, no kernel round trip while you navigate. The
ES module is bundled into this package; nothing is fetched at runtime.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import anywidget
import numpy as np
import traitlets

__version__ = "0.1.0"
__all__ = ["Condenser", "points", "blocks"]

_STATIC = pathlib.Path(__file__).parent / "static" / "widget.js"

# wire dtype tags -- mirrored by src/widget.js's TYPES table
_TAG = {
    np.dtype(np.float64): "f64",
    np.dtype(np.float32): "f32",
    np.dtype(np.uint32): "u32",
    np.dtype(np.uint16): "u16",
    np.dtype(np.uint8): "u8",
}


def _pack(kind: str, count: int, frame, cols: dict, extra: dict) -> bytes:
    """Columns -> one atomic blob:  'CDNS' | u32 ver | u32 headerLen | header | body.

    Buffer offsets in the header are RELATIVE TO THE BODY START, which both
    sides compute the same way (12 + headerLen, rounded up to 8) -- that keeps
    the header self-describing without the offsets depending on its own length.
    One blob (not a trait per column) makes a data change atomic: the header
    can never describe buffers that have not landed yet.
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

    header = {"kind": kind, "count": int(count), "frame": [float(v) for v in frame], "cols": layout}
    header.update(extra)
    hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
    out = bytearray(b"CDNS")
    out.extend(np.uint32(1).tobytes())
    out.extend(np.uint32(len(hb)).tobytes())
    out.extend(hb)
    out.extend(b"\0" * (-len(out) % 8))  # body start == (12 + headerLen) rounded to 8
    out.extend(body)
    return bytes(out)


def _col(src, spec, name, n=None):
    """Resolve a column: an array, or a column NAME when `src` is a DataFrame."""
    if spec is None:
        return None
    if isinstance(spec, str):
        if src is None:
            raise TypeError(f"gcu-condenser: {name}={spec!r} is a column name, but no DataFrame was given")
        try:
            return np.asarray(src[spec])
        except Exception as e:  # pandas/polars both raise here, with their own words
            raise KeyError(f"gcu-condenser: no column {spec!r} in the frame ({e})") from e
    a = np.asarray(spec)
    if n is not None and a.size != n:
        raise ValueError(f"gcu-condenser: {name} has {a.size} values, expected {n}")
    return a


def _codes(values):
    """Any categorical column -> (u8 codes, labels). >256 distinct -> the tail
    is folded into the last code; a viewer must not fail on a messy column."""
    vals = np.asarray(values)
    labels, codes = np.unique(vals, return_inverse=True)
    if labels.size > 256:
        codes = np.minimum(codes, 255)
        labels = np.concatenate([labels[:255], np.array(["(other)"], dtype=labels.dtype)])
    return codes.astype(np.uint8), [str(v) for v in labels]


def _infer_axis(v, name):
    """Recover a regular lattice (origin, pitch, count) from resident centroids.

    numpy has the whole column in hand, so exact unique-and-diff beats the
    engine's streaming inferAxis (which must sweep without holding anything).
    Different situation, not a duplicated algorithm.
    """
    u = np.unique(v[np.isfinite(v)])
    if u.size == 0:
        raise ValueError(f"gcu-condenser: axis {name} has no finite values")
    if u.size == 1:
        return float(u[0]), 1.0, 1
    d = np.diff(u)
    pitch = float(np.min(d))
    if pitch <= 0:
        raise ValueError(f"gcu-condenser: axis {name} has a zero pitch")
    span = float(u[-1] - u[0])
    count = int(round(span / pitch)) + 1
    # every centroid must sit on the lattice, or this is not a regular model
    off = (u - u[0]) / pitch
    if np.max(np.abs(off - np.round(off))) > 1e-3:
        raise ValueError(
            f"gcu-condenser: {name} is not on a regular lattice (irregular or sub-blocked). "
            "Use gcu_condenser.points(...) to view the centroids instead."
        )
    return float(u[0]), pitch, count


class Condenser(anywidget.AnyWidget):
    """The viewer. Build it with :func:`points` or :func:`blocks`."""

    _esm = _STATIC

    _payload = traitlets.Bytes(b"").tag(sync=True)
    _fit = traitlets.Int(0).tag(sync=True)

    #: 'z' (elevation) | 'value' | 'category' | 'rgb' | 'flat'
    color = traitlets.Unicode("z").tag(sync=True)
    #: viridis | magma | turbo | greys | spectral | fire
    ramp = traitlets.Unicode("viridis").tag(sync=True)
    #: [lo, hi] to clamp the colour scale, or [] for the data range
    clip = traitlets.List(traitlets.Float(), default_value=[]).tag(sync=True)
    #: [lo, hi] cutoff on the value column -- how you see an ore body inside a
    #: solid model. [] shows everything.
    threshold = traitlets.List(traitlets.Float(), default_value=[]).tag(sync=True)
    #: 'isolate' hides everything outside the threshold; 'dim' keeps it as context
    filter_mode = traitlets.Unicode("isolate").tag(sync=True)
    point_size = traitlets.Float(2.5).tag(sync=True)
    #: screen-door see-through (1 = solid). With filter_mode="dim" this is how
    #: you see a grade shell through its own waste.
    opacity = traitlets.Float(1.0).tag(sync=True)
    #: draw a block model as points (fast overview of a huge model)
    as_points = traitlets.Bool(False).tag(sync=True)
    block_edges = traitlets.Bool(False).tag(sync=True)
    edl = traitlets.Bool(True).tag(sync=True)
    edl_strength = traitlets.Float(1.0).tag(sync=True)
    background = traitlets.Unicode("#121212").tag(sync=True)
    height = traitlets.Int(420).tag(sync=True)
    #: elements drawn per frame before the progressive pass continues
    budget = traitlets.Int(3_000_000).tag(sync=True)
    #: row index of the last clicked element, or -1 (read-only in practice)
    selected = traitlets.Int(-1).tag(sync=True)

    #: category labels, in code order (set when color='category')
    categories: list

    def fit(self):
        """Re-frame the camera on the data."""
        self._fit += 1
        return self

    @property
    def selected_row(self):
        """The selected record index, or None."""
        return None if self.selected < 0 else int(self.selected)


def _build(kind, src, x, y, z, value, category, rgb, kwargs):
    x = _col(src, x, "x")
    if x is None:
        raise TypeError("gcu-condenser: x is required")
    n = int(np.asarray(x).size)
    y = _col(src, y, "y", n)
    z = _col(src, z, "z", n)
    if y is None or z is None:
        raise TypeError("gcu-condenser: x, y and z are all required")

    xf = np.ascontiguousarray(x, dtype=np.float64)
    yf = np.ascontiguousarray(y, dtype=np.float64)
    zf = np.ascontiguousarray(z, dtype=np.float64)

    cols: dict[str, np.ndarray] = {"x": xf, "y": yf, "z": zf}
    extra: dict[str, Any] = {}
    labels: list[str] = []

    val = _col(src, value, "value", n)
    vf = None
    if val is not None:
        vf = np.ascontiguousarray(val, dtype=np.float64)
        finite = vf[np.isfinite(vf)]
        lo = float(finite.min()) if finite.size else 0.0
        hi = float(finite.max()) if finite.size else 1.0
        extra["value_range"] = [lo, hi]
        if kind == "blocks":
            cols["value"] = vf  # blocks quantize per chunk and keep the true range
        else:
            # the points pipeline colours by its u16 intensity channel: map the
            # value onto it so hi lands on 65535 and the ramp spans the data
            span = hi - lo if hi > lo else 1.0
            q = np.clip((vf - lo) / span, 0.0, 1.0)
            q[~np.isfinite(vf)] = 0.0
            cols["value_u16"] = (q * 65535.0 + 0.5).astype(np.uint16)
            cols["value"] = vf  # kept so `color='value'` can tell it exists

    cat = _col(src, category, "category", n)
    if cat is not None:
        codes, labels = _codes(cat)
        cols["cat"] = codes
        extra["cat_n"] = len(labels)
        extra["cat_labels"] = labels

    col_rgb = _col(src, rgb, "rgb", None)
    if col_rgb is not None:
        a = np.asarray(col_rgb)
        if a.ndim != 2 or a.shape[1] != 3 or a.shape[0] != n:
            raise ValueError("gcu-condenser: rgb must be an (n, 3) array of 0-255 bytes")
        cols["rgb"] = np.ascontiguousarray(a, dtype=np.uint8).reshape(-1)

    # the FRAME (@gcu/frame): a local origin so mine-grid coordinates never hit
    # the float32 wall on the GPU. Its centre, so local values stay small.
    frame = (
        float((np.nanmin(xf) + np.nanmax(xf)) / 2),
        float((np.nanmin(yf) + np.nanmax(yf)) / 2),
        float((np.nanmin(zf) + np.nanmax(zf)) / 2),
    )

    if kind == "blocks":
        extra["axes"] = [
            list(_infer_axis(xf, "x")),
            list(_infer_axis(yf, "y")),
            list(_infer_axis(zf, "z")),
        ]

    w = Condenser(**kwargs)
    w.categories = labels
    if "color" not in kwargs:
        w.color = "value" if vf is not None else ("category" if cat is not None else "z")
    w._payload = _pack(kind, n, frame, cols, extra)
    return w


def _resolve(src, x, y, z):
    """The first positional is either a DataFrame or the x column itself.

    ``f(xa, ya, za)`` lands as ``src=xa, x=ya, y=za`` -- shift it back. Anything
    that is not an array-ish is treated as the frame and the names stand.
    """
    if src is not None and isinstance(src, (np.ndarray, list, tuple)):
        return None, src, x, y
    if src is not None and not hasattr(src, "__getitem__"):
        raise TypeError(
            "gcu-condenser: the first argument should be a DataFrame or the x array "
            "(or pass x=, y=, z= explicitly)"
        )
    return src, x, y, z


def points(src=None, x="x", y="y", z="z", value=None, category=None, rgb=None, **kwargs) -> Condenser:
    """A point cloud.

    Pass arrays directly, or a DataFrame plus column NAMES::

        cd.points(x, y, z, value=grade)
        cd.points(df, x="X", y="Y", z="Z", category="ROCK")
    """
    src, x, y, z = _resolve(src, x, y, z)
    return _build("points", src, x, y, z, value, category, rgb, kwargs)


def blocks(src=None, x="x", y="y", z="z", value=None, category=None, **kwargs) -> Condenser:
    """A block model -- drawn as real boxes on the inferred lattice.

    The block size comes from the centroid spacing; an irregular (or
    sub-blocked) model raises, pointing you at :func:`points`.
    """
    src, x, y, z = _resolve(src, x, y, z)
    return _build("blocks", src, x, y, z, value, category, None, kwargs)
