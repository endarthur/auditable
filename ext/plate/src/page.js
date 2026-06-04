// @gcu/plate — the page / frame model.
//
// A plate is a page (a fixed paper canvas) onto which panels are placed as
// frames (absolute {x,y,w,h} rects, in page pixels). This is the compositor
// shape — page → frames → panels — even at v0.1's N=1 frame; growing to a
// multi-panel figure with drag/align/snap is additive (it never reshapes the
// model, only adds editing affordances). Free placement on a fixed canvas is a
// different model from @gcu/rails' docking, so plate carries its own small one.
//
// Sizes are CSS pixels at ~96dpi (screen-first); export to a physical page
// (PDF/A via the GCU print stack) maps these later. Portrait dimensions; a
// landscape page swaps w/h.

export const PAGE_SIZES = {
  A4:     { w: 794,  h: 1123 },
  A5:     { w: 559,  h: 794  },
  Letter: { w: 816,  h: 1056 },
  Legal:  { w: 816,  h: 1344 },
};

// Resolve a page spec → concrete { w, h } in CSS px, honoring orientation.
export function pageDims(size, orientation) {
  const base = (size && typeof size === 'object' && 'w' in size)
    ? size
    : (PAGE_SIZES[size] || PAGE_SIZES.A4);
  return orientation === 'landscape'
    ? { w: base.h, h: base.w }
    : { w: base.w, h: base.h };
}

// The drawable rect inside the page margins.
export function contentRect(dims, margins) {
  const m = margins || {};
  const l = m.left ?? 32, r = m.right ?? 32, t = m.top ?? 32, b = m.bottom ?? 32;
  return { x: l, y: t, w: Math.max(0, dims.w - l - r), h: Math.max(0, dims.h - t - b) };
}

// Resolve a frame placement → an {x,y,w,h} px rect on the page. A frame is
// either the literal string 'full' (fill the content rect), or an explicit
// {x,y,w,h} (px on the page). v0.1 surfaces use 'full'; the figure editor will
// hand explicit rects once multi-panel lands.
export function resolveFrame(frame, content) {
  if (!frame || frame === 'full') return { ...content };
  return {
    x: frame.x ?? content.x,
    y: frame.y ?? content.y,
    w: frame.w ?? content.w,
    h: frame.h ?? content.h,
  };
}
