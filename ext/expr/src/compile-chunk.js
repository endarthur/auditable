// @gcu/expr — the COLUMNAR chunk compiler (the substrate resolver's hot path).
// compileChunk(ast, columns) → (cols, n) => { t, buf }: each AST node compiles to a
// vector closure that evaluates the WHOLE chunk in a loop — dispatch amortized
// per-chunk, where the per-row closure tree pays 1–3 calls per node per row.
//
// Value representation by type:
//   num  — Float64Array, NaN ≡ blank (typed source columns pass through ZERO-COPY)
//   bool — Uint8Array TRI-STATE: 0 false · 1 true · 2 blank (cmp/between can yield
//          blank, so `(x > 5) is blank` stays correct; and/or/not emit 0/1 only)
//   raw  — plain Array, null ≡ blank (strings, mixed, function results)
//
// Two layers: a GENERIC spine covering every node via the shared runtime helpers
// (bit-identical semantics — the oracle asserts chunk ≡ row ≡ tree-walk), plus
// FAST f64 loops for the hot filter/calc shapes (field coercion, arithmetic,
// compare-vs-numeric-scalar, and/or/not, blank tests). Deps-free subtrees fold to
// scalars at compile time. Buffers are owned by the closures and reused across
// chunks — a returned buffer is only valid until the next call (pipeline contract).

import { asAst } from './parse.js';
import { deps } from './analyze.js';
import { evaluate } from './eval.js';
import { indexMap } from './compile.js';
import { makeNum, isBlank, eq, compare, contains, inSet, matches, makeRegExp, FN } from './runtime.js';

const isNumArr = (a) => a instanceof Float64Array;
const CMP_INV = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!=' };

// read one value out of a plan's buffer, back in blank≡null row-space
function bget(t, buf, i) {
  const v = buf[i];
  if (t === 'num') return v !== v ? null : v;
  if (t === 'bool') return v === 2 ? null : v === 1;
  return v === undefined ? null : v;
}

export function compileChunk(exprOrAst, columns, opts = {}) {
  const ast = asAst(exprOrAst);
  const N = makeNum(opts.decimal);
  const idx = indexMap(columns);

  const f64 = () => { let b = null; return (n) => (b = b && b.length >= n ? b : new Float64Array(n)); };
  const u8 = () => { let b = null; return (n) => (b = b && b.length >= n ? b : new Uint8Array(n)); };
  const arr = () => { let b = null; return (n) => { if (!b || b.length < n) b = new Array(n); return b; }; };

  // wrap a plan into a guaranteed-Float64Array producer (zero-copy when possible)
  function numVec(p) {
    if (p.s !== undefined) return null;                    // scalars handled by callers
    if (p.t === 'num') return p.run;
    const S = f64(), run = p.run, t = p.t;
    return (ctx) => {
      const src = run(ctx), n = ctx.n;
      if (isNumArr(src)) return src;
      const out = S(n);
      if (ArrayBuffer.isView(src)) { for (let i = 0; i < n; i++) out[i] = src[i]; }
      else if (t === 'bool') { out.fill(NaN, 0, n); }   // N(boolean) is null in the row path — booleans are numerically blank
      else for (let i = 0; i < n; i++) { const v = N(src[i]); out[i] = v === null ? NaN : v; }
      return out;
    };
  }

  function build(node) {
    if (!node || typeof node !== 'object') return { s: null };
    if (node.t !== 'field' && deps(node).length === 0) {   // constant fold (totality makes this safe)
      const v = evaluate(node, {}, opts);
      return { s: v === undefined ? null : v };
    }
    switch (node.t) {
      case 'field': {
        const i = idx.get(String(node.name).toLowerCase());
        if (i === undefined) return { s: null };           // unknown column → blank (validate reports it)
        return { t: 'raw', run: (ctx) => ctx.cols[i] };    // raw passthrough; consumers coerce
      }
      case 'neg': {
        const ep = build(node.e);
        if (ep.s !== undefined) { const v = N(ep.s); return { s: v === null ? null : -v }; }
        const a = numVec(ep); const S = f64();
        return { t: 'num', run: (ctx) => { const x = a(ctx), out = S(ctx.n); for (let i = 0; i < ctx.n; i++) out[i] = -x[i]; return out; } };
      }
      case '+': case '-': case '*': case '/': {
        const lp = build(node.l), rp = build(node.r), op = node.t, S = f64();
        const lk = lp.s !== undefined ? N(lp.s) : null, rk = rp.s !== undefined ? N(rp.s) : null;
        if (lp.s !== undefined && lk === null) return { s: null };      // blank scalar → blank result
        if (rp.s !== undefined && rk === null) return { s: null };
        const a = numVec(lp), b = numVec(rp);
        return { t: 'num', run: (ctx) => {
          const n = ctx.n, out = S(n);
          const A = a ? a(ctx) : null, B = b ? b(ctx) : null;
          if (op === '+') { if (A && B) for (let i = 0; i < n; i++) out[i] = A[i] + B[i]; else if (A) for (let i = 0; i < n; i++) out[i] = A[i] + rk; else for (let i = 0; i < n; i++) out[i] = lk + B[i]; }
          else if (op === '-') { if (A && B) for (let i = 0; i < n; i++) out[i] = A[i] - B[i]; else if (A) for (let i = 0; i < n; i++) out[i] = A[i] - rk; else for (let i = 0; i < n; i++) out[i] = lk - B[i]; }
          else if (op === '*') { if (A && B) for (let i = 0; i < n; i++) out[i] = A[i] * B[i]; else if (A) for (let i = 0; i < n; i++) out[i] = A[i] * rk; else for (let i = 0; i < n; i++) out[i] = lk * B[i]; }
          else { if (A && B) for (let i = 0; i < n; i++) { const d = B[i]; out[i] = d === 0 ? NaN : A[i] / d; } else if (A) { if (rk === 0) out.fill(NaN, 0, n); else for (let i = 0; i < n; i++) out[i] = A[i] / rk; } else for (let i = 0; i < n; i++) { const d = B[i]; out[i] = d === 0 ? NaN : lk / d; } }
          return out;
        } };
      }
      case 'cmp': {
        let lp = build(node.l), rp = build(node.r), op = node.op;
        if (lp.s !== undefined && rp.s === undefined) { const t2 = lp; lp = rp; rp = t2; op = CMP_INV[op]; }   // scalar OP col → col FLIP scalar
        if (lp.s !== undefined) return { s: compare(lp.s, rp.s, op, N) };   // both scalar (e.g. an unknown column) → fold
        const S = u8();
        if (rp.s !== undefined) {
          const k = rp.s, kn = N(k);
          if (kn !== null && lp.t !== 'bool') {            // FAST: numeric threshold — THE filter shape (bools numeric-blank → generic)
            const a = numVec(lp);
            return { t: 'bool', run: (ctx) => {
              const n = ctx.n, out = S(n), A = a(ctx);
              if (op === '=') for (let i = 0; i < n; i++) out[i] = A[i] === kn ? 1 : 0;
              else if (op === '!=') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 1 : (v !== kn ? 1 : 0); }
              else if (op === '>') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v > kn ? 1 : 0); }
              else if (op === '>=') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v >= kn ? 1 : 0); }
              else if (op === '<') for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v < kn ? 1 : 0); }
              else for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v <= kn ? 1 : 0); }
              return out;
            } };
          }
          const run = lp.run, tt = lp.t;                   // string/blank scalar — eq/compare loops
          if ((op === '=' || op === '!=') && typeof k === 'string' && !isBlank(k) && tt === 'raw') {
            // FAST: category equality (LITO = "OX"). k is non-numeric here (kn === null),
            // so eq() always lands on the String branch: blank → false, else String(v) === k.
            const yes = op === '=' ? 1 : 0, no = op === '=' ? 0 : 1;
            return { t: 'bool', run: (ctx) => {
              const n = ctx.n, out = S(n), src = run(ctx);
              for (let i = 0; i < n; i++) {
                const v = src[i];
                out[i] = v === k ? yes : (v == null || v === '' || v !== v || (Array.isArray(v) && v.length === 0) ? no : (String(v) === k ? yes : no));
              }
              return out;
            } };
          }
          return { t: 'bool', run: (ctx) => {
            const n = ctx.n, out = S(n), src = run(ctx);
            if (op === '=') for (let i = 0; i < n; i++) out[i] = eq(bget(tt, src, i), k, N) ? 1 : 0;
            else if (op === '!=') for (let i = 0; i < n; i++) out[i] = eq(bget(tt, src, i), k, N) ? 0 : 1;
            else for (let i = 0; i < n; i++) { const r = compare(bget(tt, src, i), k, op, N); out[i] = r === null ? 2 : (r ? 1 : 0); }
            return out;
          } };
        }
        const lr = lp.run, lt = lp.t, rr = rp.run, rt = rp.t;   // col-op-col — generic (compare handles = / != internally)
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), A = lr(ctx), B = rr(ctx);
          for (let i = 0; i < n; i++) { const r = compare(bget(lt, A, i), bget(rt, B, i), op, N); out[i] = r === null ? 2 : (r ? 1 : 0); }
          return out;
        } };
      }
      case 'between': {
        const ep = build(node.e), lo = build(node.lo), hi = build(node.hi), S = u8();
        if (ep.s !== undefined && lo.s !== undefined && hi.s !== undefined) {           // all scalar → fold
          const ge = compare(ep.s, lo.s, '>=', N), le = compare(ep.s, hi.s, '<=', N);
          return { s: (ge === null || le === null) ? null : (ge && le) };
        }
        const lk = lo.s !== undefined ? N(lo.s) : null, hk = hi.s !== undefined ? N(hi.s) : null;
        if (ep.s === undefined && ep.t !== 'bool' && lo.s !== undefined && hi.s !== undefined && lk !== null && hk !== null) {   // FAST: literal bounds
          const a = numVec(ep);
          return { t: 'bool', run: (ctx) => { const n = ctx.n, out = S(n), A = a(ctx); for (let i = 0; i < n; i++) { const v = A[i]; out[i] = v !== v ? 2 : (v >= lk && v <= hk ? 1 : 0); } return out; } };
        }
        // generic (rare): mixed scalar/vector bounds
        const gv = (p, i, ctx, bufs) => p.s !== undefined ? p.s : bget(p.t, bufs.get(p), i);
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n);
          const bufs = new Map(); for (const p of [ep, lo, hi]) if (p.run) bufs.set(p, p.run(ctx));
          for (let i = 0; i < n; i++) {
            const ge = compare(gv(ep, i, ctx, bufs), gv(lo, i, ctx, bufs), '>=', N), le = compare(gv(ep, i, ctx, bufs), gv(hi, i, ctx, bufs), '<=', N);
            out[i] = (ge === null || le === null) ? 2 : ((ge && le) ? 1 : 0);
          }
          return out;
        } };
      }
      case 'in': {
        const ep = build(node.e), members = node.set.map(build), S = u8();
        if (ep.s !== undefined && members.every((m) => m.s !== undefined)) return { s: inSet(ep.s, members.map((m) => m.s)) };
        if (ep.s === undefined && members.every((m) => m.s !== undefined)) {     // FAST: literal set → prebuilt Set
          const set = new Set(members.filter((m) => !isBlank(m.s)).map((m) => String(m.s)));
          const run = ep.run, tt = ep.t;
          return { t: 'bool', run: (ctx) => { const n = ctx.n, out = S(n), src = run(ctx); for (let i = 0; i < n; i++) { const v = bget(tt, src, i); out[i] = isBlank(v) ? 0 : (set.has(String(v)) ? 1 : 0); } return out; } };
        }
        const run = ep.run, tt = ep.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), src = run ? run(ctx) : null;
          const bufs = members.map((m) => (m.run ? m.run(ctx) : null));
          for (let i = 0; i < n; i++) { const ms = members.map((m, j) => (m.s !== undefined ? m.s : bget(m.t, bufs[j], i))); out[i] = inSet(ep.s !== undefined ? ep.s : bget(tt, src, i), ms) ? 1 : 0; }
          return out;
        } };
      }
      case 'contains': {
        const lp = build(node.l), rp = build(node.r), S = u8();
        const lr = lp.run, lt = lp.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), A = lr ? lr(ctx) : null, B = rp.run ? rp.run(ctx) : null;
          for (let i = 0; i < n; i++) out[i] = contains(lp.s !== undefined ? lp.s : bget(lt, A, i), rp.s !== undefined ? rp.s : bget(rp.t, B, i)) ? 1 : 0;
          return out;
        } };
      }
      case 'matches': {
        const ep = build(node.e), re = makeRegExp(node.re), S = u8(), run = ep.run, tt = ep.t;
        if (ep.s !== undefined) return { s: matches(ep.s, re) };
        return { t: 'bool', run: (ctx) => { const n = ctx.n, out = S(n), src = run ? run(ctx) : null; for (let i = 0; i < n; i++) out[i] = matches(ep.s !== undefined ? ep.s : bget(tt, src, i), re) ? 1 : 0; return out; } };
      }
      case 'isblank': case 'isfilled': {
        const p = build(node.e), want = node.t === 'isblank', S = u8();
        if (p.s !== undefined) return { s: want === isBlank(p.s) };
        const run = p.run, tt = p.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), src = run(ctx);
          if (tt === 'num') for (let i = 0; i < n; i++) { const b = src[i] !== src[i]; out[i] = (b === want) ? 1 : 0; }
          else if (tt === 'bool') for (let i = 0; i < n; i++) { const b = src[i] === 2; out[i] = (b === want) ? 1 : 0; }
          else { const tv = ArrayBuffer.isView(src); for (let i = 0; i < n; i++) { const v = src[i]; const b = tv ? v !== v : isBlank(v === undefined ? null : v); out[i] = (b === want) ? 1 : 0; } }
          return out;
        } };
      }
      case 'not': {
        const p = build(node.e), S = u8();
        if (p.s !== undefined) return { s: p.s !== true };
        const run = p.run, tt = p.t;
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n), src = run(ctx);
          if (tt === 'bool') for (let i = 0; i < n; i++) out[i] = src[i] === 1 ? 0 : 1;
          else for (let i = 0; i < n; i++) out[i] = bget(tt, src, i) === true ? 0 : 1;
          return out;
        } };
      }
      case 'and': case 'or': {
        const lp = build(node.l), rp = build(node.r), isAnd = node.t === 'and', S = u8();
        const truthy = (p, buf, i) => (p.s !== undefined ? p.s === true : (p.t === 'bool' ? buf[i] === 1 : bget(p.t, buf, i) === true));
        return { t: 'bool', run: (ctx) => {
          const n = ctx.n, out = S(n);
          const A = lp.run ? lp.run(ctx) : null, B = rp.run ? rp.run(ctx) : null;
          if (lp.t === 'bool' && rp.t === 'bool' && A && B) {   // FAST: the common boolean pair
            if (isAnd) for (let i = 0; i < n; i++) out[i] = (A[i] === 1 && B[i] === 1) ? 1 : 0;
            else for (let i = 0; i < n; i++) out[i] = (A[i] === 1 || B[i] === 1) ? 1 : 0;
          } else if (isAnd) for (let i = 0; i < n; i++) out[i] = (truthy(lp, A, i) && truthy(rp, B, i)) ? 1 : 0;
          else for (let i = 0; i < n; i++) out[i] = (truthy(lp, A, i) || truthy(rp, B, i)) ? 1 : 0;
          return out;
        } };
      }
      case 'call': {
        const args = node.args.map(build), S = arr();
        if (node.fn === 'if') {
          const [c, a, b] = args;
          return { t: 'raw', run: (ctx) => {
            const n = ctx.n, out = S(ctx.n);
            const C = c.run ? c.run(ctx) : null, A = a.run ? a.run(ctx) : null, B = b.run ? b.run(ctx) : null;
            for (let i = 0; i < n; i++) {
              const cv = c.s !== undefined ? c.s === true : (c.t === 'bool' ? C[i] === 1 : bget(c.t, C, i) === true);
              out[i] = cv ? (a.s !== undefined ? a.s : bget(a.t, A, i)) : (b.s !== undefined ? b.s : bget(b.t, B, i));
            }
            return out;
          } };
        }
        const fn = FN[node.fn];                            // generic: shared helpers, per-row over vectors
        return { t: 'raw', run: (ctx) => {
          const n = ctx.n, out = S(ctx.n);
          const bufs = args.map((p) => (p.run ? p.run(ctx) : null));
          const av = new Array(args.length);
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < args.length; j++) av[j] = args[j].s !== undefined ? args[j].s : bget(args[j].t, bufs[j], i);
            const r = fn(av, N); out[i] = r === undefined ? null : r;
          }
          return out;
        } };
      }
    }
    return { s: null };
  }

  const plan = build(ast);
  if (plan.s !== undefined) {                              // whole expression is a constant
    const v = plan.s; let buf = null;
    return (cols, n) => { if (!buf || buf.length < n) { buf = new Array(n); } buf.fill(v, 0, n); return { t: 'raw', buf }; };
  }
  return (cols, n) => { const r = plan.run({ cols, n }); return { t: plan.t, buf: r }; };
}

// boolean face: (cols, n) → Uint8Array 0/1 mask (blank → 0), buffer reused.
export function compileChunkBool(exprOrAst, columns, opts = {}) {
  const f = compileChunk(exprOrAst, columns, opts);
  let mask = null;
  return (cols, n) => {
    const { t, buf } = f(cols, n);
    if (t === 'bool' && buf instanceof Uint8Array) {
      if (mask === buf) return mask;                       // (defensive; plans own their buffers)
      mask = mask && mask.length >= n ? mask : new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = buf[i] === 1 ? 1 : 0;
      return mask;
    }
    mask = mask && mask.length >= n ? mask : new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = buf[i] === true ? 1 : 0;
    return mask;
  };
}
