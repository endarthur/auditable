// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/geas/src/  Build: node ext/geas/build.js
// @gcu/geas — the GCU shell. POSIX-syntax with typed-pipe extensions.

// -- archive/index.js (pre-built bundle, prepended) --

// @gcu/archive — archive format handling for the GCU stack
// Auto-generated from ext/archive/src/ + ext/archive/vendor/ — do not edit directly.
// fflate (MIT) vendored at ext/archive/vendor/fflate.module.mjs.

// -- vendor/fflate.module.mjs (MIT, see ext/archive/vendor/LICENSE-fflate) --

const fflate = (() => {
// DEFLATE is a complex format; to read this code, you should probably check the RFC first:
// https://tools.ietf.org/html/rfc1951
// You may also wish to take a look at the guide I made about this program:
// https://gist.github.com/101arrowz/253f31eb5abc3d9275ab943003ffecad
// Some of the following code is similar to that of UZIP.js:
// https://github.com/photopea/UZIP.js
// However, the vast majority of the codebase has diverged from UZIP.js to increase performance and reduce bundle size.
// Sometimes 0 will appear where -1 would be more appropriate. This is because using a uint
// is better for memory in most engines (I *think*).
var ch2 = {};
var wk = (function (c, id, msg, transfer, cb) {
    var w = new Worker(ch2[id] || (ch2[id] = URL.createObjectURL(new Blob([
        c + ';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'
    ], { type: 'text/javascript' }))));
    w.onmessage = function (e) {
        var d = e.data, ed = d.$e$;
        if (ed) {
            var err = new Error(ed[0]);
            err['code'] = ed[1];
            err.stack = ed[2];
            cb(err, null);
        }
        else
            cb(null, d);
    };
    w.postMessage(msg, transfer);
    return w;
});

// aliases for shorter compressed code (most minifers don't do this)
var u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array;
// fixed length extra bits
var fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, /* unused */ 0, 0, /* impossible */ 0]);
// fixed distance extra bits
var fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, /* unused */ 0, 0]);
// code length index map
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
// get base, reverse index map from extra bits
var freb = function (eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
        b[i] = start += 1 << eb[i - 1];
    }
    // numbers here are at max 18 bits
    var r = new i32(b[30]);
    for (var i = 1; i < 30; ++i) {
        for (var j = b[i]; j < b[i + 1]; ++j) {
            r[j] = ((j - b[i]) << 5) | i;
        }
    }
    return { b: b, r: r };
};
var _a = freb(fleb, 2), fl = _a.b, revfl = _a.r;
// we can ignore the fact that the other numbers are wrong; they never happen anyway
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0), fd = _b.b, revfd = _b.r;
// map of value to reverse (assuming 16 bits)
var rev = new u16(32768);
for (var i = 0; i < 32768; ++i) {
    // reverse table algorithm from SO
    var x = ((i & 0xAAAA) >> 1) | ((i & 0x5555) << 1);
    x = ((x & 0xCCCC) >> 2) | ((x & 0x3333) << 2);
    x = ((x & 0xF0F0) >> 4) | ((x & 0x0F0F) << 4);
    rev[i] = (((x & 0xFF00) >> 8) | ((x & 0x00FF) << 8)) >> 1;
}
// create huffman tree from u8 "map": index -> code length for code index
// mb (max bits) must be at most 15
// TODO: optimize/split up?
var hMap = (function (cd, mb, r) {
    var s = cd.length;
    // index
    var i = 0;
    // u16 "map": index -> # of codes with bit length = index
    var l = new u16(mb);
    // length of cd must be 288 (total # of codes)
    for (; i < s; ++i) {
        if (cd[i])
            ++l[cd[i] - 1];
    }
    // u16 "map": index -> minimum code for bit length = index
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
        le[i] = (le[i - 1] + l[i - 1]) << 1;
    }
    var co;
    if (r) {
        // u16 "map": index -> number of actual bits, symbol for code
        co = new u16(1 << mb);
        // bits to remove for reverser
        var rvb = 15 - mb;
        for (i = 0; i < s; ++i) {
            // ignore 0 lengths
            if (cd[i]) {
                // num encoding both symbol and bits read
                var sv = (i << 4) | cd[i];
                // free bits
                var r_1 = mb - cd[i];
                // start value
                var v = le[cd[i] - 1]++ << r_1;
                // m is end value
                for (var m = v | ((1 << r_1) - 1); v <= m; ++v) {
                    // every 16 bit value starting with the code yields the same result
                    co[rev[v] >> rvb] = sv;
                }
            }
        }
    }
    else {
        co = new u16(s);
        for (i = 0; i < s; ++i) {
            if (cd[i]) {
                co[i] = rev[le[cd[i] - 1]++] >> (15 - cd[i]);
            }
        }
    }
    return co;
});
// fixed length tree
var flt = new u8(288);
for (var i = 0; i < 144; ++i)
    flt[i] = 8;
for (var i = 144; i < 256; ++i)
    flt[i] = 9;
for (var i = 256; i < 280; ++i)
    flt[i] = 7;
for (var i = 280; i < 288; ++i)
    flt[i] = 8;
// fixed distance tree
var fdt = new u8(32);
for (var i = 0; i < 32; ++i)
    fdt[i] = 5;
// fixed length map
var flm = /*#__PURE__*/ hMap(flt, 9, 0), flrm = /*#__PURE__*/ hMap(flt, 9, 1);
// fixed distance map
var fdm = /*#__PURE__*/ hMap(fdt, 5, 0), fdrm = /*#__PURE__*/ hMap(fdt, 5, 1);
// find max of array
var max = function (a) {
    var m = a[0];
    for (var i = 1; i < a.length; ++i) {
        if (a[i] > m)
            m = a[i];
    }
    return m;
};
// read d, starting at bit p and mask with m
var bits = function (d, p, m) {
    var o = (p / 8) | 0;
    return ((d[o] | (d[o + 1] << 8)) >> (p & 7)) & m;
};
// read d, starting at bit p continuing for at least 16 bits
var bits16 = function (d, p) {
    var o = (p / 8) | 0;
    return ((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) >> (p & 7));
};
// get end of byte
var shft = function (p) { return ((p + 7) / 8) | 0; };
// typed array slice - allows garbage collector to free original reference,
// while being more compatible than .slice
var slc = function (v, s, e) {
    if (s == null || s < 0)
        s = 0;
    if (e == null || e > v.length)
        e = v.length;
    // can't use .constructor in case user-supplied
    return new u8(v.subarray(s, e));
};
/**
 * Codes for errors generated within this library
 */
var FlateErrorCode = {
    UnexpectedEOF: 0,
    InvalidBlockType: 1,
    InvalidLengthLiteral: 2,
    InvalidDistance: 3,
    StreamFinished: 4,
    NoStreamHandler: 5,
    InvalidHeader: 6,
    NoCallback: 7,
    InvalidUTF8: 8,
    ExtraFieldTooLong: 9,
    InvalidDate: 10,
    FilenameTooLong: 11,
    StreamFinishing: 12,
    InvalidZipData: 13,
    UnknownCompressionMethod: 14
};
// error codes
var ec = [
    'unexpected EOF',
    'invalid block type',
    'invalid length/literal',
    'invalid distance',
    'stream finished',
    'no stream handler',
    ,
    'no callback',
    'invalid UTF-8 data',
    'extra field too long',
    'date not in range 1980-2099',
    'filename too long',
    'stream finishing',
    'invalid zip data'
    // determined by unknown compression method
];
;
var err = function (ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
        Error.captureStackTrace(e, err);
    if (!nt)
        throw e;
    return e;
};
// expands raw DEFLATE data
var inflt = function (dat, st, buf, dict) {
    // source length       dict length
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
        return buf || new u8(0);
    var noBuf = !buf;
    // have to estimate size
    var resize = noBuf || st.i != 2;
    // no state
    var noSt = st.i;
    // Assumes roughly 33% compression ratio average
    if (noBuf)
        buf = new u8(sl * 3);
    // ensure buffer can fit at least l elements
    var cbuf = function (l) {
        var bl = buf.length;
        // need to increase size to fit
        if (l > bl) {
            // Double or set to necessary, whichever is greater
            var nbuf = new u8(Math.max(bl * 2, l));
            nbuf.set(buf);
            buf = nbuf;
        }
    };
    //  last chunk         bitpos           bytes
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    // total bits
    var tbts = sl * 8;
    do {
        if (!lm) {
            // BFINAL - this is only 1 when last chunk is next
            final = bits(dat, pos, 1);
            // type: 0 = no compression, 1 = fixed huffman, 2 = dynamic huffman
            var type = bits(dat, pos + 1, 3);
            pos += 3;
            if (!type) {
                // go to end of byte boundary
                var s = shft(pos) + 4, l = dat[s - 4] | (dat[s - 3] << 8), t = s + l;
                if (t > sl) {
                    if (noSt)
                        err(0);
                    break;
                }
                // ensure size
                if (resize)
                    cbuf(bt + l);
                // Copy over uncompressed data
                buf.set(dat.subarray(s, t), bt);
                // Get new bitpos, update byte count
                st.b = bt += l, st.p = pos = t * 8, st.f = final;
                continue;
            }
            else if (type == 1)
                lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
            else if (type == 2) {
                //  literal                            lengths
                var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
                var tl = hLit + bits(dat, pos + 5, 31) + 1;
                pos += 14;
                // length+distance tree
                var ldt = new u8(tl);
                // code length tree
                var clt = new u8(19);
                for (var i = 0; i < hcLen; ++i) {
                    // use index map to get real code
                    clt[clim[i]] = bits(dat, pos + i * 3, 7);
                }
                pos += hcLen * 3;
                // code lengths bits
                var clb = max(clt), clbmsk = (1 << clb) - 1;
                // code lengths map
                var clm = hMap(clt, clb, 1);
                for (var i = 0; i < tl;) {
                    var r = clm[bits(dat, pos, clbmsk)];
                    // bits read
                    pos += r & 15;
                    // symbol
                    var s = r >> 4;
                    // code length to copy
                    if (s < 16) {
                        ldt[i++] = s;
                    }
                    else {
                        //  copy   count
                        var c = 0, n = 0;
                        if (s == 16)
                            n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
                        else if (s == 17)
                            n = 3 + bits(dat, pos, 7), pos += 3;
                        else if (s == 18)
                            n = 11 + bits(dat, pos, 127), pos += 7;
                        while (n--)
                            ldt[i++] = c;
                    }
                }
                //    length tree                 distance tree
                var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
                // max length bits
                lbt = max(lt);
                // max dist bits
                dbt = max(dt);
                lm = hMap(lt, lbt, 1);
                dm = hMap(dt, dbt, 1);
            }
            else
                err(1);
            if (pos > tbts) {
                if (noSt)
                    err(0);
                break;
            }
        }
        // Make sure the buffer can hold this + the largest possible addition
        // Maximum chunk size (practically, theoretically infinite) is 2^17
        if (resize)
            cbuf(bt + 131072);
        var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
        var lpos = pos;
        for (;; lpos = pos) {
            // bits read, code
            var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
            pos += c & 15;
            if (pos > tbts) {
                if (noSt)
                    err(0);
                break;
            }
            if (!c)
                err(2);
            if (sym < 256)
                buf[bt++] = sym;
            else if (sym == 256) {
                lpos = pos, lm = null;
                break;
            }
            else {
                var add = sym - 254;
                // no extra bits needed if less
                if (sym > 264) {
                    // index
                    var i = sym - 257, b = fleb[i];
                    add = bits(dat, pos, (1 << b) - 1) + fl[i];
                    pos += b;
                }
                // dist
                var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
                if (!d)
                    err(3);
                pos += d & 15;
                var dt = fd[dsym];
                if (dsym > 3) {
                    var b = fdeb[dsym];
                    dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
                }
                if (pos > tbts) {
                    if (noSt)
                        err(0);
                    break;
                }
                if (resize)
                    cbuf(bt + 131072);
                var end = bt + add;
                if (bt < dt) {
                    var shift = dl - dt, dend = Math.min(dt, end);
                    if (shift + bt < 0)
                        err(3);
                    for (; bt < dend; ++bt)
                        buf[bt] = dict[shift + bt];
                }
                for (; bt < end; ++bt)
                    buf[bt] = buf[bt - dt];
            }
        }
        st.l = lm, st.p = lpos, st.b = bt, st.f = final;
        if (lm)
            final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    // don't reallocate for streams or user buffers
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
// starting at p, write the minimum number of bits that can hold v to d
var wbits = function (d, p, v) {
    v <<= p & 7;
    var o = (p / 8) | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
};
// starting at p, write the minimum number of bits (>8) that can hold v to d
var wbits16 = function (d, p, v) {
    v <<= p & 7;
    var o = (p / 8) | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
};
// creates code lengths from a frequency table
var hTree = function (d, mb) {
    // Need extra info to make a tree
    var t = [];
    for (var i = 0; i < d.length; ++i) {
        if (d[i])
            t.push({ s: i, f: d[i] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
        return { t: et, l: 0 };
    if (s == 1) {
        var v = new u8(t[0].s + 1);
        v[t[0].s] = 1;
        return { t: v, l: 1 };
    }
    t.sort(function (a, b) { return a.f - b.f; });
    // after i2 reaches last ind, will be stopped
    // freq must be greater than largest possible number of symbols
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l: l, r: r };
    // efficient algorithm from UZIP.js
    // i0 is lookbehind, i2 is lookahead - after processing two low-freq
    // symbols that combined have high freq, will start processing i2 (high-freq,
    // non-composite) symbols instead
    // see https://reddit.com/r/photopea/comments/ikekht/uzipjs_questions/
    while (i1 != s - 1) {
        l = t[t[i0].f < t[i2].f ? i0++ : i2++];
        r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
        t[i1++] = { s: -1, f: l.f + r.f, l: l, r: r };
    }
    var maxSym = t2[0].s;
    for (var i = 1; i < s; ++i) {
        if (t2[i].s > maxSym)
            maxSym = t2[i].s;
    }
    // code lengths
    var tr = new u16(maxSym + 1);
    // max bits in tree
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
        // more algorithms from UZIP.js
        // TODO: find out how this code works (debt)
        //  ind    debt
        var i = 0, dt = 0;
        //    left            cost
        var lft = mbt - mb, cst = 1 << lft;
        t2.sort(function (a, b) { return tr[b.s] - tr[a.s] || a.f - b.f; });
        for (; i < s; ++i) {
            var i2_1 = t2[i].s;
            if (tr[i2_1] > mb) {
                dt += cst - (1 << (mbt - tr[i2_1]));
                tr[i2_1] = mb;
            }
            else
                break;
        }
        dt >>= lft;
        while (dt > 0) {
            var i2_2 = t2[i].s;
            if (tr[i2_2] < mb)
                dt -= 1 << (mb - tr[i2_2]++ - 1);
            else
                ++i;
        }
        for (; i >= 0 && dt; --i) {
            var i2_3 = t2[i].s;
            if (tr[i2_3] == mb) {
                --tr[i2_3];
                ++dt;
            }
        }
        mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
};
// get the max length and assign length codes
var ln = function (n, l, d) {
    return n.s == -1
        ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1))
        : (l[n.s] = d);
};
// length codes generation
var lc = function (c) {
    var s = c.length;
    // Note that the semicolon was intentional
    while (s && !c[--s])
        ;
    var cl = new u16(++s);
    //  ind      num         streak
    var cli = 0, cln = c[0], cls = 1;
    var w = function (v) { cl[cli++] = v; };
    for (var i = 1; i <= s; ++i) {
        if (c[i] == cln && i != s)
            ++cls;
        else {
            if (!cln && cls > 2) {
                for (; cls > 138; cls -= 138)
                    w(32754);
                if (cls > 2) {
                    w(cls > 10 ? ((cls - 11) << 5) | 28690 : ((cls - 3) << 5) | 12305);
                    cls = 0;
                }
            }
            else if (cls > 3) {
                w(cln), --cls;
                for (; cls > 6; cls -= 6)
                    w(8304);
                if (cls > 2)
                    w(((cls - 3) << 5) | 8208), cls = 0;
            }
            while (cls--)
                w(cln);
            cls = 1;
            cln = c[i];
        }
    }
    return { c: cl.subarray(0, cli), n: s };
};
// calculate the length of output from tree, code lengths
var clen = function (cf, cl) {
    var l = 0;
    for (var i = 0; i < cl.length; ++i)
        l += cf[i] * cl[i];
    return l;
};
// writes a fixed block
// returns the new bit pos
var wfblk = function (out, pos, dat) {
    // no need to write 00 as type: TypedArray defaults to 0
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i = 0; i < s; ++i)
        out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
};
// writes a block
var wblk = function (dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a = hTree(lf, 15), dlt = _a.t, mlb = _a.l;
    var _b = hTree(df, 15), ddt = _b.t, mdb = _b.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i = 0; i < lclt.length; ++i)
        ++lcfreq[lclt[i] & 31];
    for (var i = 0; i < lcdt.length; ++i)
        ++lcfreq[lcdt[i] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
        ;
    var flen = (bl + 5) << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
        return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
        lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
        var llm = hMap(lct, mlcb, 0);
        wbits(out, p, nlc - 257);
        wbits(out, p + 5, ndc - 1);
        wbits(out, p + 10, nlcc - 4);
        p += 14;
        for (var i = 0; i < nlcc; ++i)
            wbits(out, p + 3 * i, lct[clim[i]]);
        p += 3 * nlcc;
        var lcts = [lclt, lcdt];
        for (var it = 0; it < 2; ++it) {
            var clct = lcts[it];
            for (var i = 0; i < clct.length; ++i) {
                var len = clct[i] & 31;
                wbits(out, p, llm[len]), p += lct[len];
                if (len > 15)
                    wbits(out, p, (clct[i] >> 5) & 127), p += clct[i] >> 12;
            }
        }
    }
    else {
        lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i = 0; i < li; ++i) {
        var sym = syms[i];
        if (sym > 255) {
            var len = (sym >> 18) & 31;
            wbits16(out, p, lm[len + 257]), p += ll[len + 257];
            if (len > 7)
                wbits(out, p, (sym >> 23) & 31), p += fleb[len];
            var dst = sym & 31;
            wbits16(out, p, dm[dst]), p += dl[dst];
            if (dst > 3)
                wbits16(out, p, (sym >> 5) & 8191), p += fdeb[dst];
        }
        else {
            wbits16(out, p, lm[sym]), p += ll[sym];
        }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
};
// deflate options (nice << 13) | chain
var deo = /*#__PURE__*/ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
// empty
var et = /*#__PURE__*/ new u8(0);
// compresses data into a raw DEFLATE buffer
var dflt = function (dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7000)) + post);
    // writing to this writes to the output buffer
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
        if (pos)
            w[0] = st.r >> 3;
        var opt = deo[lvl - 1];
        var n = opt >> 13, c = opt & 8191;
        var msk_1 = (1 << plvl) - 1;
        //    prev 2-byte val map    curr 2-byte val map
        var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
        var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
        var hsh = function (i) { return (dat[i] ^ (dat[i + 1] << bs1_1) ^ (dat[i + 2] << bs2_1)) & msk_1; };
        // 24576 is an arbitrary number of maximum symbols per block
        // 424 buffer for last block
        var syms = new i32(25000);
        // length/literal freq   distance freq
        var lf = new u16(288), df = new u16(32);
        //  l/lcnt  exbits  index          l/lind  waitdx          blkpos
        var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
        for (; i + 2 < s; ++i) {
            // hash value
            var hv = hsh(i);
            // index mod 32768    previous index mod
            var imod = i & 32767, pimod = head[hv];
            prev[imod] = pimod;
            head[hv] = imod;
            // We always should modify head and prev, but only add symbols if
            // this data is not yet processed ("wait" for wait index)
            if (wi <= i) {
                // bytes remaining
                var rem = s - i;
                if ((lc_1 > 7000 || li > 24576) && (rem > 423 || !lst)) {
                    pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
                    li = lc_1 = eb = 0, bs = i;
                    for (var j = 0; j < 286; ++j)
                        lf[j] = 0;
                    for (var j = 0; j < 30; ++j)
                        df[j] = 0;
                }
                //  len    dist   chain
                var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
                if (rem > 2 && hv == hsh(i - dif)) {
                    var maxn = Math.min(n, rem) - 1;
                    var maxd = Math.min(32767, i);
                    // max possible length
                    // not capped at dif because decompressors implement "rolling" index population
                    var ml = Math.min(258, rem);
                    while (dif <= maxd && --ch_1 && imod != pimod) {
                        if (dat[i + l] == dat[i + l - dif]) {
                            var nl = 0;
                            for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                                ;
                            if (nl > l) {
                                l = nl, d = dif;
                                // break out early when we reach "nice" (we are satisfied enough)
                                if (nl > maxn)
                                    break;
                                // now, find the rarest 2-byte sequence within this
                                // length of literals and search for that instead.
                                // Much faster than just using the start
                                var mmd = Math.min(dif, nl - 2);
                                var md = 0;
                                for (var j = 0; j < mmd; ++j) {
                                    var ti = i - dif + j & 32767;
                                    var pti = prev[ti];
                                    var cd = ti - pti & 32767;
                                    if (cd > md)
                                        md = cd, pimod = ti;
                                }
                            }
                        }
                        // check the previous match
                        imod = pimod, pimod = prev[imod];
                        dif += imod - pimod & 32767;
                    }
                }
                // d will be nonzero only when a match was found
                if (d) {
                    // store both dist and len data in one int32
                    // Make sure this is recognized as a len/dist with 28th bit (2^28)
                    syms[li++] = 268435456 | (revfl[l] << 18) | revfd[d];
                    var lin = revfl[l] & 31, din = revfd[d] & 31;
                    eb += fleb[lin] + fdeb[din];
                    ++lf[257 + lin];
                    ++df[din];
                    wi = i + l;
                    ++lc_1;
                }
                else {
                    syms[li++] = dat[i];
                    ++lf[dat[i]];
                }
            }
        }
        for (i = Math.max(i, wi); i < s; ++i) {
            syms[li++] = dat[i];
            ++lf[dat[i]];
        }
        pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
        if (!lst) {
            st.r = (pos & 7) | w[(pos / 8) | 0] << 3;
            // shft(pos) now 1 less if pos & 7 != 0
            pos -= 7;
            st.h = head, st.p = prev, st.i = i, st.w = wi;
        }
    }
    else {
        for (var i = st.w || 0; i < s + lst; i += 65535) {
            // end
            var e = i + 65535;
            if (e >= s) {
                // write final block
                w[(pos / 8) | 0] = lst;
                e = s;
            }
            pos = wfblk(w, pos + 1, dat.subarray(i, e));
        }
        st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
};
// CRC32 table
var crct = /*#__PURE__*/ (function () {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; ++i) {
        var c = i, k = 9;
        while (--k)
            c = ((c & 1) && -306674912) ^ (c >>> 1);
        t[i] = c;
    }
    return t;
})();
// CRC32
var crc = function () {
    var c = -1;
    return {
        p: function (d) {
            // closures have awful performance
            var cr = c;
            for (var i = 0; i < d.length; ++i)
                cr = crct[(cr & 255) ^ d[i]] ^ (cr >>> 8);
            c = cr;
        },
        d: function () { return ~c; }
    };
};
// Adler32
var adler = function () {
    var a = 1, b = 0;
    return {
        p: function (d) {
            // closures have awful performance
            var n = a, m = b;
            var l = d.length | 0;
            for (var i = 0; i != l;) {
                var e = Math.min(i + 2655, l);
                for (; i < e; ++i)
                    m += n += d[i];
                n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
            }
            a = n, b = m;
        },
        d: function () {
            a %= 65521, b %= 65521;
            return (a & 255) << 24 | (a & 0xFF00) << 8 | (b & 255) << 8 | (b >> 8);
        }
    };
};
;
// deflate with opts
var dopt = function (dat, opt, pre, post, st) {
    if (!st) {
        st = { l: 1 };
        if (opt.dictionary) {
            var dict = opt.dictionary.subarray(-32768);
            var newDat = new u8(dict.length + dat.length);
            newDat.set(dict);
            newDat.set(dat, dict.length);
            dat = newDat;
            st.w = dict.length;
        }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? (st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20) : (12 + opt.mem), pre, post, st);
};
// Walmart object spread
var mrg = function (a, b) {
    var o = {};
    for (var k in a)
        o[k] = a[k];
    for (var k in b)
        o[k] = b[k];
    return o;
};
// worker clone
// This is possibly the craziest part of the entire codebase, despite how simple it may seem.
// The only parameter to this function is a closure that returns an array of variables outside of the function scope.
// We're going to try to figure out the variable names used in the closure as strings because that is crucial for workerization.
// We will return an object mapping of true variable name to value (basically, the current scope as a JS object).
// The reason we can't just use the original variable names is minifiers mangling the toplevel scope.
// This took me three weeks to figure out how to do.
var wcln = function (fn, fnStr, td) {
    var dt = fn();
    var st = fn.toString();
    var ks = st.slice(st.indexOf('[') + 1, st.lastIndexOf(']')).replace(/\s+/g, '').split(',');
    for (var i = 0; i < dt.length; ++i) {
        var v = dt[i], k = ks[i];
        if (typeof v == 'function') {
            fnStr += ';' + k + '=';
            var st_1 = v.toString();
            if (v.prototype) {
                // for global objects
                if (st_1.indexOf('[native code]') != -1) {
                    var spInd = st_1.indexOf(' ', 8) + 1;
                    fnStr += st_1.slice(spInd, st_1.indexOf('(', spInd));
                }
                else {
                    fnStr += st_1;
                    for (var t in v.prototype)
                        fnStr += ';' + k + '.prototype.' + t + '=' + v.prototype[t].toString();
                }
            }
            else
                fnStr += st_1;
        }
        else
            td[k] = v;
    }
    return fnStr;
};
var ch = [];
// clone bufs
var cbfs = function (v) {
    var tl = [];
    for (var k in v) {
        if (v[k].buffer) {
            tl.push((v[k] = new v[k].constructor(v[k])).buffer);
        }
    }
    return tl;
};
// use a worker to execute code
var wrkr = function (fns, init, id, cb) {
    if (!ch[id]) {
        var fnStr = '', td_1 = {}, m = fns.length - 1;
        for (var i = 0; i < m; ++i)
            fnStr = wcln(fns[i], fnStr, td_1);
        ch[id] = { c: wcln(fns[m], fnStr, td_1), e: td_1 };
    }
    var td = mrg({}, ch[id].e);
    return wk(ch[id].c + ';onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=' + init.toString() + '}', id, td, cbfs(td), cb);
};
// base async inflate fn
var bInflt = function () { return [u8, u16, i32, fleb, fdeb, clim, fl, fd, flrm, fdrm, rev, ec, hMap, max, bits, bits16, shft, slc, err, inflt, inflateSync, pbf, gopt]; };
var bDflt = function () { return [u8, u16, i32, fleb, fdeb, clim, revfl, revfd, flm, flt, fdm, fdt, rev, deo, et, hMap, wbits, wbits16, hTree, ln, lc, clen, wfblk, wblk, shft, slc, dflt, dopt, deflateSync, pbf]; };
// gzip extra
var gze = function () { return [gzh, gzhl, wbytes, crc, crct]; };
// gunzip extra
var guze = function () { return [gzs, gzl]; };
// zlib extra
var zle = function () { return [zlh, wbytes, adler]; };
// unzlib extra
var zule = function () { return [zls]; };
// post buf
var pbf = function (msg) { return postMessage(msg, [msg.buffer]); };
// get opts
var gopt = function (o) { return o && {
    out: o.size && new u8(o.size),
    dictionary: o.dictionary
}; };
// async helper
var cbify = function (dat, opts, fns, init, id, cb) {
    var w = wrkr(fns, init, id, function (err, dat) {
        w.terminate();
        cb(err, dat);
    });
    w.postMessage([dat, opts], opts.consume ? [dat.buffer] : []);
    return function () { w.terminate(); };
};
// auto stream
var astrm = function (strm) {
    strm.ondata = function (dat, final) { return postMessage([dat, final], [dat.buffer]); };
    return function (ev) {
        if (ev.data.length) {
            strm.push(ev.data[0], ev.data[1]);
            postMessage([ev.data[0].length]);
        }
        else
            strm.flush();
    };
};
// async stream attach
var astrmify = function (fns, strm, opts, init, id, flush, ext) {
    var t;
    var w = wrkr(fns, init, id, function (err, dat) {
        if (err)
            w.terminate(), strm.ondata.call(strm, err);
        else if (!Array.isArray(dat))
            ext(dat);
        else if (dat.length == 1) {
            strm.queuedSize -= dat[0];
            if (strm.ondrain)
                strm.ondrain(dat[0]);
        }
        else {
            if (dat[1])
                w.terminate();
            strm.ondata.call(strm, err, dat[0], dat[1]);
        }
    });
    w.postMessage(opts);
    strm.queuedSize = 0;
    strm.push = function (d, f) {
        if (!strm.ondata)
            err(5);
        if (t)
            strm.ondata(err(4, 0, 1), null, !!f);
        strm.queuedSize += d.length;
        w.postMessage([d, t = f], [d.buffer]);
    };
    strm.terminate = function () { w.terminate(); };
    if (flush) {
        strm.flush = function () { w.postMessage([]); };
    }
};
// read 2 bytes
var b2 = function (d, b) { return d[b] | (d[b + 1] << 8); };
// read 4 bytes
var b4 = function (d, b) { return (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0; };
var b8 = function (d, b) { return b4(d, b) + (b4(d, b + 4) * 4294967296); };
// write bytes
var wbytes = function (d, b, v) {
    for (; v; ++b)
        d[b] = v, v >>>= 8;
};
// gzip header
var gzh = function (c, o) {
    var fn = o.filename;
    c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3; // assume Unix
    if (o.mtime != 0)
        wbytes(c, 4, Math.floor(new Date(o.mtime || Date.now()) / 1000));
    if (fn) {
        c[3] = 8;
        for (var i = 0; i <= fn.length; ++i)
            c[i + 10] = fn.charCodeAt(i);
    }
};
// gzip footer: -8 to -4 = CRC, -4 to -0 is length
// gzip start
var gzs = function (d) {
    if (d[0] != 31 || d[1] != 139 || d[2] != 8)
        err(6, 'invalid gzip data');
    var flg = d[3];
    var st = 10;
    if (flg & 4)
        st += (d[10] | d[11] << 8) + 2;
    for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
        ;
    return st + (flg & 2);
};
// gzip length
var gzl = function (d) {
    var l = d.length;
    return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
};
// gzip header length
var gzhl = function (o) { return 10 + (o.filename ? o.filename.length + 1 : 0); };
// zlib header
var zlh = function (c, o) {
    var lv = o.level, fl = lv == 0 ? 0 : lv < 6 ? 1 : lv == 9 ? 3 : 2;
    c[0] = 120, c[1] = (fl << 6) | (o.dictionary && 32);
    c[1] |= 31 - ((c[0] << 8) | c[1]) % 31;
    if (o.dictionary) {
        var h = adler();
        h.p(o.dictionary);
        wbytes(c, 2, h.d());
    }
};
// zlib start
var zls = function (d, dict) {
    if ((d[0] & 15) != 8 || (d[0] >> 4) > 7 || ((d[0] << 8 | d[1]) % 31))
        err(6, 'invalid zlib data');
    if ((d[1] >> 5 & 1) == +!dict)
        err(6, 'invalid zlib data: ' + (d[1] & 32 ? 'need' : 'unexpected') + ' dictionary');
    return (d[1] >> 3 & 4) + 2;
};
function StrmOpt(opts, cb) {
    if (typeof opts == 'function')
        cb = opts, opts = {};
    this.ondata = cb;
    return opts;
}
/**
 * Streaming DEFLATE compression
 */
var Deflate = /*#__PURE__*/ (function () {
    function Deflate(opts, cb) {
        if (typeof opts == 'function')
            cb = opts, opts = {};
        this.ondata = cb;
        this.o = opts || {};
        this.s = { l: 0, i: 32768, w: 32768, z: 32768 };
        // Buffer length must always be 0 mod 32768 for index calculations to be correct when modifying head and prev
        // 98304 = 32768 (lookback) + 65536 (common chunk size)
        this.b = new u8(98304);
        if (this.o.dictionary) {
            var dict = this.o.dictionary.subarray(-32768);
            this.b.set(dict, 32768 - dict.length);
            this.s.i = 32768 - dict.length;
        }
    }
    Deflate.prototype.p = function (c, f) {
        this.ondata(dopt(c, this.o, 0, 0, this.s), f);
    };
    /**
     * Pushes a chunk to be deflated
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Deflate.prototype.push = function (chunk, final) {
        if (!this.ondata)
            err(5);
        if (this.s.l)
            err(4);
        var endLen = chunk.length + this.s.z;
        if (endLen > this.b.length) {
            if (endLen > 2 * this.b.length - 32768) {
                var newBuf = new u8(endLen & -32768);
                newBuf.set(this.b.subarray(0, this.s.z));
                this.b = newBuf;
            }
            var split = this.b.length - this.s.z;
            this.b.set(chunk.subarray(0, split), this.s.z);
            this.s.z = this.b.length;
            this.p(this.b, false);
            this.b.set(this.b.subarray(-32768));
            this.b.set(chunk.subarray(split), 32768);
            this.s.z = chunk.length - split + 32768;
            this.s.i = 32766, this.s.w = 32768;
        }
        else {
            this.b.set(chunk, this.s.z);
            this.s.z += chunk.length;
        }
        this.s.l = final & 1;
        if (this.s.z > this.s.w + 8191 || final) {
            this.p(this.b, final || false);
            this.s.w = this.s.i, this.s.i -= 2;
        }
    };
    /**
     * Flushes buffered uncompressed data. Useful to immediately retrieve the
     * deflated output for small inputs.
     */
    Deflate.prototype.flush = function () {
        if (!this.ondata)
            err(5);
        if (this.s.l)
            err(4);
        this.p(this.b, false);
        this.s.w = this.s.i, this.s.i -= 2;
    };
    return Deflate;
}());

/**
 * Asynchronous streaming DEFLATE compression
 */
var AsyncDeflate = /*#__PURE__*/ (function () {
    function AsyncDeflate(opts, cb) {
        astrmify([
            bDflt,
            function () { return [astrm, Deflate]; }
        ], this, StrmOpt.call(this, opts, cb), function (ev) {
            var strm = new Deflate(ev.data);
            onmessage = astrm(strm);
        }, 6, 1);
    }
    return AsyncDeflate;
}());

function deflate(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return cbify(data, opts, [
        bDflt,
    ], function (ev) { return pbf(deflateSync(ev.data[0], ev.data[1])); }, 0, cb);
}
/**
 * Compresses data with DEFLATE without any wrapper
 * @param data The data to compress
 * @param opts The compression options
 * @returns The deflated version of the data
 */
function deflateSync(data, opts) {
    return dopt(data, opts || {}, 0, 0);
}
/**
 * Streaming DEFLATE decompression
 */
var Inflate = /*#__PURE__*/ (function () {
    function Inflate(opts, cb) {
        // no StrmOpt here to avoid adding to workerizer
        if (typeof opts == 'function')
            cb = opts, opts = {};
        this.ondata = cb;
        var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
        this.s = { i: 0, b: dict ? dict.length : 0 };
        this.o = new u8(32768);
        this.p = new u8(0);
        if (dict)
            this.o.set(dict);
    }
    Inflate.prototype.e = function (c) {
        if (!this.ondata)
            err(5);
        if (this.d)
            err(4);
        if (!this.p.length)
            this.p = c;
        else if (c.length) {
            var n = new u8(this.p.length + c.length);
            n.set(this.p), n.set(c, this.p.length), this.p = n;
        }
    };
    Inflate.prototype.c = function (final) {
        this.s.i = +(this.d = final || false);
        var bts = this.s.b;
        var dt = inflt(this.p, this.s, this.o);
        this.ondata(slc(dt, bts, this.s.b), this.d);
        this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
        this.p = slc(this.p, (this.s.p / 8) | 0), this.s.p &= 7;
    };
    /**
     * Pushes a chunk to be inflated
     * @param chunk The chunk to push
     * @param final Whether this is the final chunk
     */
    Inflate.prototype.push = function (chunk, final) {
        this.e(chunk), this.c(final);
    };
    return Inflate;
}());

/**
 * Asynchronous streaming DEFLATE decompression
 */
var AsyncInflate = /*#__PURE__*/ (function () {
    function AsyncInflate(opts, cb) {
        astrmify([
            bInflt,
            function () { return [astrm, Inflate]; }
        ], this, StrmOpt.call(this, opts, cb), function (ev) {
            var strm = new Inflate(ev.data);
            onmessage = astrm(strm);
        }, 7, 0);
    }
    return AsyncInflate;
}());

function inflate(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return cbify(data, opts, [
        bInflt
    ], function (ev) { return pbf(inflateSync(ev.data[0], gopt(ev.data[1]))); }, 1, cb);
}
/**
 * Expands DEFLATE data with no wrapper
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
function inflateSync(data, opts) {
    return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
// before you yell at me for not just using extends, my reason is that TS inheritance is hard to workerize.
/**
 * Streaming GZIP compression
 */
var Gzip = /*#__PURE__*/ (function () {
    function Gzip(opts, cb) {
        this.c = crc();
        this.l = 0;
        this.v = 1;
        Deflate.call(this, opts, cb);
    }
    /**
     * Pushes a chunk to be GZIPped
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Gzip.prototype.push = function (chunk, final) {
        this.c.p(chunk);
        this.l += chunk.length;
        Deflate.prototype.push.call(this, chunk, final);
    };
    Gzip.prototype.p = function (c, f) {
        var raw = dopt(c, this.o, this.v && gzhl(this.o), f && 8, this.s);
        if (this.v)
            gzh(raw, this.o), this.v = 0;
        if (f)
            wbytes(raw, raw.length - 8, this.c.d()), wbytes(raw, raw.length - 4, this.l);
        this.ondata(raw, f);
    };
    /**
     * Flushes buffered uncompressed data. Useful to immediately retrieve the
     * GZIPped output for small inputs.
     */
    Gzip.prototype.flush = function () {
        Deflate.prototype.flush.call(this);
    };
    return Gzip;
}());

/**
 * Asynchronous streaming GZIP compression
 */
var AsyncGzip = /*#__PURE__*/ (function () {
    function AsyncGzip(opts, cb) {
        astrmify([
            bDflt,
            gze,
            function () { return [astrm, Deflate, Gzip]; }
        ], this, StrmOpt.call(this, opts, cb), function (ev) {
            var strm = new Gzip(ev.data);
            onmessage = astrm(strm);
        }, 8, 1);
    }
    return AsyncGzip;
}());

function gzip(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return cbify(data, opts, [
        bDflt,
        gze,
        function () { return [gzipSync]; }
    ], function (ev) { return pbf(gzipSync(ev.data[0], ev.data[1])); }, 2, cb);
}
/**
 * Compresses data with GZIP
 * @param data The data to compress
 * @param opts The compression options
 * @returns The gzipped version of the data
 */
function gzipSync(data, opts) {
    if (!opts)
        opts = {};
    var c = crc(), l = data.length;
    c.p(data);
    var d = dopt(data, opts, gzhl(opts), 8), s = d.length;
    return gzh(d, opts), wbytes(d, s - 8, c.d()), wbytes(d, s - 4, l), d;
}
/**
 * Streaming single or multi-member GZIP decompression
 */
var Gunzip = /*#__PURE__*/ (function () {
    function Gunzip(opts, cb) {
        this.v = 1;
        this.r = 0;
        Inflate.call(this, opts, cb);
    }
    /**
     * Pushes a chunk to be GUNZIPped
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Gunzip.prototype.push = function (chunk, final) {
        Inflate.prototype.e.call(this, chunk);
        this.r += chunk.length;
        if (this.v) {
            var p = this.p.subarray(this.v - 1);
            var s = p.length > 3 ? gzs(p) : 4;
            if (s > p.length) {
                if (!final)
                    return;
            }
            else if (this.v > 1 && this.onmember) {
                this.onmember(this.r - p.length);
            }
            this.p = p.subarray(s), this.v = 0;
        }
        // necessary to prevent TS from using the closure value
        // This allows for workerization to function correctly
        Inflate.prototype.c.call(this, final);
        // process concatenated GZIP
        if (this.s.f && !this.s.l && !final) {
            this.v = shft(this.s.p) + 9;
            this.s = { i: 0 };
            this.o = new u8(0);
            this.push(new u8(0), final);
        }
    };
    return Gunzip;
}());

/**
 * Asynchronous streaming single or multi-member GZIP decompression
 */
var AsyncGunzip = /*#__PURE__*/ (function () {
    function AsyncGunzip(opts, cb) {
        var _this = this;
        astrmify([
            bInflt,
            guze,
            function () { return [astrm, Inflate, Gunzip]; }
        ], this, StrmOpt.call(this, opts, cb), function (ev) {
            var strm = new Gunzip(ev.data);
            strm.onmember = function (offset) { return postMessage(offset); };
            onmessage = astrm(strm);
        }, 9, 0, function (offset) { return _this.onmember && _this.onmember(offset); });
    }
    return AsyncGunzip;
}());

function gunzip(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return cbify(data, opts, [
        bInflt,
        guze,
        function () { return [gunzipSync]; }
    ], function (ev) { return pbf(gunzipSync(ev.data[0], ev.data[1])); }, 3, cb);
}
/**
 * Expands GZIP data
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
function gunzipSync(data, opts) {
    var st = gzs(data);
    if (st + 8 > data.length)
        err(6, 'invalid gzip data');
    return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
}
/**
 * Streaming Zlib compression
 */
var Zlib = /*#__PURE__*/ (function () {
    function Zlib(opts, cb) {
        this.c = adler();
        this.v = 1;
        Deflate.call(this, opts, cb);
    }
    /**
     * Pushes a chunk to be zlibbed
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Zlib.prototype.push = function (chunk, final) {
        this.c.p(chunk);
        Deflate.prototype.push.call(this, chunk, final);
    };
    Zlib.prototype.p = function (c, f) {
        var raw = dopt(c, this.o, this.v && (this.o.dictionary ? 6 : 2), f && 4, this.s);
        if (this.v)
            zlh(raw, this.o), this.v = 0;
        if (f)
            wbytes(raw, raw.length - 4, this.c.d());
        this.ondata(raw, f);
    };
    /**
     * Flushes buffered uncompressed data. Useful to immediately retrieve the
     * zlibbed output for small inputs.
     */
    Zlib.prototype.flush = function () {
        Deflate.prototype.flush.call(this);
    };
    return Zlib;
}());

/**
 * Asynchronous streaming Zlib compression
 */
var AsyncZlib = /*#__PURE__*/ (function () {
    function AsyncZlib(opts, cb) {
        astrmify([
            bDflt,
            zle,
            function () { return [astrm, Deflate, Zlib]; }
        ], this, StrmOpt.call(this, opts, cb), function (ev) {
            var strm = new Zlib(ev.data);
            onmessage = astrm(strm);
        }, 10, 1);
    }
    return AsyncZlib;
}());

function zlib(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return cbify(data, opts, [
        bDflt,
        zle,
        function () { return [zlibSync]; }
    ], function (ev) { return pbf(zlibSync(ev.data[0], ev.data[1])); }, 4, cb);
}
/**
 * Compress data with Zlib
 * @param data The data to compress
 * @param opts The compression options
 * @returns The zlib-compressed version of the data
 */
function zlibSync(data, opts) {
    if (!opts)
        opts = {};
    var a = adler();
    a.p(data);
    var d = dopt(data, opts, opts.dictionary ? 6 : 2, 4);
    return zlh(d, opts), wbytes(d, d.length - 4, a.d()), d;
}
/**
 * Streaming Zlib decompression
 */
var Unzlib = /*#__PURE__*/ (function () {
    function Unzlib(opts, cb) {
        Inflate.call(this, opts, cb);
        this.v = opts && opts.dictionary ? 2 : 1;
    }
    /**
     * Pushes a chunk to be unzlibbed
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Unzlib.prototype.push = function (chunk, final) {
        Inflate.prototype.e.call(this, chunk);
        if (this.v) {
            if (this.p.length < 6 && !final)
                return;
            this.p = this.p.subarray(zls(this.p, this.v - 1)), this.v = 0;
        }
        if (final) {
            if (this.p.length < 4)
                err(6, 'invalid zlib data');
            this.p = this.p.subarray(0, -4);
        }
        // necessary to prevent TS from using the closure value
        // This allows for workerization to function correctly
        Inflate.prototype.c.call(this, final);
    };
    return Unzlib;
}());

/**
 * Asynchronous streaming Zlib decompression
 */
var AsyncUnzlib = /*#__PURE__*/ (function () {
    function AsyncUnzlib(opts, cb) {
        astrmify([
            bInflt,
            zule,
            function () { return [astrm, Inflate, Unzlib]; }
        ], this, StrmOpt.call(this, opts, cb), function (ev) {
            var strm = new Unzlib(ev.data);
            onmessage = astrm(strm);
        }, 11, 0);
    }
    return AsyncUnzlib;
}());

function unzlib(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return cbify(data, opts, [
        bInflt,
        zule,
        function () { return [unzlibSync]; }
    ], function (ev) { return pbf(unzlibSync(ev.data[0], gopt(ev.data[1]))); }, 5, cb);
}
/**
 * Expands Zlib data
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
function unzlibSync(data, opts) {
    return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
// Default algorithm for compression (used because having a known output size allows faster decompression)


/**
 * Streaming GZIP, Zlib, or raw DEFLATE decompression
 */
var Decompress = /*#__PURE__*/ (function () {
    function Decompress(opts, cb) {
        this.o = StrmOpt.call(this, opts, cb) || {};
        this.G = Gunzip;
        this.I = Inflate;
        this.Z = Unzlib;
    }
    // init substream
    // overriden by AsyncDecompress
    Decompress.prototype.i = function () {
        var _this = this;
        this.s.ondata = function (dat, final) {
            _this.ondata(dat, final);
        };
    };
    /**
     * Pushes a chunk to be decompressed
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Decompress.prototype.push = function (chunk, final) {
        if (!this.ondata)
            err(5);
        if (!this.s) {
            if (this.p && this.p.length) {
                var n = new u8(this.p.length + chunk.length);
                n.set(this.p), n.set(chunk, this.p.length);
            }
            else
                this.p = chunk;
            if (this.p.length > 2) {
                this.s = (this.p[0] == 31 && this.p[1] == 139 && this.p[2] == 8)
                    ? new this.G(this.o)
                    : ((this.p[0] & 15) != 8 || (this.p[0] >> 4) > 7 || ((this.p[0] << 8 | this.p[1]) % 31))
                        ? new this.I(this.o)
                        : new this.Z(this.o);
                this.i();
                this.s.push(this.p, final);
                this.p = null;
            }
        }
        else
            this.s.push(chunk, final);
    };
    return Decompress;
}());

/**
 * Asynchronous streaming GZIP, Zlib, or raw DEFLATE decompression
 */
var AsyncDecompress = /*#__PURE__*/ (function () {
    function AsyncDecompress(opts, cb) {
        Decompress.call(this, opts, cb);
        this.queuedSize = 0;
        this.G = AsyncGunzip;
        this.I = AsyncInflate;
        this.Z = AsyncUnzlib;
    }
    AsyncDecompress.prototype.i = function () {
        var _this = this;
        this.s.ondata = function (err, dat, final) {
            _this.ondata(err, dat, final);
        };
        this.s.ondrain = function (size) {
            _this.queuedSize -= size;
            if (_this.ondrain)
                _this.ondrain(size);
        };
    };
    /**
     * Pushes a chunk to be decompressed
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    AsyncDecompress.prototype.push = function (chunk, final) {
        this.queuedSize += chunk.length;
        Decompress.prototype.push.call(this, chunk, final);
    };
    return AsyncDecompress;
}());

function decompress(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    return (data[0] == 31 && data[1] == 139 && data[2] == 8)
        ? gunzip(data, opts, cb)
        : ((data[0] & 15) != 8 || (data[0] >> 4) > 7 || ((data[0] << 8 | data[1]) % 31))
            ? inflate(data, opts, cb)
            : unzlib(data, opts, cb);
}
/**
 * Expands compressed GZIP, Zlib, or raw DEFLATE data, automatically detecting the format
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
function decompressSync(data, opts) {
    return (data[0] == 31 && data[1] == 139 && data[2] == 8)
        ? gunzipSync(data, opts)
        : ((data[0] & 15) != 8 || (data[0] >> 4) > 7 || ((data[0] << 8 | data[1]) % 31))
            ? inflateSync(data, opts)
            : unzlibSync(data, opts);
}
// flatten a directory structure
var fltn = function (d, p, t, o) {
    for (var k in d) {
        var val = d[k], n = p + k, op = o;
        if (Array.isArray(val))
            op = mrg(o, val[1]), val = val[0];
        if (val instanceof u8)
            t[n] = [val, op];
        else {
            t[n += '/'] = [new u8(0), op];
            fltn(val, n, t, o);
        }
    }
};
// text encoder
var te = typeof TextEncoder != 'undefined' && /*#__PURE__*/ new TextEncoder();
// text decoder
var td = typeof TextDecoder != 'undefined' && /*#__PURE__*/ new TextDecoder();
// text decoder stream
var tds = 0;
try {
    td.decode(et, { stream: true });
    tds = 1;
}
catch (e) { }
// decode UTF8
var dutf8 = function (d) {
    for (var r = '', i = 0;;) {
        var c = d[i++];
        var eb = (c > 127) + (c > 223) + (c > 239);
        if (i + eb > d.length)
            return { s: r, r: slc(d, i - 1) };
        if (!eb)
            r += String.fromCharCode(c);
        else if (eb == 3) {
            c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | (d[i++] & 63)) - 65536,
                r += String.fromCharCode(55296 | (c >> 10), 56320 | (c & 1023));
        }
        else if (eb & 1)
            r += String.fromCharCode((c & 31) << 6 | (d[i++] & 63));
        else
            r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | (d[i++] & 63));
    }
};
/**
 * Streaming UTF-8 decoding
 */
var DecodeUTF8 = /*#__PURE__*/ (function () {
    /**
     * Creates a UTF-8 decoding stream
     * @param cb The callback to call whenever data is decoded
     */
    function DecodeUTF8(cb) {
        this.ondata = cb;
        if (tds)
            this.t = new TextDecoder();
        else
            this.p = et;
    }
    /**
     * Pushes a chunk to be decoded from UTF-8 binary
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    DecodeUTF8.prototype.push = function (chunk, final) {
        if (!this.ondata)
            err(5);
        final = !!final;
        if (this.t) {
            this.ondata(this.t.decode(chunk, { stream: true }), final);
            if (final) {
                if (this.t.decode().length)
                    err(8);
                this.t = null;
            }
            return;
        }
        if (!this.p)
            err(4);
        var dat = new u8(this.p.length + chunk.length);
        dat.set(this.p);
        dat.set(chunk, this.p.length);
        var _a = dutf8(dat), s = _a.s, r = _a.r;
        if (final) {
            if (r.length)
                err(8);
            this.p = null;
        }
        else
            this.p = r;
        this.ondata(s, final);
    };
    return DecodeUTF8;
}());

/**
 * Streaming UTF-8 encoding
 */
var EncodeUTF8 = /*#__PURE__*/ (function () {
    /**
     * Creates a UTF-8 decoding stream
     * @param cb The callback to call whenever data is encoded
     */
    function EncodeUTF8(cb) {
        this.ondata = cb;
    }
    /**
     * Pushes a chunk to be encoded to UTF-8
     * @param chunk The string data to push
     * @param final Whether this is the last chunk
     */
    EncodeUTF8.prototype.push = function (chunk, final) {
        if (!this.ondata)
            err(5);
        if (this.d)
            err(4);
        this.ondata(strToU8(chunk), this.d = final || false);
    };
    return EncodeUTF8;
}());

/**
 * Converts a string into a Uint8Array for use with compression/decompression methods
 * @param str The string to encode
 * @param latin1 Whether or not to interpret the data as Latin-1. This should
 *               not need to be true unless decoding a binary string.
 * @returns The string encoded in UTF-8/Latin-1 binary
 */
function strToU8(str, latin1) {
    if (latin1) {
        var ar_1 = new u8(str.length);
        for (var i = 0; i < str.length; ++i)
            ar_1[i] = str.charCodeAt(i);
        return ar_1;
    }
    if (te)
        return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function (v) { ar[ai++] = v; };
    for (var i = 0; i < l; ++i) {
        if (ai + 5 > ar.length) {
            var n = new u8(ai + 8 + ((l - i) << 1));
            n.set(ar);
            ar = n;
        }
        var c = str.charCodeAt(i);
        if (c < 128 || latin1)
            w(c);
        else if (c < 2048)
            w(192 | (c >> 6)), w(128 | (c & 63));
        else if (c > 55295 && c < 57344)
            c = 65536 + (c & 1023 << 10) | (str.charCodeAt(++i) & 1023),
                w(240 | (c >> 18)), w(128 | ((c >> 12) & 63)), w(128 | ((c >> 6) & 63)), w(128 | (c & 63));
        else
            w(224 | (c >> 12)), w(128 | ((c >> 6) & 63)), w(128 | (c & 63));
    }
    return slc(ar, 0, ai);
}
/**
 * Converts a Uint8Array to a string
 * @param dat The data to decode to string
 * @param latin1 Whether or not to interpret the data as Latin-1. This should
 *               not need to be true unless encoding to binary string.
 * @returns The original UTF-8/Latin-1 string
 */
function strFromU8(dat, latin1) {
    if (latin1) {
        var r = '';
        for (var i = 0; i < dat.length; i += 16384)
            r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
        return r;
    }
    else if (td) {
        return td.decode(dat);
    }
    else {
        var _a = dutf8(dat), s = _a.s, r = _a.r;
        if (r.length)
            err(8);
        return s;
    }
}
;
// deflate bit flag
var dbf = function (l) { return l == 1 ? 3 : l < 6 ? 2 : l == 9 ? 1 : 0; };
// skip local zip header
var slzh = function (d, b) { return b + 30 + b2(d, b + 26) + b2(d, b + 28); };
// read zip header
var zh = function (d, b, z) {
    var fnl = b2(d, b + 28), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl, bs = b4(d, b + 20);
    var _a = z && bs == 4294967295 ? z64e(d, es) : [bs, b4(d, b + 24), b4(d, b + 42)], sc = _a[0], su = _a[1], off = _a[2];
    return [b2(d, b + 10), sc, su, fn, es + b2(d, b + 30) + b2(d, b + 32), off];
};
// read zip64 extra field
var z64e = function (d, b) {
    for (; b2(d, b) != 1; b += 4 + b2(d, b + 2))
        ;
    return [b8(d, b + 12), b8(d, b + 4), b8(d, b + 20)];
};
// extra field length
var exfl = function (ex) {
    var le = 0;
    if (ex) {
        for (var k in ex) {
            var l = ex[k].length;
            if (l > 65535)
                err(9);
            le += l + 4;
        }
    }
    return le;
};
// write zip header
var wzh = function (d, b, f, fn, u, c, ce, co) {
    var fl = fn.length, ex = f.extra, col = co && co.length;
    var exl = exfl(ex);
    wbytes(d, b, ce != null ? 0x2014B50 : 0x4034B50), b += 4;
    if (ce != null)
        d[b++] = 20, d[b++] = f.os;
    d[b] = 20, b += 2; // spec compliance? what's that?
    d[b++] = (f.flag << 1) | (c < 0 && 8), d[b++] = u && 8;
    d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
    var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
    if (y < 0 || y > 119)
        err(10);
    wbytes(d, b, (y << 25) | ((dt.getMonth() + 1) << 21) | (dt.getDate() << 16) | (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1)), b += 4;
    if (c != -1) {
        wbytes(d, b, f.crc);
        wbytes(d, b + 4, c < 0 ? -c - 2 : c);
        wbytes(d, b + 8, f.size);
    }
    wbytes(d, b + 12, fl);
    wbytes(d, b + 14, exl), b += 16;
    if (ce != null) {
        wbytes(d, b, col);
        wbytes(d, b + 6, f.attrs);
        wbytes(d, b + 10, ce), b += 14;
    }
    d.set(fn, b);
    b += fl;
    if (exl) {
        for (var k in ex) {
            var exf = ex[k], l = exf.length;
            wbytes(d, b, +k);
            wbytes(d, b + 2, l);
            d.set(exf, b + 4), b += 4 + l;
        }
    }
    if (col)
        d.set(co, b), b += col;
    return b;
};
// write zip footer (end of central directory)
var wzf = function (o, b, c, d, e) {
    wbytes(o, b, 0x6054B50); // skip disk
    wbytes(o, b + 8, c);
    wbytes(o, b + 10, c);
    wbytes(o, b + 12, d);
    wbytes(o, b + 16, e);
};
/**
 * A pass-through stream to keep data uncompressed in a ZIP archive.
 */
var ZipPassThrough = /*#__PURE__*/ (function () {
    /**
     * Creates a pass-through stream that can be added to ZIP archives
     * @param filename The filename to associate with this data stream
     */
    function ZipPassThrough(filename) {
        this.filename = filename;
        this.c = crc();
        this.size = 0;
        this.compression = 0;
    }
    /**
     * Processes a chunk and pushes to the output stream. You can override this
     * method in a subclass for custom behavior, but by default this passes
     * the data through. You must call this.ondata(err, chunk, final) at some
     * point in this method.
     * @param chunk The chunk to process
     * @param final Whether this is the last chunk
     */
    ZipPassThrough.prototype.process = function (chunk, final) {
        this.ondata(null, chunk, final);
    };
    /**
     * Pushes a chunk to be added. If you are subclassing this with a custom
     * compression algorithm, note that you must push data from the source
     * file only, pre-compression.
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    ZipPassThrough.prototype.push = function (chunk, final) {
        if (!this.ondata)
            err(5);
        this.c.p(chunk);
        this.size += chunk.length;
        if (final)
            this.crc = this.c.d();
        this.process(chunk, final || false);
    };
    return ZipPassThrough;
}());

// I don't extend because TypeScript extension adds 1kB of runtime bloat
/**
 * Streaming DEFLATE compression for ZIP archives. Prefer using AsyncZipDeflate
 * for better performance
 */
var ZipDeflate = /*#__PURE__*/ (function () {
    /**
     * Creates a DEFLATE stream that can be added to ZIP archives
     * @param filename The filename to associate with this data stream
     * @param opts The compression options
     */
    function ZipDeflate(filename, opts) {
        var _this = this;
        if (!opts)
            opts = {};
        ZipPassThrough.call(this, filename);
        this.d = new Deflate(opts, function (dat, final) {
            _this.ondata(null, dat, final);
        });
        this.compression = 8;
        this.flag = dbf(opts.level);
    }
    ZipDeflate.prototype.process = function (chunk, final) {
        try {
            this.d.push(chunk, final);
        }
        catch (e) {
            this.ondata(e, null, final);
        }
    };
    /**
     * Pushes a chunk to be deflated
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    ZipDeflate.prototype.push = function (chunk, final) {
        ZipPassThrough.prototype.push.call(this, chunk, final);
    };
    return ZipDeflate;
}());

/**
 * Asynchronous streaming DEFLATE compression for ZIP archives
 */
var AsyncZipDeflate = /*#__PURE__*/ (function () {
    /**
     * Creates an asynchronous DEFLATE stream that can be added to ZIP archives
     * @param filename The filename to associate with this data stream
     * @param opts The compression options
     */
    function AsyncZipDeflate(filename, opts) {
        var _this = this;
        if (!opts)
            opts = {};
        ZipPassThrough.call(this, filename);
        this.d = new AsyncDeflate(opts, function (err, dat, final) {
            _this.ondata(err, dat, final);
        });
        this.compression = 8;
        this.flag = dbf(opts.level);
        this.terminate = this.d.terminate;
    }
    AsyncZipDeflate.prototype.process = function (chunk, final) {
        this.d.push(chunk, final);
    };
    /**
     * Pushes a chunk to be deflated
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    AsyncZipDeflate.prototype.push = function (chunk, final) {
        ZipPassThrough.prototype.push.call(this, chunk, final);
    };
    return AsyncZipDeflate;
}());

// TODO: Better tree shaking
/**
 * A zippable archive to which files can incrementally be added
 */
var Zip = /*#__PURE__*/ (function () {
    /**
     * Creates an empty ZIP archive to which files can be added
     * @param cb The callback to call whenever data for the generated ZIP archive
     *           is available
     */
    function Zip(cb) {
        this.ondata = cb;
        this.u = [];
        this.d = 1;
    }
    /**
     * Adds a file to the ZIP archive
     * @param file The file stream to add
     */
    Zip.prototype.add = function (file) {
        var _this = this;
        if (!this.ondata)
            err(5);
        // finishing or finished
        if (this.d & 2)
            this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, false);
        else {
            var f = strToU8(file.filename), fl_1 = f.length;
            var com = file.comment, o = com && strToU8(com);
            var u = fl_1 != file.filename.length || (o && (com.length != o.length));
            var hl_1 = fl_1 + exfl(file.extra) + 30;
            if (fl_1 > 65535)
                this.ondata(err(11, 0, 1), null, false);
            var header = new u8(hl_1);
            wzh(header, 0, file, f, u, -1);
            var chks_1 = [header];
            var pAll_1 = function () {
                for (var _i = 0, chks_2 = chks_1; _i < chks_2.length; _i++) {
                    var chk = chks_2[_i];
                    _this.ondata(null, chk, false);
                }
                chks_1 = [];
            };
            var tr_1 = this.d;
            this.d = 0;
            var ind_1 = this.u.length;
            var uf_1 = mrg(file, {
                f: f,
                u: u,
                o: o,
                t: function () {
                    if (file.terminate)
                        file.terminate();
                },
                r: function () {
                    pAll_1();
                    if (tr_1) {
                        var nxt = _this.u[ind_1 + 1];
                        if (nxt)
                            nxt.r();
                        else
                            _this.d = 1;
                    }
                    tr_1 = 1;
                }
            });
            var cl_1 = 0;
            file.ondata = function (err, dat, final) {
                if (err) {
                    _this.ondata(err, dat, final);
                    _this.terminate();
                }
                else {
                    cl_1 += dat.length;
                    chks_1.push(dat);
                    if (final) {
                        var dd = new u8(16);
                        wbytes(dd, 0, 0x8074B50);
                        wbytes(dd, 4, file.crc);
                        wbytes(dd, 8, cl_1);
                        wbytes(dd, 12, file.size);
                        chks_1.push(dd);
                        uf_1.c = cl_1, uf_1.b = hl_1 + cl_1 + 16, uf_1.crc = file.crc, uf_1.size = file.size;
                        if (tr_1)
                            uf_1.r();
                        tr_1 = 1;
                    }
                    else if (tr_1)
                        pAll_1();
                }
            };
            this.u.push(uf_1);
        }
    };
    /**
     * Ends the process of adding files and prepares to emit the final chunks.
     * This *must* be called after adding all desired files for the resulting
     * ZIP file to work properly.
     */
    Zip.prototype.end = function () {
        var _this = this;
        if (this.d & 2) {
            this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, true);
            return;
        }
        if (this.d)
            this.e();
        else
            this.u.push({
                r: function () {
                    if (!(_this.d & 1))
                        return;
                    _this.u.splice(-1, 1);
                    _this.e();
                },
                t: function () { }
            });
        this.d = 3;
    };
    Zip.prototype.e = function () {
        var bt = 0, l = 0, tl = 0;
        for (var _i = 0, _a = this.u; _i < _a.length; _i++) {
            var f = _a[_i];
            tl += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0);
        }
        var out = new u8(tl + 22);
        for (var _b = 0, _c = this.u; _b < _c.length; _b++) {
            var f = _c[_b];
            wzh(out, bt, f, f.f, f.u, -f.c - 2, l, f.o);
            bt += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0), l += f.b;
        }
        wzf(out, bt, this.u.length, tl, l);
        this.ondata(null, out, true);
        this.d = 2;
    };
    /**
     * A method to terminate any internal workers used by the stream. Subsequent
     * calls to add() will fail.
     */
    Zip.prototype.terminate = function () {
        for (var _i = 0, _a = this.u; _i < _a.length; _i++) {
            var f = _a[_i];
            f.t();
        }
        this.d = 2;
    };
    return Zip;
}());

function zip(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    var r = {};
    fltn(data, '', r, opts);
    var k = Object.keys(r);
    var lft = k.length, o = 0, tot = 0;
    var slft = lft, files = new Array(lft);
    var term = [];
    var tAll = function () {
        for (var i = 0; i < term.length; ++i)
            term[i]();
    };
    var cbd = function (a, b) {
        mt(function () { cb(a, b); });
    };
    mt(function () { cbd = cb; });
    var cbf = function () {
        var out = new u8(tot + 22), oe = o, cdl = tot - o;
        tot = 0;
        for (var i = 0; i < slft; ++i) {
            var f = files[i];
            try {
                var l = f.c.length;
                wzh(out, tot, f, f.f, f.u, l);
                var badd = 30 + f.f.length + exfl(f.extra);
                var loc = tot + badd;
                out.set(f.c, loc);
                wzh(out, o, f, f.f, f.u, l, tot, f.m), o += 16 + badd + (f.m ? f.m.length : 0), tot = loc + l;
            }
            catch (e) {
                return cbd(e, null);
            }
        }
        wzf(out, o, files.length, cdl, oe);
        cbd(null, out);
    };
    if (!lft)
        cbf();
    var _loop_1 = function (i) {
        var fn = k[i];
        var _a = r[fn], file = _a[0], p = _a[1];
        var c = crc(), size = file.length;
        c.p(file);
        var f = strToU8(fn), s = f.length;
        var com = p.comment, m = com && strToU8(com), ms = m && m.length;
        var exl = exfl(p.extra);
        var compression = p.level == 0 ? 0 : 8;
        var cbl = function (e, d) {
            if (e) {
                tAll();
                cbd(e, null);
            }
            else {
                var l = d.length;
                files[i] = mrg(p, {
                    size: size,
                    crc: c.d(),
                    c: d,
                    f: f,
                    m: m,
                    u: s != fn.length || (m && (com.length != ms)),
                    compression: compression
                });
                o += 30 + s + exl + l;
                tot += 76 + 2 * (s + exl) + (ms || 0) + l;
                if (!--lft)
                    cbf();
            }
        };
        if (s > 65535)
            cbl(err(11, 0, 1), null);
        if (!compression)
            cbl(null, file);
        else if (size < 160000) {
            try {
                cbl(null, deflateSync(file, p));
            }
            catch (e) {
                cbl(e, null);
            }
        }
        else
            term.push(deflate(file, p, cbl));
    };
    // Cannot use lft because it can decrease
    for (var i = 0; i < slft; ++i) {
        _loop_1(i);
    }
    return tAll;
}
/**
 * Synchronously creates a ZIP file. Prefer using `zip` for better performance
 * with more than one file.
 * @param data The directory structure for the ZIP archive
 * @param opts The main options, merged with per-file options
 * @returns The generated ZIP archive
 */
function zipSync(data, opts) {
    if (!opts)
        opts = {};
    var r = {};
    var files = [];
    fltn(data, '', r, opts);
    var o = 0;
    var tot = 0;
    for (var fn in r) {
        var _a = r[fn], file = _a[0], p = _a[1];
        var compression = p.level == 0 ? 0 : 8;
        var f = strToU8(fn), s = f.length;
        var com = p.comment, m = com && strToU8(com), ms = m && m.length;
        var exl = exfl(p.extra);
        if (s > 65535)
            err(11);
        var d = compression ? deflateSync(file, p) : file, l = d.length;
        var c = crc();
        c.p(file);
        files.push(mrg(p, {
            size: file.length,
            crc: c.d(),
            c: d,
            f: f,
            m: m,
            u: s != fn.length || (m && (com.length != ms)),
            o: o,
            compression: compression
        }));
        o += 30 + s + exl + l;
        tot += 76 + 2 * (s + exl) + (ms || 0) + l;
    }
    var out = new u8(tot + 22), oe = o, cdl = tot - o;
    for (var i = 0; i < files.length; ++i) {
        var f = files[i];
        wzh(out, f.o, f, f.f, f.u, f.c.length);
        var badd = 30 + f.f.length + exfl(f.extra);
        out.set(f.c, f.o + badd);
        wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
    }
    wzf(out, o, files.length, cdl, oe);
    return out;
}
/**
 * Streaming pass-through decompression for ZIP archives
 */
var UnzipPassThrough = /*#__PURE__*/ (function () {
    function UnzipPassThrough() {
    }
    UnzipPassThrough.prototype.push = function (data, final) {
        this.ondata(null, data, final);
    };
    UnzipPassThrough.compression = 0;
    return UnzipPassThrough;
}());

/**
 * Streaming DEFLATE decompression for ZIP archives. Prefer AsyncZipInflate for
 * better performance.
 */
var UnzipInflate = /*#__PURE__*/ (function () {
    /**
     * Creates a DEFLATE decompression that can be used in ZIP archives
     */
    function UnzipInflate() {
        var _this = this;
        this.i = new Inflate(function (dat, final) {
            _this.ondata(null, dat, final);
        });
    }
    UnzipInflate.prototype.push = function (data, final) {
        try {
            this.i.push(data, final);
        }
        catch (e) {
            this.ondata(e, null, final);
        }
    };
    UnzipInflate.compression = 8;
    return UnzipInflate;
}());

/**
 * Asynchronous streaming DEFLATE decompression for ZIP archives
 */
var AsyncUnzipInflate = /*#__PURE__*/ (function () {
    /**
     * Creates a DEFLATE decompression that can be used in ZIP archives
     */
    function AsyncUnzipInflate(_, sz) {
        var _this = this;
        if (sz < 320000) {
            this.i = new Inflate(function (dat, final) {
                _this.ondata(null, dat, final);
            });
        }
        else {
            this.i = new AsyncInflate(function (err, dat, final) {
                _this.ondata(err, dat, final);
            });
            this.terminate = this.i.terminate;
        }
    }
    AsyncUnzipInflate.prototype.push = function (data, final) {
        if (this.i.terminate)
            data = slc(data, 0);
        this.i.push(data, final);
    };
    AsyncUnzipInflate.compression = 8;
    return AsyncUnzipInflate;
}());

/**
 * A ZIP archive decompression stream that emits files as they are discovered
 */
var Unzip = /*#__PURE__*/ (function () {
    /**
     * Creates a ZIP decompression stream
     * @param cb The callback to call whenever a file in the ZIP archive is found
     */
    function Unzip(cb) {
        this.onfile = cb;
        this.k = [];
        this.o = {
            0: UnzipPassThrough
        };
        this.p = et;
    }
    /**
     * Pushes a chunk to be unzipped
     * @param chunk The chunk to push
     * @param final Whether this is the last chunk
     */
    Unzip.prototype.push = function (chunk, final) {
        var _this = this;
        if (!this.onfile)
            err(5);
        if (!this.p)
            err(4);
        if (this.c > 0) {
            var len = Math.min(this.c, chunk.length);
            var toAdd = chunk.subarray(0, len);
            this.c -= len;
            if (this.d)
                this.d.push(toAdd, !this.c);
            else
                this.k[0].push(toAdd);
            chunk = chunk.subarray(len);
            if (chunk.length)
                return this.push(chunk, final);
        }
        else {
            var f = 0, i = 0, is = void 0, buf = void 0;
            if (!this.p.length)
                buf = chunk;
            else if (!chunk.length)
                buf = this.p;
            else {
                buf = new u8(this.p.length + chunk.length);
                buf.set(this.p), buf.set(chunk, this.p.length);
            }
            var l = buf.length, oc = this.c, add = oc && this.d;
            var _loop_2 = function () {
                var _a;
                var sig = b4(buf, i);
                if (sig == 0x4034B50) {
                    f = 1, is = i;
                    this_1.d = null;
                    this_1.c = 0;
                    var bf = b2(buf, i + 6), cmp_1 = b2(buf, i + 8), u = bf & 2048, dd = bf & 8, fnl = b2(buf, i + 26), es = b2(buf, i + 28);
                    if (l > i + 30 + fnl + es) {
                        var chks_3 = [];
                        this_1.k.unshift(chks_3);
                        f = 2;
                        var sc_1 = b4(buf, i + 18), su_1 = b4(buf, i + 22);
                        var fn_1 = strFromU8(buf.subarray(i + 30, i += 30 + fnl), !u);
                        if (sc_1 == 4294967295) {
                            _a = dd ? [-2] : z64e(buf, i), sc_1 = _a[0], su_1 = _a[1];
                        }
                        else if (dd)
                            sc_1 = -1;
                        i += es;
                        this_1.c = sc_1;
                        var d_1;
                        var file_1 = {
                            name: fn_1,
                            compression: cmp_1,
                            start: function () {
                                if (!file_1.ondata)
                                    err(5);
                                if (!sc_1)
                                    file_1.ondata(null, et, true);
                                else {
                                    var ctr = _this.o[cmp_1];
                                    if (!ctr)
                                        file_1.ondata(err(14, 'unknown compression type ' + cmp_1, 1), null, false);
                                    d_1 = sc_1 < 0 ? new ctr(fn_1) : new ctr(fn_1, sc_1, su_1);
                                    d_1.ondata = function (err, dat, final) { file_1.ondata(err, dat, final); };
                                    for (var _i = 0, chks_4 = chks_3; _i < chks_4.length; _i++) {
                                        var dat = chks_4[_i];
                                        d_1.push(dat, false);
                                    }
                                    if (_this.k[0] == chks_3 && _this.c)
                                        _this.d = d_1;
                                    else
                                        d_1.push(et, true);
                                }
                            },
                            terminate: function () {
                                if (d_1 && d_1.terminate)
                                    d_1.terminate();
                            }
                        };
                        if (sc_1 >= 0)
                            file_1.size = sc_1, file_1.originalSize = su_1;
                        this_1.onfile(file_1);
                    }
                    return "break";
                }
                else if (oc) {
                    if (sig == 0x8074B50) {
                        is = i += 12 + (oc == -2 && 8), f = 3, this_1.c = 0;
                        return "break";
                    }
                    else if (sig == 0x2014B50) {
                        is = i -= 4, f = 3, this_1.c = 0;
                        return "break";
                    }
                }
            };
            var this_1 = this;
            for (; i < l - 4; ++i) {
                var state_1 = _loop_2();
                if (state_1 === "break")
                    break;
            }
            this.p = et;
            if (oc < 0) {
                var dat = f ? buf.subarray(0, is - 12 - (oc == -2 && 8) - (b4(buf, is - 16) == 0x8074B50 && 4)) : buf.subarray(0, i);
                if (add)
                    add.push(dat, !!f);
                else
                    this.k[+(f == 2)].push(dat);
            }
            if (f & 2)
                return this.push(buf.subarray(i), final);
            this.p = buf.subarray(i);
        }
        if (final) {
            if (this.c)
                err(13);
            this.p = null;
        }
    };
    /**
     * Registers a decoder with the stream, allowing for files compressed with
     * the compression type provided to be expanded correctly
     * @param decoder The decoder constructor
     */
    Unzip.prototype.register = function (decoder) {
        this.o[decoder.compression] = decoder;
    };
    return Unzip;
}());

var mt = typeof queueMicrotask == 'function' ? queueMicrotask : typeof setTimeout == 'function' ? setTimeout : function (fn) { fn(); };
function unzip(data, opts, cb) {
    if (!cb)
        cb = opts, opts = {};
    if (typeof cb != 'function')
        err(7);
    var term = [];
    var tAll = function () {
        for (var i = 0; i < term.length; ++i)
            term[i]();
    };
    var files = {};
    var cbd = function (a, b) {
        mt(function () { cb(a, b); });
    };
    mt(function () { cbd = cb; });
    var e = data.length - 22;
    for (; b4(data, e) != 0x6054B50; --e) {
        if (!e || data.length - e > 65558) {
            cbd(err(13, 0, 1), null);
            return tAll;
        }
    }
    ;
    var lft = b2(data, e + 8);
    if (lft) {
        var c = lft;
        var o = b4(data, e + 16);
        var z = o == 4294967295 || c == 65535;
        if (z) {
            var ze = b4(data, e - 12);
            z = b4(data, ze) == 0x6064B50;
            if (z) {
                c = lft = b4(data, ze + 32);
                o = b4(data, ze + 48);
            }
        }
        var fltr = opts && opts.filter;
        var _loop_3 = function (i) {
            var _a = zh(data, o, z), c_1 = _a[0], sc = _a[1], su = _a[2], fn = _a[3], no = _a[4], off = _a[5], b = slzh(data, off);
            o = no;
            var cbl = function (e, d) {
                if (e) {
                    tAll();
                    cbd(e, null);
                }
                else {
                    if (d)
                        files[fn] = d;
                    if (!--lft)
                        cbd(null, files);
                }
            };
            if (!fltr || fltr({
                name: fn,
                size: sc,
                originalSize: su,
                compression: c_1
            })) {
                if (!c_1)
                    cbl(null, slc(data, b, b + sc));
                else if (c_1 == 8) {
                    var infl = data.subarray(b, b + sc);
                    // Synchronously decompress under 512KB, or barely-compressed data
                    if (su < 524288 || sc > 0.8 * su) {
                        try {
                            cbl(null, inflateSync(infl, { out: new u8(su) }));
                        }
                        catch (e) {
                            cbl(e, null);
                        }
                    }
                    else
                        term.push(inflate(infl, { size: su }, cbl));
                }
                else
                    cbl(err(14, 'unknown compression type ' + c_1, 1), null);
            }
            else
                cbl(null, null);
        };
        for (var i = 0; i < c; ++i) {
            _loop_3(i);
        }
    }
    else
        cbd(null, {});
    return tAll;
}
/**
 * Synchronously decompresses a ZIP archive. Prefer using `unzip` for better
 * performance with more than one file.
 * @param data The raw compressed ZIP file
 * @param opts The ZIP extraction options
 * @returns The decompressed files
 */
function unzipSync(data, opts) {
    var files = {};
    var e = data.length - 22;
    for (; b4(data, e) != 0x6054B50; --e) {
        if (!e || data.length - e > 65558)
            err(13);
    }
    ;
    var c = b2(data, e + 8);
    if (!c)
        return {};
    var o = b4(data, e + 16);
    var z = o == 4294967295 || c == 65535;
    if (z) {
        var ze = b4(data, e - 12);
        z = b4(data, ze) == 0x6064B50;
        if (z) {
            c = b4(data, ze + 32);
            o = b4(data, ze + 48);
        }
    }
    var fltr = opts && opts.filter;
    for (var i = 0; i < c; ++i) {
        var _a = zh(data, o, z), c_2 = _a[0], sc = _a[1], su = _a[2], fn = _a[3], no = _a[4], off = _a[5], b = slzh(data, off);
        o = no;
        if (!fltr || fltr({
            name: fn,
            size: sc,
            originalSize: su,
            compression: c_2
        })) {
            if (!c_2)
                files[fn] = slc(data, b, b + sc);
            else if (c_2 == 8)
                files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
            else
                err(14, 'unknown compression type ' + c_2);
        }
    }
    return files;
}
return { unzipSync, zipSync, gzipSync, gunzipSync, Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough };
})();

// -- vendor/fzstd.module.mjs (MIT, see ext/archive/vendor/LICENSE-fzstd) --

const fzstd = (() => {
// Some numerical data is initialized as -1 even when it doesn't need initialization to help the JIT infer types
// aliases for shorter compressed code (most minifers don't do this)
var ab = ArrayBuffer, u8 = Uint8Array, u16 = Uint16Array, i16 = Int16Array, u32 = Uint32Array, i32 = Int32Array;
var slc = function (v, s, e) {
    if (u8.prototype.slice)
        return u8.prototype.slice.call(v, s, e);
    if (s == null || s < 0)
        s = 0;
    if (e == null || e > v.length)
        e = v.length;
    var n = new u8(e - s);
    n.set(v.subarray(s, e));
    return n;
};
var fill = function (v, n, s, e) {
    if (u8.prototype.fill)
        return u8.prototype.fill.call(v, n, s, e);
    if (s == null || s < 0)
        s = 0;
    if (e == null || e > v.length)
        e = v.length;
    for (; s < e; ++s)
        v[s] = n;
    return v;
};
var cpw = function (v, t, s, e) {
    if (u8.prototype.copyWithin)
        return u8.prototype.copyWithin.call(v, t, s, e);
    if (s == null || s < 0)
        s = 0;
    if (e == null || e > v.length)
        e = v.length;
    while (s < e) {
        v[t++] = v[s++];
    }
};
/**
 * Codes for errors generated within this library
 */
var ZstdErrorCode = {
    InvalidData: 0,
    WindowSizeTooLarge: 1,
    InvalidBlockType: 2,
    FSEAccuracyTooHigh: 3,
    DistanceTooFarBack: 4,
    UnexpectedEOF: 5
};
// error codes
var ec = [
    'invalid zstd data',
    'window size too large (>2046MB)',
    'invalid block type',
    'FSE accuracy too high',
    'match distance too far back',
    'unexpected EOF'
];
var err = function (ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
        Error.captureStackTrace(e, err);
    if (!nt)
        throw e;
    return e;
};
var rb = function (d, b, n) {
    var i = 0, o = 0;
    for (; i < n; ++i)
        o |= d[b++] << (i << 3);
    return o;
};
var b4 = function (d, b) { return (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0; };
// read Zstandard frame header
var rzfh = function (dat, w) {
    var n3 = dat[0] | (dat[1] << 8) | (dat[2] << 16);
    if (n3 == 0x2FB528 && dat[3] == 253) {
        // Zstandard
        var flg = dat[4];
        //    single segment       checksum             dict flag     frame content flag
        var ss = (flg >> 5) & 1, cc = (flg >> 2) & 1, df = flg & 3, fcf = flg >> 6;
        if (flg & 8)
            err(0);
        // byte
        var bt = 6 - ss;
        // dict bytes
        var db = df == 3 ? 4 : df;
        // dictionary id
        var di = rb(dat, bt, db);
        bt += db;
        // frame size bytes
        var fsb = fcf ? (1 << fcf) : ss;
        // frame source size
        var fss = rb(dat, bt, fsb) + ((fcf == 1) && 256);
        // window size
        var ws = fss;
        if (!ss) {
            // window descriptor
            var wb = 1 << (10 + (dat[5] >> 3));
            ws = wb + (wb >> 3) * (dat[5] & 7);
        }
        if (ws > 2145386496)
            err(1);
        var buf = new u8((w == 1 ? (fss || ws) : w ? 0 : ws) + 12);
        buf[0] = 1, buf[4] = 4, buf[8] = 8;
        return {
            b: bt + fsb,
            y: 0,
            l: 0,
            d: di,
            w: (w && w != 1) ? w : buf.subarray(12),
            e: ws,
            o: new i32(buf.buffer, 0, 3),
            u: fss,
            c: cc,
            m: Math.min(131072, ws)
        };
    }
    else if (((n3 >> 4) | (dat[3] << 20)) == 0x184D2A5) {
        // skippable
        return b4(dat, 4) + 8;
    }
    err(0);
};
// most significant bit for nonzero
var msb = function (val) {
    var bits = 0;
    for (; (1 << bits) <= val; ++bits)
        ;
    return bits - 1;
};
// read finite state entropy
var rfse = function (dat, bt, mal) {
    // table pos
    var tpos = (bt << 3) + 4;
    // accuracy log
    var al = (dat[bt] & 15) + 5;
    if (al > mal)
        err(3);
    // size
    var sz = 1 << al;
    // probabilities symbols  repeat   index   high threshold
    var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
    // optimization: single allocation is much faster
    var buf = new ab(512 + (sz << 2));
    var freq = new i16(buf, 0, 256);
    // same view as freq
    var dstate = new u16(buf, 0, 256);
    var nstate = new u16(buf, 512, sz);
    var bb1 = 512 + (sz << 1);
    var syms = new u8(buf, bb1, sz);
    var nbits = new u8(buf, bb1 + sz);
    while (sym < 255 && probs > 0) {
        var bits = msb(probs + 1);
        var cbt = tpos >> 3;
        // mask
        var msk = (1 << (bits + 1)) - 1;
        var val = ((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (tpos & 7)) & msk;
        // mask (1 fewer bit)
        var msk1fb = (1 << bits) - 1;
        // max small value
        var msv = msk - probs - 1;
        // small value
        var sval = val & msk1fb;
        if (sval < msv)
            tpos += bits, val = sval;
        else {
            tpos += bits + 1;
            if (val > msk1fb)
                val -= msv;
        }
        freq[++sym] = --val;
        if (val == -1) {
            probs += val;
            syms[--ht] = sym;
        }
        else
            probs -= val;
        if (!val) {
            do {
                // repeat byte
                var rbt = tpos >> 3;
                re = ((dat[rbt] | (dat[rbt + 1] << 8)) >> (tpos & 7)) & 3;
                tpos += 2;
                sym += re;
            } while (re == 3);
        }
    }
    if (sym > 255 || probs)
        err(0);
    var sympos = 0;
    // sym step (coprime with sz - formula from zstd source)
    var sstep = (sz >> 1) + (sz >> 3) + 3;
    // sym mask
    var smask = sz - 1;
    for (var s = 0; s <= sym; ++s) {
        var sf = freq[s];
        if (sf < 1) {
            dstate[s] = -sf;
            continue;
        }
        // This is split into two loops in zstd to avoid branching, but as JS is higher-level that is unnecessary
        for (i = 0; i < sf; ++i) {
            syms[sympos] = s;
            do {
                sympos = (sympos + sstep) & smask;
            } while (sympos >= ht);
        }
    }
    // After spreading symbols, should be zero again
    if (sympos)
        err(0);
    for (i = 0; i < sz; ++i) {
        // next state
        var ns = dstate[syms[i]]++;
        // num bits
        var nb = nbits[i] = al - msb(ns);
        nstate[i] = (ns << nb) - sz;
    }
    return [(tpos + 7) >> 3, {
            b: al,
            s: syms,
            n: nbits,
            t: nstate
        }];
};
// read huffman
var rhu = function (dat, bt) {
    //  index  weight count
    var i = 0, wc = -1;
    //    buffer             header byte
    var buf = new u8(292), hb = dat[bt];
    // huffman weights
    var hw = buf.subarray(0, 256);
    // rank count
    var rc = buf.subarray(256, 268);
    // rank index
    var ri = new u16(buf.buffer, 268);
    // NOTE: at this point bt is 1 less than expected
    if (hb < 128) {
        // end byte, fse decode table
        var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
        bt += hb;
        var epos = ebt << 3;
        // last byte
        var lb = dat[bt];
        if (!lb)
            err(0);
        //  state1   state2   state1 bits   state2 bits
        var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
        // fse pos
        // pre-increment to account for original deficit of 1
        var fpos = (++bt << 3) - 8 + msb(lb);
        for (;;) {
            fpos -= btr1;
            if (fpos < epos)
                break;
            var cbt = fpos >> 3;
            st1 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr1) - 1);
            hw[++wc] = fdt.s[st1];
            fpos -= btr2;
            if (fpos < epos)
                break;
            cbt = fpos >> 3;
            st2 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr2) - 1);
            hw[++wc] = fdt.s[st2];
            btr1 = fdt.n[st1];
            st1 = fdt.t[st1];
            btr2 = fdt.n[st2];
            st2 = fdt.t[st2];
        }
        if (++wc > 255)
            err(0);
    }
    else {
        wc = hb - 127;
        for (; i < wc; i += 2) {
            var byte = dat[++bt];
            hw[i] = byte >> 4;
            hw[i + 1] = byte & 15;
        }
        ++bt;
    }
    // weight exponential sum
    var wes = 0;
    for (i = 0; i < wc; ++i) {
        var wt = hw[i];
        // bits must be at most 11, same as weight
        if (wt > 11)
            err(0);
        wes += wt && (1 << (wt - 1));
    }
    // max bits
    var mb = msb(wes) + 1;
    // table size
    var ts = 1 << mb;
    // remaining sum
    var rem = ts - wes;
    // must be power of 2
    if (rem & (rem - 1))
        err(0);
    hw[wc++] = msb(rem) + 1;
    for (i = 0; i < wc; ++i) {
        var wt = hw[i];
        ++rc[hw[i] = wt && (mb + 1 - wt)];
    }
    // huf buf
    var hbuf = new u8(ts << 1);
    //    symbols                      num bits
    var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
    ri[mb] = 0;
    for (i = mb; i > 0; --i) {
        var pv = ri[i];
        fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << (mb - i)));
    }
    if (ri[0] != ts)
        err(0);
    for (i = 0; i < wc; ++i) {
        var bits = hw[i];
        if (bits) {
            var code = ri[bits];
            fill(syms, i, code, ri[bits] = code + (1 << (mb - bits)));
        }
    }
    return [bt, {
            n: nb,
            b: mb,
            s: syms
        }];
};
// Tables generated using this:
// https://gist.github.com/101arrowz/a979452d4355992cbf8f257cbffc9edd
// default literal length table
var dllt = /*#__PURE__*/ rfse(/*#__PURE__*/ new u8([
    81, 16, 99, 140, 49, 198, 24, 99, 12, 33, 196, 24, 99, 102, 102, 134, 70, 146, 4
]), 0, 6)[1];
// default match length table
var dmlt = /*#__PURE__*/ rfse(/*#__PURE__*/ new u8([
    33, 20, 196, 24, 99, 140, 33, 132, 16, 66, 8, 33, 132, 16, 66, 8, 33, 68, 68, 68, 68, 68, 68, 68, 68, 36, 9
]), 0, 6)[1];
// default offset code table
var doct = /*#__PURE__ */ rfse(/*#__PURE__*/ new u8([
    32, 132, 16, 66, 102, 70, 68, 68, 68, 68, 36, 73, 2
]), 0, 5)[1];
// bits to baseline
var b2bl = function (b, s) {
    var len = b.length, bl = new i32(len);
    for (var i = 0; i < len; ++i) {
        bl[i] = s;
        s += 1 << b[i];
    }
    return bl;
};
// literal length bits
var llb = /*#__PURE__ */ new u8(( /*#__PURE__ */new i32([
    0, 0, 0, 0, 16843009, 50528770, 134678020, 202050057, 269422093
])).buffer, 0, 36);
// literal length baseline
var llbl = /*#__PURE__ */ b2bl(llb, 0);
// match length bits
var mlb = /*#__PURE__ */ new u8(( /*#__PURE__ */new i32([
    0, 0, 0, 0, 0, 0, 0, 0, 16843009, 50528770, 117769220, 185207048, 252579084, 16
])).buffer, 0, 53);
// match length baseline
var mlbl = /*#__PURE__ */ b2bl(mlb, 3);
// decode huffman stream
var dhu = function (dat, out, hu) {
    var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
    if (!lb)
        err(0);
    var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
    for (; pos > eb && i < ss;) {
        var cbt = pos >> 3;
        var val = (dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (pos & 7);
        st = ((st << btr) | val) & msk;
        out[++i] = hu.s[st];
        pos -= (btr = hu.n[st]);
    }
    if (pos != eb || i + 1 != ss)
        err(0);
};
// decode huffman stream 4x
// TODO: use workers to parallelize
var dhu4 = function (dat, out, hu) {
    var bt = 6;
    var ss = out.length, sz1 = (ss + 3) >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
    dhu(dat.subarray(bt, bt += dat[0] | (dat[1] << 8)), out.subarray(0, sz1), hu);
    dhu(dat.subarray(bt, bt += dat[2] | (dat[3] << 8)), out.subarray(sz1, sz2), hu);
    dhu(dat.subarray(bt, bt += dat[4] | (dat[5] << 8)), out.subarray(sz2, sz3), hu);
    dhu(dat.subarray(bt), out.subarray(sz3), hu);
};
// read Zstandard block
var rzb = function (dat, st, out) {
    var _a;
    var bt = st.b;
    //    byte 0        block type
    var b0 = dat[bt], btype = (b0 >> 1) & 3;
    st.l = b0 & 1;
    var sz = (b0 >> 3) | (dat[bt + 1] << 5) | (dat[bt + 2] << 13);
    // end byte for block
    var ebt = (bt += 3) + sz;
    if (btype == 1) {
        if (bt >= dat.length)
            return;
        st.b = bt + 1;
        if (out) {
            fill(out, dat[bt], st.y, st.y += sz);
            return out;
        }
        return fill(new u8(sz), dat[bt]);
    }
    if (ebt > dat.length)
        return;
    if (btype == 0) {
        st.b = ebt;
        if (out) {
            out.set(dat.subarray(bt, ebt), st.y);
            st.y += sz;
            return out;
        }
        return slc(dat, bt, ebt);
    }
    if (btype == 2) {
        //    byte 3        lit btype     size format
        var b3 = dat[bt], lbt = b3 & 3, sf = (b3 >> 2) & 3;
        // lit src size  lit cmp sz 4 streams
        var lss = b3 >> 4, lcs = 0, s4 = 0;
        if (lbt < 2) {
            if (sf & 1)
                lss |= (dat[++bt] << 4) | ((sf & 2) && (dat[++bt] << 12));
            else
                lss = b3 >> 3;
        }
        else {
            s4 = sf;
            if (sf < 2)
                lss |= ((dat[++bt] & 63) << 4), lcs = (dat[bt] >> 6) | (dat[++bt] << 2);
            else if (sf == 2)
                lss |= (dat[++bt] << 4) | ((dat[++bt] & 3) << 12), lcs = (dat[bt] >> 2) | (dat[++bt] << 6);
            else
                lss |= (dat[++bt] << 4) | ((dat[++bt] & 63) << 12), lcs = (dat[bt] >> 6) | (dat[++bt] << 2) | (dat[++bt] << 10);
        }
        ++bt;
        // add literals to end - can never overlap with backreferences because unused literals always appended
        var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
        // starting point for literals
        var spl = buf.length - lss;
        if (lbt == 0)
            buf.set(dat.subarray(bt, bt += lss), spl);
        else if (lbt == 1)
            fill(buf, dat[bt++], spl);
        else {
            // huffman table
            var hu = st.h;
            if (lbt == 2) {
                var hud = rhu(dat, bt);
                // subtract description length
                lcs += bt - (bt = hud[0]);
                st.h = hu = hud[1];
            }
            else if (!hu)
                err(0);
            (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
        }
        // num sequences
        var ns = dat[bt++];
        if (ns) {
            if (ns == 255)
                ns = (dat[bt++] | (dat[bt++] << 8)) + 0x7F00;
            else if (ns > 127)
                ns = ((ns - 128) << 8) | dat[bt++];
            // symbol compression modes
            var scm = dat[bt++];
            if (scm & 3)
                err(0);
            var dts = [dmlt, doct, dllt];
            for (var i = 2; i > -1; --i) {
                var md = (scm >> ((i << 1) + 2)) & 3;
                if (md == 1) {
                    // rle buf
                    var rbuf = new u8([0, 0, dat[bt++]]);
                    dts[i] = {
                        s: rbuf.subarray(2, 3),
                        n: rbuf.subarray(0, 1),
                        t: new u16(rbuf.buffer, 0, 1),
                        b: 0
                    };
                }
                else if (md == 2) {
                    // accuracy log 8 for offsets, 9 for others
                    _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
                }
                else if (md == 3) {
                    if (!st.t)
                        err(0);
                    dts[i] = st.t[i];
                }
            }
            var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
            var lb = dat[ebt - 1];
            if (!lb)
                err(0);
            var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
            var lst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << llt.b) - 1);
            cbt = (spos -= oct.b) >> 3;
            var ost = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << oct.b) - 1);
            cbt = (spos -= mlt.b) >> 3;
            var mst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mlt.b) - 1);
            for (++ns; --ns;) {
                var llc = llt.s[lst];
                var lbtr = llt.n[lst];
                var mlc = mlt.s[mst];
                var mbtr = mlt.n[mst];
                var ofc = oct.s[ost];
                var obtr = oct.n[ost];
                cbt = (spos -= ofc) >> 3;
                var ofp = 1 << ofc;
                var off = ofp + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16) | (dat[cbt + 3] << 24)) >>> (spos & 7)) & (ofp - 1));
                cbt = (spos -= mlb[mlc]) >> 3;
                var ml = mlbl[mlc] + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << mlb[mlc]) - 1));
                cbt = (spos -= llb[llc]) >> 3;
                var ll = llbl[llc] + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << llb[llc]) - 1));
                cbt = (spos -= lbtr) >> 3;
                lst = llt.t[lst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << lbtr) - 1));
                cbt = (spos -= mbtr) >> 3;
                mst = mlt.t[mst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mbtr) - 1));
                cbt = (spos -= obtr) >> 3;
                ost = oct.t[ost] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << obtr) - 1));
                if (off > 3) {
                    st.o[2] = st.o[1];
                    st.o[1] = st.o[0];
                    st.o[0] = off -= 3;
                }
                else {
                    var idx = off - (ll != 0);
                    if (idx) {
                        off = idx == 3 ? st.o[0] - 1 : st.o[idx];
                        if (idx > 1)
                            st.o[2] = st.o[1];
                        st.o[1] = st.o[0];
                        st.o[0] = off;
                    }
                    else
                        off = st.o[0];
                }
                for (var i = 0; i < ll; ++i) {
                    buf[oubt + i] = buf[spl + i];
                }
                oubt += ll, spl += ll;
                var stin = oubt - off;
                if (stin < 0) {
                    var len = -stin;
                    var bs = st.e + stin;
                    if (len > ml)
                        len = ml;
                    for (var i = 0; i < len; ++i) {
                        buf[oubt + i] = st.w[bs + i];
                    }
                    oubt += len, ml -= len, stin = 0;
                }
                for (var i = 0; i < ml; ++i) {
                    buf[oubt + i] = buf[stin + i];
                }
                oubt += ml;
            }
            if (oubt != spl) {
                while (spl < buf.length) {
                    buf[oubt++] = buf[spl++];
                }
            }
            else
                oubt = buf.length;
            if (out)
                st.y += oubt;
            else
                buf = slc(buf, 0, oubt);
        }
        else if (out) {
            st.y += lss;
            if (spl) {
                for (var i = 0; i < lss; ++i) {
                    buf[i] = buf[spl + i];
                }
            }
        }
        else if (spl)
            buf = slc(buf, spl);
        st.b = ebt;
        return buf;
    }
    err(2);
};
// concat
var cct = function (bufs, ol) {
    if (bufs.length == 1)
        return bufs[0];
    var buf = new u8(ol);
    for (var i = 0, b = 0; i < bufs.length; ++i) {
        var chk = bufs[i];
        buf.set(chk, b);
        b += chk.length;
    }
    return buf;
};
/**
 * Decompresses Zstandard data
 * @param dat The input data
 * @param buf The output buffer. If unspecified, the function will allocate
 *            exactly enough memory to fit the decompressed data. If your
 *            data has multiple frames and you know the output size, specifying
 *            it will yield better performance.
 * @returns The decompressed data
 */
function decompress(dat, buf) {
    var bufs = [], nb = +!buf;
    var bt = 0, ol = 0;
    for (; dat.length;) {
        var st = rzfh(dat, nb || buf);
        if (typeof st == 'object') {
            if (nb) {
                buf = null;
                if (st.w.length == st.u) {
                    bufs.push(buf = st.w);
                    ol += st.u;
                }
            }
            else {
                bufs.push(buf);
                st.e = 0;
            }
            for (; !st.l;) {
                var blk = rzb(dat, st, buf);
                if (!blk)
                    err(5);
                if (buf)
                    st.e = st.y;
                else {
                    bufs.push(blk);
                    ol += blk.length;
                    cpw(st.w, 0, blk.length);
                    st.w.set(blk, st.w.length - blk.length);
                }
            }
            bt = st.b + (st.c * 4);
        }
        else
            bt = st;
        dat = dat.subarray(bt);
    }
    return cct(bufs, ol);
}
/**
 * Decompressor for Zstandard streamed data
 */
var Decompress = /*#__PURE__*/ (function () {
    /**
     * Creates a Zstandard decompressor
     * @param ondata The handler for stream data
     */
    function Decompress(ondata) {
        this.ondata = ondata;
        this.c = [];
        this.l = 0;
        this.z = 0;
    }
    /**
     * Pushes data to be decompressed
     * @param chunk The chunk of data to push
     * @param final Whether or not this is the last chunk in the stream
     */
    Decompress.prototype.push = function (chunk, final) {
        if (typeof this.s == 'number') {
            var sub = Math.min(chunk.length, this.s);
            chunk = chunk.subarray(sub);
            this.s -= sub;
        }
        var sl = chunk.length;
        var ncs = sl + this.l;
        if (!this.s) {
            if (final) {
                if (!ncs) {
                    this.ondata(new u8(0), true);
                    return;
                }
                // min for frame + one block
                if (ncs < 5)
                    err(5);
            }
            else if (ncs < 18) {
                this.c.push(chunk);
                this.l = ncs;
                return;
            }
            if (this.l) {
                this.c.push(chunk);
                chunk = cct(this.c, ncs);
                this.c = [];
                this.l = 0;
            }
            if (typeof (this.s = rzfh(chunk)) == 'number')
                return this.push(chunk, final);
        }
        if (typeof this.s != 'number') {
            if (ncs < (this.z || 3)) {
                if (final)
                    err(5);
                this.c.push(chunk);
                this.l = ncs;
                return;
            }
            if (this.l) {
                this.c.push(chunk);
                chunk = cct(this.c, ncs);
                this.c = [];
                this.l = 0;
            }
            if (!this.z && ncs < (this.z = (chunk[this.s.b] & 2) ? 4 : 3 + ((chunk[this.s.b] >> 3) | (chunk[this.s.b + 1] << 5) | (chunk[this.s.b + 2] << 13)))) {
                if (final)
                    err(5);
                this.c.push(chunk);
                this.l = ncs;
                return;
            }
            else
                this.z = 0;
            for (;;) {
                var blk = rzb(chunk, this.s);
                if (!blk) {
                    if (final)
                        err(5);
                    var adc = chunk.subarray(this.s.b);
                    this.s.b = 0;
                    this.c.push(adc), this.l += adc.length;
                    return;
                }
                else {
                    this.ondata(blk, false);
                    cpw(this.s.w, 0, blk.length);
                    this.s.w.set(blk, this.s.w.length - blk.length);
                }
                if (this.s.l) {
                    var rest = chunk.subarray(this.s.b);
                    this.s = this.s.c * 4;
                    this.push(rest, final);
                    return;
                }
            }
        }
        else if (final)
            err(5);
    };
    return Decompress;
}());
return { decompress, Decompress, ZstdErrorCode };
})();

// -- vendor/xz-decompress.module.mjs (MIT, see ext/archive/vendor/LICENSE-xz-decompress) --

const xzDecompress = (() => {
/* @gcu/archive — vendored xz-decompress 0.2.3 (MIT)
 *
 * httptoolkit fork of xzwasm by Steve Sanderson, bundling xz-embedded
 * (Lasse Collin + Igor Pavlov, public domain) and walloc (Igalia, MIT).
 * Original attribution preserved in the UMD payload header below.
 *
 * Sourced from https://registry.npmjs.org/xz-decompress/-/xz-decompress-0.2.3.tgz
 * — see ext/archive/vendor/LICENSE-xz-decompress for the full license text.
 *
 * The UMD wrapper expects CommonJS module / exports / require globals; we
 * provide them locally so the IIFE leaves nothing on globalThis. The
 * factory uses globalThis.ReadableStream directly (not the stream/web
 * import arg), so the require shim's return value is irrelevant beyond
 * being non-throwing. */

const _xzd = (() => {
  const exports = {};
  const module = { exports };
  const require = (id) => {
    if (id === 'stream/web') {
      return {
        ReadableStream: globalThis.ReadableStream,
        WritableStream: globalThis.WritableStream,
        TransformStream: globalThis.TransformStream,
      };
    }
    throw new Error('xz-decompress vendor shim: unexpected require(' + id + ')');
  };

/*!
 * Based on xzwasm (c) Steve Sanderson. License: MIT - https://github.com/SteveSanderson/xzwasm
 * Contains xz-embedded by Lasse Collin and Igor Pavlov. License: Public domain - https://tukaani.org/xz/embedded.html
 * and walloc (c) 2020 Igalia, S.L. License: MIT - https://github.com/wingo/walloc
 */
!function(A,I){"object"==typeof exports&&"object"==typeof module?module.exports=I(require("stream/web")):"function"==typeof define&&define.amd?define(["stream/web"],I):"object"==typeof exports?exports["xz-decompress"]=I(require("stream/web")):A["xz-decompress"]=I(A["stream/web"])}(this,(A=>(()=>{"use strict";var I=[,A=>{A.exports="data:application/wasm;base64,AGFzbQEAAAABOApgAX8Bf2ABfwBgAABgA39/fwF/YAABf2ACf38AYAN/f34BfmACf38Bf2AEf39/fwF/YAN/f38AAyEgAAABAgMDAwMEAQUAAgMCBgcIBwUDAAMHAQcABwcBAwkFAwEAAgYIAX8BQfCgBAsHTgUGbWVtb3J5AgAOY3JlYXRlX2NvbnRleHQACA9kZXN0cm95X2NvbnRleHQACQxzdXBwbHlfaW5wdXQACg9nZXRfbmV4dF9vdXRwdXQACwqQYCDfAgEFf0EAIQECQCAAQQdqIgJBEEkNAEEBIQEgAkEDdiIDQQJGDQBBAiEBIAJBIEkNAEEDIQEgA0EERg0AQQQhASACQTBJDQBBBSEBIANBBkYNAEEGIQEgAkHIAEkNAEEHIQEgAkHYAEkNAEEIIQEgAkGIAUkNAEEJIQEgAkGIAkkNACAAEIGAgIAAIgBBCGpBACAAGw8LAkACQCABQQJ0QcCIgIAAaiIEKAIAIgANAEEAIQACQAJAQQAoAuSIgIAAIgJFDQBBACACKAIANgLkiICAAAwBC0EAEIGAgIAAIgJFDQILIAJBgIB8cSIAIAJBCHZB/wFxIgJyIAE6AAAgACACQQh0ckGAAmohAEEAIQJBACABQQJ0QYCIgIAAaigCACIDayEFIAMhAQNAIAAgBWoiACACNgIAIAAhAiABIANqIgFBgQJJDQALIAQgADYCAAsgBCAAKAIANgIACyAAC/QHAQh/QQAoArCIgIAAIQECQAJAAkACQAJAQQAtALSIgIAARQ0AQQBBADoAtIiAgAAgAUUNAUGwiICAACECA0ACQAJAIAFBCGoiAyABKAIEIgRqIgVBCHZB/wFxIgYNACABIQIMAQsCQANAIAVBgIB8cSAGai0AAEH+AUcNAUGwiICAACEGA0AgBiIHKAIAIgYgBUcNAAsgByAFKAIANgIAIAEgBCAFKAIEakEIaiIENgIEIAcgAiACIAVGGyECIAMgBGoiBUEIdkH/AXEiBg0ACwsgAigCACECCyACKAIAIgENAAtBACgCsIiAgAAhAQsgAUUNACAAQYcCakGAfnEhCEF/IQJBsIiAgAAhBEEAIQNBsIiAgAAhBgNAIAYhBwJAIAEiBigCBCIFIABJDQAgBSACTw0AIAUhAiAHIQQgBiEDIAVBCGogCEcNACAHIQQgBSECIAYhAwwECyAGKAIAIgENAAsgAw0CDAELQbCIgIAAIQQLPwBBEHQhASAAQYgCaiEHQQAhAwJAAkBBACgCuIiAgAAiAkUNAEEAIQUgASEGDAELQQAgAUHwoISAAEH//wNqQYCAfHEiBmsiAjYCuIiAgAAgAiEFCwJAIAcgBU0NACACQQF2IgIgByAFayIHIAIgB0sbQf//A2oiB0EQdkAAQX9GDQJBAEEAKAK4iICAACAHQYCAfHEiA2o2AriIgIAACyAGRQ0BIAZB/wE6AAEgBkEAKAKwiICAADYCgAIgBkGEAmogAyAFakGAgHxxQfh9aiICNgIAIAZBgAJqIQMLIANBgIB8cSIGIANBCHZB/wFxckH/AToAACAEIAMoAgA2AgACQCACIABrQYB+cSIFDQAgAw8LIAMhAQJAIAYgBUF/cyADQQhqIgQgAmoiB2pBgIB8cUYNACAEQf//A3EhBQJAIABB9/0DSw0AIAYgBEEIdkH/AXFqQf4BOgAAIANBACgCsIiAgAA2AgAgA0GAgAQgBWsiBTYCBEEAIAM2ArCIgIAAEIOAgIAAIAZBhIIEaiACIAVrQfh9aiIFNgIAIAZBgYAEakH/AToAACAGQYCCBGohASAFIABrQYB+cSEFDAELIAIgBWogACAFakH//3tqQYCAfHFrQYCAeGohBSADIQELIAEgASgCBCAFazYCBCAFQfgBaiEGIAcgBWtBCHZB/wFxIQUCQANAIAYiB0GAfmohBiAFIgQNAUEBIQUgB0H4AUcNAAsLAkAgB0H4AUYNACACIANqIAZrQYCAfHEiBSAEakH+AToAACAFIARBCHRqIgVBACgCsIiAgAA2AgAgBSAGNgIEQQAgBTYCsIiAgAAQg4CAgAALIAEPC0EAC3wBAn8CQCAARQ0AAkAgAEGAgHxxIABBCHZB/wFxciIBLQAAIgJB/wFHDQAgAEF4aiIAQQAoArCIgIAANgIAQQAgADYCsIiAgAAgAUH+AToAAEEAQQE6ALSIgIAADwsgACACQQJ0QcCIgIAAaiICKAIANgIAIAIgADYCAAsLawECfwJAQQAoArCIgIAAIgAoAgRB/wFLDQAgAEGAgHxxIgEgAEEIdkH/AXEiAHJBCToAAEEAQQAoArCIgIAAKAIANgKwiICAACABIABBCHRyIgBBACgC5IiAgAA2AgBBACAANgLkiICAAAsLTgECfwJAIAAgAUYNACACRQ0AA0ACQCAALQAAIgMgAS0AACIERg0AQQFBfyADIARLGw8LIAFBAWohASAAQQFqIQAgAkF/aiICDQALC0EAC3gBAX8CQAJAIAAgAU8NACACRQ0BIAAhAwNAIAMgAS0AADoAACABQQFqIQEgA0EBaiEDIAJBf2oiAg0ADAILCyAAIAFNDQAgAkUNACABQX9qIQEgAEF/aiEDA0AgAyACaiABIAJqLQAAOgAAIAJBf2oiAg0ACwsgAAssAQF/AkAgAkUNACAAIQMDQCADIAE6AAAgA0EBaiEDIAJBf2oiAg0ACwsgAAt/AQF/AkACQCABIAByIAJyQQNxRQ0AIAJFDQEgACEDA0AgAyABLQAAOgAAIAFBAWohASADQQFqIQMgAkF/aiICDQAMAgsLIAJBBEkNACACQQJ2IQIgACEDA0AgAyABKAIANgIAIAFBBGohASADQQRqIQMgAkF/aiICDQALCyAAC4gBAQJ/AkBBAC0A6IiAgAANAEEAQQE6AOiIgIAAEIyAgIAAEI6AgIAAC0GggAgQgICAgAAiAEGAgAQ2AgBBAkGAgIAgEJeAgIAAIQEgAEEUakKAgICAgIDAADcCACAAQRBqIABBoIAEajYCACAAQQhqQgA3AgAgACAAQSBqNgIEIAAgATYCHCAACxUAIAAoAhwQmICAgAAgABCCgICAAAsWACAAQQxqIAE2AgAgAEEIakEANgIACxsAIAAoAhwgAEEEaiAAQQxqKAIARRCWgICAAAtUAQN/QQAhAANAQQghASAAIQIDQEEAIAJBAXFrQaCG4u1+cSACQQF2cyECIAFBf2oiAQ0ACyAAQQJ0QfCIgIAAaiACNgIAIABBAWoiAEGAAkcNAAsLTgACQCABRQ0AIAJBf3MhAgNAIAJB/wFxIAAtAABzQQJ0QfCIgIAAaigCACACQQh2cyECIABBAWohACABQX9qIgENAAsgAkF/cyECCyACC10DAX4BfwF+QgAhAANAQQghASAAIQIDQEIAIAJCAYN9QsKenLzd8pW2SYMgAkIBiIUhAiABQX9qIgENAAsgAKdBA3RB8JCAgABqIAI3AwAgAEIBfCIAQoACUg0ACwtPAAJAIAFFDQAgAkJ/hSECA0AgAkL/AYMgADEAAIWnQQN0QfCQgIAAaikDACACQgiIhSECIABBAWohACABQX9qIgENAAsgAkJ/hSECCyACC8oQAgx/An4CQAJAIAAoAiRFDQAgACgCACECDAELQQAhAiAAQQA6ACggAEIANwMAIABCADcDGCAAQcgAakEAQeQAEIaAgIAAGiAAQawBakEMNgIACyAAIAEoAgQiAzYCECAAQeAAaiEEIABByABqIQUgAEG2AWohBiAAQbABaiEHIABBqAFqIQggASgCECEJAkACQAJAAkADQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCACDgoBAgAEBQYHCAkKDwsgASgCACEKIAAoAqgBIQIgACgCrAEhCyABKAIEIQwgASgCCCENDAILIAcgACgCqAEiDGogASgCACABKAIEIgJqIAEoAgggAmsiAiAAKAKsASAMayIMIAIgDEkbIgIQh4CAgAAaIAEgASgCBCACajYCBEEAIQwgAEEAIAAoAqgBIAJqIgIgAiAAKAKsASILRhs2AqgBIAIgC0cNESAAQQE2AgACQCAHQaiIgIAAQQYQhICAgABFDQBBBSEMDBILIAZBAkEAEI2AgIAAIAAoALgBRw0QQQYhDCAGLQAADREgACAALQC3ASICNgIgIAJBBEsNEUEBIAJ0QRNxRQ0RCyABKAIEIgwgASgCCCINRg0OAkAgASgCACIKIAxqLQAAIgsNACAAIAw2AhAgASAMQQFqNgIEQQYhAgwMC0EAIQIgAEEANgKoASAAQQI2AgAgACALQQJ0QQRqIgs2AqwBIAAgCzYCQAsgByACaiAKIAxqIA0gDGsiDCALIAJrIgIgDCACSRsiAhCHgICAABogASABKAIEIAJqNgIEQQAhDCAAQQAgACgCqAEgAmoiAiACIAAoAqwBIgtGGzYCqAEgAiALRw0PIAAgAkF8aiICNgKsAUEHIQwgByACQQAQjYCAgAAgByAAKAKsASICaigAAEcNDyAAQQI2AqgBIAAtALEBIgtBP3ENDAJAAkAgC0HAAHFFDQAgACAHIAggAhCRgICAAEEBRw0RIAAgACkDCDcDMCAAKAKsASECIAAtALEBIQsMAQsgAEJ/NwMwC0J/IQ4CQCALwEF/Sg0AIAAgByAIIAIQkYCAgABBAUcNECAAKAKsASECIAApAwghDgsgACAONwM4IAIgACgCqAEiC2tBAkkNDyAAIAtBAWoiCjYCqAEgCCALakEIai0AAEEhRw0MIAAgC0ECaiINNgKoASAIIApqQQhqLQAAQQFHDQwgAiANRg0PIAAgC0EDajYCqAEgACgCsAkgCCANakEIai0AABCcgICAACIMDQ8gACgCrAEiAiAAKAKoASIMIAIgDEsbIQ0CQANAIA0gDEYNASAAIAxBAWoiAjYCqAEgACAMaiELIAIhDCALQbABai0AAA0ODAALCyAFQgA3AwAgAEEANgKoASAAQQM2AgAgBUEIakIANwMACyAAIAEoAgQ2AhAgACABKAIQNgIUIAAoArAJIAEQmYCAgAAhDCAAIAApA0ggASgCBCAAKAIQa618Ig43A0ggACAAKQNQIAEoAhAgACgCFCICayILrXwiDzcDUCAOIAApAzBWDQ0gDyAAKQM4Vg0NAkACQAJAAkAgACgCIEF/ag4EAAMDAQMLIAEoAgwgAmogCyAAKAIYEI2AgIAArSEODAELIAEoAgwgAmogCyAAKQMYEI+AgIAAIQ4LIAAgDjcDGAsgDEEBRw0OAkAgACkDMCIOQn9RDQAgDiAFKQMAUg0OCwJAIAApAzgiDkJ/UQ0AQQchDCAOIAApA1BSDQ8LIAAgACkDSCAANQJAfCAAKQNgfCIPNwNgQgQhDgJAAkACQCAAKAIgQX9qDgQBAgIAAgtCCCEOCyAEIA4gD3w3AwALIAAgACkDaCAAKQNQfDcDaCAAIARBGCAAKAJwEI2AgIAANgJwIABBBDYCACAAIAApA1hCAXw3A1gLAkAgBSkDACIOQgODUA0AIA5CAXwhDiABKAIEIQwgASgCCCELA0AgCyAMRg0NIAEgDEEBaiICNgIEIAEoAgAgDGotAAANDiAFIA43AwAgDkIDgyEPIA5CAXwhDiACIQwgD0IAUg0ACwsgAEEFNgIAC0EBIQIgACgCIEF/ag4EBgcHBQcLIAAgARCSgICAACIMQQFHDQsgAEEHNgIAC0EAIAAoAhBrIQUgAEGAAWopAwAhDiABKAIEIQwCQANAIA4gBSAMaq18QgODUA0BAkAgDCABKAIIRw0AIAAgARCTgICAAAwLCyABIAxBAWoiAjYCBCABKAIAIAxqIQsgAiEMIAstAAANCwwACwsgACABEJOAgIAAQQchDCAEIABBkAFqQRgQhICAgAANCiAAQQg2AgALIAAgAUEgEJSAgIAAIgxBAUcNCSAAQQk2AgBBDCELIABBDDYCrAEMAQsgACgCrAEhCwsgByAAKAKoASIMaiABKAIAIAEoAgQiAmogASgCCCACayICIAsgDGsiDCACIAxJGyICEIeAgIAAGiABIAEoAgQgAmo2AgRBACEMIABBACAAKAKoASACaiICIAIgACgCrAEiC0YbNgKoASACIAtHDQcgABCVgICAACEMDAcLQQEhAiAAIAFBwAAQlICAgAAiDEEBRw0GDAELQQEhAiAAIAFBIBCUgICAACIMQQFHDQULIAAgAjYCAAwACwtBBiEMDAILQQAhDAwBC0EHIQwLAkACQCAAKAIkDQACQAJAIAwOAgADAQtBB0EIIAEoAgQgASgCCEYbIQwLIAEgCTYCECABIAM2AgQgDA8LAkAgDA0AIAMgASgCBEcNACAJIAEoAhBHDQAgAC0AKCEBIABBAToAKCABQQN0DwsgAEEAOgAoCyAMC6YBAQN/AkAgACgCBCIEDQAgAEIANwMICyACKAIAIgUgAyAFIANLGyEGA0ACQCAGIAVHDQBBAA8LIAEgBWotAAAhAyACIAVBAWoiBTYCACAAIANB/wBxrSAErYYgACkDCIQ3AwgCQAJAIAPAIgNBAEgNAAJAIAMNAEEHIQMgBA0CCyAAQQA2AgRBAQ8LQQchAyAAIARBB2oiBDYCBCAEQT9HDQELCyADC6ECAgN/AX4gAEGQAWohAiABQQRqIQMDQAJAIAAgASgCACADIAEoAggQkYCAgAAiBEEBRg0AIABBgAFqIgMgAykDACABKAIEIAAoAhAiA2siAq18NwMAIAAgAyABKAIAaiACIAAoAhgQjYCAgACtNwMYIAQPCwJAAkACQAJAAkAgACgCeA4DAAIBAwsgACAAKQMIIgU3A4gBAkAgBSAAKQNYUQ0AQQcPCyAAQQE2AngMAwsgACAAKQOYASAAKQMIfDcDmAEgACACQRggACgCoAEQjYCAgAA2AqABIABBATYCeCAAIAApA4gBQn98IgU3A4gBDAILIABBAjYCeCAAIAApA5ABIAApAwh8NwOQAQsgACkDiAEhBQsgBUIAUg0AC0EBC0ABAn8gAEGAAWoiAiACKQMAIAEoAgQgACgCECICayIDrXw3AwAgACACIAEoAgBqIAMgACgCGBCNgICAAK03AxgLfAEEfyABKAIEIQMgASgCCCEEA0ACQCAEIANHDQBBAA8LIAEgA0EBaiIFNgIEAkAgASgCACADai0AACAAKQMYIAAoAgQiA62Ip0H/AXFGDQBBBw8LIAAgA0EIaiIGNgIEIAUhAyAGIAJJDQALIABBADYCBCAAQgA3AxhBAQtvAQF/QQchAQJAIABBugFqLwAAQdm0AUcNACAAQbQBakEGQQAQjYCAgAAgAEGwAWooAABHDQAgAEGAAWopAwBCAoggADUAtAFSDQAgAEG4AWotAAANAEEBQQcgACgCICAAQbkBai0AAEYbIQELIAELwAIBA38CQAJAAkAgACgCJA0AIABBADoAKCAAQQA2AgBBASECDAELAkAgACgCAEEKRw0AQQAhAwwCC0ECIQMMAQtBASEDCwJAAkADQAJAAkACQAJAIAMOAwABAwMLIAEoAgQiAyABKAIIIgRGDQQgASgCACEFAkADQCAFIANqLQAADQEgASADQQFqIgM2AgQgACAAKAIEQQFqQQNxNgIEIAQgA0YNBgwACwsCQCAAKAIERQ0AQQcPCyAAKAIkRQ0BIABBADoAKCAAQQA2AgBBASEDDAMLIABCADcDGCAAQQA2AgQgAEHIAGpBAEHkABCGgICAABogAEGsAWpBDDYCAAtBAiEDDAELIAAgARCQgICAACIDQQFHDQIgAEEKNgIAQQAhAwwACwsCQCACDQBBAA8LQQdBASAAKAIEGyEDCyADC3UBAX8CQEG4CRCAgICAACICRQ0AIAIgADYCJCACIAAgARCbgICAACIANgKwCQJAIABFDQAgAkEAOgAoIAJCADcDACACQgA3AxggAkHIAGpBAEHkABCGgICAABogAkGsAWpBDDYCACACDwsgAhCCgICAAAtBAAseAAJAIABFDQAgACgCsAkQnYCAgAAgABCCgICAAAsL3RABCn8gAEHo3QFqIQIgAEHUAGohAyAAQRxqIgRBCGohBQJAAkADQCAAKAJAIQYCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgASgCBCIHIAEoAghJDQAgBkEHRg0BDBELIAYOCQECAwQFBgcACQ4LIAAoAkwhBgwHC0EBIQYgASAHQQFqNgIEIAEoAgAgB2otAAAiB0UNCAJAAkAgB0HfAUsNACAHQQFHDQELIABBgAI7AVACQCAAKAI8DQAgACABKAIMIAEoAhAiBmo2AhggACABKAIUIAZrNgIsCyAEQgA3AgAgBUIANwIADAoLIAAtAFBFDQkMDQsgASAHQQFqNgIEIAEoAgAgB2otAAAhByAAQQI2AkAgACAHQQh0IAAoAkhqNgJIDAsLIAEgB0EBajYCBCABKAIAIAdqLQAAIQcgAEEDNgJAIAAgByAAKAJIakEBajYCSAwKCyABIAdBAWo2AgQgASgCACAHai0AACEHIABBBDYCQCAAIAdBCHQ2AkwMCQsgASAHQQFqNgIEIAEoAgAgB2otAAAhByAAIAAoAkQ2AkAgACAHIAAoAkxqQQFqNgJMDAgLIAEgB0EBajYCBEEHIQYgASgCACAHai0AACIHQeABSw0DQQAhCAJAAkAgB0EtTw0AQQAhCQwBCyAHQVNqIgcgB0H/AXFBLW4iCUEtbGshByAJQQFqIQkLIABBfyAJdEF/czYCdAJAIAdB/wFxQQlJDQAgB0F3aiIHIAdB/wFxQQluIghBCWxrIQcgCEEBaiEICyAAIAg2AnAgACAHQf8BcSIHNgJsIAggB2pBBEsNAyADQgA3AgAgA0EIakIANwIAIANBEGpBADYCACAAQX8gCHRBf3M2AnBB+AAhBwNAIAAgB2pBgAg7AQAgB0ECaiIHQeTdAUcNAAsgAEEGNgJAIABBBTYCCCAAQv////8PNwIACyAAKAJMIgpBBUkNBwJAIAAoAggiB0UNACAHQX9qIQYgASgCBCEHIAEoAgghCQNAIAkgB0YNCiABIAdBAWoiCDYCBCABKAIAIAdqLQAAIQcgACAGNgIIIAAgByAAKAIEQQh0cjYCBCAIIQcgBkF/aiIGQX9HDQALCyAAQQc2AkAgACAKQXtqIgY2AkwLIAAgACgCICIHIAEoAhQgASgCEGsiCCAAKAJIIgkgCCAJSRsiCGogACgCLCIJIAkgB2sgCEsbNgIoIAEoAggiCiABKAIEIghrIQcCQAJAAkAgACgC5N0BIgkNACAGDQFBACEGCyACIAlqIAEoAgAgCGpBKiAJayIIIAYgCWsiBiAIIAZJGyIGIAcgBiAHSRsiBxCHgICAABoCQAJAIAAoAuTdASIIIAdqIgYgACgCTEcNACACIAhqIAdqQQBBPyAGaxCGgICAABogACgC5N0BIAdqIQYMAQsCQCAGQRRLDQAgACAGNgLk3QEgASABKAIEIAdqNgIEDAMLIAZBa2ohBgsgAEEANgIQIAAgAjYCDCAAIAY2AhRBByEGIAAQmoCAgABFDQMgACgCECIIIAAoAuTdASIJIAdqSw0DIAAgACgCTCAIayIGNgJMAkAgCCAJTw0AIAAgCSAIayIHNgLk3QEgAiACIAhqIAcQhYCAgAAaDAILIABBADYC5N0BIAEgASgCBCAIIAlraiIINgIEIAEoAggiCiAIayEHCwJAIAdBFUkNACAAIAg2AhAgACABKAIANgIMIAAgCkFraiAIIAZqIAcgBkEVakkbNgIUQQchBiAAEJqAgIAARQ0DIAAoAkwiByAAKAIQIgggASgCBGsiCUkNAyABIAg2AgQgACAHIAlrIgY2AkwgASgCCCAIayIHQRRLDQELIAIgASgCACAIaiAHIAYgByAGSRsiBxCHgICAABogACAHNgLk3QEgASABKAIEIAdqNgIECyAAKAIgIgYgACgCHCIIayEHAkAgACgCPEUNAAJAIAYgACgCLEcNACAAQQA2AiALIAEoAgwgASgCEGogACgCGCAIaiAHEIeAgIAAGiAAKAIgIQYLIAAgBjYCHCABIAEoAhAgB2oiCDYCECAAIAAoAkgiBiAHazYCSAJAIAYgB0cNAEEHIQYgACgCTA0CIAAoAmgNAiAAKAIEDQIgAEEANgJADAQLQQAhBiAIIAEoAhRGDQEgASgCBCABKAIIRw0FIAAoAuTdASAAKAJMTw0FDAELAkADQCAAKAJMIghFDQFBACEGIAEoAggiCSAHTQ0CIAEoAhQiCiABKAIQIgtNDQIgACAIIAkgB2siBiAKIAtrIgkgBiAJSRsiBiAAKAIsIAAoAiAiCWsiCiAGIApJGyIGIAggBiAISRsiBms2AkwgCSAAKAIYaiABKAIAIAdqIAYQhYCAgAAaIAAgACgCICAGaiIHNgIgAkAgACgCJCAHTw0AIAAgBzYCJAsCQCAAKAI8RQ0AAkAgByAAKAIsRw0AIABBADYCIAsgASgCDCABKAIQaiABKAIAIAEoAgRqIAYQhYCAgAAaIAAoAiAhBwsgACAHNgIcIAEgASgCECAGajYCECABIAEoAgQgBmoiBzYCBAwACwsgAEEANgJADAQLIAYPCyAHwEF/Sg0BIABBATYCQCAAIAdBEHRBgID8AHE2AkgCQCAHQcABSQ0AIABBBTYCRCAAQQA6AFEMAwsgAC0AUQ0DIABBBjYCRCAHQaABSQ0CIANCADcCACADQRBqQQA2AgAgA0EIakIANwIAQfgAIQcDQCAAIAdqQYAIOwEAIAdBAmoiB0Hk3QFHDQALCyAAQQU2AgggAEL/////DzcCAAwBCyAHQQJLDQEgAEKDgICAgAE3AkAMAAsLQQcPC0EAC5wYARR/IABBGGohAQJAIABBIGooAgAiAiAAQShqKAIAIgNPDQAgAEHoAGoiBCgCAEUNACABIAQgACgCVBCegICAABogACgCKCEDIAAoAiAhAgsCQCACIANPDQAgAEHYC2ohBSAAQbwNaiEGIABB3A1qIQcgAEHoAGohCCAAQeAVaiEJIABB1ABqIQoDQCAAKAIQIgsgACgCFEsNASAAIAAoAmQiDEEFdGogACgCdCACcSINQQF0aiIOQfgAaiEPAkACQCAAKAIAIgNBgICACEkNACAAKAIEIRAMAQsgACADQQh0IgM2AgAgACALQQFqIgQ2AhAgACAAKAIEQQh0IAAoAgwgC2otAAByIhA2AgQgBCELCwJAAkAgECADQQt2IA8vAQAiEWwiBE8NACAAIAQ2AgAgDyARQYAQIBFrQQV2ajsBACACQX9qIQMCQCACDQAgACgCLCADaiEDCwJAAkAgACgCJCIRDQBBACEDDAELIAEoAgAgA2otAAAhAwsgACAAKAJwIAJxIAAoAmwiD3QgA0EIIA9rdmpBgAxsakHkHWohDgJAAkAgDEEGSw0AQQEhAwNAIA4gA0EBdCIDaiEQAkACQCAAKAIAIgRBgICACEkNACAAKAIEIQwMAQsgACAEQQh0IgQ2AgAgACAAKAIQIg9BAWo2AhAgACAAKAIEQQh0IA8gACgCDGotAAByIgw2AgQLAkACQCAMIARBC3YgEC8BACIRbCIPSQ0AIAAgDCAPazYCBCAEIA9rIQ8gA0EBciEDIBEgEUEFdmshBAwBCyARQYAQIBFrQQV2aiEECyAAIA82AgAgECAEOwEAIANBgAJJDQALIAAoAiAhAgwBCyACIAAoAlQiD0F/c2ohAwJAIAIgD0sNACAAKAIsIANqIQMLAkACQCARDQBBACESDAELIAEoAgAgA2otAAAhEgtBASEDQYACIQ8DQCAOIBJBAXQiEiAPcSITIA9qIANqQQF0aiERAkACQCAEQf///wdNDQAgBCENDAELIAAgBEEIdCINNgIAIAAgC0EBaiIENgIQIAAgEEEIdCAAKAIMIAtqLQAAciIQNgIEIAQhCwsCQAJAIBAgDUELdiARLwEAIgxsIgRPIhQNACAMQYAQIAxrQQV2aiEMDAELIAAgECAEayIQNgIEIA0gBGshBCAMIAxBBXZrIQxBACEPCyAAIAQ2AgAgESAMOwEAIA8gE3MhDyADQQF0IBRyIgNBgAJJDQALCyAAIAJBAWo2AiAgACgCGCACaiADOgAAAkAgACgCJCAAKAIgIgJPDQAgACACNgIkC0EAIQMCQCAAKAJkIgRBBEkNAAJAIARBCUsNACAEQX1qIQMMAQsgBEF6aiEDCyAAIAM2AmQMAQsgACADIARrIgM2AgAgACAQIARrIgQ2AgQgDyARIBFBBXZrOwEAIAAgDEEBdGoiEkH4A2ohDwJAAkAgA0H///8HTQ0AIAshEwwBCyAAIANBCHQiAzYCACAAIAtBAWoiEzYCECAAIARBCHQgACgCDCALai0AAHIiBDYCBAsCQAJAIAQgA0ELdiAPLwEAIhBsIhFJDQAgACADIBFrIgw2AgAgACAEIBFrIgM2AgQgDyAQIBBBBXZrOwEAIBJBkARqIQ8CQAJAIAxB////B00NACATIREMAQsgACAMQQh0Igw2AgAgACATQQFqIhE2AhAgACADQQh0IAAoAgwgE2otAAByIgM2AgQLAkACQCADIAxBC3YgDy8BACIQbCIETw0AIAAgBDYCACAPIBBBgBAgEGtBBXZqOwEAIA5B2ARqIQ8CQCAEQf///wdLDQAgACAEQQh0IgQ2AgAgACARQQFqNgIQIAAgA0EIdCAAKAIMIBFqLQAAciIDNgIECwJAIAMgBEELdiAPLwEAIhBsIhFJDQAgACAEIBFrNgIAIAAgAyARazYCBCAPIBAgEEEFdms7AQAMAgsgACARNgIAIA8gEEGAECAQa0EFdmo7AQAgAEEBNgJoIABBCUELIAAoAmRBB0kbNgJkDAMLIAAgDCAEayIMNgIAIAAgAyAEayIDNgIEIA8gECAQQQV2azsBACASQagEaiEEAkACQCAMQf///wdNDQAgESEODAELIAAgDEEIdCIMNgIAIAAgEUEBaiIONgIQIAAgA0EIdCAAKAIMIBFqLQAAciIDNgIECwJAAkAgAyAMQQt2IAQvAQAiD2wiEE8NACAAIBA2AgAgBCAPQYAQIA9rQQV2ajsBACAAKAJYIQMMAQsgACAMIBBrIhE2AgAgACADIBBrIgM2AgQgBCAPIA9BBXZrOwEAIBJBwARqIQ8CQCARQf///wdLDQAgACARQQh0IhE2AgAgACAOQQFqNgIQIAAgA0EIdCAAKAIMIA5qLQAAciIDNgIECwJAAkAgAyARQQt2IA8vAQAiEGwiBE8NACAQQYAQIBBrQQV2aiEQIAAoAlwhAwwBCyAAIAMgBGs2AgQgACgCYCEDIAAgACgCXDYCYCARIARrIQQgECAQQQV2ayEQCyAAIAQ2AgAgDyAQOwEAIAAgACgCWDYCXAsgACAAKAJUNgJYIAAgAzYCVAsgAEEIQQsgACgCZEEHSRs2AmQgACAJIA0Qn4CAgAAMAQsgACARNgIAIA8gEEGAECAQa0EFdmo7AQAgACAAKAJcNgJgIAAgACkCVDcCWCAAQQdBCiAAKAJkQQdJGzYCZCAAIAcgDRCfgICAACAKIAAoAmgiA0F+akEDIANBBkkbQQd0akGEB2ohDUEBIQMDQCANIANBAXQiA2ohEAJAAkAgACgCACIEQYCAgAhJDQAgACgCBCEMDAELIAAgBEEIdCIENgIAIAAgACgCECIPQQFqNgIQIAAgACgCBEEIdCAPIAAoAgxqLQAAciIMNgIECwJAAkAgDCAEQQt2IBAvAQAiEWwiD0kNACAAIAwgD2s2AgQgBCAPayEPIANBAXIhAyARIBFBBXZrIQQMAQsgEUGAECARa0EFdmohBAsgACAPNgIAIBAgBDsBACADQcAASQ0ACwJAIANBQGoiBEEDSw0AIAAgBDYCVAwBCyAAIANBAXFBAnIiDzYCVCAEQQF2IRACQCAEQQ1LDQAgACAPIBBBf2oiDnQiBDYCVEEBIQ8gBSAEQQF0akHAACADa0EBdGpBfmohEkEAIQwDQCASIA9BAXQiD2ohEAJAAkAgACgCACIDQYCAgAhJDQAgACgCBCENDAELIAAgA0EIdCIDNgIAIAAgACgCECIEQQFqNgIQIAAgACgCBEEIdCAEIAAoAgxqLQAAciINNgIECwJAAkAgDSADQQt2IBAvAQAiEWwiBEkNACAAIA0gBGs2AgQgACAAKAJUQQEgDHRqNgJUIAMgBGshBCAPQQFyIQ8gESARQQV2ayEDDAELIBFBgBAgEWtBBXZqIQMLIAAgBDYCACAQIAM7AQAgDiAMQQFqIgxHDQAMAgsLIBBBe2ohECAAKAIEIQQgACgCACEDA0ACQCADQf///wdLDQAgACADQQh0IgM2AgAgACAAKAIQIhFBAWo2AhAgBEEIdCARIAAoAgxqLQAAciEECyAAIANBAXYiAzYCACAAIAQgA2siBEEfdSIRIA9BAXRqQQFqIg82AlQgACARIANxIARqIgQ2AgQgEEF/aiIQDQALIAAgD0EEdDYCVEEAIQxBASEPA0AgBiAPQQF0Ig9qIRACQAJAIAAoAgAiA0GAgIAISQ0AIAAoAgQhDQwBCyAAIANBCHQiAzYCACAAIAAoAhAiBEEBajYCECAAIAAoAgRBCHQgBCAAKAIMai0AAHIiDTYCBAsCQAJAIA0gA0ELdiAQLwEAIhFsIgRJDQAgACANIARrNgIEIAAgACgCVEEBIAx0ajYCVCADIARrIQQgD0EBciEPIBEgEUEFdmshAwwBCyARQYAQIBFrQQV2aiEDCyAAIAQ2AgAgECADOwEAIAxBAWoiDEEERw0ACwsCQCABIAggACgCVBCegICAAA0AQQAPCyAAKAIgIQILIAIgACgCKEkNAAsLQQEhAwJAIAAoAgAiBEH///8HSw0AIAAgBEEIdDYCAEEBIQMgACAAKAIQIgRBAWo2AhAgACAAKAIEQQh0IAQgACgCDGotAAByNgIECyADC3ABAX8CQEGo3gEQgICAgAAiAkUNACACQTRqIAE2AgAgAkE8aiAANgIAAkACQAJAIABBf2oOAgABAgsgAiABEICAgIAAIgA2AhggAA0BIAIQgoCAgAAMAgsgAkEANgIYIAJBOGpBADYCAAsgAg8LQQAL0gEBAn9BBiECAkAgAUEnSw0AIABBMGogAUEBcUECciABQQF2QQtqdCIBNgIAAkACQCAAQTxqKAIAIgNFDQBBBCECIAEgAEE0aigCAEsNAiAAQSxqIAE2AgAgA0ECRw0AIABBOGoiAygCACABTw0AIAAgATYCOCAAKAIYEIKAgIAAIAAgACgCMBCAgICAACIBNgIYIAENAEEDIQIMAQtBACECIABBADYCQCAAQdAAakEBOgAAIABB6ABqQQA2AgAgAEHk3QFqIQMLIANBADYCAAsgAgsjAAJAIABBPGooAgBFDQAgACgCGBCCgICAAAsgABCCgICAAAvHAQEDf0EAIQMCQCAAKAIMIAJNDQAgACgCGCACTQ0AIAEgASgCACIDIAAoAhAgACgCCCIEayIFIAMgBSADSRsiBWs2AgAgBCACQX9zaiEDAkAgBCACSw0AIAAoAhQgA2ohAwsDQCAAKAIAIgIgA2otAAAhASAAIAAoAggiBEEBajYCCCACIARqIAE6AABBACADQQFqIgMgAyAAKAIURhshAyAFQX9qIgUNAAtBASEDIAAoAgwgACgCCCIFTw0AIAAgBTYCDAsgAwvoBAEGfwJAAkAgACgCACIDQYCAgAhJDQAgACgCBCEEDAELIAAgA0EIdCIDNgIAIAAgACgCECIFQQFqNgIQIAAgACgCBEEIdCAFIAAoAgxqLQAAciIENgIECwJAAkAgBCADQQt2IAEvAQAiBWwiBk8NACAAIAY2AgAgASAFQYAQIAVrQQV2ajsBACABIAJBBHRqQQRqIQdBCCEIQQIhAQwBCyAAIAMgBmsiAzYCACAAIAQgBmsiBDYCBCABIAUgBUEFdms7AQACQCADQf///wdLDQAgACADQQh0IgM2AgAgACAAKAIQIgVBAWo2AhAgACAEQQh0IAUgACgCDGotAAByIgQ2AgQLAkAgBCADQQt2IAEvAQIiBWwiBk8NACAAIAY2AgAgASAFQYAQIAVrQQV2ajsBAiABIAJBBHRqQYQCaiEHQQghCEEKIQEMAQsgACADIAZrNgIAIAAgBCAGazYCBCABIAUgBUEFdms7AQIgAUGEBGohB0GAAiEIQRIhAQsgAEHoAGogATYCAEEBIQEDQCAHIAFBAXQiAWohBAJAAkAgACgCACIDQYCAgAhJDQAgACgCBCECDAELIAAgA0EIdCIDNgIAIAAgACgCECIFQQFqNgIQIAAgACgCBEEIdCAFIAAoAgxqLQAAciICNgIECwJAAkAgAiADQQt2IAQvAQAiBmwiBUkNACAAIAIgBWs2AgQgAyAFayEFIAFBAXIhASAGIAZBBXZrIQMMAQsgBkGAECAGa0EFdmohAwsgACAFNgIAIAQgAzsBACABIAhJDQALIABB6ABqIgAgASAIayAAKAIAajYCAAsLNQEAQYAICy4IAAAAEAAAABgAAAAgAAAAKAAAADAAAABAAAAAUAAAAIAAAAAAAQAA/Td6WFoA"},I=>{I.exports=A}],g={};function C(A){var Q=g[A];if(void 0!==Q)return Q.exports;var B=g[A]={exports:{}};return I[A](B,B.exports,C),B.exports}C.d=(A,I)=>{for(var g in I)C.o(I,g)&&!C.o(A,g)&&Object.defineProperty(A,g,{enumerable:!0,get:I[g]})},C.o=(A,I)=>Object.prototype.hasOwnProperty.call(A,I),C.r=A=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(A,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(A,"__esModule",{value:!0})};var Q={};return(()=>{C.r(Q),C.d(Q,{XzReadableStream:()=>E});var A=C(1);const I=globalThis.ReadableStream||C(2).ReadableStream;class g{constructor(A){this.exports=A.exports,this.memory=this.exports.memory,this.ptr=this.exports.create_context(),this._refresh(),this.bufSize=this.mem32[0],this.inStart=this.mem32[1]-this.ptr,this.inEnd=this.inStart+this.bufSize,this.outStart=this.mem32[4]-this.ptr}supplyInput(A){this._refresh();this.mem8.subarray(this.inStart,this.inEnd).set(A,0),this.exports.supply_input(this.ptr,A.byteLength),this._refresh()}getNextOutput(){const A=this.exports.get_next_output(this.ptr);if(this._refresh(),0!==A&&1!==A)throw new Error(`get_next_output failed with error code ${A}`);return{outChunk:this.mem8.slice(this.outStart,this.outStart+this.mem32[5]),finished:1===A}}needsMoreInput(){return this.mem32[2]===this.mem32[3]}outputBufferIsFull(){return this.mem32[5]===this.bufSize}resetOutputBuffer(){this.outPos=this.mem32[5]=0}dispose(){this.exports.destroy_context(this.ptr),this.exports=null}_refresh(){this.memory.buffer!==this.mem8?.buffer&&(this.mem8=new Uint8Array(this.memory.buffer,this.ptr),this.mem32=new Uint32Array(this.memory.buffer,this.ptr))}}class B{constructor(){this.locked=!1,this.waitQueue=[]}async acquire(){if(this.locked)return new Promise((A=>{this.waitQueue.push(A)}));this.locked=!0}release(){if(this.waitQueue.length>0){this.waitQueue.shift()()}else this.locked=!1}}class E extends I{static _moduleInstancePromise;static _moduleInstance;static _contextMutex=new B;static async _getModuleInstance(){const I=A.replace("data:application/wasm;base64,",""),g=Uint8Array.from(atob(I),(A=>A.charCodeAt(0))).buffer,C=await WebAssembly.instantiate(g,{});E._moduleInstance=C.instance}constructor(A){let I,C=null;const Q=A.getReader();super({async start(A){await E._contextMutex.acquire();try{E._moduleInstance||await(E._moduleInstancePromise||(E._moduleInstancePromise=E._getModuleInstance())),I=new g(E._moduleInstance)}catch(A){throw E._contextMutex.release(),A}},async pull(A){try{if(I.needsMoreInput()){if(null===C||0===C.byteLength){const{done:A,value:I}=await Q.read();A||(C=I)}const A=Math.min(I.bufSize,C.byteLength);I.supplyInput(C.subarray(0,A)),C=C.subarray(A)}const g=I.getNextOutput();A.enqueue(g.outChunk),I.resetOutputBuffer(),g.finished&&(I.dispose(),E._contextMutex.release(),A.close())}catch(A){throw I&&I.dispose(),E._contextMutex.release(),A}},cancel(){try{return I&&I.dispose(),Q.cancel()}finally{E._contextMutex.release()}}})}}})(),Q})()));

  return module.exports;
})();

const XzReadableStream = _xzd.XzReadableStream;
return { XzReadableStream };
})();

// -- vendor/seek-bzip.module.mjs (MIT, see ext/archive/vendor/LICENSE-seek-bzip) --

const seekBzip = (() => {
/* @gcu/archive — vendored seek-bzip 1.0.6 (MIT)
 *
 * Pure-JS bzip2 decoder by C. Scott Ananian (adapted from node-bzip /
 * antimatter15's bzip2.js). Decode-only — bz2 encode is out of scope
 * (see project-archive-shipped memory + the spec).
 *
 * Sourced from https://registry.npmjs.org/seek-bzip/-/seek-bzip-1.0.6.tgz
 * — full license at ext/archive/vendor/LICENSE-seek-bzip.
 *
 * The original 4 source files (bitreader.js, crc32.js, stream.js,
 * index.js) are CommonJS and require() each other. We inline them in
 * dependency order, each in its own IIFE that simulates module / exports
 * / require, and resolve cross-file references through a small in-IIFE
 * require shim. The result is a single ESM module exposing the Bunzip
 * constructor — Bunzip.decode(input) is the public API.
 *
 * The commander CLI dep declared in seek-bzip's package.json is only
 * used by the bin/ scripts; library code never touches it. */

const _seekBzip = (() => {
  const _mods = {};
  const require = (id) => {
    if (id === './bitreader')      return _mods.bitreader;
    if (id === './stream')         return _mods.stream;
    if (id === './crc32')          return _mods.crc32;
    if (id === '../package.json')  return { version: '1.0.6', license: 'MIT' };
    throw new Error('seek-bzip vendor shim: unexpected require(' + id + ')');
  };

  _mods.bitreader = (() => {
    const exports = {};
    const module = { exports };
/*
node-bzip - a pure-javascript Node.JS module for decoding bzip2 data

Copyright (C) 2012 Eli Skeggs

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Adapted from bzip2.js, copyright 2011 antimatter15 (antimatter15@gmail.com).

Based on micro-bunzip by Rob Landley (rob@landley.net).

Based on bzip2 decompression code by Julian R Seward (jseward@acm.org),
which also acknowledges contributions by Mike Burrows, David Wheeler,
Peter Fenwick, Alistair Moffat, Radford Neal, Ian H. Witten,
Robert Sedgewick, and Jon L. Bentley.
*/

var BITMASK = [0x00, 0x01, 0x03, 0x07, 0x0F, 0x1F, 0x3F, 0x7F, 0xFF];

// offset in bytes
var BitReader = function(stream) {
  this.stream = stream;
  this.bitOffset = 0;
  this.curByte = 0;
  this.hasByte = false;
};

BitReader.prototype._ensureByte = function() {
  if (!this.hasByte) {
    this.curByte = this.stream.readByte();
    this.hasByte = true;
  }
};

// reads bits from the buffer
BitReader.prototype.read = function(bits) {
  var result = 0;
  while (bits > 0) {
    this._ensureByte();
    var remaining = 8 - this.bitOffset;
    // if we're in a byte
    if (bits >= remaining) {
      result <<= remaining;
      result |= BITMASK[remaining] & this.curByte;
      this.hasByte = false;
      this.bitOffset = 0;
      bits -= remaining;
    } else {
      result <<= bits;
      var shift = remaining - bits;
      result |= (this.curByte & (BITMASK[bits] << shift)) >> shift;
      this.bitOffset += bits;
      bits = 0;
    }
  }
  return result;
};

// seek to an arbitrary point in the buffer (expressed in bits)
BitReader.prototype.seek = function(pos) {
  var n_bit = pos % 8;
  var n_byte = (pos - n_bit) / 8;
  this.bitOffset = n_bit;
  this.stream.seek(n_byte);
  this.hasByte = false;
};

// reads 6 bytes worth of data using the read method
BitReader.prototype.pi = function() {
  var buf = new Buffer(6), i;
  for (i = 0; i < buf.length; i++) {
    buf[i] = this.read(8);
  }
  return buf.toString('hex');
};

module.exports = BitReader;

    return module.exports;
  })();

  _mods.crc32 = (() => {
    const exports = {};
    const module = { exports };
/* CRC32, used in Bzip2 implementation.
 * This is a port of CRC32.java from the jbzip2 implementation at
 *   https://code.google.com/p/jbzip2
 * which is:
 *   Copyright (c) 2011 Matthew Francis
 *
 *   Permission is hereby granted, free of charge, to any person
 *   obtaining a copy of this software and associated documentation
 *   files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use,
 *   copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following
 *   conditions:
 *
 *   The above copyright notice and this permission notice shall be
 *   included in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 *   OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 *   WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 *   OTHER DEALINGS IN THE SOFTWARE.
 * This JavaScript implementation is:
 *   Copyright (c) 2013 C. Scott Ananian
 * with the same licensing terms as Matthew Francis' original implementation.
 */
module.exports = (function() {

  /**
   * A static CRC lookup table
   */
  var crc32Lookup = new Uint32Array([
    0x00000000, 0x04c11db7, 0x09823b6e, 0x0d4326d9, 0x130476dc, 0x17c56b6b, 0x1a864db2, 0x1e475005,
    0x2608edb8, 0x22c9f00f, 0x2f8ad6d6, 0x2b4bcb61, 0x350c9b64, 0x31cd86d3, 0x3c8ea00a, 0x384fbdbd,
    0x4c11db70, 0x48d0c6c7, 0x4593e01e, 0x4152fda9, 0x5f15adac, 0x5bd4b01b, 0x569796c2, 0x52568b75,
    0x6a1936c8, 0x6ed82b7f, 0x639b0da6, 0x675a1011, 0x791d4014, 0x7ddc5da3, 0x709f7b7a, 0x745e66cd,
    0x9823b6e0, 0x9ce2ab57, 0x91a18d8e, 0x95609039, 0x8b27c03c, 0x8fe6dd8b, 0x82a5fb52, 0x8664e6e5,
    0xbe2b5b58, 0xbaea46ef, 0xb7a96036, 0xb3687d81, 0xad2f2d84, 0xa9ee3033, 0xa4ad16ea, 0xa06c0b5d,
    0xd4326d90, 0xd0f37027, 0xddb056fe, 0xd9714b49, 0xc7361b4c, 0xc3f706fb, 0xceb42022, 0xca753d95,
    0xf23a8028, 0xf6fb9d9f, 0xfbb8bb46, 0xff79a6f1, 0xe13ef6f4, 0xe5ffeb43, 0xe8bccd9a, 0xec7dd02d,
    0x34867077, 0x30476dc0, 0x3d044b19, 0x39c556ae, 0x278206ab, 0x23431b1c, 0x2e003dc5, 0x2ac12072,
    0x128e9dcf, 0x164f8078, 0x1b0ca6a1, 0x1fcdbb16, 0x018aeb13, 0x054bf6a4, 0x0808d07d, 0x0cc9cdca,
    0x7897ab07, 0x7c56b6b0, 0x71159069, 0x75d48dde, 0x6b93dddb, 0x6f52c06c, 0x6211e6b5, 0x66d0fb02,
    0x5e9f46bf, 0x5a5e5b08, 0x571d7dd1, 0x53dc6066, 0x4d9b3063, 0x495a2dd4, 0x44190b0d, 0x40d816ba,
    0xaca5c697, 0xa864db20, 0xa527fdf9, 0xa1e6e04e, 0xbfa1b04b, 0xbb60adfc, 0xb6238b25, 0xb2e29692,
    0x8aad2b2f, 0x8e6c3698, 0x832f1041, 0x87ee0df6, 0x99a95df3, 0x9d684044, 0x902b669d, 0x94ea7b2a,
    0xe0b41de7, 0xe4750050, 0xe9362689, 0xedf73b3e, 0xf3b06b3b, 0xf771768c, 0xfa325055, 0xfef34de2,
    0xc6bcf05f, 0xc27dede8, 0xcf3ecb31, 0xcbffd686, 0xd5b88683, 0xd1799b34, 0xdc3abded, 0xd8fba05a,
    0x690ce0ee, 0x6dcdfd59, 0x608edb80, 0x644fc637, 0x7a089632, 0x7ec98b85, 0x738aad5c, 0x774bb0eb,
    0x4f040d56, 0x4bc510e1, 0x46863638, 0x42472b8f, 0x5c007b8a, 0x58c1663d, 0x558240e4, 0x51435d53,
    0x251d3b9e, 0x21dc2629, 0x2c9f00f0, 0x285e1d47, 0x36194d42, 0x32d850f5, 0x3f9b762c, 0x3b5a6b9b,
    0x0315d626, 0x07d4cb91, 0x0a97ed48, 0x0e56f0ff, 0x1011a0fa, 0x14d0bd4d, 0x19939b94, 0x1d528623,
    0xf12f560e, 0xf5ee4bb9, 0xf8ad6d60, 0xfc6c70d7, 0xe22b20d2, 0xe6ea3d65, 0xeba91bbc, 0xef68060b,
    0xd727bbb6, 0xd3e6a601, 0xdea580d8, 0xda649d6f, 0xc423cd6a, 0xc0e2d0dd, 0xcda1f604, 0xc960ebb3,
    0xbd3e8d7e, 0xb9ff90c9, 0xb4bcb610, 0xb07daba7, 0xae3afba2, 0xaafbe615, 0xa7b8c0cc, 0xa379dd7b,
    0x9b3660c6, 0x9ff77d71, 0x92b45ba8, 0x9675461f, 0x8832161a, 0x8cf30bad, 0x81b02d74, 0x857130c3,
    0x5d8a9099, 0x594b8d2e, 0x5408abf7, 0x50c9b640, 0x4e8ee645, 0x4a4ffbf2, 0x470cdd2b, 0x43cdc09c,
    0x7b827d21, 0x7f436096, 0x7200464f, 0x76c15bf8, 0x68860bfd, 0x6c47164a, 0x61043093, 0x65c52d24,
    0x119b4be9, 0x155a565e, 0x18197087, 0x1cd86d30, 0x029f3d35, 0x065e2082, 0x0b1d065b, 0x0fdc1bec,
    0x3793a651, 0x3352bbe6, 0x3e119d3f, 0x3ad08088, 0x2497d08d, 0x2056cd3a, 0x2d15ebe3, 0x29d4f654,
    0xc5a92679, 0xc1683bce, 0xcc2b1d17, 0xc8ea00a0, 0xd6ad50a5, 0xd26c4d12, 0xdf2f6bcb, 0xdbee767c,
    0xe3a1cbc1, 0xe760d676, 0xea23f0af, 0xeee2ed18, 0xf0a5bd1d, 0xf464a0aa, 0xf9278673, 0xfde69bc4,
    0x89b8fd09, 0x8d79e0be, 0x803ac667, 0x84fbdbd0, 0x9abc8bd5, 0x9e7d9662, 0x933eb0bb, 0x97ffad0c,
    0xafb010b1, 0xab710d06, 0xa6322bdf, 0xa2f33668, 0xbcb4666d, 0xb8757bda, 0xb5365d03, 0xb1f740b4
  ]);

  var CRC32 = function() {
    /**
     * The current CRC
     */
    var crc = 0xffffffff;

    /**
     * @return The current CRC
     */
    this.getCRC = function() {
      return (~crc) >>> 0; // return an unsigned value
    };

    /**
     * Update the CRC with a single byte
     * @param value The value to update the CRC with
     */
    this.updateCRC = function(value) {
      crc = (crc << 8) ^ crc32Lookup[((crc >>> 24) ^ value) & 0xff];
    };

    /**
     * Update the CRC with a sequence of identical bytes
     * @param value The value to update the CRC with
     * @param count The number of bytes
     */
    this.updateCRCRun = function(value, count) {
      while (count-- > 0) {
        crc = (crc << 8) ^ crc32Lookup[((crc >>> 24) ^ value) & 0xff];
      }
    };
  };
  return CRC32;
})();

    return module.exports;
  })();

  _mods.stream = (() => {
    const exports = {};
    const module = { exports };
/* very simple input/output stream interface */
var Stream = function() {
};

// input streams //////////////
/** Returns the next byte, or -1 for EOF. */
Stream.prototype.readByte = function() {
  throw new Error("abstract method readByte() not implemented");
};
/** Attempts to fill the buffer; returns number of bytes read, or
 *  -1 for EOF. */
Stream.prototype.read = function(buffer, bufOffset, length) {
  var bytesRead = 0;
  while (bytesRead < length) {
    var c = this.readByte();
    if (c < 0) { // EOF
      return (bytesRead===0) ? -1 : bytesRead;
    }
    buffer[bufOffset++] = c;
    bytesRead++;
  }
  return bytesRead;
};
Stream.prototype.seek = function(new_pos) {
  throw new Error("abstract method seek() not implemented");
};

// output streams ///////////
Stream.prototype.writeByte = function(_byte) {
  throw new Error("abstract method readByte() not implemented");
};
Stream.prototype.write = function(buffer, bufOffset, length) {
  var i;
  for (i=0; i<length; i++) {
    this.writeByte(buffer[bufOffset++]);
  }
  return length;
};
Stream.prototype.flush = function() {
};

module.exports = Stream;

    return module.exports;
  })();

  return (() => {
    const exports = {};
    const module = { exports };
/*
seek-bzip - a pure-javascript module for seeking within bzip2 data

Copyright (C) 2013 C. Scott Ananian
Copyright (C) 2012 Eli Skeggs
Copyright (C) 2011 Kevin Kwok

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Adapted from node-bzip, copyright 2012 Eli Skeggs.
Adapted from bzip2.js, copyright 2011 Kevin Kwok (antimatter15@gmail.com).

Based on micro-bunzip by Rob Landley (rob@landley.net).

Based on bzip2 decompression code by Julian R Seward (jseward@acm.org),
which also acknowledges contributions by Mike Burrows, David Wheeler,
Peter Fenwick, Alistair Moffat, Radford Neal, Ian H. Witten,
Robert Sedgewick, and Jon L. Bentley.
*/

var BitReader = require('./bitreader');
var Stream = require('./stream');
var CRC32 = require('./crc32');
var pjson = require('../package.json');

var MAX_HUFCODE_BITS = 20;
var MAX_SYMBOLS = 258;
var SYMBOL_RUNA = 0;
var SYMBOL_RUNB = 1;
var MIN_GROUPS = 2;
var MAX_GROUPS = 6;
var GROUP_SIZE = 50;

var WHOLEPI = "314159265359";
var SQRTPI = "177245385090";

var mtf = function(array, index) {
  var src = array[index], i;
  for (i = index; i > 0; i--) {
    array[i] = array[i-1];
  }
  array[0] = src;
  return src;
};

var Err = {
  OK: 0,
  LAST_BLOCK: -1,
  NOT_BZIP_DATA: -2,
  UNEXPECTED_INPUT_EOF: -3,
  UNEXPECTED_OUTPUT_EOF: -4,
  DATA_ERROR: -5,
  OUT_OF_MEMORY: -6,
  OBSOLETE_INPUT: -7,
  END_OF_BLOCK: -8
};
var ErrorMessages = {};
ErrorMessages[Err.LAST_BLOCK] =            "Bad file checksum";
ErrorMessages[Err.NOT_BZIP_DATA] =         "Not bzip data";
ErrorMessages[Err.UNEXPECTED_INPUT_EOF] =  "Unexpected input EOF";
ErrorMessages[Err.UNEXPECTED_OUTPUT_EOF] = "Unexpected output EOF";
ErrorMessages[Err.DATA_ERROR] =            "Data error";
ErrorMessages[Err.OUT_OF_MEMORY] =         "Out of memory";
ErrorMessages[Err.OBSOLETE_INPUT] = "Obsolete (pre 0.9.5) bzip format not supported.";

var _throw = function(status, optDetail) {
  var msg = ErrorMessages[status] || 'unknown error';
  if (optDetail) { msg += ': '+optDetail; }
  var e = new TypeError(msg);
  e.errorCode = status;
  throw e;
};

var Bunzip = function(inputStream, outputStream) {
  this.writePos = this.writeCurrent = this.writeCount = 0;

  this._start_bunzip(inputStream, outputStream);
};
Bunzip.prototype._init_block = function() {
  var moreBlocks = this._get_next_block();
  if ( !moreBlocks ) {
    this.writeCount = -1;
    return false; /* no more blocks */
  }
  this.blockCRC = new CRC32();
  return true;
};
/* XXX micro-bunzip uses (inputStream, inputBuffer, len) as arguments */
Bunzip.prototype._start_bunzip = function(inputStream, outputStream) {
  /* Ensure that file starts with "BZh['1'-'9']." */
  var buf = new Buffer(4);
  if (inputStream.read(buf, 0, 4) !== 4 ||
      String.fromCharCode(buf[0], buf[1], buf[2]) !== 'BZh')
    _throw(Err.NOT_BZIP_DATA, 'bad magic');

  var level = buf[3] - 0x30;
  if (level < 1 || level > 9)
    _throw(Err.NOT_BZIP_DATA, 'level out of range');

  this.reader = new BitReader(inputStream);

  /* Fourth byte (ascii '1'-'9'), indicates block size in units of 100k of
     uncompressed data.  Allocate intermediate buffer for block. */
  this.dbufSize = 100000 * level;
  this.nextoutput = 0;
  this.outputStream = outputStream;
  this.streamCRC = 0;
};
Bunzip.prototype._get_next_block = function() {
  var i, j, k;
  var reader = this.reader;
  // this is get_next_block() function from micro-bunzip:
  /* Read in header signature and CRC, then validate signature.
     (last block signature means CRC is for whole file, return now) */
  var h = reader.pi();
  if (h === SQRTPI) { // last block
    return false; /* no more blocks */
  }
  if (h !== WHOLEPI)
    _throw(Err.NOT_BZIP_DATA);
  this.targetBlockCRC = reader.read(32) >>> 0; // (convert to unsigned)
  this.streamCRC = (this.targetBlockCRC ^
                    ((this.streamCRC << 1) | (this.streamCRC>>>31))) >>> 0;
  /* We can add support for blockRandomised if anybody complains.  There was
     some code for this in busybox 1.0.0-pre3, but nobody ever noticed that
     it didn't actually work. */
  if (reader.read(1))
    _throw(Err.OBSOLETE_INPUT);
  var origPointer = reader.read(24);
  if (origPointer > this.dbufSize)
    _throw(Err.DATA_ERROR, 'initial position out of bounds');
  /* mapping table: if some byte values are never used (encoding things
     like ascii text), the compression code removes the gaps to have fewer
     symbols to deal with, and writes a sparse bitfield indicating which
     values were present.  We make a translation table to convert the symbols
     back to the corresponding bytes. */
  var t = reader.read(16);
  var symToByte = new Buffer(256), symTotal = 0;
  for (i = 0; i < 16; i++) {
    if (t & (1 << (0xF - i))) {
      var o = i * 16;
      k = reader.read(16);
      for (j = 0; j < 16; j++)
        if (k & (1 << (0xF - j)))
          symToByte[symTotal++] = o + j;
    }
  }

  /* How many different huffman coding groups does this block use? */
  var groupCount = reader.read(3);
  if (groupCount < MIN_GROUPS || groupCount > MAX_GROUPS)
    _throw(Err.DATA_ERROR);
  /* nSelectors: Every GROUP_SIZE many symbols we select a new huffman coding
     group.  Read in the group selector list, which is stored as MTF encoded
     bit runs.  (MTF=Move To Front, as each value is used it's moved to the
     start of the list.) */
  var nSelectors = reader.read(15);
  if (nSelectors === 0)
    _throw(Err.DATA_ERROR);

  var mtfSymbol = new Buffer(256);
  for (i = 0; i < groupCount; i++)
    mtfSymbol[i] = i;

  var selectors = new Buffer(nSelectors); // was 32768...

  for (i = 0; i < nSelectors; i++) {
    /* Get next value */
    for (j = 0; reader.read(1); j++)
      if (j >= groupCount) _throw(Err.DATA_ERROR);
    /* Decode MTF to get the next selector */
    selectors[i] = mtf(mtfSymbol, j);
  }

  /* Read the huffman coding tables for each group, which code for symTotal
     literal symbols, plus two run symbols (RUNA, RUNB) */
  var symCount = symTotal + 2;
  var groups = [], hufGroup;
  for (j = 0; j < groupCount; j++) {
    var length = new Buffer(symCount), temp = new Uint16Array(MAX_HUFCODE_BITS + 1);
    /* Read huffman code lengths for each symbol.  They're stored in
       a way similar to mtf; record a starting value for the first symbol,
       and an offset from the previous value for everys symbol after that. */
    t = reader.read(5); // lengths
    for (i = 0; i < symCount; i++) {
      for (;;) {
        if (t < 1 || t > MAX_HUFCODE_BITS) _throw(Err.DATA_ERROR);
        /* If first bit is 0, stop.  Else second bit indicates whether
           to increment or decrement the value. */
        if(!reader.read(1))
          break;
        if(!reader.read(1))
          t++;
        else
          t--;
      }
      length[i] = t;
    }

    /* Find largest and smallest lengths in this group */
    var minLen,  maxLen;
    minLen = maxLen = length[0];
    for (i = 1; i < symCount; i++) {
      if (length[i] > maxLen)
        maxLen = length[i];
      else if (length[i] < minLen)
        minLen = length[i];
    }

    /* Calculate permute[], base[], and limit[] tables from length[].
     *
     * permute[] is the lookup table for converting huffman coded symbols
     * into decoded symbols.  base[] is the amount to subtract from the
     * value of a huffman symbol of a given length when using permute[].
     *
     * limit[] indicates the largest numerical value a symbol with a given
     * number of bits can have.  This is how the huffman codes can vary in
     * length: each code with a value>limit[length] needs another bit.
     */
    hufGroup = {};
    groups.push(hufGroup);
    hufGroup.permute = new Uint16Array(MAX_SYMBOLS);
    hufGroup.limit = new Uint32Array(MAX_HUFCODE_BITS + 2);
    hufGroup.base = new Uint32Array(MAX_HUFCODE_BITS + 1);
    hufGroup.minLen = minLen;
    hufGroup.maxLen = maxLen;
    /* Calculate permute[].  Concurently, initialize temp[] and limit[]. */
    var pp = 0;
    for (i = minLen; i <= maxLen; i++) {
      temp[i] = hufGroup.limit[i] = 0;
      for (t = 0; t < symCount; t++)
        if (length[t] === i)
          hufGroup.permute[pp++] = t;
    }
    /* Count symbols coded for at each bit length */
    for (i = 0; i < symCount; i++)
      temp[length[i]]++;
    /* Calculate limit[] (the largest symbol-coding value at each bit
     * length, which is (previous limit<<1)+symbols at this level), and
     * base[] (number of symbols to ignore at each bit length, which is
     * limit minus the cumulative count of symbols coded for already). */
    pp = t = 0;
    for (i = minLen; i < maxLen; i++) {
      pp += temp[i];
      /* We read the largest possible symbol size and then unget bits
         after determining how many we need, and those extra bits could
         be set to anything.  (They're noise from future symbols.)  At
         each level we're really only interested in the first few bits,
         so here we set all the trailing to-be-ignored bits to 1 so they
         don't affect the value>limit[length] comparison. */
      hufGroup.limit[i] = pp - 1;
      pp <<= 1;
      t += temp[i];
      hufGroup.base[i + 1] = pp - t;
    }
    hufGroup.limit[maxLen + 1] = Number.MAX_VALUE; /* Sentinal value for reading next sym. */
    hufGroup.limit[maxLen] = pp + temp[maxLen] - 1;
    hufGroup.base[minLen] = 0;
  }
  /* We've finished reading and digesting the block header.  Now read this
     block's huffman coded symbols from the file and undo the huffman coding
     and run length encoding, saving the result into dbuf[dbufCount++]=uc */

  /* Initialize symbol occurrence counters and symbol Move To Front table */
  var byteCount = new Uint32Array(256);
  for (i = 0; i < 256; i++)
    mtfSymbol[i] = i;
  /* Loop through compressed symbols. */
  var runPos = 0, dbufCount = 0, selector = 0, uc;
  var dbuf = this.dbuf = new Uint32Array(this.dbufSize);
  symCount = 0;
  for (;;) {
    /* Determine which huffman coding group to use. */
    if (!(symCount--)) {
      symCount = GROUP_SIZE - 1;
      if (selector >= nSelectors) { _throw(Err.DATA_ERROR); }
      hufGroup = groups[selectors[selector++]];
    }
    /* Read next huffman-coded symbol. */
    i = hufGroup.minLen;
    j = reader.read(i);
    for (;;i++) {
      if (i > hufGroup.maxLen) { _throw(Err.DATA_ERROR); }
      if (j <= hufGroup.limit[i])
        break;
      j = (j << 1) | reader.read(1);
    }
    /* Huffman decode value to get nextSym (with bounds checking) */
    j -= hufGroup.base[i];
    if (j < 0 || j >= MAX_SYMBOLS) { _throw(Err.DATA_ERROR); }
    var nextSym = hufGroup.permute[j];
    /* We have now decoded the symbol, which indicates either a new literal
       byte, or a repeated run of the most recent literal byte.  First,
       check if nextSym indicates a repeated run, and if so loop collecting
       how many times to repeat the last literal. */
    if (nextSym === SYMBOL_RUNA || nextSym === SYMBOL_RUNB) {
      /* If this is the start of a new run, zero out counter */
      if (!runPos){
        runPos = 1;
        t = 0;
      }
      /* Neat trick that saves 1 symbol: instead of or-ing 0 or 1 at
         each bit position, add 1 or 2 instead.  For example,
         1011 is 1<<0 + 1<<1 + 2<<2.  1010 is 2<<0 + 2<<1 + 1<<2.
         You can make any bit pattern that way using 1 less symbol than
         the basic or 0/1 method (except all bits 0, which would use no
         symbols, but a run of length 0 doesn't mean anything in this
         context).  Thus space is saved. */
      if (nextSym === SYMBOL_RUNA)
        t += runPos;
      else
        t += 2 * runPos;
      runPos <<= 1;
      continue;
    }
    /* When we hit the first non-run symbol after a run, we now know
       how many times to repeat the last literal, so append that many
       copies to our buffer of decoded symbols (dbuf) now.  (The last
       literal used is the one at the head of the mtfSymbol array.) */
    if (runPos){
      runPos = 0;
      if (dbufCount + t > this.dbufSize) { _throw(Err.DATA_ERROR); }
      uc = symToByte[mtfSymbol[0]];
      byteCount[uc] += t;
      while (t--)
        dbuf[dbufCount++] = uc;
    }
    /* Is this the terminating symbol? */
    if (nextSym > symTotal)
      break;
    /* At this point, nextSym indicates a new literal character.  Subtract
       one to get the position in the MTF array at which this literal is
       currently to be found.  (Note that the result can't be -1 or 0,
       because 0 and 1 are RUNA and RUNB.  But another instance of the
       first symbol in the mtf array, position 0, would have been handled
       as part of a run above.  Therefore 1 unused mtf position minus
       2 non-literal nextSym values equals -1.) */
    if (dbufCount >= this.dbufSize) { _throw(Err.DATA_ERROR); }
    i = nextSym - 1;
    uc = mtf(mtfSymbol, i);
    uc = symToByte[uc];
    /* We have our literal byte.  Save it into dbuf. */
    byteCount[uc]++;
    dbuf[dbufCount++] = uc;
  }
  /* At this point, we've read all the huffman-coded symbols (and repeated
     runs) for this block from the input stream, and decoded them into the
     intermediate buffer.  There are dbufCount many decoded bytes in dbuf[].
     Now undo the Burrows-Wheeler transform on dbuf.
     See http://dogma.net/markn/articles/bwt/bwt.htm
  */
  if (origPointer < 0 || origPointer >= dbufCount) { _throw(Err.DATA_ERROR); }
  /* Turn byteCount into cumulative occurrence counts of 0 to n-1. */
  j = 0;
  for (i = 0; i < 256; i++) {
    k = j + byteCount[i];
    byteCount[i] = j;
    j = k;
  }
  /* Figure out what order dbuf would be in if we sorted it. */
  for (i = 0; i < dbufCount; i++) {
    uc = dbuf[i] & 0xff;
    dbuf[byteCount[uc]] |= (i << 8);
    byteCount[uc]++;
  }
  /* Decode first byte by hand to initialize "previous" byte.  Note that it
     doesn't get output, and if the first three characters are identical
     it doesn't qualify as a run (hence writeRunCountdown=5). */
  var pos = 0, current = 0, run = 0;
  if (dbufCount) {
    pos = dbuf[origPointer];
    current = (pos & 0xff);
    pos >>= 8;
    run = -1;
  }
  this.writePos = pos;
  this.writeCurrent = current;
  this.writeCount = dbufCount;
  this.writeRun = run;

  return true; /* more blocks to come */
};
/* Undo burrows-wheeler transform on intermediate buffer to produce output.
   If start_bunzip was initialized with out_fd=-1, then up to len bytes of
   data are written to outbuf.  Return value is number of bytes written or
   error (all errors are negative numbers).  If out_fd!=-1, outbuf and len
   are ignored, data is written to out_fd and return is RETVAL_OK or error.
*/
Bunzip.prototype._read_bunzip = function(outputBuffer, len) {
    var copies, previous, outbyte;
    /* james@jamestaylor.org: writeCount goes to -1 when the buffer is fully
       decoded, which results in this returning RETVAL_LAST_BLOCK, also
       equal to -1... Confusing, I'm returning 0 here to indicate no
       bytes written into the buffer */
  if (this.writeCount < 0) { return 0; }

  var gotcount = 0;
  var dbuf = this.dbuf, pos = this.writePos, current = this.writeCurrent;
  var dbufCount = this.writeCount, outputsize = this.outputsize;
  var run = this.writeRun;

  while (dbufCount) {
    dbufCount--;
    previous = current;
    pos = dbuf[pos];
    current = pos & 0xff;
    pos >>= 8;
    if (run++ === 3){
      copies = current;
      outbyte = previous;
      current = -1;
    } else {
      copies = 1;
      outbyte = current;
    }
    this.blockCRC.updateCRCRun(outbyte, copies);
    while (copies--) {
      this.outputStream.writeByte(outbyte);
      this.nextoutput++;
    }
    if (current != previous)
      run = 0;
  }
  this.writeCount = dbufCount;
  // check CRC
  if (this.blockCRC.getCRC() !== this.targetBlockCRC) {
    _throw(Err.DATA_ERROR, "Bad block CRC "+
           "(got "+this.blockCRC.getCRC().toString(16)+
           " expected "+this.targetBlockCRC.toString(16)+")");
  }
  return this.nextoutput;
};

var coerceInputStream = function(input) {
  if ('readByte' in input) { return input; }
  var inputStream = new Stream();
  inputStream.pos = 0;
  inputStream.readByte = function() { return input[this.pos++]; };
  inputStream.seek = function(pos) { this.pos = pos; };
  inputStream.eof = function() { return this.pos >= input.length; };
  return inputStream;
};
var coerceOutputStream = function(output) {
  var outputStream = new Stream();
  var resizeOk = true;
  if (output) {
    if (typeof(output)==='number') {
      outputStream.buffer = new Buffer(output);
      resizeOk = false;
    } else if ('writeByte' in output) {
      return output;
    } else {
      outputStream.buffer = output;
      resizeOk = false;
    }
  } else {
    outputStream.buffer = new Buffer(16384);
  }
  outputStream.pos = 0;
  outputStream.writeByte = function(_byte) {
    if (resizeOk && this.pos >= this.buffer.length) {
      var newBuffer = new Buffer(this.buffer.length*2);
      this.buffer.copy(newBuffer);
      this.buffer = newBuffer;
    }
    this.buffer[this.pos++] = _byte;
  };
  outputStream.getBuffer = function() {
    // trim buffer
    if (this.pos !== this.buffer.length) {
      if (!resizeOk)
        throw new TypeError('outputsize does not match decoded input');
      var newBuffer = new Buffer(this.pos);
      this.buffer.copy(newBuffer, 0, 0, this.pos);
      this.buffer = newBuffer;
    }
    return this.buffer;
  };
  outputStream._coerced = true;
  return outputStream;
};

/* Static helper functions */
Bunzip.Err = Err;
// 'input' can be a stream or a buffer
// 'output' can be a stream or a buffer or a number (buffer size)
Bunzip.decode = function(input, output, multistream) {
  // make a stream from a buffer, if necessary
  var inputStream = coerceInputStream(input);
  var outputStream = coerceOutputStream(output);

  var bz = new Bunzip(inputStream, outputStream);
  while (true) {
    if ('eof' in inputStream && inputStream.eof()) break;
    if (bz._init_block()) {
      bz._read_bunzip();
    } else {
      var targetStreamCRC = bz.reader.read(32) >>> 0; // (convert to unsigned)
      if (targetStreamCRC !== bz.streamCRC) {
        _throw(Err.DATA_ERROR, "Bad stream CRC "+
               "(got "+bz.streamCRC.toString(16)+
               " expected "+targetStreamCRC.toString(16)+")");
      }
      if (multistream &&
          'eof' in inputStream &&
          !inputStream.eof()) {
        // note that start_bunzip will also resync the bit reader to next byte
        bz._start_bunzip(inputStream, outputStream);
      } else break;
    }
  }
  if ('getBuffer' in outputStream)
    return outputStream.getBuffer();
};
Bunzip.decodeBlock = function(input, pos, output) {
  // make a stream from a buffer, if necessary
  var inputStream = coerceInputStream(input);
  var outputStream = coerceOutputStream(output);
  var bz = new Bunzip(inputStream, outputStream);
  bz.reader.seek(pos);
  /* Fill the decode buffer for the block */
  var moreBlocks = bz._get_next_block();
  if (moreBlocks) {
    /* Init the CRC for writing */
    bz.blockCRC = new CRC32();

    /* Zero this so the current byte from before the seek is not written */
    bz.writeCopies = 0;

    /* Decompress the block and write to stdout */
    bz._read_bunzip();
    // XXX keep writing?
  }
  if ('getBuffer' in outputStream)
    return outputStream.getBuffer();
};
/* Reads bzip2 file from stream or buffer `input`, and invoke
 * `callback(position, size)` once for each bzip2 block,
 * where position gives the starting position (in *bits*)
 * and size gives uncompressed size of the block (in *bytes*). */
Bunzip.table = function(input, callback, multistream) {
  // make a stream from a buffer, if necessary
  var inputStream = new Stream();
  inputStream.delegate = coerceInputStream(input);
  inputStream.pos = 0;
  inputStream.readByte = function() {
    this.pos++;
    return this.delegate.readByte();
  };
  if (inputStream.delegate.eof) {
    inputStream.eof = inputStream.delegate.eof.bind(inputStream.delegate);
  }
  var outputStream = new Stream();
  outputStream.pos = 0;
  outputStream.writeByte = function() { this.pos++; };

  var bz = new Bunzip(inputStream, outputStream);
  var blockSize = bz.dbufSize;
  while (true) {
    if ('eof' in inputStream && inputStream.eof()) break;

    var position = inputStream.pos*8 + bz.reader.bitOffset;
    if (bz.reader.hasByte) { position -= 8; }

    if (bz._init_block()) {
      var start = outputStream.pos;
      bz._read_bunzip();
      callback(position, outputStream.pos - start);
    } else {
      var crc = bz.reader.read(32); // (but we ignore the crc)
      if (multistream &&
          'eof' in inputStream &&
          !inputStream.eof()) {
        // note that start_bunzip will also resync the bit reader to next byte
        bz._start_bunzip(inputStream, outputStream);
        console.assert(bz.dbufSize === blockSize,
                       "shouldn't change block size within multistream file");
      } else break;
    }
  }
};

Bunzip.Stream = Stream;

Bunzip.version = pjson.version;
Bunzip.license = pjson.license;

module.exports = Bunzip;

    return module.exports;
  })();
})();

const Bunzip = _seekBzip;
return { Bunzip };
})();

// -- vendor alias bindings (collision-safe namespacing) --

const unzipSync = fflate.unzipSync;
const zipSync = fflate.zipSync;
const gzipSync_fflate = fflate.gzipSync;
const gunzipSync_fflate = fflate.gunzipSync;
const Unzip = fflate.Unzip;
const UnzipInflate = fflate.UnzipInflate;
const UnzipPassThrough = fflate.UnzipPassThrough;
const Zip = fflate.Zip;
const ZipDeflate = fflate.ZipDeflate;
const ZipPassThrough = fflate.ZipPassThrough;
const fzstd_decompress = fzstd.decompress;
const fzstd_Decompress = fzstd.Decompress;
const fzstd_ZstdErrorCode = fzstd.ZstdErrorCode;
const XzReadableStream = xzDecompress.XzReadableStream;
const Bunzip = seekBzip.Bunzip;


// -- detect.js --

// Format detection by magic bytes, with an extension-based fallback for
// callers who only have a filename (no buffer access). The byte path is
// authoritative — extension is best-effort.
//
// Magic-byte references (per the archive spec §3.3):
//   ZIP     PK (0x50 0x4B) at offset 0
//   tar     "ustar" (0x75 0x73 0x74 0x61 0x72) at offset 257
//   gzip    1f 8b at offset 0
//   zstd    28 b5 2f fd at offset 0
//   xz      fd 37 7a 58 5a 00 at offset 0
//   bz2     BZh (0x42 0x5a 0x68) at offset 0

const FORMATS = ['zip', 'tar', 'tar.gz', 'tar.zst', 'tar.xz', 'tar.bz2',
                 'gz', 'zst', 'xz', 'bz2'];

// Probe `bytes` (Uint8Array | ArrayBuffer | Buffer-like) and return one of
// 'zip' | 'tar' | 'gz' | 'zst' | 'xz' | 'bz2' | null. Tar wins over gz/zst/xz/bz2
// only when its ustar header is intact at offset 257; otherwise we report the
// outer container (`gz` for a gzipped tar — the caller decompresses then re-detects).
function detectFormat(bytes) {
  if (!bytes) return null;
  const u = bytes instanceof Uint8Array ? bytes :
            (bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength) :
             new Uint8Array(bytes));
  if (u.length < 2) return null;

  // ZIP — 'PK' at offset 0. (Empty ZIPs start with PK\x05\x06, regular ones with PK\x03\x04.)
  if (u[0] === 0x50 && u[1] === 0x4B) return 'zip';

  // gzip — 1f 8b. Could be a gzip-of-tar, but the caller decompresses first.
  if (u[0] === 0x1f && u[1] === 0x8b) return 'gz';

  // zstd — 28 b5 2f fd (little-endian magic, RFC 8478 §3.1.1.1.1).
  if (u.length >= 4 && u[0] === 0x28 && u[1] === 0xb5 && u[2] === 0x2f && u[3] === 0xfd) return 'zst';

  // xz — fd 37 7a 58 5a 00.
  if (u.length >= 6 && u[0] === 0xfd && u[1] === 0x37 && u[2] === 0x7a
      && u[3] === 0x58 && u[4] === 0x5a && u[5] === 0x00) return 'xz';

  // bz2 — 'BZh'.
  if (u.length >= 3 && u[0] === 0x42 && u[1] === 0x5a && u[2] === 0x68) return 'bz2';

  // tar — 'ustar' at offset 257 (POSIX ustar header). Tar's magic is far
  // into the file because tar is offset-based; we check it last.
  if (u.length >= 263
      && u[257] === 0x75 && u[258] === 0x73 && u[259] === 0x74
      && u[260] === 0x61 && u[261] === 0x72) return 'tar';

  return null;
}

// Map a filename extension to a format. Best-effort; the magic-byte sniff is
// authoritative when bytes are available. The compound forms ('.tar.gz') are
// recognized too so callers can route to a tar-on-top-of-gz pipeline directly.
function magicForFormat(filename) {
  if (typeof filename !== 'string') return null;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz')  || lower.endsWith('.tgz'))  return 'tar.gz';
  if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst')) return 'tar.zst';
  if (lower.endsWith('.tar.xz')  || lower.endsWith('.txz'))  return 'tar.xz';
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar.bz2';
  if (lower.endsWith('.zip'))                                return 'zip';
  if (lower.endsWith('.tar'))                                return 'tar';
  if (lower.endsWith('.gz'))                                 return 'gz';
  if (lower.endsWith('.zst'))                                return 'zst';
  if (lower.endsWith('.xz'))                                 return 'xz';
  if (lower.endsWith('.bz2'))                                return 'bz2';
  return null;
}

// -- source.js --

// Source adapter — normalize whatever the caller hands us into a thin
// `{ bytes(): Promise<Uint8Array>, name: string|null }` shape that the
// per-format handlers can consume without caring where the bytes came from.
//
// Accepted source shapes:
//   - Uint8Array | ArrayBuffer                    in-memory bytes (sync)
//   - Blob                                        browser Blob (async .arrayBuffer)
//   - { vfs, path }                               VFS adapter (uses vfs.readFile)
//   - { fetch: '<url>' [, fetchFn] }              lazy fetch from URL
//   - ReadableStream<Uint8Array>                  drained on first .bytes() call
//
// `name` is preserved when known — used as an extension hint when magic-byte
// detection is ambiguous.

// Renamed from `basename` to avoid colliding with @gcu/vfs's exported
// `basename` function in worker bundles that compose both libs into one
// scope (e.g. the geas worker, which inlines @gcu/archive via build-time
// concat).
const _arcBasename = (p) => String(p).split(/[\\/]/).pop();

function normalizeSource(input) {
  if (!input) throw new TypeError('source: required');

  // Uint8Array / ArrayBuffer / Buffer-like — wrap as-is.
  if (input instanceof Uint8Array) {
    const b = input;
    return { bytes: async () => b, name: null };
  }
  if (input instanceof ArrayBuffer) {
    const b = new Uint8Array(input);
    return { bytes: async () => b, name: null };
  }

  // Blob — has .arrayBuffer().
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return {
      bytes: async () => new Uint8Array(await input.arrayBuffer()),
      name: input.name || null,
    };
  }

  // ReadableStream — drain into a single Uint8Array on first call. (For
  // larger archives the format handlers can opt into the streaming `Unzip`
  // path via archive.stream(); this adapter is the "small archive, eager"
  // path.)
  if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) {
    return {
      bytes: async () => new Uint8Array(await new Response(input).arrayBuffer()),
      name: null,
    };
  }

  // Object descriptors.
  if (typeof input === 'object') {
    // { vfs, path }
    if (input.vfs && typeof input.path === 'string') {
      return {
        bytes: async () => {
          // Request 'bytes' encoding explicitly — without it, the
          // MemoryBackend returns TextDecoder().decode(bytes), which
          // substitutes U+FFFD for any byte outside a valid UTF-8 sequence
          // and corrupts binary. CommentBackend / IDBBackend behave
          // similarly. Backends that don't recognize 'bytes' fall through
          // to the same code path; the resulting string is encoded back to
          // utf8, which round-trips for text but not for binary — same
          // behaviour as before for those backends.
          const r = input.vfs.readFile(input.path, 'bytes');
          const v = (r && typeof r.then === 'function') ? await r : r;
          if (v instanceof Uint8Array) return v;
          if (typeof v === 'string') return new TextEncoder().encode(v);
          if (v && v.buffer) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
          throw new TypeError('vfs.readFile returned unsupported shape');
        },
        name: _arcBasename(input.path),
      };
    }
    // { fetch: url, fetchFn? }
    if (typeof input.fetch === 'string') {
      const fetchFn = input.fetchFn || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
      if (!fetchFn) throw new TypeError('source: { fetch } requires a fetch implementation in the environment');
      return {
        bytes: async () => {
          const r = await fetchFn(input.fetch);
          if (!r || !r.ok) throw new Error(`fetch ${input.fetch}: HTTP ${r ? r.status : 'no-response'}`);
          return new Uint8Array(await r.arrayBuffer());
        },
        name: _arcBasename(input.fetch.split('?')[0]),
      };
    }
  }

  throw new TypeError('source: unrecognized shape — expected Uint8Array | ArrayBuffer | Blob | ReadableStream | { vfs, path } | { fetch }');
}

// -- sink.js --

// Sink adapter — normalize a destination into a thin shape the format
// handlers write extraction output through. Mirrors source.js.
//
// Accepted sink shapes:
//   - { vfs, path }       VFS adapter; `path` is the destination directory.
//                         writeFile creates path/<entry>; mkdir creates
//                         path/<entryDir>. Both auto-create parents.
//   - 'memory'            Returns the populated `Map<innerPath, Uint8Array>`
//                         from the sink's `.result()` method.
//   - WritableStream      Streaming write (not yet implemented for extract;
//                         placeholder shape for future compress streaming).
//
// Overwrite semantics ('error' | 'skip' | 'rename' | 'overwrite') are handled
// by the per-format extract code, not here — the sink just writes when asked.

const joinPath = (a, b) => {
  if (!a || a === '/') return '/' + String(b).replace(/^\/+/, '');
  return a.replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '');
};

const parentOf = (p) => {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
};

// Finder-style auto-rename: file.csv → file (2).csv → file (3).csv ...
// Shared by the per-format extract paths (zip / tar / single-file) so the
// behaviour is identical regardless of source format. Bounded at 1000 to
// surface bugs rather than spin forever; real archives never hit this.
async function autoRename(sink, name) {
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  // Don't split on a dot that's inside a parent dir name.
  const stem = (dot > slash) ? name.slice(0, dot) : name;
  const ext  = (dot > slash) ? name.slice(dot)    : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await sink.exists(candidate))) return candidate;
  }
  throw new Error('extract: too many rename collisions');
}

function normalizeSink(input) {
  if (!input) throw new TypeError('sink: required');

  // 'memory' — collect into a Map. result() drains it.
  if (input === 'memory') {
    const map = new Map();
    return {
      kind: 'memory',
      async writeFile(innerPath, bytes) {
        map.set(innerPath, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      },
      async mkdir(/* innerPath */) { /* memory sink doesn't track dirs */ },
      async exists(innerPath)      { return map.has(innerPath); },
      result()                     { return map; },
    };
  }

  // { vfs, path } — VFS adapter with destination directory.
  if (typeof input === 'object' && input.vfs && typeof input.path === 'string') {
    const vfs = input.vfs;
    const root = input.path.replace(/\/+$/, '') || '/';
    const callMaybeAsync = async (fn) => {
      const r = fn();
      return (r && typeof r.then === 'function') ? await r : r;
    };
    return {
      kind: 'vfs',
      root,
      async writeFile(innerPath, bytes) {
        const full = joinPath(root, innerPath);
        const dir = parentOf(full);
        try { await callMaybeAsync(() => vfs.mkdir(dir, { recursive: true })); } catch {}
        await callMaybeAsync(() => vfs.writeFile(full,
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
      },
      async mkdir(innerPath) {
        const full = joinPath(root, innerPath);
        try { await callMaybeAsync(() => vfs.mkdir(full, { recursive: true })); } catch {}
      },
      async exists(innerPath) {
        const full = joinPath(root, innerPath);
        try {
          const r = await callMaybeAsync(() => vfs.exists ? vfs.exists(full) :
            (vfs.stat ? vfs.stat(full).then(() => true, () => false) : false));
          return !!r;
        } catch { return false; }
      },
    };
  }

  // WritableStream — not yet hooked up for extract.
  if (typeof WritableStream !== 'undefined' && input instanceof WritableStream) {
    throw new TypeError('sink: WritableStream is reserved for streaming compress (not yet implemented)');
  }

  throw new TypeError('sink: unrecognized shape — expected { vfs, path } | "memory" | WritableStream');
}

// -- zip.js --

// ZIP read via fflate (vendored). Sync surface for v0.1; the streaming
// `Unzip` class is available for archive.stream() when it lands.
//
// Note: at runtime (after the build concatenates everything into one
// scope), fflate's `unzipSync` lives at the top of the same scope —
// these imports get stripped, references resolve directly.
//
// Entry shape we expose (matches the spec §3.2 list() shape):
//   { path, type: 'file' | 'directory', size, compressed?, mtime? }
//
// Directories in fflate's output appear as zero-byte entries whose path
// ends with '/'; we translate those into type: 'directory'.



// listZip(bytes) → entries[]
// fflate's unzipSync decompresses everything into a `{ name: Uint8Array }`
// map. For v0.1 we accept the cost — list-only routes also discard the data
// after measuring. The streaming Unzip path will land in archive.stream()
// for huge archives.
function listZip(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('listZip: bytes must be a Uint8Array');
  }
  const map = unzipSync(bytes);
  const out = [];
  for (const [name, data] of Object.entries(map)) {
    const isDir = name.endsWith('/');
    out.push(isDir
      ? { path: name, type: 'directory' }
      : { path: name, type: 'file', size: data.length });
  }
  return out;
}

// readZip(bytes, innerPath) → Uint8Array | null
// Extract a single entry. Returns null if the entry isn't present.
// Same caveat as listZip — fflate's sync API decompresses everything; for
// archives with many entries the streaming path is better.
function readZip(bytes, innerPath) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('readZip: bytes must be a Uint8Array');
  }
  if (typeof innerPath !== 'string' || !innerPath) {
    throw new TypeError('readZip: innerPath must be a non-empty string');
  }
  const map = unzipSync(bytes, { filter: (file) => file.name === innerPath });
  const data = map[innerPath];
  return data || null;
}

// extractZip(bytes, sink, opts?) → { count, paths }
// Walk every entry, write through the sink. opts.overwrite controls
// collision behavior: 'error' (default) throws, 'skip' skips, 'rename'
// auto-suffixes (Finder-shape, file (2).csv), 'overwrite' clobbers.
async function extractZip(bytes, sink, opts) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('extractZip: bytes must be a Uint8Array');
  }
  const map = unzipSync(bytes);
  const overwrite = (opts && opts.overwrite) || 'error';
  const filter = (opts && opts.filter) || null;
  const progress = (opts && opts.progress) || null;
  const paths = [];

  // Total byte count (best-effort for progress reporting).
  let total = 0;
  for (const v of Object.values(map)) if (v && v.length) total += v.length;
  let done = 0;

  for (const [name, data] of Object.entries(map)) {
    if (filter && !filter({ path: name })) continue;
    const isDir = name.endsWith('/');
    if (isDir) {
      await sink.mkdir(name);
      paths.push(name);
      continue;
    }

    let targetName = name;
    if (await sink.exists(targetName)) {
      if (overwrite === 'error')     throw new Error(`extract: destination exists — ${name}`);
      else if (overwrite === 'skip') continue;
      else if (overwrite === 'rename') targetName = await autoRename(sink, name);
      // 'overwrite' falls through and clobbers.
    }
    await sink.writeFile(targetName, data);
    paths.push(targetName);
    done += data.length;
    if (progress) progress({ path: name, bytesDone: done, bytesTotal: total });
  }
  return { count: paths.length, paths };
}

// -- tar.js --

// POSIX ustar reader + writer. ~150 LOC inline implementation — the format
// is simple enough that vendoring a library would add more bytes than the
// implementation itself.
//
// Format recap:
//   - Archive = sequence of (header + data) records, each padded to 512.
//   - Header is 512 bytes; only the first ~500 are used. Trailing pad is NUL.
//   - Numeric fields are ASCII octal, NUL- or space-terminated.
//   - End of archive: two consecutive 512-byte blocks of all zeros.
//   - Typeflag '0' or '\0' = regular file; '5' = directory; others ignored.
//   - Paths up to 100 chars in `name`; longer ones use `prefix` (155 chars)
//     and join as `${prefix}/${name}`. Anything beyond ~255 chars needs
//     PAX/GNU long-link extensions (not implemented yet).
//
// All sizes / offsets are spec-mandated; magic numbers below are field
// boundaries within the 512-byte header, not arbitrary choices.

const BLOCK = 512;

// ── Helpers ─────────────────────────────────────────────────────────────

function _readString(block, off, len) {
  let end = off;
  while (end < off + len && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(off, end));
}

function _readOctal(block, off, len) {
  // The trailing byte is typically NUL or space; trim and parse.
  const s = _readString(block, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function _isAllZero(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function _writeString(block, off, maxLen, s) {
  const bytes = new TextEncoder().encode(String(s));
  const len = Math.min(bytes.length, maxLen);
  block.set(bytes.subarray(0, len), off);
  // Trailing space stays zero — that's the NUL terminator.
}

function _writeOctal(block, off, len, n) {
  // Right-aligned octal ASCII + trailing NUL (POSIX style).
  const s = Math.floor(n).toString(8);
  const fieldLen = len - 1;        // leave room for the NUL
  if (s.length > fieldLen) throw new Error(`tar: value ${n} too large for ${len}-byte field`);
  const padded = s.padStart(fieldLen, '0');
  for (let i = 0; i < fieldLen; i++) block[off + i] = padded.charCodeAt(i);
  block[off + fieldLen] = 0;
}

// Per POSIX, the checksum is the sum of all bytes in the header treating the
// chksum field itself as 8 spaces (0x20). Written back as octal (6 digits +
// NUL + space) so writers can be lenient.
function _computeChecksum(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += (i >= 148 && i < 156) ? 0x20 : block[i];
  }
  return sum;
}

// ── parseHeader ─────────────────────────────────────────────────────────

function _parseHeader(block) {
  if (_isAllZero(block)) return null;
  const name     = _readString(block, 0,   100);
  const mode     = _readOctal (block, 100, 8);
  const uid      = _readOctal (block, 108, 8);
  const gid      = _readOctal (block, 116, 8);
  const size     = _readOctal (block, 124, 12);
  const mtime    = _readOctal (block, 136, 12);
  const chksum   = _readOctal (block, 148, 8);
  const typeflag = String.fromCharCode(block[156]);
  const linkname = _readString(block, 157, 100);
  const magic    = _readString(block, 257, 6);
  const prefix   = _readString(block, 345, 155);
  const fullPath = prefix ? `${prefix}/${name}` : name;
  return { path: fullPath, mode, uid, gid, size, mtime, chksum, typeflag, linkname, magic };
}

// Treat the entry as a file when typeflag is '0' or NUL (the legacy zero
// byte from pre-POSIX tars). Treat as a directory when '5' or the path ends
// with '/'. Anything else (symlinks, fifos, pax extended headers, GNU long
// names) is silently skipped — recognized in `_isUnsupported` so the test
// suite can probe it.
function _isFile(h)      { return h.typeflag === '0' || h.typeflag === '\0' || h.typeflag === ''; }
function _isDirectory(h) { return h.typeflag === '5' || h.path.endsWith('/'); }

// ── Public read API ─────────────────────────────────────────────────────

function listTar(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('listTar: bytes must be a Uint8Array');
  const out = [];
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const hdr = _parseHeader(bytes.subarray(off, off + BLOCK));
    if (!hdr) break;
    if (_isDirectory(hdr)) {
      out.push({ path: hdr.path.endsWith('/') ? hdr.path : hdr.path + '/', type: 'directory' });
    } else if (_isFile(hdr)) {
      out.push({ path: hdr.path, type: 'file', size: hdr.size, mtime: new Date(hdr.mtime * 1000) });
    }
    // Advance past header + data (data rounded up to BLOCK).
    const dataBlocks = Math.ceil(hdr.size / BLOCK);
    off += BLOCK * (1 + dataBlocks);
  }
  return out;
}

function readTar(bytes, innerPath) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readTar: bytes must be a Uint8Array');
  if (typeof innerPath !== 'string' || !innerPath) {
    throw new TypeError('readTar: innerPath must be a non-empty string');
  }
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const hdr = _parseHeader(bytes.subarray(off, off + BLOCK));
    if (!hdr) break;
    if (_isFile(hdr) && hdr.path === innerPath) {
      return bytes.subarray(off + BLOCK, off + BLOCK + hdr.size);
    }
    const dataBlocks = Math.ceil(hdr.size / BLOCK);
    off += BLOCK * (1 + dataBlocks);
  }
  return null;
}

async function extractTar(bytes, sink, opts) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('extractTar: bytes must be a Uint8Array');
  const overwrite = (opts && opts.overwrite) || 'error';
  const filter    = (opts && opts.filter)    || null;
  const progress  = (opts && opts.progress)  || null;
  const paths = [];

  // Best-effort progress total — sum data sizes from headers.
  let total = 0;
  {
    let probe = 0;
    while (probe + BLOCK <= bytes.length) {
      const hdr = _parseHeader(bytes.subarray(probe, probe + BLOCK));
      if (!hdr) break;
      if (_isFile(hdr)) total += hdr.size;
      probe += BLOCK * (1 + Math.ceil(hdr.size / BLOCK));
    }
  }

  let done = 0;
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const hdr = _parseHeader(bytes.subarray(off, off + BLOCK));
    if (!hdr) break;
    const dataBlocks = Math.ceil(hdr.size / BLOCK);

    if (filter && !filter({ path: hdr.path })) {
      off += BLOCK * (1 + dataBlocks);
      continue;
    }

    if (_isDirectory(hdr)) {
      const p = hdr.path.endsWith('/') ? hdr.path.slice(0, -1) : hdr.path;
      await sink.mkdir(p);
      paths.push(hdr.path.endsWith('/') ? hdr.path : hdr.path + '/');
    } else if (_isFile(hdr)) {
      let target = hdr.path;
      if (await sink.exists(target)) {
        if (overwrite === 'error')     throw new Error(`extract: destination exists — ${hdr.path}`);
        else if (overwrite === 'skip') { off += BLOCK * (1 + dataBlocks); continue; }
        else if (overwrite === 'rename') target = await autoRename(sink, hdr.path);
      }
      const data = bytes.subarray(off + BLOCK, off + BLOCK + hdr.size);
      await sink.writeFile(target, data);
      paths.push(target);
      done += hdr.size;
      if (progress) progress({ path: hdr.path, bytesDone: done, bytesTotal: total });
    }
    // Unsupported typeflags (symlink, pax, etc.) just get skipped — caller
    // sees them missing from the output. A future commit can warn.

    off += BLOCK * (1 + dataBlocks);
  }
  return { count: paths.length, paths };
}

// ── Public write API ────────────────────────────────────────────────────
//
// writeTar({ 'README.md': bytes, 'src/foo.js': bytes, ... }) → Uint8Array
//
// Mirrors fflate's zipSync shape so callers can swap between formats. For
// each entry: build a header block, append data (padded to 512), then the
// final two zero blocks. Directories are inferred from paths ending '/';
// otherwise emitted as type='5' when an entry's value is the empty
// Uint8Array AND the key ends with '/'.

function writeTar(entries, opts) {
  if (!entries || typeof entries !== 'object') {
    throw new TypeError('writeTar: entries must be an object map');
  }
  const mtime = (opts && opts.mtime) || Math.floor(Date.now() / 1000);
  const mode = (opts && opts.mode) || 0o644;
  const chunks = [];

  for (const [path, data] of Object.entries(entries)) {
    const isDir = path.endsWith('/');
    const bytes = isDir ? new Uint8Array(0)
      : (data instanceof Uint8Array ? data : new Uint8Array(data));

    const header = _buildHeader(path, bytes.length, isDir ? '5' : '0',
      isDir ? (mode | 0o111) : mode, mtime);
    chunks.push(header);
    if (bytes.length > 0) {
      chunks.push(bytes);
      const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
      if (pad > 0) chunks.push(new Uint8Array(pad));
    }
  }
  // End-of-archive marker: two zero blocks.
  chunks.push(new Uint8Array(BLOCK * 2));

  // Concat.
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function _buildHeader(path, size, typeflag, mode, mtime) {
  // Split paths > 100 chars into prefix + name.
  let name = path, prefix = '';
  if (path.length > 100) {
    // Find a '/' such that the suffix fits in 100 bytes and the prefix in 155.
    let split = -1;
    for (let i = path.length - 100; i < path.length && i <= 155; i++) {
      if (path[i] === '/') { split = i; break; }
    }
    if (split < 0) throw new Error(`tar: path too long (>255 chars, PAX not yet supported): ${path}`);
    prefix = path.slice(0, split);
    name   = path.slice(split + 1);
  }

  const block = new Uint8Array(BLOCK);
  _writeString(block, 0,   100, name);
  _writeOctal (block, 100, 8,   mode);
  _writeOctal (block, 108, 8,   0);            // uid
  _writeOctal (block, 116, 8,   0);            // gid
  _writeOctal (block, 124, 12,  size);
  _writeOctal (block, 136, 12,  mtime);
  // chksum field stays zero for now — we'll fill below.
  block[156] = typeflag.charCodeAt(0);
  _writeString(block, 257, 6,   'ustar');
  block[263] = 0x30; block[264] = 0x30;        // version '00'
  if (prefix) _writeString(block, 345, 155, prefix);

  // Compute chksum + write back.
  const sum = _computeChecksum(block);
  // GNU convention: 6 octal digits + NUL + space. POSIX accepts either.
  const s = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < 6; i++) block[148 + i] = s.charCodeAt(i);
  block[154] = 0;     // NUL
  block[155] = 0x20;  // space
  return block;
}

// -- gz.js --

// gzip compress + decompress via the native Web Streams (De)CompressionStream
// API. Zero vendored bytes — gzip support is in every browser ≥ 80 and
// Node ≥ 18, which is the floor for this whole project anyway.
//
// Exposes:
//   gunzipBytes(u8) → Promise<Uint8Array>          single-shot decompress
//   gzipBytes(u8) → Promise<Uint8Array>            single-shot compress
//
// api.js wires these into:
//   - archive.list/read/extract dispatch for 'gz' (single-file) and 'tar.gz'
//     (gunzip → re-detect → tar.* dispatch)
//   - archive.gzip / archive.gunzip helpers (single-file source ↔ sink)

// Drain a stream into a Uint8Array. Response().arrayBuffer() is the
// portable path — works in Node 18+ and every modern browser.
async function _drain(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Wrap bytes as a one-chunk ReadableStream so they can be pipeThrough'd.
function _bytesToStream(bytes) {
  return new Blob([bytes]).stream();
}

async function gunzipBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('gunzipBytes: expected Uint8Array');
  const piped = _bytesToStream(u8).pipeThrough(new DecompressionStream('gzip'));
  return _drain(piped);
}

async function gzipBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('gzipBytes: expected Uint8Array');
  const piped = _bytesToStream(u8).pipeThrough(new CompressionStream('gzip'));
  return _drain(piped);
}

// Derive an inner filename for single-file gzip archives — strip '.gz' (or
// '.tgz' → '.tar', which is what most tools do when expanding a .tgz).
// Falls back to 'data' when no name is available.
function _gzInnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.tgz'))  return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.tzst')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.tbz2')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.txz'))  return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.gz'))   return sourceName.slice(0, -3);
  if (lower.endsWith('.zst'))  return sourceName.slice(0, -4);
  if (lower.endsWith('.xz'))   return sourceName.slice(0, -3);
  if (lower.endsWith('.bz2'))  return sourceName.slice(0, -4);
  return sourceName;
}

// -- zst.js --

// Zstandard read via fzstd (vendored). Decode-only; the encoder is a
// separate, larger package that we don't ship in v0.1 — anyone trying to
// .compress to zst gets a clear "decode-only build" error.
//
// At dev time the imports below resolve through ESM directly. At build
// time the imports are stripped and the references hit aliases declared
// after each vendored IIFE (see ext/archive/build.js's "vendor alias
// bindings" section).


// Single-shot decompress. fzstd's API is sync — same shape as fflate's
// unzipSync — so we wrap it in an async function to match gz.js's
// promise-returning shape and keep the API consistent.
async function unzstdBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('unzstdBytes: expected Uint8Array');
  // fzstd returns a Uint8Array directly; no Promise involved.
  return fzstd_decompress(u8);
}

// Placeholder for the encoder. Throws a clear error pointing at why.
async function zstdBytes(/* u8 */) {
  throw new Error(
    'archive: zstd encode not available in this build — fzstd is decode-only ' +
    'and the encoder package (~120 KB) is not vendored yet. ' +
    'Use tar.gz or zip if you need a writeable archive format right now.'
  );
}

// Derive an inner filename for single-file .zst archives — strip '.zst' (or
// '.tzst' → '.tar'). Mirrors gz.js's _gzInnerName for consistency.
function _zstInnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.tzst')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.zst'))  return sourceName.slice(0, -4);
  return sourceName;
}

// -- xz.js --

// XZ read via xz-decompress (vendored). Decode-only — xz encode is out
// of scope (the LZMA2 encoder is large and not bundled). A user trying
// to .compress to xz gets the "decode-only build" error from api.js.
//
// At dev time the import below resolves through ESM directly. At build
// time the import is stripped and `XzReadableStream` is provided by an
// alias declared after the vendored IIFE (see ext/archive/build.js's
// "vendor alias bindings" section).


// Single-shot decompress. xz-decompress is stream-only — wrap the input
// bytes in a one-chunk ReadableStream, drain through XzReadableStream,
// concatenate output chunks. The decoder's WebAssembly module is
// instantiated lazily on the first construct() — subsequent calls reuse
// the cached instance, so back-to-back unxz operations only pay the
// init cost once.
async function unxzBytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('unxzBytes: expected Uint8Array');

  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(u8);
      controller.close();
    },
  });

  const decoded = new XzReadableStream(input);
  const reader = decoded.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Placeholder for the encoder. Throws a clear error pointing at why.
async function xzBytes(/* u8 */) {
  throw new Error(
    'archive: xz encode not available — xz-decompress is decode-only and ' +
    'an LZMA2 encoder is not vendored. Use tar.gz or zip if you need a ' +
    'writeable archive format right now.'
  );
}

// Derive an inner filename for single-file .xz archives — strip '.xz' (or
// '.txz' → '.tar'). Mirrors gz.js / zst.js for consistency.
function _xzInnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.txz')) return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.xz'))  return sourceName.slice(0, -3);
  return sourceName;
}

// -- bz2.js --

// bzip2 read via seek-bzip (vendored). Decode-only — bz2 encode is out
// of scope (modern toolchains produce .tar.gz or .tar.zst; bz2 is mostly
// for reading older Debian sources / scientific datasets). A user trying
// to .compress to bz2 gets the "decode-only build" error from api.js.
//
// At dev time the import below resolves through ESM directly. At build
// time the import is stripped and `Bunzip` is provided by an alias
// declared after the vendored IIFE (see ext/archive/build.js's "vendor
// alias bindings" section).


// Single-shot decompress. seek-bzip is sync — same shape as fzstd /
// fflate — so we wrap in an async function to match the rest of the
// archive helpers' Promise-returning shape.
async function unbz2Bytes(u8) {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('unbz2Bytes: expected Uint8Array');
  // Bunzip.decode returns a Buffer-shaped result; coerce to Uint8Array.
  const out = Bunzip.decode(u8);
  return out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// Placeholder for the encoder. Throws a clear error pointing at why.
async function bz2Bytes(/* u8 */) {
  throw new Error(
    'archive: bz2 encode not available — seek-bzip is decode-only and a ' +
    'bzip2 encoder is not vendored. Use tar.gz or zip if you need a ' +
    'writeable archive format right now.'
  );
}

// Derive an inner filename for single-file .bz2 archives — strip '.bz2'
// (or '.tbz' / '.tbz2' → '.tar'). Mirrors gz.js / zst.js / xz.js.
function _bz2InnerName(sourceName) {
  if (!sourceName) return 'data';
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.tbz2')) return sourceName.slice(0, -5) + '.tar';
  if (lower.endsWith('.tbz'))  return sourceName.slice(0, -4) + '.tar';
  if (lower.endsWith('.bz2'))  return sourceName.slice(0, -4);
  return sourceName;
}

// -- walk.js --

// VFS directory walker — recursively enumerates a tree into a flat list of
// `{ path, type, bytes }` entries with paths relative to the root.
//
// Used by archive.compress to build the entry map for ZIP / tar / tar.gz
// from a workspace directory. The output shape matches what zipSync /
// writeTar consume (after a final reduce to `{ path: bytes }`).
//
// VFS duck type: needs readdir, stat, readFile. Same surface as
// aggregateLicenses uses. Each method may be sync or return a Promise —
// we await both shapes uniformly.

async function _call(fn, ...args) {
  const r = fn(...args);
  return (r && typeof r.then === 'function') ? await r : r;
}

// Read the file at path as raw bytes. We MUST pass 'bytes' as the encoding
// here — most VFS backends (MemoryBackend, IDBBackend, CommentBackend) will
// otherwise call TextDecoder().decode() on Uint8Array contents and produce
// a string with U+FFFD substituted for every byte outside a valid UTF-8
// sequence. Encoding that string back to utf8 is lossy and silently
// corrupts binary files (compresses fine, extracts to garbage).
async function _readBytes(vfs, path) {
  try {
    const r = await _call(vfs.readFile.bind(vfs), path, 'bytes');
    if (r instanceof Uint8Array) return r;
    if (r && r.buffer && typeof r.byteLength === 'number') {
      return new Uint8Array(r.buffer, r.byteOffset || 0, r.byteLength);
    }
    // Some backends always return strings — treat as utf8 text. Lossy for
    // binary but matches the only sensible fallback for an ambiguous API.
    if (typeof r === 'string') return new TextEncoder().encode(r);
  } catch (e) {
    throw new Error(`walk: read ${path} failed: ${e.message || e}`);
  }
  throw new Error(`walk: read ${path} returned unsupported shape`);
}

// walkVfsTree(vfs, rootPath, opts?) → Promise<entries[]>
//
// rootPath may be a directory or a single file. For a directory, we recurse
// and return entries with paths relative to rootPath. For a file, we return
// one entry whose path is the file's basename.
//
// opts.filter: predicate ({ path, type }) → boolean. Excluded entries are
// neither recursed into nor emitted; truthy values are kept.
//
// opts.includeRootDirEntry: emit a leading `path: ''` directory entry for
// the root. Defaults to false — most archive formats don't need it and ZIP
// conventions vary.
async function walkVfsTree(vfs, rootPath, opts = {}) {
  if (!vfs || typeof vfs.readdir !== 'function' || typeof vfs.readFile !== 'function'
      || typeof vfs.stat !== 'function') {
    throw new TypeError('walkVfsTree: vfs must implement readdir, readFile, stat');
  }
  const filter = opts.filter || (() => true);
  const entries = [];

  const root = String(rootPath).replace(/\/+$/, '') || '/';
  const stRoot = await _call(vfs.stat.bind(vfs), root);
  if (!stRoot) throw new Error(`walk: root path does not exist: ${root}`);

  // Single-file root — emit just the file.
  if (stRoot.type === 'file') {
    const name = root.split('/').filter(Boolean).pop() || 'file';
    if (filter({ path: name, type: 'file' })) {
      entries.push({ path: name, type: 'file', bytes: await _readBytes(vfs, root) });
    }
    return entries;
  }

  if (stRoot.type !== 'directory') {
    throw new Error(`walk: root ${root} has unsupported type: ${stRoot.type}`);
  }

  // Directory root — recurse. `relPath` accumulates the path inside the
  // archive; rootPath stays separate so we don't leak the workspace
  // absolute path into the archive's entry names.
  async function recurse(absPath, relPath) {
    const names = (await _call(vfs.readdir.bind(vfs), absPath)) || [];
    // Sort for determinism — archive byte output is reproducible across runs.
    names.sort();
    for (const name of names) {
      const child = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
      const childRel = relPath ? `${relPath}/${name}` : name;
      let st;
      try { st = await _call(vfs.stat.bind(vfs), child); } catch { continue; }
      if (!st) continue;

      if (st.type === 'directory') {
        if (!filter({ path: childRel, type: 'directory' })) continue;
        entries.push({ path: childRel + '/', type: 'directory', bytes: new Uint8Array(0) });
        await recurse(child, childRel);
      } else if (st.type === 'file') {
        if (!filter({ path: childRel, type: 'file' })) continue;
        entries.push({ path: childRel, type: 'file',
          bytes: await _readBytes(vfs, child) });
      }
      // Anything else (symlinks etc.) is skipped silently.
    }
  }

  if (opts.includeRootDirEntry) {
    entries.push({ path: '', type: 'directory', bytes: new Uint8Array(0) });
  }
  await recurse(root, '');
  return entries;
}

// Convenience: walk + reduce to a flat { path: bytes } object — the input
// shape that fflate's zipSync and our own writeTar accept directly.
// Directory entries are emitted as zero-byte values keyed with a trailing '/'.
async function buildEntryMap(vfs, rootPath, opts = {}) {
  const entries = await walkVfsTree(vfs, rootPath, opts);
  const map = {};
  for (const e of entries) map[e.path] = e.bytes;
  return map;
}

// -- writer.js --

// Streaming archive writer — call addFile(path, bytes) / addDirectory(path)
// incrementally, then close() to flush. Memory benefit over archive.compress
// is real for ZIP (fflate's Zip class compresses each entry as it's added)
// and for tar (header + data + padding emit immediately, source bytes can
// be released). tar.gz still buffers the tar stream and pipes it through
// CompressionStream at close — true streaming gzip is a v0.2 enhancement.
//
// Sink semantics (single output file, not a directory):
//   - { vfs, path }   final bytes written at close()
//   - 'memory'        close() returns the Uint8Array directly
//   - WritableStream  chunks pushed as they're produced; closed at close()
//
// At dev time the fflate imports below resolve through ESM; at build time
// they're stripped and references land on the namespaced aliases declared
// after the vendored IIFEs (Zip, ZipDeflate, ZipPassThrough).




const _nowSec = () => Math.floor(Date.now() / 1000);

// Helper: emit `chunk` to the destination — memory buffer / writable stream
// / VFS-deferred buffer. Same abstraction used by all format-specific
// writers below.
class _ChunkSink {
  constructor(sink) {
    this.sink = sink;
    this.chunks = [];        // for buffered sinks (memory, vfs)
    this.totalLen = 0;
    this._streamWriter = null;
    this._closed = false;

    if (typeof WritableStream !== 'undefined' && sink instanceof WritableStream) {
      this._streamWriter = sink.getWriter();
    }
  }
  async push(chunk) {
    if (this._closed) throw new Error('writer: push after close');
    if (this._streamWriter) {
      await this._streamWriter.write(chunk);
    } else {
      this.chunks.push(chunk);
      this.totalLen += chunk.length;
    }
  }
  async finalize() {
    if (this._closed) throw new Error('writer: close already called');
    this._closed = true;
    if (this._streamWriter) {
      await this._streamWriter.close();
      return undefined;   // stream sink owns the bytes
    }
    // Concat the accumulated chunks.
    const out = new Uint8Array(this.totalLen);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    this.chunks = null;

    if (this.sink === 'memory') return out;
    if (this.sink && typeof this.sink === 'object' && this.sink.vfs && typeof this.sink.path === 'string') {
      const r = this.sink.vfs.writeFile(this.sink.path, out);
      if (r && typeof r.then === 'function') await r;
      return { count: 1, paths: [this.sink.path] };
    }
    throw new TypeError('writer: sink must be { vfs, path } | "memory" | WritableStream');
  }
}

// ── ZIP writer ──────────────────────────────────────────────────────────
//
// fflate's Zip class is event-driven: you push files via .add(...), each
// file pushes its bytes via .push(bytes, final), and zip chunks come out
// of the top-level .ondata callback. Wire it to our ChunkSink.

class _ZipWriter {
  constructor(sink, opts) {
    this._sink = new _ChunkSink(sink);
    this._z = new Zip();
    this._z.ondata = (err, chunk, final) => {
      if (err) { this._pendingError = err; return; }
      if (chunk && chunk.length > 0) {
        // ondata is sync, but our sink.push is async. Queue the work via
        // _writePromise so addFile/close can await it.
        const p = this._sink.push(chunk).catch((e) => { this._pendingError = e; });
        this._writePromise = this._writePromise
          ? this._writePromise.then(() => p) : p;
      }
    };
    this._writePromise = null;
    this._pendingError = null;
    this._level = (opts && typeof opts.level === 'number')
      ? Math.max(0, Math.min(9, opts.level | 0)) : 6;
  }

  async addFile(path, bytes, opts) {
    if (this._pendingError) throw this._pendingError;
    const buf = bytes instanceof Uint8Array ? bytes
      : (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
    // Per-file level override falls back to the writer-wide level.
    // level=0 → STORE (no compression); else DEFLATE at that level.
    // EPUB needs this: mimetype MUST be stored, everything else deflated.
    const lvl = (opts && typeof opts.level === 'number')
      ? Math.max(0, Math.min(9, opts.level | 0))
      : this._level;
    const file = lvl === 0
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: lvl });
    this._z.add(file);
    file.push(buf, true);   // single-shot — all bytes for this file at once
    if (this._writePromise) await this._writePromise;
    if (this._pendingError) throw this._pendingError;
  }

  async addDirectory(path) {
    if (!path.endsWith('/')) path = path + '/';
    // fflate emits a directory entry from a ZipPassThrough with no data.
    const dir = new ZipPassThrough(path);
    this._z.add(dir);
    dir.push(new Uint8Array(0), true);
    if (this._writePromise) await this._writePromise;
    if (this._pendingError) throw this._pendingError;
  }

  async close() {
    if (this._pendingError) throw this._pendingError;
    this._z.end();
    if (this._writePromise) await this._writePromise;
    if (this._pendingError) throw this._pendingError;
    return this._sink.finalize();
  }
}

// ── tar writer ──────────────────────────────────────────────────────────
//
// True streaming: header + data + padding emit to the sink the moment
// addFile returns. close() pushes the 1024-byte end-of-archive marker.
// Building the header from scratch here would duplicate the implementation
// in tar.js, so we call writeTar with one entry at a time and SLICE OFF
// the end-of-archive marker, then emit a fresh marker only at close().

const _TAR_TRAILER = new Uint8Array(1024);  // shared zero-bytes block

class _TarWriter {
  constructor(sink) {
    this._sink = new _ChunkSink(sink);
  }

  async addFile(path, bytes) {
    const buf = bytes instanceof Uint8Array ? bytes
      : (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
    // writeTar({ path: bytes }) emits header + data (rounded to 512) + 1024
    // zero bytes. Drop the trailer; we emit it once at close().
    const full = writeTar({ [path]: buf });
    await this._sink.push(full.subarray(0, full.length - 1024));
  }

  async addDirectory(path) {
    if (!path.endsWith('/')) path = path + '/';
    const full = writeTar({ [path]: new Uint8Array(0) });
    await this._sink.push(full.subarray(0, full.length - 1024));
  }

  async close() {
    await this._sink.push(_TAR_TRAILER);
    return this._sink.finalize();
  }
}

// ── tar.gz writer ───────────────────────────────────────────────────────
//
// For v0.1: buffer the tar stream in memory, gzip it at close. This still
// gives the memory-saving "release input bytes after addFile" benefit, but
// the output isn't true-streaming. A future enhancement can wire
// CompressionStream incrementally for true streaming gzip.

class _TarGzWriter {
  constructor(sink) {
    this._inner = new _TarWriter('memory');
    this._sink = sink;
  }
  addFile(path, bytes)  { return this._inner.addFile(path, bytes); }
  addDirectory(path)    { return this._inner.addDirectory(path); }
  async close() {
    const tarBytes = await this._inner.close();   // Uint8Array
    const gz = await gzipBytes(tarBytes);
    const out = new _ChunkSink(this._sink);
    await out.push(gz);
    return out.finalize();
  }
}

// ── Public ──────────────────────────────────────────────────────────────

function createWriter(sink, opts = {}) {
  if (!sink) throw new TypeError('createWriter: sink required');
  const format = opts.format;
  if (!format) throw new TypeError('createWriter: opts.format required (zip | tar | tar.gz)');
  if (format === 'zip')    return new _ZipWriter(sink, opts);
  if (format === 'tar')    return new _TarWriter(sink);
  if (format === 'tar.gz') return new _TarGzWriter(sink);
  if (format === 'tar.zst') {
    throw new Error('createWriter: tar.zst encode not available (fzstd is decode-only)');
  }
  if (format === 'gz' || format === 'zst') {
    throw new Error(`createWriter: ${format} is a single-stream format — use archive.${format === 'gz' ? 'gzip' : 'zstd'} for that`);
  }
  if (format === 'xz' || format === 'tar.xz') {
    throw new Error(`createWriter: ${format} encode not available (xz-decompress is decode-only)`);
  }
  if (format === 'bz2' || format === 'tar.bz2') {
    throw new Error(`createWriter: ${format} encode not available (seek-bzip is decode-only)`);
  }
  throw new Error(`createWriter: unsupported format '${format}'`);
}

// -- api.js --

// Public surface for @gcu/archive.
//
// Shipped this commit (foundation — ZIP read only):
//   archive.list(source)              → entries[]
//   archive.read(source, innerPath)   → Uint8Array | null
//   archive.extract(source, sink, opts?) → { count, paths }
//   archive.detect(source)            → 'zip' | 'tar' | ... | null
//
// Forthcoming:
//   archive.compress(source, sink, opts)     — write ZIP/tar/tar.gz/tar.zst
//   archive.stream(source)                   — async iterable of entries
//   archive.gzip / gunzip / zstd / unzstd    — single-file helpers
//   tar / tar.gz / tar.zst dispatch          — tar.js + gz.js + zst.js wiring
//
// Format dispatch: detectFormat(bytes) is authoritative; falls back to
// magicForFormat(name) when the source had a filename hint. Compound formats
// like `.tar.gz` won't be handled here — tar.js will own the pipeline once
// it lands; today's ZIP-only impl returns a clear error for unsupported types.













async function _resolveSourceFormat(src) {
  const bytes = await src.bytes();
  const detected = detectFormat(bytes);
  if (detected) return { bytes, format: detected, name: src.name };
  if (src.name) {
    const hinted = magicForFormat(src.name);
    if (hinted) return { bytes, format: hinted, name: src.name };
  }
  throw new Error('archive: could not detect format (no magic bytes match, no extension hint)');
}

// Peel off one gzip wrapper and re-detect the inner payload. Returns the
// same { bytes, format, name } shape as _resolveSourceFormat. For tar.gz
// the inner is 'tar'; for a single-file gzip of a CSV the inner is null
// (no archive format) and we report 'gz' as a single-entry container.
async function _unwrapGz(bytes, name) {
  const inner = await gunzipBytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _gzInnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'gz-single', name: innerName, innerName };
}

// Same shape as _unwrapGz but for zstd. Single-file .zst payloads land
// as `zst-single`; .tar.zst unwraps to tar.
async function _unwrapZst(bytes, name) {
  const inner = await unzstdBytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _zstInnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'zst-single', name: innerName, innerName };
}

// Same shape as _unwrapGz but for xz.
async function _unwrapXz(bytes, name) {
  const inner = await unxzBytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _xzInnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'xz-single', name: innerName, innerName };
}

// Same shape as _unwrapGz but for bzip2.
async function _unwrapBz2(bytes, name) {
  const inner = await unbz2Bytes(bytes);
  const innerFormat = detectFormat(inner);
  const innerName = _bz2InnerName(name);
  if (innerFormat) return { bytes: inner, format: innerFormat, name: innerName };
  return { bytes: inner, format: 'bz2-single', name: innerName, innerName };
}

// Resolve a source to bytes + format, peeling off any outer gz/zst/xz/bz2
// wrapper so the caller can dispatch on the inner archive format uniformly.
async function _peelCompression(src) {
  const resolved = await _resolveSourceFormat(src);
  if (resolved.format === 'gz' || resolved.format === 'tar.gz') {
    return _unwrapGz(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'zst' || resolved.format === 'tar.zst') {
    return _unwrapZst(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'xz' || resolved.format === 'tar.xz') {
    return _unwrapXz(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'bz2' || resolved.format === 'tar.bz2') {
    return _unwrapBz2(resolved.bytes, resolved.name);
  }
  return resolved;
}

// Write a single decompressed payload into a directory-shaped sink, applying
// the overwrite policy. Shared by gz-single and zst-single extract paths.
async function _extractSingle(dst, innerName, bytes, opts) {
  const overwrite = (opts && opts.overwrite) || 'error';
  let target = innerName;
  if (await dst.exists(target)) {
    if (overwrite === 'error') throw new Error(`extract: destination exists — ${target}`);
    if (overwrite === 'skip')  return { count: 0, paths: [] };
    if (overwrite === 'rename') target = await autoRename(dst, target);
  }
  await dst.writeFile(target, bytes);
  return { count: 1, paths: [target] };
}

function _explainUnsupported(format) {
  return `archive: unsupported format '${format}'`;
}

const archive = {
  // detect — peek at a source without reading the whole thing into memory
  // unnecessarily. For a small archive (or any in-memory bytes) it's cheap;
  // for a large stream it still has to drain to inspect the magic bytes.
  async detect(source) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    return detectFormat(bytes) || (src.name && magicForFormat(src.name)) || null;
  },

  async list(source) {
    const src = normalizeSource(source);
    const resolved = await _peelCompression(src);
    const { bytes, format } = resolved;
    if (format === 'zip') return listZip(bytes);
    if (format === 'tar') return listTar(bytes);
    if (format === 'gz-single' || format === 'zst-single' || format === 'xz-single' || format === 'bz2-single') {
      return [{ path: resolved.innerName, type: 'file', size: bytes.length }];
    }
    throw new Error(_explainUnsupported(format));
  },

  async read(source, innerPath) {
    if (typeof innerPath !== 'string' || !innerPath) {
      throw new TypeError('archive.read: innerPath must be a non-empty string');
    }
    const src = normalizeSource(source);
    const resolved = await _peelCompression(src);
    const { bytes, format } = resolved;
    if (format === 'zip') return readZip(bytes, innerPath);
    if (format === 'tar') return readTar(bytes, innerPath);
    if (format === 'gz-single' || format === 'zst-single' || format === 'xz-single' || format === 'bz2-single') {
      return innerPath === resolved.innerName ? bytes : null;
    }
    throw new Error(_explainUnsupported(format));
  },

  async extract(source, sink, opts) {
    const src = normalizeSource(source);
    const dst = normalizeSink(sink);
    const resolved = await _peelCompression(src);
    const { bytes, format } = resolved;
    let result;
    if (format === 'zip')      result = await extractZip(bytes, dst, opts);
    else if (format === 'tar') result = await extractTar(bytes, dst, opts);
    else if (format === 'gz-single' || format === 'zst-single' || format === 'xz-single' || format === 'bz2-single') {
      result = await _extractSingle(dst, resolved.innerName, bytes, opts);
    }
    else throw new Error(_explainUnsupported(format));
    if (dst.kind === 'memory') return dst.result();
    return result;
  },

  // Write side. Builds a ZIP / tar / tar.gz from a VFS directory (walked
  // recursively) or a flat `{ name: bytes }` entry map. Single-file gz /
  // zst formats route through archive.gzip / archive.zstd respectively.
  //
  // source:
  //   - { vfs, path: '/dir' }        — walk recursively, archive entries
  //     are paths relative to that dir
  //   - { vfs, path: '/file' }       — single file, archive contains the
  //     file under its basename
  //   - { name: bytes, ... }         — entries provided directly (advanced)
  //   - Uint8Array                   — only valid with format 'gz' (single
  //     stream compress)
  //
  // sink:
  //   - { vfs, path: '/out.zip' }    — file path; bytes written there
  //   - 'memory'                     — returns the raw archive bytes
  //     wrapped in a 1-key Map keyed by the sink-derived name
  //
  // opts.format: explicit format override; otherwise inferred from sink path.
  // opts.filter: predicate(entry) excluding paths during walk.
  // opts.level: deflate level for ZIP (0-9). tar / gz / zst pick their own.
  async compress(source, sink, opts = {}) {
    const format = opts.format || _formatFromSinkPath(sink);
    if (!format) {
      throw new Error(
        'archive.compress: format required — pass opts.format or use a sink path ' +
        'with a recognized extension (.zip, .tar, .tar.gz, .gz, …)');
    }

    // Single-stream gz / zst paths: read source as bytes, compress one shot.
    if (format === 'gz') return this.gzip(source, sink);
    if (format === 'zst') return this.zstd(source, sink);

    // tar.zst / tar.xz / tar.bz2 / single-stream variants are decode-only
    // by design (out-of-scope encode — modern toolchains produce tar.gz or
    // tar.zst and zstd encoding is the only one we'd vendor if any). Be
    // explicit so users don't think it silently no-op'd.
    if (format === 'tar.zst') {
      throw new Error('archive.compress: tar.zst encode not available (fzstd is decode-only)');
    }
    if (format === 'tar.xz' || format === 'xz') {
      throw new Error('archive.compress: xz encode not available (xz-decompress is decode-only)');
    }
    if (format === 'tar.bz2' || format === 'bz2') {
      throw new Error('archive.compress: bz2 encode not available (seek-bzip is decode-only)');
    }

    // Multi-entry formats. Gather entries, build the archive, write it out.
    const filter = opts.filter || null;
    const entryMap = await _gatherEntries(source, filter);
    let archiveBytes;
    if (format === 'zip')         archiveBytes = zipSync(entryMap, _zipOptsFor(opts));
    else if (format === 'tar')    archiveBytes = writeTar(entryMap);
    else if (format === 'tar.gz') archiveBytes = await gzipBytes(writeTar(entryMap));
    else throw new Error(_explainUnsupported(format));

    const fallbackName = _sinkBasename(sink) || ('archive.' + format);
    return _writeSingle(sink, archiveBytes, fallbackName);
  },

  // Single-file gzip helpers. Sink semantics differ from extract's: the
  // sink's `path` (when vfs) is the OUTPUT FILE, not a destination directory
  // — gunzip writes one byte stream, not many entries. memory sink returns
  // a one-key Map keyed by the derived inner name.
  async gzip(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const compressed = await gzipBytes(bytes);
    return _writeSingle(sink, compressed, (src.name || 'data') + '.gz');
  },

  async gunzip(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const inner = await gunzipBytes(bytes);
    return _writeSingle(sink, inner, _gzInnerName(src.name));
  },

  // Single-file zstd helpers. Encode path throws — fzstd is decode-only.
  // (When the encoder gets vendored, zstdBytes lights up and this works.)
  async zstd(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const compressed = await zstdBytes(bytes);
    return _writeSingle(sink, compressed, (src.name || 'data') + '.zst');
  },

  async unzstd(source, sink) {
    const src = normalizeSource(source);
    const bytes = await src.bytes();
    const inner = await unzstdBytes(bytes);
    return _writeSingle(sink, inner, _zstInnerName(src.name));
  },

  // Streaming writer — call addFile / addDirectory / close incrementally
  // instead of materialising the whole entry map in memory before encoding.
  // See src/writer.js for the per-format details.
  createWriter,
};

// Write a single byte stream to whatever shape of sink the caller passed.
// Used by archive.gzip and archive.gunzip; bypasses normalizeSink because
// the directory-shaped semantics there don't fit single-file destinations.
async function _writeSingle(sink, bytes, defaultName) {
  if (sink === 'memory') {
    const m = new Map();
    m.set(defaultName, bytes);
    return m;
  }
  if (sink && typeof sink === 'object' && sink.vfs && typeof sink.path === 'string') {
    const r = sink.vfs.writeFile(sink.path, bytes);
    if (r && typeof r.then === 'function') await r;
    return { count: 1, paths: [sink.path] };
  }
  throw new TypeError('sink: single-file helpers expect { vfs, path: <file> } or "memory"');
}

// Infer the output format from the sink's file path extension. Used as the
// fallback when opts.format isn't specified — matches the spec's promise
// that `archive.compress({vfs,path:'a'}, {vfs,path:'a.tar.gz'})` Just Works.
function _formatFromSinkPath(sink) {
  if (sink && typeof sink === 'object' && typeof sink.path === 'string') {
    return magicForFormat(sink.path);
  }
  return null;
}

function _sinkBasename(sink) {
  if (sink && typeof sink === 'object' && typeof sink.path === 'string') {
    return sink.path.split('/').pop();
  }
  return null;
}

// Map opts.level (0..9 or undefined) onto fflate's zipSync options shape.
function _zipOptsFor(opts) {
  const o = {};
  if (typeof opts.level === 'number') o.level = Math.max(0, Math.min(9, opts.level | 0));
  return o;
}

// Build a `{ path: bytes }` entry map from one of the supported compress
// source shapes. VFS-backed sources walk via walkVfsTree; plain objects
// pass through after byte-coercing values; Uint8Array isn't accepted here
// (single-file gz/zst takes a different path in compress() above).
async function _gatherEntries(source, filter) {
  // VFS source — directory or single file.
  if (source && typeof source === 'object' && source.vfs && typeof source.path === 'string') {
    const entries = await walkVfsTree(source.vfs, source.path, filter ? { filter } : {});
    const map = {};
    for (const e of entries) map[e.path] = e.bytes;
    return map;
  }
  // Plain entry object — { 'a/b.txt': bytes-or-string, ... }
  if (source && typeof source === 'object' && !(source instanceof Uint8Array)) {
    const map = {};
    for (const [k, v] of Object.entries(source)) {
      if (filter && !filter({ path: k, type: k.endsWith('/') ? 'directory' : 'file' })) continue;
      if (v instanceof Uint8Array) map[k] = v;
      else if (typeof v === 'string') map[k] = new TextEncoder().encode(v);
      else if (v && v.buffer) map[k] = new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
      else map[k] = new Uint8Array(0);
    }
    return map;
  }
  throw new TypeError(
    'archive.compress: source must be { vfs, path } or a flat { path: bytes } object ' +
    '(single-stream compress goes through archive.gzip / archive.zstd)');
}

// -- licenses/index.js (IIFE-wrapped — exposes _licFetchLicense / _licAggregateLicenses / _licFormatTable) --

const { _licFetchLicense, _licAggregateLicenses, _licFormatTable } = (() => {
// @gcu/licenses — third-party license attribution for the GCU stack
// Auto-generated from ext/licenses/src/ — do not edit directly

// -- spdx.js --

// SPDX 3.0 license expression parser + bundled corpus.
//
// The corpus covers ~30 most-common SPDX ids — enough for >99% of real-world
// npm packages plus the academic/research adjacent stuff GCU users encounter.
// Anything outside the corpus parses fine (the parser is grammar-driven, not
// corpus-bound) but classify() returns 'unknown' for unrecognized ids.
//
// Grammar (SPDX 3.0):
//   compound  ::= or-expr
//   or-expr   ::= and-expr ("OR"  and-expr)*
//   and-expr  ::= with-expr ("AND" with-expr)*
//   with-expr ::= simple ("WITH" exception-id)?
//   simple    ::= id "+"? | "(" or-expr ")"
//   id        ::= [A-Za-z0-9][A-Za-z0-9.+-]*
//
// Precedence (high → low): "+", WITH, AND, OR. Operators are left-associative.

// ── Corpus ───────────────────────────────────────────────────────────────
// kind: 'permissive' | 'weak-copyleft' | 'strong-copyleft'
// fsfLibre / osiApproved fields omitted from v0.1 — add if a UI surfaces them.

const SPDX_KINDS = Object.freeze({
  PERMISSIVE: 'permissive',
  WEAK_COPYLEFT: 'weak-copyleft',
  STRONG_COPYLEFT: 'strong-copyleft',
  UNKNOWN: 'unknown',
});

const SPDX_CORPUS = Object.freeze({
  // Permissive — the long tail of "just attribute me".
  'MIT':              { kind: 'permissive', name: 'MIT License' },
  'MIT-0':            { kind: 'permissive', name: 'MIT No Attribution' },
  'Apache-2.0':       { kind: 'permissive', name: 'Apache License 2.0' },
  'BSD-2-Clause':     { kind: 'permissive', name: 'BSD 2-Clause "Simplified" License' },
  'BSD-3-Clause':     { kind: 'permissive', name: 'BSD 3-Clause "New" or "Revised" License' },
  'BSD-3-Clause-Clear': { kind: 'permissive', name: 'BSD 3-Clause Clear License' },
  'ISC':              { kind: 'permissive', name: 'ISC License' },
  '0BSD':             { kind: 'permissive', name: 'BSD Zero Clause License' },
  'Unlicense':        { kind: 'permissive', name: 'The Unlicense' },
  'WTFPL':            { kind: 'permissive', name: 'Do What The F*ck You Want To Public License' },
  'BlueOak-1.0.0':    { kind: 'permissive', name: 'Blue Oak Model License 1.0.0' },
  'CC0-1.0':          { kind: 'permissive', name: 'Creative Commons Zero v1.0 Universal' },
  'CC-BY-4.0':        { kind: 'permissive', name: 'Creative Commons Attribution 4.0 International' },
  'Python-2.0':       { kind: 'permissive', name: 'Python License 2.0' },
  'PSF-2.0':          { kind: 'permissive', name: 'Python Software Foundation License 2.0' },
  'Zlib':             { kind: 'permissive', name: 'zlib License' },
  'MS-PL':            { kind: 'permissive', name: 'Microsoft Public License' },
  'AFL-3.0':          { kind: 'permissive', name: 'Academic Free License v3.0' },
  'OFL-1.1':          { kind: 'permissive', name: 'SIL Open Font License 1.1' },
  'X11':              { kind: 'permissive', name: 'X11 License' },
  'Artistic-2.0':     { kind: 'permissive', name: 'Artistic License 2.0' },

  // Weak copyleft — file/library-level reciprocity.
  'LGPL-2.1-only':     { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v2.1 only' },
  'LGPL-2.1-or-later': { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v2.1 or later' },
  'LGPL-3.0-only':     { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v3.0 only' },
  'LGPL-3.0-or-later': { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v3.0 or later' },
  'MPL-2.0':           { kind: 'weak-copyleft', name: 'Mozilla Public License 2.0' },
  'MPL-1.1':           { kind: 'weak-copyleft', name: 'Mozilla Public License 1.1' },
  'EPL-1.0':           { kind: 'weak-copyleft', name: 'Eclipse Public License 1.0' },
  'EPL-2.0':           { kind: 'weak-copyleft', name: 'Eclipse Public License 2.0' },
  'CDDL-1.0':          { kind: 'weak-copyleft', name: 'Common Development and Distribution License 1.0' },
  'CDDL-1.1':          { kind: 'weak-copyleft', name: 'Common Development and Distribution License 1.1' },
  'CC-BY-SA-4.0':      { kind: 'weak-copyleft', name: 'Creative Commons Attribution Share Alike 4.0 International' },

  // Strong copyleft — viral.
  'GPL-2.0-only':      { kind: 'strong-copyleft', name: 'GNU General Public License v2.0 only' },
  'GPL-2.0-or-later':  { kind: 'strong-copyleft', name: 'GNU General Public License v2.0 or later' },
  'GPL-3.0-only':      { kind: 'strong-copyleft', name: 'GNU General Public License v3.0 only' },
  'GPL-3.0-or-later':  { kind: 'strong-copyleft', name: 'GNU General Public License v3.0 or later' },
  'AGPL-3.0-only':     { kind: 'strong-copyleft', name: 'GNU Affero General Public License v3.0 only' },
  'AGPL-3.0-or-later': { kind: 'strong-copyleft', name: 'GNU Affero General Public License v3.0 or later' },
});

// Legacy / deprecated ids that still appear in old package.json files.
// Per SPDX convention, bare "GPL-3.0" maps to "GPL-3.0-or-later" (npm history).
const SPDX_ALIASES = Object.freeze({
  'GPL-2.0':  'GPL-2.0-or-later',
  'GPL-3.0':  'GPL-3.0-or-later',
  'LGPL-2.1': 'LGPL-2.1-or-later',
  'LGPL-3.0': 'LGPL-3.0-or-later',
  'AGPL-3.0': 'AGPL-3.0-or-later',
  'BSD':      'BSD-3-Clause',
  'Apache':   'Apache-2.0',
});

function isKnownSpdxId(id) {
  if (typeof id !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(SPDX_CORPUS, id)
      || Object.prototype.hasOwnProperty.call(SPDX_ALIASES, id);
}

// Resolve aliases + strip "-or-later" / "+" suffix for corpus lookup.
// Returns canonical id present in SPDX_CORPUS, or null if no resolution.
function canonicalize(id) {
  if (Object.prototype.hasOwnProperty.call(SPDX_CORPUS, id)) return id;
  if (Object.prototype.hasOwnProperty.call(SPDX_ALIASES, id)) return SPDX_ALIASES[id];
  return null;
}


// ── Lexer ────────────────────────────────────────────────────────────────

const TOKEN = {
  ID: 'id', LPAREN: '(', RPAREN: ')', PLUS: '+', AND: 'AND', OR: 'OR', WITH: 'WITH',
};

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { tokens.push({ kind: TOKEN.LPAREN }); i++; continue; }
    if (c === ')') { tokens.push({ kind: TOKEN.RPAREN }); i++; continue; }
    if (c === '+') { tokens.push({ kind: TOKEN.PLUS }); i++; continue; }
    if (/[A-Za-z0-9]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9.\-]/.test(input[j])) j++;
      const word = input.slice(i, j);
      i = j;
      if (word === 'AND')  { tokens.push({ kind: TOKEN.AND }); continue; }
      if (word === 'OR')   { tokens.push({ kind: TOKEN.OR }); continue; }
      if (word === 'WITH') { tokens.push({ kind: TOKEN.WITH }); continue; }
      tokens.push({ kind: TOKEN.ID, value: word });
      continue;
    }
    return { error: `unexpected character '${c}' at position ${i}` };
  }
  return { tokens };
}

// ── Parser ───────────────────────────────────────────────────────────────
//
// AST nodes:
//   { kind: 'id',   id: 'MIT' }
//   { kind: 'plus', term: <id-node> }                  // GPL-2.0+
//   { kind: 'with', term: <node>, exception: 'name' }  // GPL-3.0+ WITH ...
//   { kind: 'and',  terms: [<node>, <node>, ...] }     // n-ary, flattened
//   { kind: 'or',   terms: [<node>, <node>, ...] }     // n-ary, flattened

function parser(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const eat  = (k) => {
    if (!tokens[i] || tokens[i].kind !== k) {
      throw new Error(`expected ${k}, got ${tokens[i] ? tokens[i].kind : 'EOF'}`);
    }
    return tokens[i++];
  };

  function parseOr() {
    const terms = [parseAnd()];
    while (peek() && peek().kind === TOKEN.OR) { eat(TOKEN.OR); terms.push(parseAnd()); }
    return terms.length === 1 ? terms[0] : { kind: 'or', terms };
  }

  function parseAnd() {
    const terms = [parseWith()];
    while (peek() && peek().kind === TOKEN.AND) { eat(TOKEN.AND); terms.push(parseWith()); }
    return terms.length === 1 ? terms[0] : { kind: 'and', terms };
  }

  function parseWith() {
    const term = parseSimple();
    if (peek() && peek().kind === TOKEN.WITH) {
      eat(TOKEN.WITH);
      if (!peek() || peek().kind !== TOKEN.ID) throw new Error('expected exception id after WITH');
      const exc = eat(TOKEN.ID);
      return { kind: 'with', term, exception: exc.value };
    }
    return term;
  }

  function parseSimple() {
    if (!peek()) throw new Error('unexpected end of expression');
    if (peek().kind === TOKEN.LPAREN) {
      eat(TOKEN.LPAREN);
      const inner = parseOr();
      eat(TOKEN.RPAREN);
      return inner;
    }
    if (peek().kind !== TOKEN.ID) throw new Error(`expected license id, got ${peek().kind}`);
    const id = eat(TOKEN.ID);
    let node = { kind: 'id', id: id.value };
    if (peek() && peek().kind === TOKEN.PLUS) { eat(TOKEN.PLUS); node = { kind: 'plus', term: node }; }
    return node;
  }

  const ast = parseOr();
  if (i < tokens.length) throw new Error(`unexpected token ${tokens[i].kind} after expression`);
  return ast;
}

// ── Public ───────────────────────────────────────────────────────────────

// validateSpdx(expression) → { valid: true, ast } | { valid: false, reason }
function validateSpdx(expression) {
  if (typeof expression !== 'string') return { valid: false, reason: 'not a string' };
  const trimmed = expression.trim();
  if (!trimmed) return { valid: false, reason: 'empty expression' };
  // npm anti-patterns: "SEE LICENSE IN <file>", "UNLICENSED", "Custom"
  if (/^SEE LICENSE IN /i.test(trimmed)) return { valid: false, reason: 'see-license-in placeholder' };
  if (/^UNLICENSED$/i.test(trimmed))     return { valid: false, reason: 'unlicensed marker' };

  const lex = tokenize(trimmed);
  if (lex.error) return { valid: false, reason: lex.error };
  try {
    const ast = parser(lex.tokens);
    return { valid: true, ast };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

// parseSpdx(expression) → ast, or throws.
// Convenience for callers who'd rather try/catch.
function parseSpdx(expression) {
  const r = validateSpdx(expression);
  if (!r.valid) throw new Error(`invalid SPDX expression: ${r.reason}`);
  return r.ast;
}

// -- classify.js --

// classify(id|expression) → 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown'
//
// Composition rules:
//   AND — must comply with all → take the MOST RESTRICTIVE classification
//   OR  — caller picks one     → take the MOST PERMISSIVE classification
//   WITH — preserves the base classification (the exception is a carve-out
//          to the same license; it doesn't change the broad kind)
//   "+"  — preserves the base classification (or-later semantics)
//
// "Unknown" is treated as maximally restrictive: in AND it dominates (we can't
// reason about it), in OR it loses to any known permissive option (a rational
// caller picks the known-safe license).


// Severity ordering — higher = more restrictive / less attractive.
const SEVERITY = {
  permissive: 0,
  'weak-copyleft': 1,
  'strong-copyleft': 2,
  unknown: 3,
};

const FROM_SEVERITY = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

function kindOfId(id) {
  const canonical = canonicalize(id);
  if (!canonical) return SPDX_KINDS.UNKNOWN;
  return SPDX_CORPUS[canonical].kind;
}

// Walk an AST node (as produced by parseSpdx) and return the kind.
function classifyExpression(ast) {
  if (!ast || typeof ast !== 'object') return SPDX_KINDS.UNKNOWN;
  switch (ast.kind) {
    case 'id':
      return kindOfId(ast.id);
    case 'plus':
      return classifyExpression(ast.term);
    case 'with':
      // The exception carves out specific permissions; the base license kind
      // is what governs reciprocity expectations. Classpath exception on
      // GPL-3.0 is still strong-copyleft for our warning purposes.
      return classifyExpression(ast.term);
    case 'and': {
      // Most restrictive (max severity).
      let worst = -1;
      for (const t of ast.terms) {
        const sev = SEVERITY[classifyExpression(t)];
        if (sev > worst) worst = sev;
      }
      return worst < 0 ? SPDX_KINDS.UNKNOWN : FROM_SEVERITY[worst];
    }
    case 'or': {
      // Most permissive (min severity).
      let best = Infinity;
      for (const t of ast.terms) {
        const sev = SEVERITY[classifyExpression(t)];
        if (sev < best) best = sev;
      }
      return !isFinite(best) ? SPDX_KINDS.UNKNOWN : FROM_SEVERITY[best];
    }
    default:
      return SPDX_KINDS.UNKNOWN;
  }
}

// classify accepts either a bare SPDX id, an SPDX expression string, or null.
// Returns the same four-way verdict regardless of input shape.
function classify(input) {
  if (input == null) return SPDX_KINDS.UNKNOWN;
  if (typeof input !== 'string') return SPDX_KINDS.UNKNOWN;
  const trimmed = input.trim();
  if (!trimmed) return SPDX_KINDS.UNKNOWN;

  // Fast path — bare id with no operators.
  if (/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(trimmed)) {
    return kindOfId(trimmed);
  }

  // Expression path — parse + walk.
  const parsed = validateSpdx(trimmed);
  if (!parsed.valid) return SPDX_KINDS.UNKNOWN;
  return classifyExpression(parsed.ast);
}

// -- format.js --

// Formatters for license aggregation output.
//
// Input shape (the table — as produced by aggregateLicenses, not yet shipped):
//   [
//     { pkg, version, source, path, spdx, classification, confidence?, verified?,
//       copyright?, text?, fetchedFrom? },
//     ...
//   ]
//
// 'pkg' is the bare name (lodash); 'version' is optional (vendored deps may
// just be '6.x'); 'source' is one of:
//   'install'    — runtime install() in a notebook
//   'pkg/npm', 'pkg/jsr', 'pkg/gh', 'pkg/local' — workspace pkg manager
//   'vendored'   — build-time-baked dep from /sys/licenses/
//
// Three output modes:
//   text     — geas stdout / log lines
//   html     — settings UI table rows
//   spdx-bom — SPDX SBOM 2.3 JSON (compliance tooling)
//
// formatNoticesFile produces a single plaintext blob suitable for a
// THIRD-PARTY-NOTICES.txt sidecar.

const STATUS_TEXT = {
  permissive:        'ok',
  'weak-copyleft':   'weak copyleft',
  'strong-copyleft': 'strong copyleft',
  unknown:           'no license',
};

const STATUS_HTML_CLASS = {
  permissive:        'lic-ok',
  'weak-copyleft':   'lic-warn',
  'strong-copyleft': 'lic-danger',
  unknown:           'lic-unknown',
};

function pkgLabel(entry) {
  return entry.version ? `${entry.pkg}@${entry.version}` : entry.pkg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Text ─────────────────────────────────────────────────────────────────

function formatText(table) {
  const rows = table.map((e) => ({
    pkg:    pkgLabel(e),
    spdx:   e.spdx || 'UNKNOWN',
    source: e.source || '-',
    status: STATUS_TEXT[e.classification] || 'unknown',
  }));

  const headers = { pkg: 'Package', spdx: 'SPDX', source: 'Source', status: 'Status' };
  const widths = {};
  for (const k of Object.keys(headers)) {
    widths[k] = headers[k].length;
    for (const r of rows) widths[k] = Math.max(widths[k], r[k].length);
  }

  const pad = (s, w) => s + ' '.repeat(w - s.length);
  const line = (r) =>
    `${pad(r.pkg, widths.pkg)}  ${pad(r.spdx, widths.spdx)}  ${pad(r.source, widths.source)}  ${r.status}`;

  const out = [line(headers)];
  out.push('-'.repeat(out[0].length));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// ── HTML ─────────────────────────────────────────────────────────────────

function formatHtml(table) {
  const out = ['<table class="lic-table">'];
  out.push('<thead><tr>',
    '<th>Package</th>',
    '<th>SPDX</th>',
    '<th>Source</th>',
    '<th>Status</th>',
    '</tr></thead><tbody>');
  for (const e of table) {
    const cls = STATUS_HTML_CLASS[e.classification] || 'lic-unknown';
    out.push(
      `<tr class="${cls}">`,
      `<td>${escapeHtml(pkgLabel(e))}</td>`,
      `<td>${escapeHtml(e.spdx || 'UNKNOWN')}</td>`,
      `<td>${escapeHtml(e.source || '-')}</td>`,
      `<td>${escapeHtml(STATUS_TEXT[e.classification] || 'unknown')}</td>`,
      '</tr>'
    );
  }
  out.push('</tbody></table>');
  return out.join('');
}

// ── SPDX SBOM 2.3 ────────────────────────────────────────────────────────
//
// Minimal-but-conformant SBOM document. Real compliance tooling (e.g.
// spdx-tools, FOSSology) accepts this shape. We don't compute file-level
// SPDX info — package granularity only.

function spdxRef(entry, idx) {
  // SPDXID must match: ^SPDXRef-[A-Za-z0-9.\-]+$
  const safe = String(pkgLabel(entry)).replace(/[^A-Za-z0-9.\-]/g, '-');
  return `SPDXRef-Package-${safe}-${idx}`;
}

function formatSpdxBom(table, opts = {}) {
  const now = (opts.now || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const docName = opts.documentName || 'auditable-workspace';
  const namespace = opts.documentNamespace
    || `https://endarthur.github.io/auditable/sbom/${docName}-${Date.now()}`;

  const packages = table.map((e, idx) => {
    const declared = e.spdx && e.spdx !== 'UNKNOWN' ? e.spdx : 'NOASSERTION';
    return {
      SPDXID: spdxRef(e, idx),
      name: e.pkg,
      versionInfo: e.version || 'NOASSERTION',
      downloadLocation: e.fetchedFrom || 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: declared,
      licenseDeclared: declared,
      copyrightText: e.copyright || 'NOASSERTION',
    };
  });

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: namespace,
    creationInfo: {
      created: now,
      creators: ['Tool: @gcu/licenses-0.1.0'],
    },
    packages,
    relationships: packages.map((p) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relatedSpdxElement: p.SPDXID,
      relationshipType: 'DESCRIBES',
    })),
  };
}

// ── Public ───────────────────────────────────────────────────────────────

function formatTable(table, opts = {}) {
  if (!Array.isArray(table)) throw new TypeError('formatTable: table must be an array');
  const format = opts.format || 'text';
  switch (format) {
    case 'text':     return formatText(table);
    case 'html':     return formatHtml(table);
    case 'spdx-bom': return formatSpdxBom(table, opts);
    default: throw new Error(`formatTable: unknown format '${format}'`);
  }
}

// formatNoticesFile — single plaintext blob for a THIRD-PARTY-NOTICES.txt
// sidecar. Each entry: header + copyright + LICENSE text + separator.
function formatNoticesFile(table, opts = {}) {
  if (!Array.isArray(table)) throw new TypeError('formatNoticesFile: table must be an array');
  const intro = opts.intro
    || `Third-party notices\n` +
       `===================\n\n` +
       `This artifact includes the following third-party components.\n` +
       `Each component is reproduced under its own license; see the per-entry\n` +
       `license text below for terms.\n`;
  const SEP = '\n' + '='.repeat(72) + '\n\n';

  const parts = [intro];
  for (const e of table) {
    const lines = [];
    lines.push(SEP);
    lines.push(`${pkgLabel(e)}`);
    lines.push(`License: ${e.spdx || 'UNKNOWN'}`);
    if (e.source)      lines.push(`Source: ${e.source}`);
    if (e.fetchedFrom) lines.push(`Origin: ${e.fetchedFrom}`);
    if (e.copyright)   lines.push(`\n${e.copyright}`);
    lines.push('');
    if (e.text) {
      lines.push(e.text.trim());
    } else {
      lines.push('(No license text captured.)');
    }
    lines.push('');
    parts.push(lines.join('\n'));
  }
  return parts.join('');
}

// -- fetch.js --

// fetchLicense — fetch + interpret SPDX + LICENSE info for a remote module.
//
// parseUrlToSource(url) → { source, pkg, version, origin } normalizes a
// remote URL into a registry descriptor; fetchLicense(desc) then dispatches
// to the appropriate per-registry handler.
//
// Per-registry handlers (esm.sh, jsdelivr, unpkg, github, jsr, generic url)
// each do up to ~3 small HTTP requests: typically package metadata +
// LICENSE-file probe. Failures degrade gracefully — the function never
// throws on registry quirks; it returns `{ spdx: 'UNKNOWN', spdxSource: ..., hint }`
// instead so the caller's install path stays unaffected.
//
// Network is injected via opts.fetch (defaults to globalThis.fetch). Tests
// pass a mock; production passes the real thing.

// ── parseUrlToSource ─────────────────────────────────────────────────────
//
// URL shapes handled:
//   https://esm.sh/<pkg>@<ver>[/<deep>][?<qs>]            → esm.sh
//   https://esm.sh/<pkg>                                   → esm.sh (no version)
//   https://esm.sh/@<scope>/<pkg>@<ver>                    → esm.sh (scoped)
//   https://cdn.jsdelivr.net/npm/<pkg>@<ver>[/<deep>]      → jsdelivr (npm)
//   https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>[...]  → github (via jsdelivr)
//   https://unpkg.com/<pkg>@<ver>[/<deep>]                 → unpkg
//   https://jsr.io/<pkg>@<ver>[/<deep>]                    → jsr (pkg is @scope/name)
//   https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<file>  → github
//   https://github.com/<owner>/<repo>/raw/<sha>/<file>             → github
//   anything else                                          → 'url' (generic)

const PKG_VERSION_RE = /^(?:(@[^/]+)\/)?([^@/]+)(?:@([^/?#]+))?(.*)$/;
//                      ^scope?           ^name    ^version       ^rest

function splitPkgVersion(slug) {
  // slug here is the path-after-prefix, no leading slash. Returns { pkg, version }
  // or null if not parseable. Handles scoped packages.
  const m = PKG_VERSION_RE.exec(slug);
  if (!m) return null;
  const scope = m[1] || '';
  const name = m[2];
  const version = m[3] || null;
  if (!name) return null;
  return { pkg: scope ? `${scope}/${name}` : name, version };
}

function parseUrlToSource(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }

  // esm.sh
  if (u.hostname === 'esm.sh' || u.hostname.endsWith('.esm.sh')) {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'esm.sh', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // jsdelivr (two prefixes: /npm/ and /gh/)
  if (u.hostname === 'cdn.jsdelivr.net') {
    if (u.pathname.startsWith('/npm/')) {
      const slug = u.pathname.slice(5);
      const pv = splitPkgVersion(slug);
      if (!pv) return null;
      return { source: 'jsdelivr', pkg: pv.pkg, version: pv.version, origin: url };
    }
    if (u.pathname.startsWith('/gh/')) {
      // /gh/<owner>/<repo>@<ref>[/...]
      const slug = u.pathname.slice(4);
      const m = /^([^/]+)\/([^/@]+)(?:@([^/]+))?(?:\/|$)/.exec(slug);
      if (!m) return null;
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3] || null,
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] || null },
      };
    }
  }

  // unpkg
  if (u.hostname === 'unpkg.com') {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'unpkg', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // jsr
  if (u.hostname === 'jsr.io') {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'jsr', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // GitHub raw
  if (u.hostname === 'raw.githubusercontent.com') {
    const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3],
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] },
      };
    }
  }
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3],
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] },
      };
    }
  }

  // Generic fallback — use hostname+path as pkg name, no version.
  return {
    source: 'url',
    pkg: u.hostname + u.pathname.replace(/\/[^/]*$/, ''),
    version: null,
    origin: url,
  };
}

// ── License field interpretation ─────────────────────────────────────────

// package.json#license can be: string, { type, url }, or absent.
// Older packages used a `licenses` array of { type, url } objects.
// Exported so aggregate.js can reuse the same logic on VFS-stored package.json
// files. At build time the `export` keyword is stripped and the function ends
// up as a single top-level declaration in the concatenated bundle.
function spdxFromPackageJson(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.license === 'string') return json.license;
  if (json.license && typeof json.license === 'object' && typeof json.license.type === 'string') {
    return json.license.type;
  }
  if (Array.isArray(json.licenses) && json.licenses.length > 0) {
    const types = json.licenses
      .map((l) => (l && typeof l === 'object' ? l.type : (typeof l === 'string' ? l : null)))
      .filter(Boolean);
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

// Extract a copyright notice line from LICENSE text. Best-effort, regex-y.
// Exported for aggregate.js's reuse — see spdxFromPackageJson note above.
function extractCopyright(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (/^Copyright\b/i.test(t) || /^\(c\)\s/i.test(t) || /^©\s/.test(t)) {
      if (t.length > 4 && t.length < 400) return t;
    }
  }
  return null;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function tryFetchText(fetch, url) {
  try {
    const res = await fetch(url);
    if (!res || !res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function tryFetchJson(fetch, url) {
  const text = await tryFetchText(fetch, url);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Probe a base directory for a LICENSE-like file. Returns { text, filename, url }
// on first hit, or null.
//
// Trimmed to the three canonical names — together they hit ~99% of real
// packages, and each miss costs an HTTP round-trip that the user can see in
// devtools as a noisy 404. The original long-tail (license.md, COPYING*,
// NOTICE) was nice-to-have but not worth the cost.
//
// Exported for aggregate.js's reuse — see spdxFromPackageJson note above.
const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
];

async function probeLicense(fetch, baseUrl) {
  for (const name of LICENSE_FILENAMES) {
    const url = baseUrl.replace(/\/$/, '') + '/' + name;
    const text = await tryFetchText(fetch, url);
    if (text) return { text, filename: name, url };
  }
  return null;
}

// ── Per-registry fetchers ────────────────────────────────────────────────

const STAMP = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function unknownResult({ origin, hint, fetchedFrom = null }) {
  return {
    spdx: 'UNKNOWN',
    text: null,
    copyright: null,
    spdxSource: 'unknown',
    textSource: null,
    fetchedFrom: fetchedFrom || origin || null,
    fetchedAt: STAMP(),
    confidence: 'low',
    hint: hint || null,
  };
}

function buildResult({ spdx, text, filename, baseUrl, spdxSource, textSource, origin }) {
  return {
    spdx: spdx || 'UNKNOWN',
    text: text || null,
    copyright: text ? extractCopyright(text) : null,
    spdxSource: spdx ? spdxSource : (text ? 'inferred-from-license-file' : 'unknown'),
    textSource: text ? textSource : null,
    fetchedFrom: text && filename ? `${baseUrl.replace(/\/$/, '')}/${filename}` : (origin || null),
    fetchedAt: STAMP(),
    confidence: spdx ? 'high' : (text ? 'low' : 'low'),
    hint: null,
  };
}

async function fetchFromCdnBase(fetch, desc, baseUrl) {
  // Both esm.sh and jsdelivr/npm expose package.json at <base>/package.json
  // and LICENSE files at <base>/<name>. unpkg too.
  const pkgJson = await tryFetchJson(fetch, baseUrl.replace(/\/$/, '') + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const probe = await probeLicense(fetch, baseUrl);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no package.json and no LICENSE file at base url' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl,
    spdxSource: 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

async function fetchEsmSh(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const esmBase = `https://esm.sh/${desc.pkg}${verSlug}`;
  // esm.sh serves package.json reliably but NOT arbitrary repo files
  // (LICENSE et al.). Use jsdelivr for the LICENSE-file probe — it mirrors
  // the npm tarball verbatim, so files like LICENSE that ship with the
  // tarball are served at predictable paths. Two CDNs, one HTTP request
  // each at the happy path (package.json from esm.sh, LICENSE from jsdelivr).
  const pkgJson = await tryFetchJson(fetch, esmBase + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const jsdBase = `https://cdn.jsdelivr.net/npm/${desc.pkg}${verSlug}`;
  const probe = await probeLicense(fetch, jsdBase);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no package.json on esm.sh and no LICENSE on jsdelivr' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl: jsdBase,
    spdxSource: 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

async function fetchJsdelivr(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://cdn.jsdelivr.net/npm/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchUnpkg(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://unpkg.com/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchJsr(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://jsr.io/${desc.pkg}${verSlug}`;
  // jsr exposes jsr.json (not package.json) — try both, prefer jsr.json
  const jsrJson = await tryFetchJson(fetch, base + '/jsr.json');
  const pkgJson = jsrJson || await tryFetchJson(fetch, base + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const probe = await probeLicense(fetch, base);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no jsr.json/package.json and no LICENSE on jsr.io' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl: base,
    spdxSource: jsrJson ? 'jsr.json' : 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

// GitHub License API returns { license: { spdx_id, name }, content: <base64>,
// encoding: 'base64', download_url, ... }. Rate-limited (60/hr unauthenticated).
async function fetchGithub(fetch, desc) {
  const owner = desc.github && desc.github.owner;
  const repo  = desc.github && desc.github.repo;
  if (!owner || !repo) {
    // Fall back to parsing from desc.pkg = "owner/repo"
    const parts = (desc.pkg || '').split('/');
    if (parts.length !== 2) return unknownResult({ origin: desc.origin, hint: 'cannot parse github owner/repo' });
  }
  const o = owner || desc.pkg.split('/')[0];
  const r = repo  || desc.pkg.split('/')[1];

  const api = `https://api.github.com/repos/${o}/${r}/license`;
  const json = await tryFetchJson(fetch, api);
  if (!json) {
    // Rate-limit or 404 — try raw fallback at <ref>/LICENSE
    const ref = (desc.github && desc.github.ref) || desc.version || 'HEAD';
    const rawBase = `https://raw.githubusercontent.com/${o}/${r}/${ref}`;
    const probe = await probeLicense(fetch, rawBase);
    if (!probe) {
      return unknownResult({ origin: desc.origin, hint: 'github API unreachable and no LICENSE in raw' });
    }
    return buildResult({
      spdx: null,
      text: probe.text,
      filename: probe.filename,
      baseUrl: rawBase,
      spdxSource: null,
      textSource: 'LICENSE-file',
      origin: desc.origin,
    });
  }

  const spdx = json.license && typeof json.license.spdx_id === 'string'
    ? (json.license.spdx_id === 'NOASSERTION' ? null : json.license.spdx_id)
    : null;
  let text = null;
  if (typeof json.content === 'string' && json.encoding === 'base64') {
    try {
      // Node + browser both have atob in modern envs; Node 16+ has globalThis.atob.
      const cleaned = json.content.replace(/\s+/g, '');
      text = typeof atob === 'function'
        ? atob(cleaned)
        : Buffer.from(cleaned, 'base64').toString('utf8');
    } catch { text = null; }
  }

  return {
    spdx: spdx || 'UNKNOWN',
    text,
    copyright: text ? extractCopyright(text) : null,
    spdxSource: spdx ? 'github-api' : (text ? 'inferred-from-license-file' : 'unknown'),
    textSource: text ? 'github-api' : null,
    fetchedFrom: json.download_url || api,
    fetchedAt: STAMP(),
    confidence: spdx ? 'high' : 'low',
    hint: null,
  };
}

// Generic-URL: best-effort. If the URL is a JS file at <host>/<path>/<file>.js,
// try a sibling LICENSE at <host>/<path>/LICENSE. If the URL is a directory,
// try LICENSE at root. Nothing else.
async function fetchGenericUrl(fetch, desc) {
  let u;
  try { u = new URL(desc.origin); } catch { return unknownResult({ origin: desc.origin, hint: 'unparseable url' }); }
  const dir = u.origin + u.pathname.replace(/\/[^/]*$/, '');
  const probe = await probeLicense(fetch, dir);
  if (!probe) return unknownResult({ origin: desc.origin, hint: 'no LICENSE near url' });
  return buildResult({
    spdx: null,
    text: probe.text,
    filename: probe.filename,
    baseUrl: dir,
    spdxSource: null,
    textSource: 'LICENSE-file',
    origin: desc.origin,
  });
}

// ── Public ───────────────────────────────────────────────────────────────

async function fetchLicense(input, opts = {}) {
  const fetch = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
  if (!fetch) {
    return { ...unknownResult({ origin: null, hint: 'no fetch available in environment' }), spdxSource: 'no-fetch' };
  }

  let desc;
  if (typeof input === 'string') desc = parseUrlToSource(input);
  else if (input && typeof input === 'object') desc = input;
  else return { ...unknownResult({ origin: null, hint: 'invalid input to fetchLicense' }), spdxSource: 'invalid-input' };

  if (!desc) return { ...unknownResult({ origin: typeof input === 'string' ? input : null, hint: 'could not parse url' }), spdxSource: 'unparseable-source' };

  switch (desc.source) {
    case 'esm.sh':   return fetchEsmSh(fetch, desc);
    case 'jsdelivr': return fetchJsdelivr(fetch, desc);
    case 'unpkg':    return fetchUnpkg(fetch, desc);
    case 'jsr':      return fetchJsr(fetch, desc);
    case 'github':   return fetchGithub(fetch, desc);
    case 'url':      return fetchGenericUrl(fetch, desc);
    default:
      return { ...unknownResult({ origin: desc.origin, hint: `no handler for source '${desc.source}'` }), spdxSource: 'no-handler' };
  }
}

// -- infer.js --

// inferLicense(text) — fingerprint-based SPDX-id guess from raw license text.
//
// Use case: an installed module shipped a LICENSE file but no package.json
// `license` field (or pkg-managed only). Without this, the aggregator labels
// everything UNKNOWN — pessimistic but useless. The fingerprints below match
// the distinctive sentinel phrase from each license's CANONICAL text — same
// approach SPDX/license-detector use, scaled down to the ~10 ids that cover
// the ecosystem auditable actually pulls from.
//
// Returns: an SPDX id string on a confident match, or null. Designed to be
// boring: we'd rather decline than misclassify. The caller treats null as
// "still UNKNOWN, fall back to whatever was already there."
//
// Not a full SPDX detector. Things deliberately out of scope:
//   - Exception detection (WITH clauses).
//   - License-text variants that diverge from canonical wording.
//   - OR-disjunctions inside one file.
//
// Fingerprints picked for uniqueness within the working corpus, not for
// distinguishing every SPDX id from every other. ISC + MIT share a lot of
// phrasing; the ISC check runs first because its distinctive "fee" wording
// would otherwise be claimed as MIT.

// Each entry: { id, pattern } where pattern is a regex. The first match wins.
// Order matters — more-specific patterns ahead of more-generic ones.
const FINGERPRINTS = [
  // BSD-3 has the distinctive third clause about endorsement.
  { id: 'BSD-3-Clause', pattern: /neither the name of (the copyright holder|the (\w+\s){1,4}foundation)?[\s\S]{0,200}?be used to endorse or promote products/i },

  // BSD-2 = BSD-3 minus the endorsement clause. Match the redistributions clauses without endorsement.
  { id: 'BSD-2-Clause', pattern: /redistributions of source code must retain[\s\S]{0,400}?redistributions in binary form must reproduce/i },

  // ISC — short permissive, distinctive "fee" + no warranty.
  { id: 'ISC', pattern: /permission to use,? copy,? modify,?( and\/or)? distribute this software for any purpose with or without fee/i },

  // MIT — distinctive opening clause + "Software" reference.
  { id: 'MIT', pattern: /permission is hereby granted,? free of charge,? to any person obtaining a copy[\s\S]{0,200}?(of this software|the "?Software"?)/i },

  // Apache-2.0 — distinctive title line.
  { id: 'Apache-2.0', pattern: /apache license[\s\S]{0,30}?version 2\.0/i },

  // MPL-2.0 — distinctive title line.
  { id: 'MPL-2.0', pattern: /mozilla public license[\s\S]{0,30}?version 2\.0/i },

  // AGPL-3.0 — order before GPL because both contain "GNU GENERAL PUBLIC LICENSE".
  { id: 'AGPL-3.0', pattern: /gnu affero general public license[\s\S]{0,30}?version 3/i },

  // LGPL — version-specific.
  { id: 'LGPL-3.0', pattern: /gnu lesser general public license[\s\S]{0,30}?version 3/i },
  { id: 'LGPL-2.1', pattern: /gnu lesser general public license[\s\S]{0,30}?version 2\.1/i },

  // GPL — version-specific. AGPL/LGPL already filtered above.
  { id: 'GPL-3.0', pattern: /gnu general public license[\s\S]{0,30}?version 3/i },
  { id: 'GPL-2.0', pattern: /gnu general public license[\s\S]{0,30}?version 2/i },

  // The Unlicense — distinctive public-domain dedication phrasing.
  { id: 'Unlicense', pattern: /this is free and unencumbered software released into the public domain/i },

  // 0BSD / BSD-Zero-Clause — distinctive no-attribution-required phrasing.
  { id: '0BSD', pattern: /permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i },

  // CC0 — public domain dedication, distinctive title.
  { id: 'CC0-1.0', pattern: /cc0 1\.0 universal/i },
];

function inferLicense(text) {
  if (typeof text !== 'string' || text.length < 40) return null;
  // Whitespace normalize so a Win-style \r\n LICENSE file matches the same
  // patterns as a Unix one. Cheap; ~one allocation.
  const t = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
  for (const fp of FINGERPRINTS) {
    if (fp.pattern.test(t)) return fp.id;
  }
  return null;
}

// -- aggregate.js --

// aggregateLicenses(vfs) — pure view function over the workspace VFS.
//
// Walks three well-known roots and returns a flat table:
//   /var/modules/<key>/         — install()'d modules (meta.json + LICENSE)
//   /lib/<source>/<pkg>@<ver>/  — pkg-managed (package.json + LICENSE)
//   /sys/licenses/<name>/       — build-time-vendored (index.json + LICENSE)
//
// No caching, no aggregator file. The per-folder LICENSE is the canonical
// store; this function just walks + classifies. Tolerant of missing roots
// (returns the entries from whichever roots exist).
//
// VFS duck type — needs only:
//   readdir(path)            → array of names (string)
//   readFile(path, encoding) → string (encoding='utf8') or Uint8Array
//   stat(path)               → { type: 'file' | 'directory', ... }
//
// All three may throw on missing paths; we catch and treat as empty.




// Backfill an SPDX id from license text when the upstream metadata didn't
// declare one. Returns { spdx, inferred } — inferred=true marks rows whose
// classification leaned on the fingerprint heuristic rather than a declared
// package.json field. UI can show this with a softer badge.
function _resolveSpdx(declared, text) {
  if (declared && typeof declared === 'string' && declared !== 'UNKNOWN') {
    return { spdx: declared, inferred: false };
  }
  if (typeof text === 'string' && text.length > 0) {
    const guess = inferLicense(text);
    if (guess) return { spdx: guess, inferred: true };
  }
  return { spdx: declared || 'UNKNOWN', inferred: false };
}

// ── VFS-safe helpers ─────────────────────────────────────────────────────

async function safeReaddir(vfs, path) {
  try {
    const r = vfs.readdir(path);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return []; }
}

async function safeReadFile(vfs, path, encoding) {
  try {
    const r = vfs.readFile(path, encoding);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return null; }
}

async function safeStat(vfs, path) {
  try {
    const r = vfs.stat(path);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return null; }
}

async function readJson(vfs, path) {
  const text = await safeReadFile(vfs, path, 'utf8');
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

// readLicenseFile reuses the LICENSE-filename list from fetch.js (probed against
// HTTP URLs there, VFS paths here). spdxFromPackageJson + extractCopyright are
// also shared — same heuristics whether we read package.json from a CDN or
// from a /lib/<pkg>/ directory.
async function readLicenseFile(vfs, dir) {
  for (const name of LICENSE_FILENAMES) {
    const text = await safeReadFile(vfs, `${dir}/${name}`, 'utf8');
    if (typeof text === 'string' && text.length > 0) {
      return { text, filename: name };
    }
  }
  return null;
}

// ── Per-root walkers ─────────────────────────────────────────────────────

// /var/modules/<url-encoded-key>/  → install()'d ESM modules
async function walkVarModules(vfs) {
  const out = [];
  const entries = await safeReaddir(vfs, '/var/modules');
  for (const key of entries) {
    const dir = `/var/modules/${key}`;
    const st = await safeStat(vfs, dir);
    if (!st || st.type !== 'directory') continue;

    const meta = await readJson(vfs, `${dir}/meta.json`) || {};
    const lic  = await readLicenseFile(vfs, dir);

    // Prefer meta.json.url for canonical pkg/version (round-trippable through
    // parseUrlToSource); fall back to decoded key.
    let pkg = null, version = null;
    if (typeof meta.url === 'string') {
      const desc = parseUrlToSource(meta.url);
      if (desc) { pkg = desc.pkg; version = desc.version; }
    }
    if (!pkg) {
      try {
        const decoded = decodeURIComponent(key);
        const desc = parseUrlToSource(decoded);
        if (desc) { pkg = desc.pkg; version = desc.version; }
      } catch { /* fall through */ }
    }
    if (!pkg) pkg = key;

    const declared = (meta.license && typeof meta.license.spdx === 'string')
      ? meta.license.spdx
      : null;
    const { spdx, inferred } = _resolveSpdx(declared, lic ? lic.text : null);

    out.push({
      pkg, version,
      source: 'install',
      path: dir,
      spdx,
      classification: classify(spdx),
      inferred,
      copyright: meta.license && meta.license.copyright || (lic ? extractCopyright(lic.text) : null),
      text: lic ? lic.text : null,
      fetchedFrom: meta.license && meta.license.fetchedFrom || null,
      verified: !!(meta.license && lic),  // meta says X, file present — verifiable
    });
  }
  return out;
}

// /lib/<source>/<pkg-dir>/  — pkg-managed packages
// Sources we recognize: npm, jsr, gh, @gcu/local
async function walkLib(vfs) {
  const out = [];
  const sources = await safeReaddir(vfs, '/lib');
  for (const srcName of sources) {
    const sourcePath = `/lib/${srcName}`;
    const st = await safeStat(vfs, sourcePath);
    if (!st || st.type !== 'directory') continue;

    // gh has nested owner/repo, others have flat pkg@ver.
    if (srcName === 'gh') {
      const owners = await safeReaddir(vfs, sourcePath);
      for (const owner of owners) {
        const repos = await safeReaddir(vfs, `${sourcePath}/${owner}`);
        for (const repoSlug of repos) {
          const dir = `${sourcePath}/${owner}/${repoSlug}`;
          const st2 = await safeStat(vfs, dir);
          if (!st2 || st2.type !== 'directory') continue;
          const m = /^([^@]+)(?:@(.+))?$/.exec(repoSlug);
          const repo = m ? m[1] : repoSlug;
          const ref  = m && m[2] ? m[2] : null;
          out.push(await collectLibEntry(vfs, dir, `${owner}/${repo}`, ref, 'pkg/gh'));
        }
      }
      continue;
    }

    const items = await safeReaddir(vfs, sourcePath);
    for (const item of items) {
      // Scoped npm packages are nested: /lib/npm/@scope/pkg@ver
      if (item.startsWith('@')) {
        const scoped = await safeReaddir(vfs, `${sourcePath}/${item}`);
        for (const sub of scoped) {
          const dir = `${sourcePath}/${item}/${sub}`;
          const st2 = await safeStat(vfs, dir);
          if (!st2 || st2.type !== 'directory') continue;
          const m = /^([^@]+)(?:@(.+))?$/.exec(sub);
          const name = m ? m[1] : sub;
          const ver  = m && m[2] ? m[2] : null;
          out.push(await collectLibEntry(vfs, dir, `${item}/${name}`, ver, `pkg/${srcName}`));
        }
        continue;
      }
      const dir = `${sourcePath}/${item}`;
      const st2 = await safeStat(vfs, dir);
      if (!st2 || st2.type !== 'directory') continue;
      const m = /^([^@]+)(?:@(.+))?$/.exec(item);
      const name = m ? m[1] : item;
      const ver  = m && m[2] ? m[2] : null;
      out.push(await collectLibEntry(vfs, dir, name, ver, `pkg/${srcName}`));
    }
  }
  return out;
}

async function collectLibEntry(vfs, dir, pkg, version, sourceTag) {
  const pkgJson = await readJson(vfs, `${dir}/package.json`)
              || await readJson(vfs, `${dir}/jsr.json`)
              || {};
  const lic = await readLicenseFile(vfs, dir);
  const declared = spdxFromPackageJson(pkgJson);
  const { spdx, inferred } = _resolveSpdx(declared, lic ? lic.text : null);
  return {
    pkg, version,
    source: sourceTag,
    path: dir,
    spdx,
    classification: classify(spdx),
    inferred,
    copyright: lic ? extractCopyright(lic.text) : null,
    text: lic ? lic.text : null,
    fetchedFrom: null,
    verified: !!(declared && lic),
  };
}

// /sys/licenses/<name>/  — build-time-vendored deps
async function walkSysLicenses(vfs) {
  const out = [];
  const index = await readJson(vfs, '/sys/licenses/index.json') || {};
  const names = await safeReaddir(vfs, '/sys/licenses');
  for (const name of names) {
    if (name === 'index.json') continue;
    const dir = `/sys/licenses/${name}`;
    const st = await safeStat(vfs, dir);
    if (!st || st.type !== 'directory') continue;

    const entry = index[name] || {};
    const lic = await readLicenseFile(vfs, dir);
    const declared = typeof entry.spdx === 'string' ? entry.spdx : null;
    const { spdx, inferred } = _resolveSpdx(declared, lic ? lic.text : null);

    out.push({
      pkg: name,
      version: entry.version || null,
      source: 'vendored',
      path: dir,
      spdx,
      classification: classify(spdx),
      inferred,
      copyright: lic ? extractCopyright(lic.text) : null,
      text: lic ? lic.text : null,
      fetchedFrom: entry.homepage || null,
      verified: !!(declared && lic),
    });
  }
  return out;
}

// aggregateFromBuildLicenses — turn the build-time-injected manifest (see
// build.js's __BUILD_LICENSES__ injection, sourced from vendor-licenses.json)
// into the standard table shape. Used by the settings Licenses tab and the
// About dialog to surface what the binary itself was built from.
//
// Expected manifest shape:
//   { <name>: { spdx, version, homepage, description, text? } }
//
// Tolerant of missing fields — entries without `spdx` come through as UNKNOWN.
function aggregateFromBuildLicenses(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const out = [];
  for (const [name, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry !== 'object') continue;
    const declared = (typeof entry.spdx === 'string') ? entry.spdx : null;
    const text = typeof entry.text === 'string' ? entry.text : null;
    const { spdx, inferred } = _resolveSpdx(declared, text);
    out.push({
      pkg: name,
      version: entry.version || null,
      source: 'vendored',
      path: entry.homepage || name,
      spdx,
      classification: classify(spdx),
      inferred,
      copyright: text ? extractCopyright(text) : null,
      text,
      fetchedFrom: entry.homepage || null,
      description: entry.description || null,
      verified: !!text,
    });
  }
  return out;
}

// aggregateFromInstalledModules — in-memory variant for auditable's current
// runtime layout, where install()'d ESM modules live in a flat JS object
// (window._installedModules) rather than per-module VFS folders. Same entry
// shape as aggregateLicenses so the formatters and UI don't care which path
// produced the table.
//
// Expected entry shape (the runtime cache used by cell-builtins/modules.js):
//   _installedModules[url] = {
//     source, compressed, cellId, url, alias, integrity, kind,
//     installedAt, size,
//     license?:    { spdx, copyright, fetchedFrom, source, fetchedAt, ... },
//     licenseText?: string,   // raw or gzip-base64; treated as opaque text
//   }
//
// Pre-tracking entries (no `license` field) come through as classification:
// 'unknown' with `verified: false` — surfaces in the UI as a grey badge.
function aggregateFromInstalledModules(installedModules) {
  if (!installedModules || typeof installedModules !== 'object') return [];
  const out = [];
  for (const [key, entry] of Object.entries(installedModules)) {
    if (!entry || typeof entry !== 'object') continue;
    // binary assets aren't really "modules with licenses" — skip them. Their
    // upstream license, if any, is captured via the URL they came from in
    // the source-side install (handled separately by installBinary).
    if (entry.binary) continue;

    const url = entry.url || key;
    let pkg = null, version = null;
    const desc = parseUrlToSource(url);
    if (desc) { pkg = desc.pkg; version = desc.version; }
    if (!pkg) pkg = entry.alias || key;

    const lic = entry.license || null;
    const declared = (lic && typeof lic.spdx === 'string') ? lic.spdx : null;
    const text = typeof entry.licenseText === 'string' ? entry.licenseText : null;
    const { spdx, inferred } = _resolveSpdx(declared, text);
    out.push({
      pkg, version,
      source: 'install',
      path: key,                                         // the runtime cache key (URL)
      spdx,
      classification: classify(spdx),
      inferred,
      copyright: lic ? (lic.copyright || null) : null,
      text,
      fetchedFrom: lic ? (lic.fetchedFrom || null) : null,
      verified: !!(declared && text),
    });
  }
  return out;
}

// ── Public ───────────────────────────────────────────────────────────────

async function aggregateLicenses(vfs) {
  if (!vfs || typeof vfs.readdir !== 'function' || typeof vfs.readFile !== 'function') {
    throw new TypeError('aggregateLicenses: vfs must implement readdir() and readFile()');
  }
  const [installs, lib, sys] = await Promise.all([
    walkVarModules(vfs),
    walkLib(vfs),
    walkSysLicenses(vfs),
  ]);
  // Stable order: vendored first (the binary's own deps), then pkg, then install.
  return [...sys, ...lib, ...installs];
}

// -- api.js --

// Public surface for @gcu/licenses.
//
// Shipped:
//   - validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId  (from spdx.js)
//   - classify, classifyExpression                         (from classify.js)
//   - formatTable, formatNoticesFile                       (from format.js)
//   - parseUrlToSource, fetchLicense                       (from fetch.js)
//   - aggregateLicenses                                    (from aggregate.js)
//
//   - inferLicense                                          (from infer.js)
//
// inferLicense (added in this commit) is a substring-fingerprint fallback
// the aggregator uses automatically when an entry has LICENSE text but no
// declared SPDX id — rows with `inferred: true` mark heuristic matches.
return {
  _licFetchLicense:     fetchLicense,
  _licAggregateLicenses: aggregateLicenses,
  _licFormatTable:      formatTable,
};
})();

// -- src/js/gcupkg.js (prepended for `pkg install <file.gcupkg>`) --

// .gcupkg consumer — reader + VFS installer per EXTENSION_SPEC.md §6.1.
//
// A `.gcupkg` is a ZIP archive with a fixed internal layout:
//   package.json              ← required
//   index.js                  ← required (primary ES module entry)
//   adder.js                  ← optional (Python-shape adapter)
//   LICENSE                   ← required
//   README.md, SPEC.md        ← optional
//   examples/*.txt + manifest.json   ← optional (§6.3)
//   docs/*.md                 ← optional (§6.2)
//   .gcupkg-meta.json         ← required (schema below)
//
// Two phases:
//   parseGcupkg(bytes, archiveLib) → { meta, packageJson, files, integrity }
//     Unzips, parses metadata, validates schema, computes/verifies integrity.
//   installGcupkg(parsed, { vfs, installedModules }) → { libPath, ... }
//     Writes to /lib/<name>/, /usr/share/examples/<name>/, /usr/share/docs/<name>/.
//     Updates /lib/.gcu-lock.json + window._installedModules.
//
// Caller supplies the archive lib (zip reader). Auditable doesn't bundle
// @gcu/archive by default; works does, and geas can prepend it. The
// dependency is injected so this module stays portable.

const _DECODER = new TextDecoder();
const _ENCODER = new TextEncoder();

// ── Parse phase ──────────────────────────────────────────────────────────

async function parseGcupkg(bytes, archiveLib) {
  if (!bytes || !(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
    throw new TypeError('parseGcupkg: bytes must be Uint8Array | ArrayBuffer');
  }
  if (!archiveLib || !archiveLib.archive) {
    throw new Error('parseGcupkg: archive library required — pass { archive } from @gcu/archive');
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const archive = archiveLib.archive;

  // ZIP must be the outer container.
  const fmt = await archive.detect(u8);
  if (fmt !== 'zip') {
    throw new Error(`parseGcupkg: expected ZIP archive, detected '${fmt || 'unknown'}'`);
  }

  // Drain every entry into a flat map. .gcupkg are small (KB to MB range);
  // streaming would be overkill.
  const entries = await archive.list(u8);
  const files = {};
  for (const e of entries) {
    if (e.type !== 'file') continue;
    files[e.path] = await archive.read(u8, e.path);
  }

  // Required-file check before any further parsing. index.js is NOT required:
  // a shell-only package (surfaces via works.js + services via gcu.services,
  // no notebook-context entry) ships none. The notebook-side `source` (= index.js)
  // is only written when present (install phase).
  for (const required of ['.gcupkg-meta.json', 'package.json', 'LICENSE']) {
    if (!files[required]) {
      throw new Error(`parseGcupkg: missing required file '${required}'`);
    }
  }

  // Parse JSON.
  let meta, packageJson;
  try {
    meta = JSON.parse(_DECODER.decode(files['.gcupkg-meta.json']));
  } catch (e) {
    throw new Error(`parseGcupkg: invalid .gcupkg-meta.json — ${e.message}`);
  }
  try {
    packageJson = JSON.parse(_DECODER.decode(files['package.json']));
  } catch (e) {
    throw new Error(`parseGcupkg: invalid package.json — ${e.message}`);
  }

  // Schema check (small, intentional — keep the surface tight).
  if (meta.gcupkgVersion !== 1) {
    throw new Error(`parseGcupkg: unsupported gcupkgVersion ${JSON.stringify(meta.gcupkgVersion)} (this build supports 1)`);
  }
  if (typeof meta.name !== 'string' || !meta.name) {
    throw new Error('parseGcupkg: meta.name is required');
  }
  if (typeof meta.version !== 'string' || !meta.version) {
    throw new Error('parseGcupkg: meta.version is required');
  }
  if (packageJson.name && packageJson.name !== meta.name) {
    throw new Error(`parseGcupkg: name mismatch — meta says ${JSON.stringify(meta.name)}, package.json says ${JSON.stringify(packageJson.name)}`);
  }

  // Integrity verification, if the meta provides enough info.
  //
  // EXTENSION_SPEC §6.1 (revised): `integrityCovers` lists the files included
  // in the hash. Sort lexicographically, then for each: filename + NUL byte +
  // file bytes + NUL byte, all concatenated and SHA-256'd. The spec's
  // recommended scope is index.js + every secondary entry from
  // package.json `exports`, but the meta is the source of truth here.
  //
  // Legacy single-file integrity (carotte 0.1.0 shape — hash of index.js
  // only, no `integrityCovers` field) is verified as an `index.js`-only
  // hash for backwards compatibility, with a hint logged so the producer
  // can upgrade.
  let integrity = { ok: null, covered: null, computed: null, declared: null, note: null };
  if (typeof meta.integrity === 'string' && meta.integrity.startsWith('sha256-')) {
    integrity.declared = meta.integrity;
    if (Array.isArray(meta.integrityCovers) && meta.integrityCovers.length > 0) {
      integrity.covered = meta.integrityCovers;
      integrity.computed = await _computeIntegrity(meta.integrityCovers, files);
      integrity.ok = integrity.computed === meta.integrity;
    } else if (files['index.js']) {
      // Legacy: single-file index.js hash (no separator framing).
      integrity.covered = ['index.js'];
      integrity.computed = await _computeLegacyIntegrity(files['index.js']);
      integrity.ok = integrity.computed === meta.integrity;
      integrity.note = 'legacy single-file integrity (index.js only); upgrade producer to emit integrityCovers';
    } else {
      // A declared hash but no integrityCovers and no index.js to fall back on
      // (shell-only package) — can't verify. Leave ok null; the consent prompt
      // surfaces it as unsigned.
      integrity.note = 'integrity declared but no integrityCovers and no index.js — cannot verify; producer must emit integrityCovers';
    }
  } else {
    integrity.note = 'no integrity hash in meta';
  }

  return { meta, packageJson, files, integrity };
}

// SHA-256 of: sorted filename\0bytes\0... concatenation. Matches carotte's
// CLAUDE.md §1.1 recommendation + EXTENSION_SPEC §6.1's revised scope.
async function _computeIntegrity(coverList, files) {
  const sorted = [...coverList].sort();
  const chunks = [];
  let totalLen = 0;
  for (const name of sorted) {
    if (!files[name]) throw new Error(`integrity: file missing from archive: ${name}`);
    const nameBytes = _ENCODER.encode(name);
    chunks.push(nameBytes, _NUL, files[name], _NUL);
    totalLen += nameBytes.length + 1 + files[name].length + 1;
  }
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return _toSriSha256(await crypto.subtle.digest('SHA-256', merged));
}

// Legacy compatibility: SHA-256 of index.js bytes alone, no framing.
async function _computeLegacyIntegrity(indexBytes) {
  return _toSriSha256(await crypto.subtle.digest('SHA-256', indexBytes));
}

const _NUL = new Uint8Array([0]);

function _toSriSha256(hashBuffer) {
  const u8 = new Uint8Array(hashBuffer);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return 'sha256-' + btoa(bin);
}

// ── Consent descriptor ─────────────────────────────────────────────────────
//
// A realm-agnostic summary of what installing this package entails — fed to the
// install-consent dialog (shell-side in Works, notebook-side standalone). The
// single source of "what the user is consenting to": identity, integrity, what
// the package contributes (§6 `contributes`), and where it lands. `permissions`
// is the hook for the §7 capability manifest (declared `needs:`) — empty until
// that ships, but the dialog already has a place to render it. No install is
// ever silent: every entry point builds a descriptor and prompts (gcupkg always;
// gcudat when the "confirm data-pack installs" setting is on).
function gcupkgConsentDescriptor(parsed, opts = {}) {
  const meta = (parsed && parsed.meta) || {};
  const integ = (parsed && parsed.integrity) || { ok: null, note: 'no integrity hash in meta' };
  return {
    kind:        opts.kind || 'extension',        // 'extension' (code) | 'data'
    name:        meta.name || opts.name || 'unknown',
    version:     meta.version || '',
    integrity:   { ok: integ.ok, note: integ.note || null },  // ok: true | false | null (unsigned)
    contributes: Array.isArray(meta.contributes) ? meta.contributes.slice() : [],
    scope:       opts.scope || null,              // 'workspace' | 'notebook'
    permissions: [],                              // §7 capability-manifest hook (future)
  };
}

// Build the consent prompt content from a descriptor — pure (no DOM), so the
// SAME security copy renders in every realm (shell-side Works, notebook-side
// standalone) via that realm's own confirm() dialog. One source of truth for
// what the user is consenting to. `danger` flips the dialog to its warn styling
// (red primary) when integrity can't be verified — the part that earns the
// "never a silent install": you have to mean it.
function gcupkgConsentPrompt(d) {
  const isData = d.kind === 'data';
  const what = isData ? 'data pack' : 'extension';
  const ver = d.version ? ' v' + d.version : '';
  const scopeLine = d.scope === 'workspace'
    ? 'Installs to the workspace — available to every surface.'
    : d.scope === 'notebook'
      ? 'Installs to this notebook.'
      : '';
  let integLine = '';
  let danger = false;
  if (!isData) {
    if (d.integrity.ok === true) {
      integLine = '✓ Integrity verified.';
    } else if (d.integrity.ok === false) {
      integLine = '⚠ INTEGRITY MISMATCH — the contents do not match the declared signature. Only install if you trust the source.';
      danger = true;
    } else {
      integLine = '⚠ Unsigned — the publisher cannot be verified.';
      danger = true;
    }
  }
  const contribLine = (!isData && d.contributes && d.contributes.length)
    ? 'Adds: ' + d.contributes.map((c) =>
        typeof c === 'string' ? c : (c && (c.type || c.kind || c.name)) || 'contribution').join(', ') + '.'
    : '';
  const permLine = (d.permissions && d.permissions.length)
    ? 'Requests: ' + d.permissions.join(', ') + '.'
    : '';   // §7 manifest — empty until declared capabilities ship
  return {
    title:   isData ? 'Install data pack' : 'Install extension',
    message: [`${d.name}${ver}`, scopeLine, contribLine, permLine, integLine].filter(Boolean).join('\n\n'),
    okLabel: 'Install',
    danger,
  };
}

// ── Install phase ────────────────────────────────────────────────────────

async function installGcupkg(parsed, opts = {}) {
  const { meta, packageJson, files, integrity } = parsed;
  if (!opts.vfs) throw new Error('installGcupkg: opts.vfs is required');
  const { vfs, installedModules, strictIntegrity } = opts;

  // Refuse to install if integrity is declared but doesn't verify, when
  // the caller asks for strict mode. Default is permissive (warn-only via
  // the returned integrity record) so users can still install partially-
  // broken packages if they choose.
  if (strictIntegrity && integrity.ok === false) {
    throw new Error(
      `installGcupkg: integrity mismatch — meta declared ${integrity.declared}, ` +
      `computed ${integrity.computed} over [${integrity.covered.join(', ')}]`
    );
  }

  const libPath = _libPathForName(meta.name);
  const slug = _slugifyName(meta.name);

  // Clean replace — wipe any prior install of this same name before
  // writing the new artifacts. Without this, files removed in a newer
  // version of the package would linger (e.g. example renamed in v0.2
  // would leave the old name in /lib/<name>/examples/). Wrapped in
  // try/catch because rm() may not exist on every VFS backend and
  // ENOENT on first-install is expected.
  for (const cleanupPath of [libPath, '/usr/share/examples/' + slug, '/usr/share/docs/' + slug]) {
    try {
      if (typeof vfs.rm === 'function') {
        await vfs.rm(cleanupPath, { recursive: true });
      }
    } catch { /* first install, or backend doesn't support rm — fine */ }
  }

  await vfs.mkdir(libPath, { recursive: true });

  // Canonical artifact: `source` (matches pkg's existing /lib layout) — only when
  // the package ships a notebook-context index.js. Shell-only packages (surface +
  // service) have none; their entries (works.js / service.js / surface.html) land
  // via the generic top-level asset loop below.
  if (files['index.js']) await vfs.writeFile(libPath + '/source', files['index.js']);

  // Optional secondary entry — adder.js. Stored as its OWN leaf
  // directory (/lib/<pkg>/adder/source + meta.json) so persist.js's
  // hydrateModulesFromVfs picks it up on next reload. An earlier layout
  // wrote it as a sibling file (/lib/<pkg>/adder.js) which the walker
  // ignored — the entry only existed in _installedModules during the
  // install session and vanished on reload, surfacing as a V8 "Failed
  // to resolve module specifier" for the bare-fallback path.
  if (files['adder.js']) {
    const adderDir = libPath + '/adder';
    await vfs.mkdir(adderDir, { recursive: true });
    await vfs.writeFile(adderDir + '/source', files['adder.js']);
    await vfs.writeFile(adderDir + '/meta.json', _ENCODER.encode(JSON.stringify({
      alias:   meta.name + '/adder',
      url:     meta.name + '/adder',
      kind:    'gcupkg-secondary',
      parent:  meta.name,
    }, null, 2)));
  }

  // Other extension data alongside (consumed by aggregateLicenses walkLib
  // for license, by future tooling for the rest).
  await vfs.writeFile(libPath + '/package.json', files['package.json']);
  await vfs.writeFile(libPath + '/LICENSE', files['LICENSE']);
  if (files['README.md']) await vfs.writeFile(libPath + '/README.md', files['README.md']);
  if (files['SPEC.md'])   await vfs.writeFile(libPath + '/SPEC.md',   files['SPEC.md']);

  // Top-level assets the manifest may reference (Works surface HTML files,
  // viewer templates, etc — anything `manifest.surfaces[].file` can point
  // at, plus any non-conventional files the extension chose to ship).
  // Write everything at the archive root that isn't already-handled or
  // in a special subdir; the installer doesn't need to know about each
  // asset by name. EXTENSION_SPEC §6.1 doesn't constrain custom assets.
  const _knownTopLevel = new Set([
    'package.json', 'index.js', 'adder.js',
    'LICENSE', 'README.md', 'SPEC.md',
    '.gcupkg-meta.json',
  ]);
  const _knownSubdirs = ['examples/', 'docs/'];
  for (const [archivePath, bytes] of Object.entries(files)) {
    if (_knownTopLevel.has(archivePath)) continue;
    if (_knownSubdirs.some(p => archivePath.startsWith(p))) continue;
    // Mirror the archive layout under /lib/<pkg>/. For nested non-special
    // dirs (e.g. `assets/icon.svg`), mkdir along the way.
    const dest = libPath + '/' + archivePath;
    const slash = dest.lastIndexOf('/');
    if (slash > libPath.length) {
      await vfs.mkdir(dest.slice(0, slash), { recursive: true });
    }
    await vfs.writeFile(dest, bytes);
  }

  // pkg's per-entry meta + lockfile entry. Match the shape pkg-cmd.js writes
  // so `pkg list` and `pkg licenses` pick the entry up uniformly.
  const pkgMeta = {
    alias:       meta.name,
    url:         meta.homepage || meta.name,
    kind:        'gcupkg',
    installedAt: new Date().toISOString(),
    size:        files['index.js'] ? files['index.js'].length : 0,
    version:     meta.version,
    license: {
      spdx:        meta.spdx || packageJson.license || null,
      spdxSource:  'gcupkg-meta',
      fetchedFrom: 'gcupkg',
    },
    gcupkg: {
      version:      meta.gcupkgVersion,
      contributes:  meta.contributes || [],
      integrity:    meta.integrity || null,
      integrityOk:  integrity.ok,
      hasAdder:     !!files['adder.js'],
    },
  };
  // Surface the package's declarative language contract (gcu.languages) onto the
  // installed entry's meta, so the notebook's hydrateModulesFromVfs carries it
  // and seedDeclaredLanguages can offer the language in the cell-type picker
  // (cold) without loading the pack. The bundle still registers the real cell
  // type on first load (cold→hot).
  if (packageJson.gcu && Array.isArray(packageJson.gcu.languages) && packageJson.gcu.languages.length) {
    pkgMeta.languages = packageJson.gcu.languages;
  }
  // adderExports — the names adder code imports the package by (e.g. @gcu/plot →
  // `plt`). Surfaced onto the entry's meta so resolveAdderModule (exec.js)
  // resolves `import plt` / `from sadpan import …` OFFLINE in a provisioned
  // notebook, the same way profiles/packages.json wires it for baked editions.
  if (packageJson.gcu && Array.isArray(packageJson.gcu.adderExports) && packageJson.gcu.adderExports.length) {
    pkgMeta.adderExports = packageJson.gcu.adderExports;
  }
  await vfs.writeFile(libPath + '/meta.json', _ENCODER.encode(JSON.stringify(pkgMeta, null, 2)));
  await _updateLockfile(vfs, meta.name, pkgMeta);

  // Examples — written to TWO locations:
  //   /lib/<name>/examples/<file>           ← persistent (workspace VFS / IDB)
  //   /usr/share/examples/<slug>/<file>     ← volatile (the picker's view)
  //
  // The /lib copy is the source of truth and survives reload; the
  // /usr/share/ copy is what works/js/menubar.js's Open Example picker
  // currently reads. On boot, works/js/examples-loader.js rehydrates the
  // volatile copy from /lib (see scanLibExamples there).
  //
  // (Docs handled the same way — persistent in /lib, volatile in /usr/share
  // for the docs surface to discover.)
  let exampleCount = 0;
  const exampleRoot = '/usr/share/examples/' + slug;
  const libExampleRoot = libPath + '/examples';
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('examples/') || path === 'examples/') continue;
    const inner = path.slice('examples/'.length);
    if (!inner) continue;
    await vfs.mkdir(libExampleRoot, { recursive: true });
    await vfs.writeFile(libExampleRoot + '/' + inner, bytes);
    await vfs.mkdir(exampleRoot, { recursive: true });
    await vfs.writeFile(exampleRoot + '/' + inner, bytes);
    if (inner.endsWith('.txt')) exampleCount++;
  }

  let docsCount = 0;
  const docsRoot = '/usr/share/docs/' + slug;
  const libDocsRoot = libPath + '/docs';
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('docs/') || path === 'docs/') continue;
    const inner = path.slice('docs/'.length);
    if (!inner) continue;
    await vfs.mkdir(libDocsRoot, { recursive: true });
    await vfs.writeFile(libDocsRoot + '/' + inner, bytes);
    await vfs.mkdir(docsRoot, { recursive: true });
    await vfs.writeFile(docsRoot + '/' + inner, bytes);
    if (inner.endsWith('.md')) docsCount++;
  }

  // Hydrate the runtime module cache so load() resolves immediately
  // — without this, the user has to reload the notebook for the install
  // to take effect.
  if (installedModules) {
    const indexSource = _DECODER.decode(files['index.js']);
    installedModules[meta.name] = {
      url:         meta.name,
      alias:       meta.name,
      source:      indexSource,
      compressed:  false,
      kind:        'js',
      installedAt: pkgMeta.installedAt,
      size:        files['index.js'].length,
      license:     pkgMeta.license,
    };
    if (files['adder.js']) {
      const adderSource = _DECODER.decode(files['adder.js']);
      const adderKey = meta.name + '/adder';
      installedModules[adderKey] = {
        url:         adderKey,
        alias:       adderKey,
        source:      adderSource,
        compressed:  false,
        kind:        'js',
        installedAt: pkgMeta.installedAt,
        size:        files['adder.js'].length,
      };
    }
  }

  return {
    libPath,
    exampleRoot:   exampleCount > 0 ? exampleRoot : null,
    docsRoot:      docsCount > 0    ? docsRoot    : null,
    exampleCount,
    docsCount,
    hasAdder:      !!files['adder.js'],
    integrity,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

// Map an extension name to its /lib path. Scoped names land at
// /lib/<scope>/<name> (matches pkg-cmd's existing convention); bare
// names go under /lib/local/.
function _libPathForName(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

// Slugify the extension name for VFS paths that can't have a `/` in them
// (the examples and docs roots). @gcu/foo → @gcu_foo.
function _slugifyName(name) {
  return name.replace(/\//g, '_');
}

// ── thin archive shim ────────────────────────────────────────────────────
//
// parseGcupkg expects a `{ archive: { detect, list, read } }` object so
// callers can plug in whatever ZIP reader they like. The full @gcu/archive
// bundle is ~226 KB (zip+tar+gz+zst+xz+bz2 read/write); for the
// cell-side install("file.gcupkg") path we only need ZIP read, which
// auditable's stdlib already does via unzipArchive (uses native
// DecompressionStream('deflate-raw'), zero new deps).
//
// makeUnzipArchiveShim(unzipArchive) returns an archiveLib whose
// list/read are backed by one cached unzipArchive call per bytes
// reference. detect always reports 'zip' — anything else would have
// failed in unzipArchive first. The cache is a WeakMap keyed by the
// bytes buffer; subsequent list+read for the same parse share one
// decompression.
function makeUnzipArchiveShim(unzipArchive) {
  if (typeof unzipArchive !== 'function') {
    throw new TypeError('makeUnzipArchiveShim: unzipArchive function required');
  }
  const cache = new WeakMap();
  async function _entries(bytes) {
    if (cache.has(bytes)) return cache.get(bytes);
    const map = await unzipArchive(bytes);
    cache.set(bytes, map);
    return map;
  }
  return {
    archive: {
      async detect(_bytes) { return 'zip'; },
      async list(bytes) {
        const map = await _entries(bytes);
        const out = [];
        for (const [path, data] of map) {
          out.push({ path, type: 'file', size: data.length });
        }
        return out;
      },
      async read(bytes, path) {
        const map = await _entries(bytes);
        return map.get(path) || null;
      },
    },
  };
}

async function _updateLockfile(vfs, name, pkgMeta) {
  const lockPath = '/lib/.gcu-lock.json';
  let lockfile;
  try {
    const raw = await vfs.readFile(lockPath, 'utf8');
    lockfile = JSON.parse(raw);
  } catch {
    lockfile = { version: 1, modules: {} };
  }
  if (!lockfile.modules || typeof lockfile.modules !== 'object') lockfile.modules = {};
  lockfile.modules[name] = pkgMeta;
  await vfs.writeFile(lockPath, JSON.stringify(lockfile, null, 2));
}

// -- ast-nodes.js --

// AST node type tags + factory helpers.
//
// Nodes are plain object literals with a `type` discriminator string from
// the NODE table below. Factories exist purely to centralise the shapes
// (so a typo in a producer like `{ type: 'Pipline' }` is harder to make);
// they're optional — consumers should pattern-match on the type field.

const NODE = Object.freeze({
  PROGRAM:        'Program',
  LIST:           'List',
  AND_OR:         'AndOr',
  PIPELINE:       'Pipeline',
  SIMPLE_COMMAND: 'SimpleCommand',
  BRACE_GROUP:    'BraceGroup',
  SUBSHELL:       'Subshell',
  IF_CLAUSE:      'IfClause',
  FOR_CLAUSE:     'ForClause',
  WHILE_CLAUSE:   'WhileClause',
  UNTIL_CLAUSE:   'UntilClause',
  CASE_CLAUSE:    'CaseClause',
  CASE_ITEM:      'CaseItem',
  FUNCTION_DEF:   'FunctionDef',
  ASSIGNMENT:     'Assignment',
  REDIRECT:       'Redirect',
  WORD:           'Word',
});

// `body` is a List node; List wraps multiple commands separated by ';' / '&' / NEWLINE.
// `commands` on Pipeline is the segments left-to-right (data flows L→R).
// `negated` on Pipeline reflects a leading `!` (POSIX: invert the pipeline's exit status).
// Redirect.fd is null when no explicit file descriptor was given (defaults inferred at exec time).

function mkProgram(commands, pos) {
  return { type: NODE.PROGRAM, commands, pos };
}

function mkList(items, pos) {
  // items: Array<{ op: ';' | '&' | null, cmd: AndOr | Pipeline | Command }>
  // The last item's `op` is null when the input didn't end with a terminator.
  return { type: NODE.LIST, items, pos };
}

function mkAndOr(left, op, right, pos) {
  // op: '&&' | '||'
  return { type: NODE.AND_OR, left, op, right, pos };
}

function mkPipeline(commands, negated, pos) {
  return { type: NODE.PIPELINE, commands, negated, pos };
}

function mkSimpleCommand(assignments, words, redirects, pos) {
  return { type: NODE.SIMPLE_COMMAND, assignments, words, redirects, pos };
}

function mkBraceGroup(body, redirects, pos) {
  return { type: NODE.BRACE_GROUP, body, redirects, pos };
}

function mkSubshell(body, redirects, pos) {
  return { type: NODE.SUBSHELL, body, redirects, pos };
}

function mkIfClause(cond, then_, elifs, else_, redirects, pos) {
  // elifs: [{ cond: List, then: List }]
  return { type: NODE.IF_CLAUSE, cond, then: then_, elifs, else: else_, redirects, pos };
}

function mkForClause(name, words, body, redirects, pos) {
  // words: Array<Word> | null  — null means `for x do …` (iterates "$@")
  return { type: NODE.FOR_CLAUSE, name, words, body, redirects, pos };
}

function mkWhileClause(cond, body, redirects, pos) {
  return { type: NODE.WHILE_CLAUSE, cond, body, redirects, pos };
}

function mkUntilClause(cond, body, redirects, pos) {
  return { type: NODE.UNTIL_CLAUSE, cond, body, redirects, pos };
}

function mkCaseClause(word, items, redirects, pos) {
  return { type: NODE.CASE_CLAUSE, word, items, redirects, pos };
}

function mkCaseItem(patterns, body, pos) {
  // body may be null (an empty case branch: `pat) ;;`)
  return { type: NODE.CASE_ITEM, patterns, body, pos };
}

function mkFunctionDef(name, body, pos) {
  return { type: NODE.FUNCTION_DEF, name, body, pos };
}

function mkAssignment(name, value, pos) {
  // value is a Word; for bare `name=` the word is an empty literal.
  return { type: NODE.ASSIGNMENT, name, value, pos };
}

function mkRedirect(fd, op, target, pos) {
  // op: one of '<' '>' '>>' '<&' '>&' '<>' '>|' '<<' '<<-'
  return { type: NODE.REDIRECT, fd, op, target, pos };
}

function mkWord(value, pos, parts) {
  // `value` is the raw lexer text (preserved verbatim — quotes, expansions,
  // escapes all intact for round-trip / error reporting).
  // `parts` is the structured decomposition for the executor — array of
  // shapes documented in word-parts.js. Parser callers should pass parts
  // from `parseWordParts(value)`; older callers can omit and get parts
  // computed lazily on first access.
  return { type: NODE.WORD, value, parts: parts ?? null, pos };
}

// -- lexer.js --

// POSIX-shape shell lexer for geas.
//
// Produces a flat token stream of {type, value, pos} records. Words preserve
// their quoting and expansion syntax verbatim — the executor decides how to
// unquote / expand them at run time. The parser treats words as opaque
// strings; word-internal $-expansions, ${...}, $(...), `...`, '...', "..."
// are NOT split out here, which keeps the lexer small (~300 LOC) and lets
// the executor own the expansion semantics.
//
// Token types:
//   WORD          — anything that isn't an operator (preserves quoting verbatim)
//   OPERATOR      — single- or multi-char shell operator (see OPERATORS table)
//   IO_NUMBER     — digit run immediately followed by < or > (no space between)
//   NEWLINE       — \n line terminator (token-significant in shell grammar)
//   HEREDOC_BODY  — body text of a `<<DELIM` / `<<-DELIM` here-doc, emitted
//                   immediately after the operator's delimiter word. The
//                   `quoted` flag tells the executor whether the delimiter
//                   was quoted (POSIX: any quoting suppresses body expansion).
//   EOF           — end-of-input sentinel emitted once at the end
//
// Line continuation (backslash-newline) between tokens is silently consumed.
// Comments (# to end of line) are stripped before token emission.
//
// Here-doc handling: when `<<` or `<<-` is emitted, the immediately-following
// word is consumed as the delimiter (`heredoc:` field on the operator token);
// the body is captured on the next NEWLINE. Multiple heredocs on the same
// line stack in queue order: `cat <<A <<B` captures A's body then B's body
// after the trailing newline. The `<<-` variant strips leading TABS (not
// spaces — POSIX-strict) from each body line and from the closing delimiter.
//
// Not yet implemented (TODOs):
//   - Aliases. POSIX has alias expansion as a lexer-time transform; geas can
//     defer until aliases are a real feature.

// Multi-char operators MUST come before any single-char prefix to ensure
// longest-match wins (e.g. `<<-` before `<<` before `<`).
const OPERATORS = [
  '<<-', '&&', '||', ';;', ';&', '|&',
  '<<', '>>', '<&', '>&', '<>', '>|',
  '<', '>', '|', '&', ';', '(', ')',
];

// Characters that end an unquoted word.
const WORD_BOUNDARY = new Set([' ', '\t', '\n', '|', '&', ';', '<', '>', '(', ')']);

function tokenize(input) {
  const tokens = [];
  const src = String(input ?? '');
  let pos = 0;
  // Queue of here-docs awaiting body capture. Each entry: { delim, quoted,
  // stripTabs }. Filled when `<<` / `<<-` is emitted; drained when the next
  // NEWLINE fires.
  const heredocQueue = [];

  while (pos < src.length) {
    // Skip horizontal whitespace and line continuations.
    pos = _skipWS(src, pos);
    if (pos >= src.length) break;

    const ch = src[pos];

    // Comments: # to end of line. Newline itself stays in the stream.
    if (ch === '#') {
      while (pos < src.length && src[pos] !== '\n') pos++;
      continue;
    }

    if (ch === '\n') {
      const nlStart = pos;
      pos++; // consume the newline first — heredoc bodies start on the next char

      // Drain any pending here-docs. Each captures lines until its delimiter.
      while (heredocQueue.length > 0) {
        const hd = heredocQueue.shift();
        const cap = _captureHeredocBody(src, pos, hd.delim, hd.stripTabs);
        tokens.push({
          type: 'HEREDOC_BODY',
          value: cap.body,
          quoted: hd.quoted,
          delim: hd.delim,
          stripTabs: hd.stripTabs,
          pos: { start: pos, end: cap.end },
        });
        pos = cap.end;
      }

      // Emit the NEWLINE at its ORIGINAL position (not adjusted for the body scan).
      tokens.push({ type: 'NEWLINE', value: '\n', pos: { start: nlStart, end: nlStart + 1 } });
      continue;
    }

    // Operator (longest-match against OPERATORS table).
    const opLen = _matchOperator(src, pos);
    if (opLen > 0) {
      const opVal = src.slice(pos, pos + opLen);
      tokens.push({
        type: 'OPERATOR',
        value: opVal,
        pos: { start: pos, end: pos + opLen },
      });
      pos += opLen;

      // If this was `<<` or `<<-`, the next word is the delimiter — consume
      // it inline so we can queue the heredoc before any NEWLINE shows up.
      if (opVal === '<<' || opVal === '<<-') {
        pos = _skipWS(src, pos);
        if (pos < src.length && src[pos] !== '\n') {
          const delimStart = pos;
          const delimEnd = _readWord(src, pos);
          const delimRaw = src.slice(delimStart, delimEnd);
          // Emit the delimiter as a WORD so the parser sees it normally.
          tokens.push({
            type: 'WORD',
            value: delimRaw,
            pos: { start: delimStart, end: delimEnd },
          });
          pos = delimEnd;
          // Queue the heredoc. `delim` is the unquoted form (for matching).
          // `quoted` records whether the original WORD had any quoting at all
          // (POSIX: any quoting suppresses body expansion).
          const unquoted = _unquoteDelim(delimRaw);
          heredocQueue.push({
            delim: unquoted,
            quoted: unquoted !== delimRaw,
            stripTabs: opVal === '<<-',
          });
        }
        // If no delimiter followed (malformed input), let the parser raise.
      }
      continue;
    }

    // IO_NUMBER: a digit run that is *immediately* followed by < or >.
    // POSIX: this is what distinguishes `2>foo` (redirect stderr) from
    // `2 >foo` (word "2" then redirect stdout).
    if (ch >= '0' && ch <= '9') {
      const digits = _matchIONumber(src, pos);
      if (digits !== null) {
        tokens.push({
          type: 'IO_NUMBER',
          value: digits,
          pos: { start: pos, end: pos + digits.length },
        });
        pos += digits.length;
        continue;
      }
    }

    // Otherwise: a word. Read until the next unquoted boundary.
    const start = pos;
    const end = _readWord(src, pos);
    tokens.push({
      type: 'WORD',
      value: src.slice(start, end),
      pos: { start, end },
    });
    pos = end;
  }

  // If input ends without a trailing newline but heredocs are queued, drain
  // them now — unterminated heredocs capture what they can up to EOF.
  while (heredocQueue.length > 0) {
    const hd = heredocQueue.shift();
    const cap = _captureHeredocBody(src, pos, hd.delim, hd.stripTabs);
    tokens.push({
      type: 'HEREDOC_BODY',
      value: cap.body,
      quoted: hd.quoted,
      delim: hd.delim,
      stripTabs: hd.stripTabs,
      pos: { start: pos, end: cap.end },
    });
    pos = cap.end;
  }

  tokens.push({ type: 'EOF', value: '', pos: { start: pos, end: pos } });
  return tokens;
}

// ── helpers ──

function _skipWS(src, pos) {
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === ' ' || ch === '\t') {
      pos++;
    } else if (ch === '\\' && src[pos + 1] === '\n') {
      // Line continuation: backslash + newline → silently consumed between tokens.
      pos += 2;
    } else {
      break;
    }
  }
  return pos;
}

function _matchOperator(src, pos) {
  for (const op of OPERATORS) {
    if (src.startsWith(op, pos)) return op.length;
  }
  return 0;
}

function _matchIONumber(src, pos) {
  let i = pos;
  while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
  if (i === pos) return null;
  if (src[i] === '<' || src[i] === '>') return src.slice(pos, i);
  return null;
}

function _readWord(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];

    // Single-quoted: literal, no interpretation, up to the next single quote.
    if (ch === "'") {
      i = _scanSingleQuote(src, i);
      continue;
    }
    // Double-quoted: allow $-expansions, `-substitution, and \-escape (of
    // limited chars per POSIX, but we don't enforce here — preserved verbatim).
    if (ch === '"') {
      i = _scanDoubleQuote(src, i);
      continue;
    }
    // Backslash-escape: preserve the backslash + the next char as part of the word.
    if (ch === '\\') {
      if (src[i + 1] === '\n') {
        // Line continuation INSIDE a word: per POSIX, the backslash+newline
        // pair is discarded. We collapse by advancing past both without
        // including them in the slice — but since _readWord returns an end
        // index for `src.slice(start, end)`, we can't easily skip mid-string.
        // For now: preserve verbatim; the executor handles unescaping. This
        // is a rare construct and the executor sees the right thing anyway
        // (literal backslash-newline disappears during expansion).
        i += 2;
      } else if (i + 1 < src.length) {
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // $(...) command substitution: balance parens.
    if (ch === '$' && src[i + 1] === '(') {
      // Could also be $((arith)) — same paren balancing handles it.
      i = _scanBalanced(src, i + 1, '(', ')') + 1;
      continue;
    }
    // ${...} parameter expansion: balance braces.
    if (ch === '$' && src[i + 1] === '{') {
      i = _scanBalanced(src, i + 1, '{', '}') + 1;
      continue;
    }
    // $name parameter expansion (identifier name).
    if (ch === '$' && src[i + 1] && /[a-zA-Z_]/.test(src[i + 1])) {
      i += 2;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
      continue;
    }
    // $@, $*, $#, $?, $$, $!, $0..$9, $- — single-char special parameters.
    if (ch === '$' && src[i + 1] && '@*#?$!-0123456789'.includes(src[i + 1])) {
      i += 2;
      continue;
    }
    // Backtick command substitution.
    if (ch === '`') {
      i = _scanBacktick(src, i);
      continue;
    }
    // Unquoted boundary char terminates the word.
    if (WORD_BOUNDARY.has(ch)) break;
    i++;
  }
  return i;
}

// Returns the index just past the closing single quote (or end of input if
// unterminated — we don't throw; the executor will see an unterminated word).
function _scanSingleQuote(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== "'") i++;
  return i < src.length ? i + 1 : i;
}

function _scanDoubleQuote(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== '"') {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      i += 2;
    } else if (ch === '$' && src[i + 1] === '(') {
      i = _scanBalanced(src, i + 1, '(', ')') + 1;
    } else if (ch === '$' && src[i + 1] === '{') {
      i = _scanBalanced(src, i + 1, '{', '}') + 1;
    } else if (ch === '`') {
      i = _scanBacktick(src, i);
    } else {
      i++;
    }
  }
  return i < src.length ? i + 1 : i;
}

// `openIdx` points at the opening bracket. Returns the index OF the matching
// closer (caller advances past it). Handles nested quoting and escapes so
// `$(echo ")")` doesn't terminate at the inner `)`.
function _scanBalanced(src, openIdx, openCh, closeCh) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "'") {
      i = _scanSingleQuote(src, i);
      continue;
    }
    if (ch === '"') {
      i = _scanDoubleQuote(src, i);
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = _scanBacktick(src, i);
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return i; // unterminated → caller treats as end of input
}

function _scanBacktick(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\' && i + 1 < src.length) i += 2;
    else i++;
  }
  return i < src.length ? i + 1 : i;
}

// ── here-doc support ──

// Scan from `pos` line-by-line, capturing body lines until a line matching
// `delim` is found. POSIX: the closing delimiter must occupy its line by
// itself (with leading TABS stripped if `stripTabs`). Lines and the closing
// delimiter line itself are NOT included in the body.
//
// Returns { body, end } where `end` is the index just past the delimiter
// line's trailing \n (or end of input if unterminated). `body` is joined
// with '\n' and a trailing '\n' on each line (so the executor sees real
// shell-shape line-terminated text).
function _captureHeredocBody(src, pos, delim, stripTabs) {
  const lines = [];
  let i = pos;
  while (i < src.length) {
    const lineStart = i;
    while (i < src.length && src[i] !== '\n') i++;
    let line = src.slice(lineStart, i);
    if (stripTabs) {
      let k = 0;
      while (k < line.length && line[k] === '\t') k++;
      line = line.slice(k);
    }
    if (line === delim) {
      // Closing delimiter — consume its trailing \n and stop.
      const end = i < src.length ? i + 1 : i;
      return { body: lines.length ? lines.join('\n') + '\n' : '', end };
    }
    lines.push(line);
    if (i < src.length) i++; // step over the \n
  }
  // Unterminated. Return what we have; the executor / parser can choose to
  // warn or accept as-is.
  return { body: lines.length ? lines.join('\n') + '\n' : '', end: i };
}

// POSIX: a here-doc delimiter that contains any quoted or escaped character
// is matched against the literal (unquoted) text, and the body is treated
// as literal (no expansion). This helper strips quotes/escapes so the
// matching delimiter is correct; the *caller* records whether quoting was
// present (via the `quoted` flag on the HEREDOC_BODY token) so the executor
// later knows whether to expand body content.
function _unquoteDelim(word) {
  let out = '';
  let i = 0;
  while (i < word.length) {
    const ch = word[i];
    if (ch === '\\' && i + 1 < word.length) {
      out += word[i + 1];
      i += 2;
    } else if (ch === "'") {
      i++;
      while (i < word.length && word[i] !== "'") { out += word[i]; i++; }
      if (i < word.length) i++;
    } else if (ch === '"') {
      i++;
      while (i < word.length && word[i] !== '"') {
        if (word[i] === '\\' && i + 1 < word.length) {
          out += word[i + 1];
          i += 2;
        } else {
          out += word[i];
          i++;
        }
      }
      if (i < word.length) i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// -- word-parts.js --

// Word structure: parse an opaque WORD value into structured parts so the
// executor can do expansion without re-tokenising. Called by the parser's
// mkWord(); the lexer remains "opaque WORDs" — all structure lives here.
//
// Part shapes (the `kind` discriminator):
//
//   { kind: 'lit',    value }                    plain unquoted literal text
//   { kind: 'sq',     value }                    single-quoted segment (literal)
//   { kind: 'dq',     parts: [Part] }            double-quoted: nested parts,
//                                                  expansions allowed inside but
//                                                  no field-splitting on results
//   { kind: 'escape', value }                    backslash-escaped char
//   { kind: 'var',    name }                     $X — simple variable reference
//   { kind: 'param',  name, op, word: Word? }    ${X op default}: op ∈ {':-',':=',':?',':+','-','=','?','+','#','##','%','%%'}
//                                                  word = the default/replacement (parsed as a Word)
//   { kind: 'cmd',    body }                     $(...) or `...` — command substitution
//   { kind: 'arith',  body }                     $((...)) — arithmetic substitution
//
// For v0 the parser produces these but the EXECUTOR may only implement the
// common subset (lit, sq, dq, var, cmd). param/arith are emitted faithfully
// but the executor can choose how to handle them (substitute "" or warn).

function parseWordParts(src) {
  const parts = [];
  const state = { src, i: 0, buf: '' };
  while (state.i < src.length) _wpScanTop(state, parts);
  _wpFlushBuf(state, parts);
  return parts;
}

function _wpFlushBuf(state, parts) {
  if (state.buf) { parts.push({ kind: 'lit', value: state.buf }); state.buf = ''; }
}

function _wpScanTop(state, parts) {
  const { src } = state;
  const ch = src[state.i];

  // Backslash escape: preserved as 'escape' part so the executor knows it
  // was escaped (and which char). Mostly equivalent to a 'lit' for purposes
  // of substitution, but kept distinct for round-tripping / error messages.
  if (ch === '\\' && state.i + 1 < src.length) {
    _wpFlushBuf(state, parts);
    parts.push({ kind: 'escape', value: src[state.i + 1] });
    state.i += 2;
    return;
  }
  if (ch === "'") {
    _wpFlushBuf(state, parts);
    parts.push(_wpScanSQ(state));
    return;
  }
  if (ch === '"') {
    _wpFlushBuf(state, parts);
    parts.push(_wpScanDQ(state));
    return;
  }
  if (ch === '$') {
    const expanded = _wpScanDollar(state);
    if (expanded) {
      _wpFlushBuf(state, parts);
      parts.push(expanded);
      return;
    }
    // Bare $ with no recognisable expansion — treat as literal $.
    state.buf += '$';
    state.i++;
    return;
  }
  if (ch === '`') {
    _wpFlushBuf(state, parts);
    parts.push(_wpScanBacktick(state));
    return;
  }
  state.buf += ch;
  state.i++;
}

// Inside double quotes: the rules differ. Backslash escapes a smaller set,
// $ and ` still introduce expansions, single quotes lose their meaning,
// double quote closes the group. All inner expansions get `quoted: true`
// semantics, but we encode that via the wrapping 'dq' part rather than a
// per-part flag.
function _wpScanDQ(state) {
  const { src } = state;
  state.i++; // consume opening "
  const parts = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push({ kind: 'lit', value: buf }); buf = ''; } };

  while (state.i < src.length && src[state.i] !== '"') {
    const ch = src[state.i];
    if (ch === '\\' && state.i + 1 < src.length) {
      // POSIX: inside "...", \ escapes only $ ` " \ <newline>
      const next = src[state.i + 1];
      if ('$`"\\'.includes(next)) {
        buf += next;
        state.i += 2;
      } else if (next === '\n') {
        // line continuation in dquote: backslash + newline both disappear
        state.i += 2;
      } else {
        buf += ch;
        state.i++;
      }
      continue;
    }
    if (ch === '$') {
      const expanded = _wpScanDollar(state);
      if (expanded) {
        flush();
        parts.push(expanded);
        continue;
      }
      buf += '$';
      state.i++;
      continue;
    }
    if (ch === '`') {
      flush();
      parts.push(_wpScanBacktick(state));
      continue;
    }
    buf += ch;
    state.i++;
  }
  flush();
  if (state.i < src.length) state.i++; // consume closing "
  return { kind: 'dq', parts };
}

function _wpScanSQ(state) {
  const { src } = state;
  state.i++; // consume opening '
  let buf = '';
  while (state.i < src.length && src[state.i] !== "'") {
    buf += src[state.i];
    state.i++;
  }
  if (state.i < src.length) state.i++; // consume closing '
  return { kind: 'sq', value: buf };
}

function _wpScanBacktick(state) {
  const { src } = state;
  state.i++; // consume opening `
  let buf = '';
  while (state.i < src.length && src[state.i] !== '`') {
    // POSIX: inside backticks, only `, $, and \ need escape; the canonical
    // form is `\$`, `\\`, `\\`` for literal $, \, `. We preserve verbatim
    // so the executor can re-parse the body when it executes.
    if (src[state.i] === '\\' && state.i + 1 < src.length
        && '\\$`'.includes(src[state.i + 1])) {
      buf += src[state.i + 1];
      state.i += 2;
    } else {
      buf += src[state.i];
      state.i++;
    }
  }
  if (state.i < src.length) state.i++; // consume closing `
  return { kind: 'cmd', body: buf };
}

// Returns a Part or null. `null` means the $ wasn't a recognisable
// expansion (the caller should emit a literal '$').
function _wpScanDollar(state) {
  const { src } = state;
  const next = src[state.i + 1];

  if (next === '(') {
    // $((arith)) — two opens; $(cmd) — one
    if (src[state.i + 2] === '(') {
      const end = _wpFindArith(src, state.i + 2);
      const body = src.slice(state.i + 3, end - 1);
      state.i = end + 1;
      return { kind: 'arith', body };
    }
    const end = _wpFindBalanced(src, state.i + 1, '(', ')');
    const body = src.slice(state.i + 2, end);
    state.i = end + 1;
    return { kind: 'cmd', body };
  }

  if (next === '{') {
    const end = _wpFindBalanced(src, state.i + 1, '{', '}');
    const inner = src.slice(state.i + 2, end);
    state.i = end + 1;
    return _wpParseParam(inner);
  }

  if (next && /[a-zA-Z_]/.test(next)) {
    let j = state.i + 2;
    while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
    const name = src.slice(state.i + 1, j);
    state.i = j;
    return { kind: 'var', name };
  }

  if (next && '@*#?$!-0123456789'.includes(next)) {
    state.i += 2;
    return { kind: 'var', name: next };
  }

  return null;
}

// Parse the contents of `${...}`. Supports:
//   ${name}                      bare reference
//   ${name:-word}                use default if unset or null
//   ${name:=word}                assign default if unset or null
//   ${name:?word}                error if unset or null
//   ${name:+word}                alt value if set and non-null
//   ${name-word} / ${name=word}/ ${name?word} / ${name+word}   same but only "unset"
//   ${#name}                     string length
//   ${name#pattern} / ${name##pattern}   prefix removal
//   ${name%pattern} / ${name%%pattern}   suffix removal
// Returns either { kind: 'var', name } (simple) or { kind: 'param', name, op, word: Word }.
function _wpParseParam(inner) {
  // Length: ${#name}
  if (inner.startsWith('#') && inner.length > 1) {
    const name = inner.slice(1);
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || '@*#?$!-0123456789'.includes(name)) {
      return { kind: 'param', name, op: '#', word: null };
    }
  }
  // Match the leading name (identifier-shape or special-parameter).
  const nameMatch = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*|[@*#?$!-]|\d+)/);
  if (!nameMatch) {
    // Malformed ${...}; preserve as a literal var reference with the whole inner as the name.
    return { kind: 'var', name: inner };
  }
  const name = nameMatch[1];
  const rest = inner.slice(name.length);
  if (rest.length === 0) return { kind: 'var', name };
  // Multi-char operators first (longest-match).
  for (const op of [':-', ':=', ':?', ':+', '##', '%%', '-', '=', '?', '+', '#', '%']) {
    if (rest.startsWith(op)) {
      const word = rest.slice(op.length);
      // Recursively parse the default-word as its own Word.
      return { kind: 'param', name, op, word: { type: 'Word', value: word, parts: parseWordParts(word) } };
    }
  }
  // Unknown operator — fall back to a bare var with the whole rest captured
  // as the op's literal payload, so the executor at least knows something
  // was there.
  return { kind: 'param', name, op: rest, word: null };
}

function _wpFindBalanced(src, openIdx, openCh, closeCh) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "'") { i = _wpSkipQuote(src, i, "'"); continue; }
    if (ch === '"') { i = _wpSkipDQuote(src, i); continue; }
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === '`') { i = _wpSkipQuote(src, i, '`'); continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) return i; }
    i++;
  }
  return i;
}

// $((...)) — match an inner double-close `))`.
function _wpFindArith(src, openOuterIdx) {
  // openOuterIdx points at the SECOND `(` of `$((`. We want the matching `))`.
  let depth = 1;
  let i = openOuterIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) {
      // We just consumed the inner ). The outer ) should be next.
      if (src[i + 1] === ')') return i + 1;
      // Unbalanced; treat as end here.
      return i + 1;
    }
    i++;
  }
  return i;
}

function _wpSkipQuote(src, openIdx, quoteCh) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== quoteCh) {
    if (src[i] === '\\' && i + 1 < src.length && quoteCh !== "'") i += 2;
    else i++;
  }
  return i < src.length ? i + 1 : i;
}

function _wpSkipDQuote(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\' && i + 1 < src.length) i += 2;
    else i++;
  }
  return i < src.length ? i + 1 : i;
}

// -- parser.js --

// Recursive-descent parser for the POSIX-shape geas grammar.
//
// Consumes the token stream from `lexer.tokenize()` and produces a tree of
// AST nodes from `ast-nodes.js`. The grammar is a simplified subset of POSIX
// shell (https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html):
//
//   program          = linebreak (complete_command (separator complete_command)*)? linebreak EOF
//   complete_command = and_or
//   and_or           = pipeline (('&&'|'||') linebreak pipeline)*
//   pipeline         = ['!'] command ('|' linebreak command)*
//   command          = compound_command redirect*
//                    | function_def
//                    | simple_command
//   compound_command = brace_group | subshell | if_clause | for_clause
//                    | while_clause | until_clause | case_clause
//   simple_command   = (assignment | redirect)* (WORD (WORD | assignment | redirect)*)?
//   assignment       = a WORD matching /^[A-Za-z_][A-Za-z0-9_]*=/
//   redirect         = [IO_NUMBER] redir_op WORD
//
// Reserved words (`if`, `then`, `elif`, `else`, `fi`, `for`, `while`, `until`,
// `do`, `done`, `case`, `esac`, `in`, `!`, `{`, `}`) are recognised
// positionally — the lexer emits them as plain WORDs and the parser
// dispatches based on grammar context.
//
// Here-doc bodies are NOT captured in this pass: `<<WORD` / `<<-WORD` are
// parsed as redirects with op `<<`/`<<-` and target being the delimiter
// word, but the body lines stay in the source stream. Wire body capture
// when the executor needs it.


// an optional `parts` arg and uses it verbatim when provided.
function _word(value, pos) {
  return mkWord(value, pos, parseWordParts(value));
}

// Reserved words and word-operators recognised at command position.
const COMPOUND_START_WORDS = new Set(['if', 'for', 'while', 'until', 'case', '{']);
const REDIR_OPS = new Set(['<', '>', '>>', '<&', '>&', '<>', '>|', '<<', '<<-']);

class ParseError extends Error {
  constructor(message, token) {
    super(token
      ? `geas parse error at offset ${token.pos.start}: ${message} (got ${_describeToken(token)})`
      : `geas parse error: ${message}`);
    this.token = token;
    this.name = 'ParseError';
  }
}

function _describeToken(t) {
  if (t.type === 'EOF') return 'end of input';
  if (t.type === 'NEWLINE') return 'newline';
  return `${t.type} "${t.value}"`;
}

function parse(input) {
  const tokens = Array.isArray(input) ? input : tokenize(input);
  // pendingHeredocs: FIFO of Redirect nodes awaiting body attachment. Each
  // `<<` / `<<-` parseRedirect pushes; HEREDOC_BODY tokens drain via
  // _drainHeredocBodies (called as part of _skipNL).
  const ctx = { tokens, i: 0, pendingHeredocs: [] };
  return parseProgram(ctx);
}

// ── token helpers ──

function _peek(ctx, offset = 0) {
  return ctx.tokens[ctx.i + offset];
}

function _at(ctx, type, value) {
  const t = ctx.tokens[ctx.i];
  if (!t || t.type !== type) return false;
  if (value !== undefined && t.value !== value) return false;
  return true;
}

// "Reserved word" peek — true iff the current token is a WORD whose value
// matches `name`. Used for keyword dispatch (`if`, `then`, `do`, `done`, …).
function _atKeyword(ctx, name) {
  const t = ctx.tokens[ctx.i];
  return !!t && t.type === 'WORD' && t.value === name;
}

function _consume(ctx) {
  return ctx.tokens[ctx.i++];
}

function _expect(ctx, type, value) {
  const t = ctx.tokens[ctx.i];
  if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
    throw new ParseError(`expected ${type}${value !== undefined ? ` "${value}"` : ''}`, t);
  }
  return _consume(ctx);
}

function _expectKeyword(ctx, name) {
  if (!_atKeyword(ctx, name)) {
    throw new ParseError(`expected "${name}"`, ctx.tokens[ctx.i]);
  }
  return _consume(ctx);
}

// Skip zero-or-more NEWLINE tokens. Used wherever POSIX `linebreak` appears.
// HEREDOC_BODY tokens immediately preceding a NEWLINE are drained here too
// — the lexer emits them right before the NEWLINE that triggered their
// capture, so this is where they naturally get attached to their owning
// redirects (in queue order).
function _skipNL(ctx) {
  while (true) {
    _drainHeredocBodies(ctx);
    if (!_at(ctx, 'NEWLINE')) break;
    ctx.i++;
  }
}

function _drainHeredocBodies(ctx) {
  while (_at(ctx, 'HEREDOC_BODY')) {
    const t = _consume(ctx);
    const redir = ctx.pendingHeredocs.shift();
    if (redir) {
      redir.body = t.value;
      redir.bodyQuoted = t.quoted;
    }
    // If there's no pending redirect (shouldn't happen for well-formed input
    // since the lexer only emits HEREDOC_BODY when it queued one at op-time),
    // silently drop the body — better than throwing on a parser-internal
    // accounting mismatch.
  }
}

// ── top-level ──

function parseProgram(ctx) {
  const start = (ctx.tokens[0] || { pos: { start: 0 } }).pos.start;
  _skipNL(ctx);
  const commands = [];
  while (!_at(ctx, 'EOF')) {
    const before = ctx.i;
    // Parse one complete_command (which may itself be a List separated by
    // ';' or '&' or NEWLINEs).
    const cmd = parseList(ctx);
    if (cmd) commands.push(cmd);
    _skipNL(ctx);
    // Defensive: drain any HEREDOC_BODY tokens that ended up sitting at EOF
    // (input that lacks a trailing newline after the last heredoc).
    _drainHeredocBodies(ctx);
    // Failsafe: if we made no progress AND aren't at EOF, the current token
    // is something the parser doesn't know how to handle. Throw rather than
    // loop forever — much better feedback than a silent hang.
    if (ctx.i === before) {
      throw new ParseError('unexpected token', ctx.tokens[ctx.i]);
    }
  }
  return mkProgram(commands, { start, end: ctx.tokens[ctx.tokens.length - 1].pos.end });
}

// list = and_or (separator and_or)*    where separator is ';' '&' (and NEWLINE in compound contexts).
//
// `crossNewlines` toggles whether NEWLINE counts as an item-separator. POSIX
// distinguishes:
//   - top-level `list` (per `complete_command`): separators are ';' / '&'
//     only; NEWLINE ends the list and starts a new complete_command at the
//     program level.
//   - `compound_list` (inside do/then/else/etc.): NEWLINE is also a
//     separator within the list, so the body of a `do ... done` block can
//     contain multiple newline-separated commands.
function parseList(ctx, crossNewlines = false) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  const items = [];
  let cur = parseAndOr(ctx);
  if (cur === null) return null;

  // Each "item" carries the separator that follows it (or null if it was the
  // last thing on its line with no trailing ';'/'&'/NEWLINE).
  while (true) {
    let sep = null;
    if (_at(ctx, 'OPERATOR', ';')) { sep = ';'; _consume(ctx); }
    else if (_at(ctx, 'OPERATOR', '&')) { sep = '&'; _consume(ctx); }
    else if (_at(ctx, 'NEWLINE')) {
      // Only treat as a list separator when caller permits crossing newlines
      // (compound contexts). At program level, NEWLINE peek-only — caller
      // (parseProgram) consumes and starts a fresh list.
      if (crossNewlines) {
        sep = '\n';
        _consume(ctx);
      }
    }

    items.push({ op: sep, cmd: cur });

    if (sep === null) break;

    // After any separator, skip extra blank lines.
    _skipNL(ctx);

    // Terminators that stop list parsing.
    if (_at(ctx, 'EOF')) break;
    if (_isListTerminatorKeyword(ctx)) break;
    if (_at(ctx, 'OPERATOR', ')') || _at(ctx, 'OPERATOR', ';;')) break;

    cur = parseAndOr(ctx);
    if (cur === null) break;
  }

  // Collapse a trivial 1-item list-with-no-trailing-separator into just its
  // command. Keeps the AST cleaner for the common one-command-per-line case.
  if (items.length === 1 && items[0].op === null) return items[0].cmd;
  return mkList(items, { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// Compound-list keywords that end a list (don't try to parse past them).
function _isListTerminatorKeyword(ctx) {
  const t = ctx.tokens[ctx.i];
  if (!t || t.type !== 'WORD') return false;
  return ['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'].includes(t.value)
      || t.value === '}';
}

// and_or = pipeline (('&&'|'||') linebreak pipeline)*    left-associative
function parseAndOr(ctx) {
  if (!_canStartCommand(ctx)) return null;
  let left = parsePipeline(ctx);
  const startPos = left.pos.start;
  while (_at(ctx, 'OPERATOR', '&&') || _at(ctx, 'OPERATOR', '||')) {
    const op = _consume(ctx).value;
    _skipNL(ctx);
    const right = parsePipeline(ctx);
    left = mkAndOr(left, op, right, { start: startPos, end: right.pos.end });
  }
  return left;
}

// pipeline = ['!'] command ('|' linebreak command)*
function parsePipeline(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  let negated = false;
  if (_atKeyword(ctx, '!')) { _consume(ctx); negated = true; }

  const commands = [parseCommand(ctx)];
  while (_at(ctx, 'OPERATOR', '|')) {
    _consume(ctx);
    _skipNL(ctx);
    commands.push(parseCommand(ctx));
  }
  if (commands.length === 1 && !negated) return commands[0];
  return mkPipeline(commands, negated, { start: startPos, end: commands[commands.length - 1].pos.end });
}

function _canStartCommand(ctx) {
  const t = ctx.tokens[ctx.i];
  if (!t) return false;
  if (t.type === 'EOF' || t.type === 'NEWLINE') return false;
  if (t.type === 'OPERATOR') {
    // `(` opens a subshell, `{` would be a WORD ('{' is brace-group reserved word
    // only when standalone, lexer-wise). Redirect ops can start a simple command
    // (POSIX: `< in.txt cmd` is valid — the cmd word can follow leading redirects).
    return t.value === '(' || REDIR_OPS.has(t.value);
  }
  if (t.type === 'IO_NUMBER') return true;
  if (t.type === 'WORD') {
    // Reserved word that terminates an enclosing context shouldn't start a new command.
    return !['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'].includes(t.value);
  }
  return false;
}

// command = compound_command redirect*
//         | function_def
//         | simple_command
function parseCommand(ctx) {
  const t = ctx.tokens[ctx.i];

  // Compound openers: `(`, `{`, or a keyword.
  if (t.type === 'OPERATOR' && t.value === '(') {
    return parseSubshell(ctx);
  }
  if (t.type === 'WORD' && t.value === '{') {
    return parseBraceGroup(ctx);
  }
  if (t.type === 'WORD' && COMPOUND_START_WORDS.has(t.value)) {
    switch (t.value) {
      case 'if':    return parseIf(ctx);
      case 'for':   return parseFor(ctx);
      case 'while': return parseWhile(ctx);
      case 'until': return parseUntil(ctx);
      case 'case':  return parseCase(ctx);
      case '{':     return parseBraceGroup(ctx);
    }
  }

  // Function def lookahead: `name ( )` with no leading assignment/redirect.
  // POSIX disallows prefix on function defs, so if the very first thing is a
  // bare WORD that's a valid identifier AND the next two tokens are '(' ')',
  // it's a function definition.
  if (t.type === 'WORD' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value)) {
    const t1 = ctx.tokens[ctx.i + 1];
    const t2 = ctx.tokens[ctx.i + 2];
    if (t1 && t1.type === 'OPERATOR' && t1.value === '('
        && t2 && t2.type === 'OPERATOR' && t2.value === ')') {
      return parseFunctionDef(ctx);
    }
  }

  return parseSimpleCommand(ctx);
}

// ── simple command ──

const _ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function _wordIsAssignment(token) {
  return token.type === 'WORD' && _ASSIGN_RE.test(token.value);
}

function parseSimpleCommand(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  const assignments = [];
  const words = [];
  const redirects = [];

  // Prefix: assignments and redirects, in any order, until we see something
  // that isn't either — at which point we're in the suffix.
  while (true) {
    const t = ctx.tokens[ctx.i];
    if (!t) break;
    if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
      redirects.push(parseRedirect(ctx));
      continue;
    }
    if (_wordIsAssignment(t)) {
      const m = t.value.match(_ASSIGN_RE);
      assignments.push(mkAssignment(m[1], _word(m[2], t.pos), t.pos));
      _consume(ctx);
      continue;
    }
    break;
  }

  // Command name + suffix. POSIX rule 7b: after the command name, subsequent
  // tokens that look like `NAME=value` are arguments, not assignments.
  if (_at(ctx, 'WORD')) {
    words.push(_word(_consume(ctx).value, ctx.tokens[ctx.i - 1].pos));
    while (true) {
      const t = ctx.tokens[ctx.i];
      if (!t) break;
      if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
        redirects.push(parseRedirect(ctx));
        continue;
      }
      if (t.type === 'WORD') {
        // POSIX rule: reserved words are recognised ONLY at command-start
        // position. Once we've started accumulating a simple command's
        // suffix, subsequent WORDs are always arguments — including words
        // spelled like reserved words. So `echo done` reads `done` as an
        // arg, not a do-group terminator. The enclosing list's call to
        // _canStartCommand handles keyword-as-terminator at the right time
        // (when deciding whether to start the next command in the list).
        words.push(_word(t.value, t.pos));
        _consume(ctx);
        continue;
      }
      break;
    }
  } else if (assignments.length === 0 && redirects.length === 0) {
    // Nothing parsed — caller's _canStartCommand should have prevented this.
    throw new ParseError('expected a command', ctx.tokens[ctx.i]);
  }

  const endPos = ctx.tokens[ctx.i - 1] ? ctx.tokens[ctx.i - 1].pos.end : startPos;
  return mkSimpleCommand(assignments, words, redirects, { start: startPos, end: endPos });
}

// redirect = [IO_NUMBER] redir_op WORD
function parseRedirect(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  let fd = null;
  if (_at(ctx, 'IO_NUMBER')) {
    fd = Number(_consume(ctx).value);
  }
  const opTok = _consume(ctx);
  if (opTok.type !== 'OPERATOR' || !REDIR_OPS.has(opTok.value)) {
    throw new ParseError(`expected redirection operator`, opTok);
  }
  const targetTok = _consume(ctx);
  if (targetTok.type !== 'WORD') {
    throw new ParseError(`expected redirection target word`, targetTok);
  }
  const redir = mkRedirect(fd, opTok.value, _word(targetTok.value, targetTok.pos),
                           { start: startPos, end: targetTok.pos.end });
  // Here-doc redirects expect a body to be attached when the next NEWLINE
  // fires (the lexer queues bodies in declaration order and emits them just
  // before the NEWLINE; _drainHeredocBodies pairs them with these). Bodies
  // remain null on this node if the input is malformed or unterminated.
  if (opTok.value === '<<' || opTok.value === '<<-') {
    redir.body = null;
    redir.bodyQuoted = false;
    ctx.pendingHeredocs.push(redir);
  }
  return redir;
}

// ── compound commands ──

// brace_group = '{' compound_list '}'
function parseBraceGroup(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, '{');
  _skipNL(ctx);
  const body = parseList(ctx, true);
  _skipNL(ctx);
  _expectKeyword(ctx, '}');
  const redirects = _parseTrailingRedirects(ctx);
  return mkBraceGroup(body, redirects, { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// subshell = '(' compound_list ')'
function parseSubshell(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expect(ctx, 'OPERATOR', '(');
  _skipNL(ctx);
  const body = parseList(ctx, true);
  _skipNL(ctx);
  _expect(ctx, 'OPERATOR', ')');
  const redirects = _parseTrailingRedirects(ctx);
  return mkSubshell(body, redirects, { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// if_clause = 'if' list 'then' list ('elif' list 'then' list)* ('else' list)? 'fi'
function parseIf(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'if');
  _skipNL(ctx);
  const cond = parseList(ctx, true);
  _skipNL(ctx);
  _expectKeyword(ctx, 'then');
  _skipNL(ctx);
  const then_ = parseList(ctx, true);
  _skipNL(ctx);

  const elifs = [];
  while (_atKeyword(ctx, 'elif')) {
    _consume(ctx);
    _skipNL(ctx);
    const ec = parseList(ctx, true);
    _skipNL(ctx);
    _expectKeyword(ctx, 'then');
    _skipNL(ctx);
    const et = parseList(ctx, true);
    _skipNL(ctx);
    elifs.push({ cond: ec, then: et });
  }

  let else_ = null;
  if (_atKeyword(ctx, 'else')) {
    _consume(ctx);
    _skipNL(ctx);
    else_ = parseList(ctx, true);
    _skipNL(ctx);
  }
  _expectKeyword(ctx, 'fi');
  const redirects = _parseTrailingRedirects(ctx);
  return mkIfClause(cond, then_, elifs, else_, redirects,
                    { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// for_clause = 'for' name (linebreak 'in' word* separator)? do_group
function parseFor(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'for');
  const nameTok = _expect(ctx, 'WORD');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTok.value)) {
    throw new ParseError(`invalid for-loop variable name "${nameTok.value}"`, nameTok);
  }
  const name = nameTok.value;
  _skipNL(ctx);

  let words = null;
  if (_atKeyword(ctx, 'in')) {
    _consume(ctx);
    words = [];
    while (_at(ctx, 'WORD') && !_isListTerminatorKeyword(ctx) && !_atKeyword(ctx, 'do')) {
      const w = _consume(ctx);
      words.push(_word(w.value, w.pos));
    }
    // Optional ; or newline before do
    if (_at(ctx, 'OPERATOR', ';')) _consume(ctx);
    _skipNL(ctx);
  } else {
    // No `in` clause; allow ; or newline directly before do.
    if (_at(ctx, 'OPERATOR', ';')) _consume(ctx);
    _skipNL(ctx);
  }
  const body = _parseDoGroup(ctx);
  const redirects = _parseTrailingRedirects(ctx);
  return mkForClause(name, words, body, redirects,
                     { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// while_clause = 'while' list do_group
function parseWhile(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'while');
  _skipNL(ctx);
  const cond = parseList(ctx, true);
  _skipNL(ctx);
  const body = _parseDoGroup(ctx);
  const redirects = _parseTrailingRedirects(ctx);
  return mkWhileClause(cond, body, redirects,
                       { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

function parseUntil(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'until');
  _skipNL(ctx);
  const cond = parseList(ctx, true);
  _skipNL(ctx);
  const body = _parseDoGroup(ctx);
  const redirects = _parseTrailingRedirects(ctx);
  return mkUntilClause(cond, body, redirects,
                       { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

function _parseDoGroup(ctx) {
  _expectKeyword(ctx, 'do');
  _skipNL(ctx);
  const body = parseList(ctx, true);
  _skipNL(ctx);
  _expectKeyword(ctx, 'done');
  return body;
}

// case_clause = 'case' word linebreak 'in' linebreak (case_item ;;)* [case_item ;;?] 'esac'
// case_item   = ['('] pattern ('|' pattern)* ')' compound_list?
function parseCase(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'case');
  const wTok = _expect(ctx, 'WORD');
  const word = _word(wTok.value, wTok.pos);
  _skipNL(ctx);
  _expectKeyword(ctx, 'in');
  _skipNL(ctx);

  const items = [];
  while (!_atKeyword(ctx, 'esac') && !_at(ctx, 'EOF')) {
    const itemStart = ctx.tokens[ctx.i].pos.start;
    // Optional leading `(`
    if (_at(ctx, 'OPERATOR', '(')) _consume(ctx);
    const patterns = [];
    // First pattern
    if (!_at(ctx, 'WORD')) {
      throw new ParseError('expected case pattern', ctx.tokens[ctx.i]);
    }
    const p0 = _consume(ctx);
    patterns.push(_word(p0.value, p0.pos));
    while (_at(ctx, 'OPERATOR', '|')) {
      _consume(ctx);
      const pn = _expect(ctx, 'WORD');
      patterns.push(_word(pn.value, pn.pos));
    }
    _expect(ctx, 'OPERATOR', ')');
    _skipNL(ctx);
    // Body: anything up to ';;' or 'esac'.
    let body = null;
    if (!_at(ctx, 'OPERATOR', ';;') && !_atKeyword(ctx, 'esac')) {
      body = parseList(ctx, true);
    }
    _skipNL(ctx);
    if (_at(ctx, 'OPERATOR', ';;')) _consume(ctx);
    _skipNL(ctx);
    items.push(mkCaseItem(patterns, body,
                          { start: itemStart, end: ctx.tokens[ctx.i - 1].pos.end }));
  }
  _expectKeyword(ctx, 'esac');
  const redirects = _parseTrailingRedirects(ctx);
  return mkCaseClause(word, items, redirects,
                      { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// function_def = name '(' ')' linebreak compound_command
function parseFunctionDef(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  const nameTok = _expect(ctx, 'WORD');
  const name = nameTok.value;
  _expect(ctx, 'OPERATOR', '(');
  _expect(ctx, 'OPERATOR', ')');
  _skipNL(ctx);
  // POSIX says the body must be a compound_command — for simplicity we parse
  // any command (lets `foo() simple cmd` work too, a bash-style extension).
  const body = parseCommand(ctx);
  return mkFunctionDef(name, body, { start: startPos, end: body.pos.end });
}

function _parseTrailingRedirects(ctx) {
  const out = [];
  while (true) {
    const t = ctx.tokens[ctx.i];
    if (!t) break;
    if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
      out.push(parseRedirect(ctx));
    } else {
      break;
    }
  }
  return out;
}

// -- typed.js --

// Typed pipe protocol — the GCU-distinctive feature.
//
// Pipes carry one of two payload shapes:
//
//   string       — POSIX-shape text (default)
//   Typed object — { __geas_typed: true, kind, value, toString }
//
// When the previous stage's stdout is a Typed value, the next stage's ctx.stdin
// is that Typed object. Stages that recognise its `kind` can read `.value`
// directly without re-parsing. Stages that don't (cat, grep, head, etc.)
// fall back to `String(stdin)` — the Typed object's `toString()` returns
// its text rendering, so the pipe degrades gracefully to POSIX semantics.
//
// Capability negotiation is implicit: producers always emit Typed; consumers
// inspect `__geas_typed`. No explicit handshake. The terminal adapter does
// a separate negotiation via `caps()` for inline rich-block rendering of
// the final pipe stage's typed output.

// ── factory ──

// Construct a Typed value. `text` is the canonical text rendering used by
// downstream non-typed consumers and by terminal adapters without rich-block
// support. Can be a string OR a function () => string for lazy rendering.
function mkTyped(kind, value, text) {
  const tv = {
    __geas_typed: true,
    kind,
    value,
    toString() { return typeof text === 'function' ? text() : text; },
  };
  // Make sure `'' + tv` / template literals invoke toString correctly.
  // (Object stringification falls back to toString automatically.)
  return tv;
}

function isTyped(v) {
  return v != null && typeof v === 'object' && v.__geas_typed === true;
}

// Convert any pipe payload to text. Used by builtins that don't understand
// the Typed kind — they read input through here and get a string.
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (isTyped(v)) return v.toString();
  return String(v);
}

// Drain a pipe-stdin into a single value. Handles the four shapes
// ctx.stdin can take after the streaming-pipes refactor:
//   string             — passed through (initial stdin / heredoc body)
//   Typed object       — passed through (single upstream push)
//   async iterable     — drained: concatenate string items, keep the
//                        last Typed pushed; if any Typed was seen,
//                        return it (matching the prior "last typed
//                        wins" rule); else return the joined text
//   anything else      — String(...) fallback
//
// Builtins that want a string call this then `String(v)`; builtins
// that understand typed values inspect the return.
async function drainInput(ctx) {
  const s = ctx.stdin;
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (isTyped(s)) return s;
  if (s && typeof s[Symbol.asyncIterator] === 'function') {
    let typed = null;
    let text = '';
    for await (const v of s) {
      if (isTyped(v)) typed = v;
      else text += typeof v === 'string' ? v : String(v);
    }
    return typed != null ? typed : text;
  }
  return String(s);
}

// ── CSV helpers (minimal) ──
//
// v0 ships a compact CSV parser/serialiser inline so the typed-pipe demo
// works without dragging in sadpan. The format is small but POSIX-friendly:
//
//   parseCSV(text, opts)   → { columns: string[], rows: any[][] }
//   serializeCSV(table)    → string (with trailing newline if rows > 0)
//
// Quoting: double-quote-wrapped fields with ""-doubled embedded quotes.
// Delimiter: comma by default; opts.delim overrides.

function parseCSV(text, opts = {}) {
  const delim = opts.delim || ',';
  if (!text || text.length === 0) return { columns: [], rows: [] };
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const records = _parseCSVRecords(trimmed, delim);
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0];
  const rows = records.slice(1);
  return { columns, rows };
}

function _parseCSVRecords(text, delim) {
  const out = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  // Last field / row.
  row.push(field);
  if (row.length > 1 || row[0] !== '') out.push(row);
  return out;
}

function serializeCSV(table, opts = {}) {
  const delim = opts.delim || ',';
  const escape = (v) => {
    const s = String(v ?? '');
    if (s.includes(delim) || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [];
  if (table.columns && table.columns.length > 0) {
    lines.push(table.columns.map(escape).join(delim));
  }
  for (const row of table.rows || []) {
    lines.push(row.map(escape).join(delim));
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

// Pretty-format a table as a fixed-width text block, for tty fallback.
// Used by Typed-table.toString() in the absence of structured rendering.
function formatTable(table, opts = {}) {
  const max = opts.maxRows ?? 50;
  const cols = table.columns || [];
  const rows = (table.rows || []).slice(0, max);
  const widths = cols.map((c, i) => {
    let w = String(c).length;
    for (const r of rows) w = Math.max(w, String(r[i] ?? '').length);
    return w;
  });
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const lines = [];
  if (cols.length > 0) {
    lines.push(cols.map((c, i) => pad(c, widths[i])).join('  '));
    lines.push(widths.map(w => '─'.repeat(w)).join('  '));
  }
  for (const r of rows) lines.push(r.map((v, i) => pad(v, widths[i])).join('  '));
  if ((table.rows?.length ?? 0) > max) {
    lines.push(`… (${table.rows.length - max} more rows)`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

// -- executor.js --

// Executor — walks a parsed geas AST against a context, producing output
// and exit codes. v0 skeleton: covers the common-path shell semantics
// (simple commands, pipelines, and-or, lists, if/for/while/until/case,
// redirects, word expansion with $vars and $(cmd) substitution).
//
// Context shape (all fields are optional unless noted; defaults below):
//
//   vfs       — @gcu/vfs-shaped instance (readFile/writeFile/readdir/...).
//               Required if any redirect or filesystem builtin runs.
//   env       — Map<string,string>. Defaults to empty.
//   cwd       — string. Defaults to '/'.
//   stdin     — string | AsyncIterable<string>. Defaults to ''.
//   stdout    — async (text) => void. Defaults to throw if not provided.
//   stderr    — async (text) => void. Defaults to ctx.stdout if absent.
//   builtins  — Map<name, async (argv, subctx) => exitCode>. Empty default.
//   onCommand — async (name, argv, subctx) => exitCode. Called when a
//               command isn't a builtin; defaults to "127 command not found".
//   functions — Map<name, FunctionDef AST>. Populated by FunctionDef nodes.
//   lastStatus — number. Tracks $? across commands. Initialised to 0.
//
// What v0 does NOT do:
//   - Backgrounding via `&` (parsed, runs synchronously)
//   - Function call frames (FunctionDef stores the body; calling skips for now)
//   - Subshell isolation (Subshell runs in the same scope as a brace group)
//   - Glob expansion (patterns stay literal except inside `case`)
//   - Field splitting on $IFS (unquoted expansions stay single fields)
//   - Real streaming pipes (each stage's stdout buffers before the next runs)
//   - Process substitution `<(...)` / `>(...)`
//   - Job control / signals beyond Ctrl+C-style abort via thrown promises
//
// These are sized-by-need additions; the architecture leaves room.


async function execute(ast, ctx) {
  const c = _normalize(ctx);
  return await _exec(ast, c);
}

// Normalize a raw context into the full executor-ready shape (env/
// functions as Maps, options/positional/signal-symbols filled in,
// _geasNormalized flag set). Exported so a long-lived shell can
// normalize ONCE and reuse the same ctx across exec calls — that's
// what makes `cd` and other cwd mutations persist between commands.
function normalizeContext(ctx) {
  return _normalize(ctx);
}

function _normalize(ctx) {
  // Idempotent: an already-normalized ctx is returned as-is. This lets
  // a long-lived shell (createShell) hold ONE normalized ctx and reuse
  // it across exec calls — without this, every exec copied `cwd` (a
  // string) into a fresh object, so `cd` never persisted between
  // commands. Env / functions survived only because they're Maps
  // (shared by reference); cwd, being a primitive, was silently lost.
  if (ctx && ctx._geasNormalized) return ctx;
  return {
    _geasNormalized: true,
    vfs:        ctx.vfs ?? null,
    // Optional host-RPC bridge (member, args) → Promise — present only when a
    // worker-hosted shell was wired to a host realm (e.g. the Works terminal).
    host:       ctx.host ?? null,
    env:        ctx.env instanceof Map ? ctx.env : new Map(Object.entries(ctx.env || {})),
    cwd:        ctx.cwd ?? '/',
    stdin:      ctx.stdin ?? '',
    stdout:     ctx.stdout ?? (() => { throw new Error('geas: no stdout sink configured'); }),
    stderr:     ctx.stderr ?? ctx.stdout ?? (() => { throw new Error('geas: no stderr sink configured'); }),
    builtins:   ctx.builtins instanceof Map ? ctx.builtins : new Map(Object.entries(ctx.builtins || {})),
    onCommand:  ctx.onCommand ?? (async (name) => 127),
    functions:  ctx.functions instanceof Map ? ctx.functions : new Map(Object.entries(ctx.functions || {})),
    lastStatus: ctx.lastStatus ?? 0,
    // Shell options (set via `set -e`, `set -u`, `set -o pipefail`, ...).
    // Live on ctx so builtins like `set` can flip them at runtime, and the
    // executor checks them at the right gates (errexit after every command
    // in a list / program; pipefail when deriving a pipeline's exit code;
    // nounset on var lookup).
    options:    ctx.options ?? { errexit: false, nounset: false, pipefail: false, xtrace: false },
    // True while evaluating an `if`/`while`/`until` condition, the left
    // side of `&&`/`||`, or a negated `! cmd`. errexit doesn't trigger
    // inside these contexts — only on the rightmost actually-evaluated
    // command of a list (POSIX 2.5.3 / Bash "Shell Builtin Commands" set).
    _inCondition: ctx._inCondition ?? false,
    positional: ctx.positional ?? [],
    // Optional interactive-input hook used by `read` when stdin is empty.
    readLine:   typeof ctx.readLine === 'function' ? ctx.readLine : null,
    // When true, _execProgram's catch re-throws an `exit` signal
    // instead of converting it to a return value — needed by source
    // and eval so an `exit` in their bodies halts the calling script.
    _propagateExit: !!ctx._propagateExit,
    // Internal signal markers — thrown by `break`/`continue`/`return`/`exit`.
    // Exposed on ctx so builtins can throw them too.
    _BREAK:     ctx._BREAK ?? Symbol.for('geas:break'),
    _CONTINUE:  ctx._CONTINUE ?? Symbol.for('geas:continue'),
    _RETURN:    ctx._RETURN ?? Symbol.for('geas:return'),
    _EXIT:      ctx._EXIT ?? Symbol.for('geas:exit'),
  };
}

// Run a child node with _inCondition forced true. Used by if/while/until
// conditions, the left side of &&/||, and the body of a negated pipeline.
// Restores _inCondition on return so siblings see the original value.
async function _withCondition(node, ctx) {
  const prev = ctx._inCondition;
  ctx._inCondition = true;
  try {
    return await _exec(node, ctx);
  } finally {
    ctx._inCondition = prev;
  }
}

// Does a command qualify for errexit-suppression by being a "tested" command?
// POSIX: negated pipelines (`! cmd`) never trigger errexit even on failure.
// Compound conditions handle their own context via _withCondition.
function _errexitExempt(cmd) {
  if (cmd && cmd.type === NODE.PIPELINE && cmd.negated) return true;
  return false;
}

// After executing a command in a list/program context, check whether
// errexit should trigger a script exit. Called by _execProgram, _execList,
// and the compound-body helpers (which themselves invoke _execList for
// their bodies, so the check happens transparently there too).
function _maybeErrexit(cmd, exitCode, ctx) {
  if (!ctx.options || !ctx.options.errexit) return;
  if (exitCode === 0) return;
  if (ctx._inCondition) return;
  if (_errexitExempt(cmd)) return;
  throw { exitCode, _exit: true };
}

async function _exec(node, ctx) {
  switch (node.type) {
    case NODE.PROGRAM:        return await _execProgram(node, ctx);
    case NODE.LIST:           return await _execList(node, ctx);
    case NODE.AND_OR:         return await _execAndOr(node, ctx);
    case NODE.PIPELINE:       return await _execPipeline(node, ctx);
    case NODE.SIMPLE_COMMAND: return await _execSimpleCommand(node, ctx);
    case NODE.IF_CLAUSE:      return await _execIf(node, ctx);
    case NODE.FOR_CLAUSE:     return await _execFor(node, ctx);
    case NODE.WHILE_CLAUSE:   return await _execWhile(node, ctx);
    case NODE.UNTIL_CLAUSE:   return await _execUntil(node, ctx);
    case NODE.CASE_CLAUSE:    return await _execCase(node, ctx);
    case NODE.BRACE_GROUP:    return await _execBraceGroup(node, ctx);
    case NODE.SUBSHELL:       return await _execSubshell(node, ctx);
    case NODE.FUNCTION_DEF:   return _execFunctionDef(node, ctx);
    default: throw new Error(`geas executor: unknown node type "${node.type}"`);
  }
}

// ── top-level ──

async function _execProgram(node, ctx) {
  let exitCode = 0;
  try {
    for (const cmd of node.commands) {
      const r = await _exec(cmd, ctx);
      exitCode = r.exitCode;
      ctx.lastStatus = exitCode;
      _maybeErrexit(cmd, exitCode, ctx);
    }
  } catch (e) {
    // `exit` builtin throws { exitCode, _exit: true }; catch here to stop
    // running subsequent top-level commands. The errexit path also throws
    // an _exit signal, which routes the same way. nounset (`set -u`)
    // tags its throw with `_unbound` so we can surface the variable name.
    //
    // `ctx._propagateExit` lets the source / eval builtins re-throw
    // the exit signal past their inner `execute()` so it reaches the
    // caller's _execProgram instead of being smoothed into a normal
    // exit code (POSIX: exit inside a sourced file halts the script).
    if (e && e._exit) {
      if (ctx._propagateExit) throw e;
      if (e._unbound) {
        try { await ctx.stderr(`geas: ${e._unbound}: unbound variable\n`); } catch {}
      }
      return { exitCode: e.exitCode };
    }
    throw e;
  }
  return { exitCode };
}

async function _execList(node, ctx) {
  let exitCode = 0;
  for (const item of node.items) {
    const r = await _exec(item.cmd, ctx);
    exitCode = r.exitCode;
    ctx.lastStatus = exitCode;
    _maybeErrexit(item.cmd, exitCode, ctx);
    // v0: `&` runs synchronously, same as `;`.
  }
  return { exitCode };
}

async function _execAndOr(node, ctx) {
  // The left side of && / || is a "tested" command (its exit code drives
  // the chain decision), so errexit doesn't trigger on it. The right side
  // inherits the caller's _inCondition — at the top level that's false,
  // so the rightmost actually-evaluated command CAN trigger errexit; for
  // nested chains like `A && B && C` the outer wraps the inner left in a
  // condition, which transitively suppresses A and B but leaves C exposed.
  const left = await _withCondition(node.left, ctx);
  ctx.lastStatus = left.exitCode;
  if (node.op === '&&' && left.exitCode !== 0) return left;
  if (node.op === '||' && left.exitCode === 0) return left;
  const right = await _exec(node.right, ctx);
  ctx.lastStatus = right.exitCode;
  return right;
}

// ── pipelines ──

async function _execPipeline(node, ctx) {
  // A `! pipeline` is a "tested" command for errexit purposes — POSIX says
  // commands whose status is being inverted with `!` do NOT trigger
  // errexit. Force _inCondition for the body's evaluation so anything
  // inside (including non-final pipefail-derived non-zero exits) is
  // suppressed, then invert the final exit. The outer _maybeErrexit()
  // also short-circuits on negated pipelines via _errexitExempt.
  if (node.negated) {
    const inner = await _withCondition({ ...node, negated: false }, ctx);
    return { exitCode: inner.exitCode === 0 ? 1 : 0 };
  }

  if (node.commands.length === 1) {
    const r = await _exec(node.commands[0], ctx);
    return { exitCode: r.exitCode };
  }

  // Multi-stage pipeline: stages run as CONCURRENT tasks, connected by
  // bounded async queues (one queue per inter-stage gap). Backpressure
  // is built in — upstream's push awaits when the downstream queue is
  // full. When a downstream stage finishes early (`head -1`), it closes
  // its input queue, which makes upstream's next push throw _pipeClosed;
  // upstream catches that as a clean early-return signal so the long
  // walk (e.g. `find /huge`) doesn't run to completion uselessly.
  //
  // Typed-pipe protocol stays: a stage can push a Typed value (`from-csv`)
  // or string chunks; the downstream's drain (_drainInput in builtins.js)
  // collects items and returns either text or a Typed value, matching
  // the previous semantics. The order rule (last typed wins, strings
  // concat) is preserved by the drain helper, not by the queue itself.
  const stages = node.commands;
  const queues = [];
  for (let i = 0; i < stages.length - 1; i++) queues.push(_makePipeQueue());
  const exits = new Array(stages.length).fill(0);

  await Promise.all(stages.map(async (cmd, i) => {
    const isFirst = i === 0;
    const isLast  = i === stages.length - 1;
    const inQueue  = isFirst ? null : queues[i - 1];
    const outQueue = isLast  ? null : queues[i];
    // POSIX: each pipeline stage runs in a subshell-like environment.
    // Clone the mutable containers (env, functions, options, positional)
    // so a stage's `cd` / `FOO=bar` / `set -e` / `set --` mutations stay
    // inside that stage instead of leaking sideways into siblings or up
    // into the parent. Local frames reset too — `local NAME` inside a
    // pipeline stage shadowed-binding mechanics don't make sense
    // outside an enclosing function, and we're starting a fresh nesting.
    const subCtx = {
      ...ctx,
      env:        new Map(ctx.env),
      functions:  new Map(ctx.functions),
      options:    { ...ctx.options },
      positional: [...(ctx.positional || [])],
      _localFrames:  [],
      _inCondition:  false,
      _redirectFlush: null,
      stdin: inQueue ?? ctx.stdin,
      stdout: isLast ? ctx.stdout : async (value) => {
        await outQueue.push(value);
      },
    };
    try {
      const r = await _exec(cmd, subCtx);
      exits[i] = r.exitCode;
    } catch (e) {
      if (e && e._pipeClosed) {
        // Downstream went away — clean early termination.
        exits[i] = 0;
      } else {
        // Propagate after closing our outgoing queue so other stages
        // don't deadlock waiting for our writes.
        if (outQueue) outQueue.close();
        throw e;
      }
    } finally {
      if (outQueue) outQueue.close();
    }
  }));

  // POSIX pipefail: pipeline exit code is the rightmost non-zero stage,
  // or 0 if all succeeded. Without pipefail, only the last stage's exit
  // counts. (We use first non-zero here — bash returns "last non-zero",
  // which is the same when only one stage fails; for multi-failure
  // cases, "first non-zero" tends to be more useful for diagnosis.)
  const lastExit = exits[exits.length - 1];
  const finalExit = ctx.options.pipefail
    ? (exits.find(c => c !== 0) ?? 0)
    : lastExit;
  return { exitCode: finalExit };
}

// Bounded async queue connecting two pipeline stages. push() waits when
// the buffer hits the high-water mark (backpressure); iterating drains
// in FIFO order. close() signals "no more writes coming" — readers exit
// when buffer empties; pending writers wake and see the close so they
// can throw _pipeClosed to their caller (which surfaces as the
// "downstream went away" signal in the executor).
function _makePipeQueue(highWaterMark = 64) {
  let buffer = [];
  let closed = false;
  const readers = [];
  const writers = [];
  const wakeAll = (arr) => { while (arr.length) arr.shift()(); };
  return {
    async push(value) {
      if (closed) throw { _pipeClosed: true };
      buffer.push(value);
      wakeAll(readers);
      if (buffer.length >= highWaterMark) {
        await new Promise(r => writers.push(r));
        if (closed) throw { _pipeClosed: true };
      }
    },
    close() {
      closed = true;
      wakeAll(readers);
      wakeAll(writers);
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffer.length > 0) {
          const v = buffer.shift();
          wakeAll(writers);
          yield v;
          continue;
        }
        if (closed) return;
        await new Promise(r => readers.push(r));
      }
    },
    get _isPipeQueue() { return true; },
  };
}

// ── simple commands ──

async function _execSimpleCommand(node, ctx) {
  // 1. Expand assignments. If there are no words (no command name), apply
  //    them to ctx.env permanently. Otherwise, scope them to this command
  //    only (POSIX semantics).
  const assignmentBindings = [];
  for (const a of node.assignments) {
    const value = await _expandWord(a.value, ctx);
    assignmentBindings.push([a.name, value]);
  }
  if (node.words.length === 0) {
    for (const [n, v] of assignmentBindings) ctx.env.set(n, v);
    return { exitCode: 0 };
  }

  // 2. Set up sub-context for per-command assignments + redirects.
  //    Only create a fresh subCtx when we actually need isolation —
  //    otherwise pass the parent ctx through directly so builtins that
  //    mutate state (cd → ctx.cwd, exit → throws) see the right object.
  //    POSIX: per-command assignments scope only to that command; redirects
  //    only affect that command's stdio. Plain builtins with no
  //    assignments/redirects can (and should) mutate the parent ctx.
  let subCtx = ctx;
  const needsScope =
    assignmentBindings.length > 0 ||
    (node.redirects && node.redirects.length > 0);
  if (needsScope) {
    subCtx = { ...ctx, _redirectFlush: null };
    if (assignmentBindings.length > 0) {
      subCtx.env = new Map(ctx.env);
      for (const [n, v] of assignmentBindings) subCtx.env.set(n, v);
    }
    await _applyRedirects(node.redirects, subCtx);
  }

  // 3. Expand command name + args. Argv expansion (unlike redirect targets)
  //    is subject to field splitting on $IFS and pathname (glob) expansion,
  //    so a single Word can produce zero, one, or many argv entries.
  const argv = [];
  for (const w of node.words) {
    const fields = await _expandWordToFields(w, subCtx);
    for (const f of fields) argv.push(f);
  }
  // POSIX: if all words expand to nothing (e.g. `$EMPTY $UNDEFINED`),
  // there's no command to run — exit 0 (assignments + redirects above
  // are the side effect).
  if (argv.length === 0) return { exitCode: 0 };
  const cmdName = argv[0];

  // 3b. xtrace (`set -x`). Print the fully-expanded command line to
  // stderr before dispatch, prefixed by $PS4 (default '+ '). POSIX
  // doesn't trace compound constructs in v0 — only simple commands.
  if (subCtx.options && subCtx.options.xtrace) {
    const ps4 = subCtx.env.get('PS4') || '+ ';
    try { await subCtx.stderr(ps4 + argv.join(' ') + '\n'); } catch { /* ignore */ }
  }

  // 4. Dispatch.
  let exitCode = 127;
  try {
    try {
      if (ctx.builtins.has(cmdName)) {
        const r = await ctx.builtins.get(cmdName)(argv, subCtx);
        exitCode = typeof r === 'number' ? r : 0;
      } else if (ctx.functions.has(cmdName)) {
        const fnDef = ctx.functions.get(cmdName);
        exitCode = await _callFunction(fnDef, argv.slice(1), subCtx);
      } else {
        exitCode = await ctx.onCommand(cmdName, argv, subCtx);
      }
    } catch (e) {
      // The `exit` builtin throws { exitCode, _exit: true } to signal full
      // script termination — re-throw so _execProgram catches it instead of
      // smoothing it over into a normal exit code. `return` throws
      // { exitCode, _return: true } to unwind to the function boundary —
      // also re-throw so _callFunction sees it. Plain { exitCode } throws
      // (no _exit/_return marker) are treated as the command's exit code.
      if (e && (e._exit || e._return)) throw e;
      if (e && typeof e.exitCode === 'number') exitCode = e.exitCode;
      else throw e;
    }
  } finally {
    // Redirects buffered their writes; flush them now that the command
    // has produced all its output. Runs even if the command exited via
    // `_exit` or threw — `> file` should land its bytes either way.
    if (subCtx !== ctx) await _flushRedirects(subCtx);
  }
  ctx.lastStatus = exitCode;
  return { exitCode };
}

// ── compound commands ──

// Wrap a compound clause's execution in its trailing-redirect scope.
// POSIX allows `if/for/while/until/case ... done > file` to redirect
// the whole compound's stdout. We isolate via a sub-ctx (same shape as
// brace groups: shared env, separate redirect-flush queue), run the
// caller-supplied body, and flush at the boundary.
async function _withCompoundRedirects(node, ctx, body) {
  if (!node.redirects || node.redirects.length === 0) return await body(ctx);
  const subCtx = { ...ctx, _redirectFlush: null };
  await _applyRedirects(node.redirects, subCtx);
  try {
    return await body(subCtx);
  } finally {
    await _flushRedirects(subCtx);
  }
}

async function _execIf(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    const cond = await _withCondition(node.cond, ctx);
    if (cond.exitCode === 0) return await _exec(node.then, ctx);
    for (const elif of node.elifs) {
      const c = await _withCondition(elif.cond, ctx);
      if (c.exitCode === 0) return await _exec(elif.then, ctx);
    }
    if (node.else) return await _exec(node.else, ctx);
    return { exitCode: 0 };
  });
}

async function _execFor(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    // POSIX: `for x` (no `in`) iterates over "$@" — the positional params.
    // v0 doesn't have positional params plumbed through; treat as no-op
    // iteration in that case.
    //
    // Field expansion: each word can yield multiple values via $list-splitting
    // or glob expansion (`for f in *.csv`), so flatten with the splitting
    // surface rather than the single-string one.
    const values = [];
    if (node.words) {
      for (const w of node.words) {
        const fields = await _expandWordToFields(w, ctx);
        for (const f of fields) values.push(f);
      }
    }
    let exitCode = 0;
    for (const v of values) {
      ctx.env.set(node.name, v);
      try {
        const r = await _exec(node.body, ctx);
        exitCode = r.exitCode;
      } catch (e) {
        if (e === ctx._BREAK) return { exitCode };
        if (e === ctx._CONTINUE) continue;
        throw e;
      }
    }
    return { exitCode };
  });
}

async function _execWhile(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    let exitCode = 0;
    // POSIX safety net: cap iterations to a large but bounded number so a
    // pure infinite loop in a notebook cell doesn't hang the worker. Real
    // shells don't do this; we choose to because we're running in someone's
    // browser. Override by setting ctx.maxWhileIters.
    const maxIters = ctx.maxWhileIters ?? 1_000_000;
    let n = 0;
    while (true) {
      if (++n > maxIters) {
        throw new Error(`geas: while-loop exceeded ${maxIters} iterations (set ctx.maxWhileIters to raise)`);
      }
      const cond = await _withCondition(node.cond, ctx);
      if (cond.exitCode !== 0) break;
      try {
        const r = await _exec(node.body, ctx);
        exitCode = r.exitCode;
      } catch (e) {
        if (e === ctx._BREAK) break;
        if (e === ctx._CONTINUE) continue;
        throw e;
      }
    }
    return { exitCode };
  });
}

async function _execUntil(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    let exitCode = 0;
    const maxIters = ctx.maxWhileIters ?? 1_000_000;
    let n = 0;
    while (true) {
      if (++n > maxIters) {
        throw new Error(`geas: until-loop exceeded ${maxIters} iterations`);
      }
      const cond = await _withCondition(node.cond, ctx);
      if (cond.exitCode === 0) break;
      try {
        const r = await _exec(node.body, ctx);
        exitCode = r.exitCode;
      } catch (e) {
        if (e === ctx._BREAK) break;
        if (e === ctx._CONTINUE) continue;
        throw e;
      }
    }
    return { exitCode };
  });
}

async function _execCase(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    const word = await _expandWord(node.word, ctx);
    for (const item of node.items) {
      for (const pat of item.patterns) {
        const patStr = await _expandWord(pat, ctx);
        if (_globMatch(patStr, word)) {
          if (item.body) {
            const r = await _exec(item.body, ctx);
            return r;
          }
          return { exitCode: 0 };
        }
      }
    }
    return { exitCode: 0 };
  });
}

async function _execBraceGroup(node, ctx) {
  // Brace groups share the caller's scope (unlike subshells) — only
  // redirects are scoped. We still need a fresh _redirectFlush queue
  // so the group's redirects flush at the group boundary, not earlier.
  const subCtx = { ...ctx, _redirectFlush: null };
  await _applyRedirects(node.redirects, subCtx);
  let result;
  try {
    result = await _exec(node.body, subCtx);
  } finally {
    await _flushRedirects(subCtx);
  }
  return result;
}

async function _execSubshell(node, ctx) {
  // POSIX: subshells run in a copy of the parent's environment, so any
  // mutation — env vars, cwd, function definitions, set-options, last
  // status — stays inside. We clone every mutable container; `options`
  // gets a shallow spread (it's a flat bool record). Positional params
  // are immutable arrays so a reference-share is fine.
  const subCtx = {
    ...ctx,
    env:       new Map(ctx.env),
    functions: new Map(ctx.functions),
    options:   { ...ctx.options },
    lastStatus: ctx.lastStatus,
    _redirectFlush: null,
    // The subshell starts a fresh execution context — its body is at
    // "top level" inside the subshell. Outer flags like `_inCondition`
    // (set when the subshell is the left side of `||`, the test of
    // an `if`, etc.) shouldn't suppress errexit inside.
    _inCondition: false,
  };
  await _applyRedirects(node.redirects, subCtx);
  let result;
  try {
    try {
      result = await _exec(node.body, subCtx);
    } catch (e) {
      // POSIX: an `exit` inside a subshell terminates only the subshell.
      // errexit (`set -e`) inside the subshell similarly halts only the
      // subshell. Both signal via `_exit` — convert to a regular exit
      // code for the subshell as a whole so it doesn't propagate out.
      if (e && e._exit) result = { exitCode: e.exitCode };
      else throw e;
    }
  } finally {
    await _flushRedirects(subCtx);
  }
  return result;
}

function _execFunctionDef(node, ctx) {
  ctx.functions.set(node.name, node);
  return { exitCode: 0 };
}

// ── function call frames ──
//
// Each call pushes a frame onto ctx._localFrames. The frame remembers
// the prior values of any variable later declared `local` inside the
// function, so we can restore them on return. Positional parameters
// ($1..$N, $#, $@, $*) are similarly save-and-restored.
//
// Non-local variable assignments inside a function leak to the parent
// (POSIX dynamic scoping). `local NAME[=val]` shadows the parent
// binding for the frame's lifetime. `return [N]` exits the function
// with status N; signalled via { _return: true } and caught here so
// it never propagates past the call boundary.
async function _callFunction(fnDef, args, ctx) {
  const frame = { savedBindings: new Map() };
  if (!ctx._localFrames) ctx._localFrames = [];
  ctx._localFrames.push(frame);
  const savedPositional = ctx.positional || [];
  ctx.positional = args;
  let exitCode = 0;
  try {
    const r = await _exec(fnDef.body, ctx);
    exitCode = r.exitCode;
  } catch (e) {
    if (e && e._return) {
      exitCode = e.exitCode;
    } else {
      // Re-throw _exit (which terminates the whole script) and any other
      // non-return signal, but make sure the finally still runs to
      // unwind locals and positional.
      throw e;
    }
  } finally {
    for (const [name, prior] of frame.savedBindings) {
      if (prior === undefined) ctx.env.delete(name);
      else ctx.env.set(name, prior);
    }
    ctx._localFrames.pop();
    ctx.positional = savedPositional;
  }
  return exitCode;
}

// ── redirects ──

async function _applyRedirects(redirects, ctx) {
  if (!redirects || redirects.length === 0) return;
  // Each write redirect buffers its chunks into a local array; the
  // single VFS write happens in `_flushRedirects` at the command (or
  // brace/subshell) boundary. The previous per-call read+rewrite cost
  // O(n²) for hot loops like `for i in ...; do echo $i >> file; done`.
  const ensureFlushQueue = () => {
    if (!ctx._redirectFlush) ctx._redirectFlush = [];
    return ctx._redirectFlush;
  };
  for (const r of redirects) {
    const target = await _expandWord(r.target, ctx);
    const isWrite = r.op === '>' || r.op === '>|' || r.op === '>>';
    const fd = r.fd;
    if (isWrite) {
      _requireVfs(ctx, `redirect ${r.op}`);
      const path = _resolvePath(target, ctx);
      const buf = [];
      const sink = (text) => {
        buf.push(typeof text === 'string' ? text : String(text));
      };
      // POSIX defaults: `>` / `>|` route fd 1 (stdout) to the file;
      // `2>` routes fd 2; other fd numbers are not modeled in v0.
      if (fd === 2) ctx.stderr = sink;
      else          ctx.stdout = sink;
      const appendMode = r.op === '>>';
      ensureFlushQueue().push(async () => {
        const out = buf.join('');
        if (appendMode) {
          let prior = '';
          try { prior = await ctx.vfs.readFile(path, 'text'); } catch { /* missing file → start fresh */ }
          await ctx.vfs.writeFile(path, prior + out);
        } else {
          // `>` truncates: even with zero output, the file is created/emptied.
          await ctx.vfs.writeFile(path, out);
        }
      });
      continue;
    }
    if (r.op === '<') {
      _requireVfs(ctx, 'redirect <');
      const path = _resolvePath(target, ctx);
      ctx.stdin = await ctx.vfs.readFile(path, 'text');
      continue;
    }
    if (r.op === '<<' || r.op === '<<-') {
      // Here-doc body was attached at parse time.
      let body = r.body ?? '';
      if (!r.bodyQuoted) body = await _expandTextString(body, ctx);
      ctx.stdin = body;
      continue;
    }
    if (r.op === '>&' || r.op === '<&') {
      // Duplicate fd. `2>&1` (stderr → stdout) and `1>&2` are the common cases.
      if (fd === 2 && target === '1') ctx.stderr = ctx.stdout;
      else if (fd === 1 && target === '2') ctx.stdout = ctx.stderr;
      // Other dup combinations are rare; skip for v0.
    }
  }
}

// Drain a context's pending redirect-flush callbacks. Called at the
// boundary of any scope that applied redirects (simple command, brace
// group, subshell). Failures during flush emit a stderr diagnostic but
// don't unwind further — the command's exit code is already decided.
async function _flushRedirects(ctx) {
  if (!ctx._redirectFlush || ctx._redirectFlush.length === 0) return;
  const queue = ctx._redirectFlush;
  ctx._redirectFlush = null;
  for (const flush of queue) {
    try { await flush(); }
    catch (e) {
      try { await ctx.stderr(`geas: redirect: ${e.message || e}\n`); } catch { /* ignore */ }
    }
  }
}

function _requireVfs(ctx, what) {
  if (!ctx.vfs) throw new Error(`geas: ${what} requires a VFS in context`);
}

function _resolvePath(p, ctx) {
  if (p.startsWith('/')) return p;
  // Simple POSIX join: cwd + '/' + path. Doesn't normalise '../' etc.
  // The VFS itself can handle that on its end.
  return ctx.cwd.endsWith('/') ? ctx.cwd + p : ctx.cwd + '/' + p;
}

// ── word expansion ──
//
// Two surfaces:
//   _expandWord(word, ctx) → string
//     Concatenates parts, NO field splitting or globbing. Used for
//     redirect targets, case patterns, heredoc delimiters — anywhere
//     POSIX says expansion produces a single field.
//
//   _expandWordToFields(word, ctx) → string[]
//     Full POSIX expansion: substitution → field splitting on $IFS →
//     pathname expansion (glob). Used for argv positions (command name
//     + args) and `for ... in` lists, where one word can yield 0-N fields.

async function _expandWord(word, ctx) {
  if (!word || !word.parts) return word?.value ?? '';
  let out = '';
  for (const part of word.parts) {
    out += await _expandPart(part, ctx);
  }
  return out;
}

// Field-aware expansion. Walks parts producing "fragments" — pairs of
// (text, splittable?) — then runs IFS-based field splitting only at
// splittable boundaries. Literal/quoted text never splits, even if it
// contains spaces. Finally glob-expands each resulting field against
// ctx.vfs when the field contains pattern metacharacters.
async function _expandWordToFields(word, ctx) {
  if (!word || !word.parts) {
    return word?.value !== undefined ? [word.value] : [];
  }
  const frags = [];
  for (const part of word.parts) await _expandPartToFrags(part, ctx, frags, /*inQuote*/ false);
  // Pair each field with a "had any quoted contribution" flag so we know
  // whether to attempt glob expansion. POSIX: glob chars introduced via
  // quoted text are LITERAL (`"/a/*.txt"` doesn't expand). v0 simplifies
  // to per-field rather than per-character — if any contributing fragment
  // was quoted, skip globbing for that whole field. The common cases
  // (`*.txt` unquoted, `"/dir/*.txt"` quoted) work; the mixed case
  // (`"/dir"/*.txt`) errs on the safe side of not-globbing.
  const fieldsWithMeta = _splitFieldsWithMeta(frags, _getIFS(ctx));
  if (!ctx.vfs) return fieldsWithMeta.map(f => f.text);
  const out = [];
  for (const f of fieldsWithMeta) {
    if (f.anyQuoted || !_hasGlobChars(f.text)) { out.push(f.text); continue; }
    const matches = await _globExpand(f.text, ctx);
    if (matches.length === 0) out.push(f.text);
    else for (const m of matches) out.push(m);
  }
  return out;
}

// Fragment shape: { t: text, s: splittable, q: quoted-source }
// - s (splittable): true iff IFS-splitting should happen across this frag's chars
// - q (quoted-source): true iff this frag contributed by a quoted (dq/sq/escape)
//                     source; used downstream to suppress globbing on the
//                     resulting field.
async function _expandPartToFrags(part, ctx, frags, inQuote) {
  switch (part.kind) {
    case 'lit':    frags.push({ t: part.value, s: false, q: inQuote });            return;
    case 'sq':     frags.push({ t: part.value, s: false, q: true });               return;
    case 'escape': frags.push({ t: part.value, s: false, q: true });               return;
    case 'dq': {
      // Everything inside dq is quoted + non-splittable. Empty `""` still
      // contributes a sentinel frag so `cat ""` keeps its empty argv slot.
      // Exception: a dq containing only `"$@"` with no positional args
      // legitimately produces ZERO fields (POSIX), so we don't emit the
      // sentinel when the inside had content but resolved to no frags.
      const before = frags.length;
      for (const p of part.parts) await _expandPartToFrags(p, ctx, frags, /*inQuote*/ true);
      if (part.parts.length === 0 && frags.length === before) {
        frags.push({ t: '', s: false, q: true });
      }
      return;
    }
    case 'var': {
      // `$@` and `$*` are special: each positional becomes its own field.
      // POSIX:
      //   $@ unquoted   → each positional, then IFS-split each (rare)
      //   "$@"          → each positional, NO splitting (the common case)
      //   $* unquoted   → IFS-joined into one field, then IFS-split
      //   "$*"          → IFS-joined into one field, NO splitting
      // We use a splittable space frag between each positional to force
      // field boundaries through the splitter regardless of quoting.
      if (part.name === '@') {
        const pos = ctx.positional || [];
        for (let k = 0; k < pos.length; k++) {
          if (k > 0) frags.push({ t: ' ', s: true, q: false }); // boundary
          frags.push({ t: pos[k], s: false, q: inQuote });
        }
        return;
      }
      frags.push({ t: _lookupVar(part.name, ctx), s: !inQuote, q: inQuote });
      return;
    }
    case 'param':  frags.push({ t: await _expandParam(part, ctx),     s: !inQuote, q: inQuote }); return;
    case 'cmd':    frags.push({ t: await _runCmdSub(part.body, ctx),  s: !inQuote, q: inQuote }); return;
    case 'arith':  frags.push({ t: _evalArith(part.body, ctx),        s: !inQuote, q: inQuote }); return;
  }
}

// Field-split fragments on IFS. Whitespace IFS chars (' ', '\t', '\n')
// are POSIX "whitespace IFS" — runs of them treat as one separator and
// leading/trailing runs are stripped. Non-whitespace IFS chars each
// separate one field (allowing empty fields). For v0 we honour both.
// Variant that returns [{text, anyQuoted}] so the caller knows whether to
// glob-expand each field. Per-field, anyQuoted is the OR of contributing
// fragments' q flag — once a quoted source has touched the field, glob
// chars in that field are treated as literal.
function _splitFieldsWithMeta(frags, ifs) {
  if (frags.length === 0) return [];
  // Build a marker-tagged string: '' marks where a splittable run
  // began, '' where it ended. Then walk, splitting only between
  // markers' contents on IFS chars.
  //
  // Simpler approach: produce fields by streaming. Maintain `cur` string
  // accumulator + emit when a splittable fragment yields an IFS char that
  // closes the current field.
  const wsIFS = new Set();
  const otherIFS = new Set();
  for (const c of ifs) {
    if (c === ' ' || c === '\t' || c === '\n') wsIFS.add(c);
    else otherIFS.add(c);
  }
  const out = [];
  let cur = '';
  let curAnyQuoted = false;
  let curHasContent = false;
  let seenSplittable = false;
  let pendingWsBoundary = false;
  const emit = () => {
    out.push({ text: cur, anyQuoted: curAnyQuoted });
    cur = ''; curAnyQuoted = false; curHasContent = false;
  };
  for (const frag of frags) {
    if (!frag.s) {
      if (pendingWsBoundary && curHasContent) emit();
      pendingWsBoundary = false;
      cur += frag.t;
      if (frag.t.length > 0) curHasContent = true;
      if (frag.q) curAnyQuoted = true;
      continue;
    }
    seenSplittable = true;
    for (const ch of frag.t) {
      if (wsIFS.has(ch)) {
        if (curHasContent) pendingWsBoundary = true;
        continue;
      }
      if (otherIFS.has(ch)) {
        if (curHasContent || !pendingWsBoundary) emit();
        else { cur = ''; curAnyQuoted = false; curHasContent = false; }
        pendingWsBoundary = false;
        continue;
      }
      if (pendingWsBoundary && curHasContent) emit();
      pendingWsBoundary = false;
      cur += ch;
      curHasContent = true;
      // splittable frag → unquoted-sourced; do NOT set curAnyQuoted
    }
  }
  if (curHasContent) emit();
  // Edge case (same as before): a Word with only non-splittable empty
  // frags (e.g. `""`) must still produce one empty field.
  if (out.length === 0 && !seenSplittable) {
    return [{ text: cur, anyQuoted: curAnyQuoted }];
  }
  return out;
}

function _getIFS(ctx) {
  return ctx.env.get('IFS') ?? ' \t\n';
}

// ── pathname expansion (glob) ──

function _hasGlobChars(s) {
  return /[*?\[]/.test(s);
}

async function _globExpand(pattern, ctx) {
  // VFS.glob handles absolute patterns natively. For relative, resolve
  // against ctx.cwd first, then strip the cwd prefix back off the results
  // so the returned fields stay relative — matching shell convention.
  const isRel = !pattern.startsWith('/');
  const fullPattern = isRel
    ? (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + pattern
    : pattern;
  let matches = [];
  try {
    matches = await ctx.vfs.glob(fullPattern);
  } catch {
    return [];
  }
  if (isRel) {
    const prefix = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    matches = matches.map(p => p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return matches.sort();
}

async function _expandPart(part, ctx) {
  switch (part.kind) {
    case 'lit':    return part.value;
    case 'sq':     return part.value;
    case 'escape': return part.value;
    case 'dq': {
      let out = '';
      for (const p of part.parts) out += await _expandPart(p, ctx);
      return out;
    }
    case 'var':   return _lookupVar(part.name, ctx);
    case 'param': return await _expandParam(part, ctx);
    case 'cmd':   return await _runCmdSub(part.body, ctx);
    case 'arith': return _evalArith(part.body, ctx);
    default: return '';
  }
}

function _lookupVar(name, ctx) {
  // Special parameters.
  if (name === '?') return String(ctx.lastStatus);
  if (name === '#') return String((ctx.positional || []).length);
  if (name === '@') return (ctx.positional || []).join(' ');
  if (name === '*') return (ctx.positional || []).join(' ');
  if (name === '$') return String(typeof process !== 'undefined' ? process.pid : 0);
  if (/^\d+$/.test(name)) {
    const idx = Number(name);
    if (idx === 0) return ctx.env.get('0') ?? 'geas';
    return (ctx.positional || [])[idx - 1] ?? '';
  }
  if (ctx.env.has(name)) return ctx.env.get(name);
  // POSIX nounset (`set -u`): unbound named variable is a fatal error.
  // Throws an _exit signal so _execProgram halts the script. Special
  // params, positional, and the parameter-expansion forms `${X:-d}` /
  // `${X-d}` / `${X:+v}` / `${X+v}` route around _lookupVar (they go
  // through _expandParam directly), which preserves POSIX semantics.
  if (ctx.options && ctx.options.nounset) {
    throw { exitCode: 1, _exit: true, _unbound: name };
  }
  return '';
}

async function _expandParam(part, ctx) {
  const set = ctx.env.has(part.name);
  const val = set ? ctx.env.get(part.name) : '';
  const isNull = !val;
  switch (part.op) {
    case ':-': return (!set || isNull) ? await _expandWord(part.word, ctx) : val;
    case '-':  return (!set)           ? await _expandWord(part.word, ctx) : val;
    case ':=': {
      if (!set || isNull) {
        const def = await _expandWord(part.word, ctx);
        ctx.env.set(part.name, def);
        return def;
      }
      return val;
    }
    case '=': {
      if (!set) {
        const def = await _expandWord(part.word, ctx);
        ctx.env.set(part.name, def);
        return def;
      }
      return val;
    }
    case ':?': {
      if (!set || isNull) {
        const msg = part.word ? await _expandWord(part.word, ctx) : `${part.name}: parameter null or not set`;
        await ctx.stderr(msg + '\n');
        throw { exitCode: 1 };
      }
      return val;
    }
    case '?': {
      if (!set) {
        const msg = part.word ? await _expandWord(part.word, ctx) : `${part.name}: parameter not set`;
        await ctx.stderr(msg + '\n');
        throw { exitCode: 1 };
      }
      return val;
    }
    case ':+': return (set && !isNull) ? await _expandWord(part.word, ctx) : '';
    case '+':  return (set)             ? await _expandWord(part.word, ctx) : '';
    // `#` is overloaded: `${#name}` (parser emits word=null) is length;
    // `${name#pat}` and friends are prefix/suffix removal using
    // _patternRemove's scan-based glob matcher.
    case '#':
    case '##':
    case '%':
    case '%%': {
      if (part.op === '#' && part.word == null) return String(val.length);
      const pat = part.word ? await _expandWord(part.word, ctx) : '';
      return _patternRemove(val, pat, part.op);
    }
    default: return val;
  }
}

function _patternRemove(s, pat, op) {
  // POSIX glob → regex via _globToRegExp. Match is scan-based rather
  // than relying on regex backtracking: appending `?` to make a regex
  // "lazy" only works for trailing quantifiers, and a bare `[abc]?`
  // means "optional class" not "shortest match." Direct scanning gives
  // unambiguous shortest/longest semantics for arbitrary glob shapes.
  const re = _globToRegExp(pat);
  const anchored = new RegExp('^' + re.source + '$');
  if (op === '#') {
    // Prefix shortest: empty prefix outward.
    for (let i = 0; i <= s.length; i++) {
      if (anchored.test(s.slice(0, i))) return s.slice(i);
    }
    return s;
  }
  if (op === '##') {
    // Prefix longest: full-string inward.
    for (let i = s.length; i >= 0; i--) {
      if (anchored.test(s.slice(0, i))) return s.slice(i);
    }
    return s;
  }
  if (op === '%') {
    // Suffix shortest: empty suffix outward.
    for (let i = s.length; i >= 0; i--) {
      if (anchored.test(s.slice(i))) return s.slice(0, i);
    }
    return s;
  }
  if (op === '%%') {
    // Suffix longest: full-string inward.
    for (let i = 0; i <= s.length; i++) {
      if (anchored.test(s.slice(i))) return s.slice(0, i);
    }
    return s;
  }
  return s;
}

async function _runCmdSub(body, ctx) {
  // Parse + execute the body in a sub-context with a buffered stdout.
  // Lazy import to avoid a circular dep (parser already imports nothing
  // from executor, but we keep the surface minimal).
  const { parse } = await import('./parser.js');
  const ast = parse(body);
  const chunks = [];
  const subCtx = { ...ctx, stdout: (t) => { chunks.push(String(t)); } };
  await _exec(ast, subCtx);
  // POSIX: trailing newlines are stripped from $(...) result.
  return chunks.join('').replace(/\n+$/, '');
}

// ── arithmetic expansion ──
//
// Real recursive-descent parser over POSIX arith. Replaces the previous
// `eval()`-after-substitution hack — the eval was gated by a strict
// charset regex, but that regex blocked legitimate POSIX syntax like
// `$((x = 5))` or `$((x ? a : b))`, and the eval itself was a code
// smell even when gated.
//
// Precedence ladder (low → high): assignment, ternary, logical-or,
// logical-and, bitwise-or, bitwise-xor, bitwise-and, equality,
// comparison, shift, additive, multiplicative, unary, primary.
//
// All arithmetic is 32-bit integer (POSIX). Division truncates toward
// zero. Division/modulo by zero → 0 (silent; POSIX-undefined). Variables
// can be referenced bare (`x`) or with `$` (`$x`); both look up in
// ctx.env. Unbound names treat as 0.
function _evalArith(body, ctx) {
  let tokens;
  try {
    tokens = _arithTokenize(body);
  } catch {
    return '0';
  }
  const state = { tokens, i: 0 };
  let val;
  try {
    val = _arithAssign(state, ctx);
    if (state.i !== tokens.length) return '0';
  } catch {
    return '0';
  }
  return String(val | 0);
}

const _ARITH_OPS = [
  // Longest-first so '<<=' beats '<<' beats '<'.
  '<<=', '>>=',
  '&&', '||', '<<', '>>', '<=', '>=', '==', '!=',
  '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=',
  '+', '-', '*', '/', '%', '!', '~', '&', '|', '^',
  '<', '>', '=', '(', ')', '?', ':', ',',
];

function _arithTokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i, val;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 16);
      } else if (ch === '0' && /[0-7]/.test(src[i + 1] || '')) {
        j = i;
        while (j < src.length && /[0-7]/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 8);
      } else {
        while (j < src.length && /\d/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 10);
      }
      tokens.push({ type: 'num', val: Number.isFinite(val) ? val : 0 });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'var', val: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '$') {
      // POSIX: `$var` inside arith is just `var` — the $ is optional.
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      if (j === i + 1) throw new Error('arith: lone $');
      tokens.push({ type: 'var', val: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    let matched = null;
    for (const op of _ARITH_OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      tokens.push({ type: 'op', val: matched });
      i += matched.length;
      continue;
    }
    throw new Error(`arith: unexpected char "${ch}"`);
  }
  return tokens;
}

function _arithLookup(name, ctx) {
  if (!ctx.env.has(name)) return 0;
  const v = ctx.env.get(name);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? (n | 0) : 0;
}

const _ARITH_ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=',
]);

// Assignment is right-associative. We peek for `var <assign-op>` and
// take the assignment branch only when both fit; otherwise fall through
// to the ternary level.
function _arithAssign(state, ctx) {
  const t = state.tokens[state.i];
  const next = state.tokens[state.i + 1];
  if (t && t.type === 'var' && next && next.type === 'op' && _ARITH_ASSIGN_OPS.has(next.val)) {
    const name = t.val;
    const op = next.val;
    state.i += 2;
    const rhs = _arithAssign(state, ctx);
    let val;
    if (op === '=') {
      val = rhs;
    } else {
      const cur = _arithLookup(name, ctx);
      switch (op) {
        case '+=':  val = (cur + rhs) | 0; break;
        case '-=':  val = (cur - rhs) | 0; break;
        case '*=':  val = (cur * rhs) | 0; break;
        case '/=':  val = rhs === 0 ? 0 : (Math.trunc(cur / rhs) | 0); break;
        case '%=':  val = rhs === 0 ? 0 : (cur % rhs) | 0; break;
        case '|=':  val = (cur | rhs) | 0; break;
        case '&=':  val = (cur & rhs) | 0; break;
        case '^=':  val = (cur ^ rhs) | 0; break;
        case '<<=': val = (cur << rhs) | 0; break;
        case '>>=': val = (cur >> rhs) | 0; break;
      }
    }
    val = val | 0;
    ctx.env.set(name, String(val));
    return val;
  }
  return _arithTernary(state, ctx);
}

function _arithTernary(state, ctx) {
  const cond = _arithLogicalOr(state, ctx);
  const t = state.tokens[state.i];
  if (t && t.val === '?') {
    state.i++;
    const ifTrue = _arithAssign(state, ctx);
    const colon = state.tokens[state.i];
    if (!colon || colon.val !== ':') throw new Error("arith: expected ':'");
    state.i++;
    const ifFalse = _arithAssign(state, ctx);
    return cond !== 0 ? ifTrue : ifFalse;
  }
  return cond;
}

function _arithLogicalOr(state, ctx) {
  let left = _arithLogicalAnd(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '||') {
    state.i++;
    const right = _arithLogicalAnd(state, ctx);
    left = (left !== 0 || right !== 0) ? 1 : 0;
  }
  return left;
}

function _arithLogicalAnd(state, ctx) {
  let left = _arithBitOr(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '&&') {
    state.i++;
    const right = _arithBitOr(state, ctx);
    left = (left !== 0 && right !== 0) ? 1 : 0;
  }
  return left;
}

function _arithBitOr(state, ctx) {
  let left = _arithBitXor(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '|') {
    state.i++;
    left = (left | _arithBitXor(state, ctx)) | 0;
  }
  return left;
}

function _arithBitXor(state, ctx) {
  let left = _arithBitAnd(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '^') {
    state.i++;
    left = (left ^ _arithBitAnd(state, ctx)) | 0;
  }
  return left;
}

function _arithBitAnd(state, ctx) {
  let left = _arithEq(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '&') {
    state.i++;
    left = (left & _arithEq(state, ctx)) | 0;
  }
  return left;
}

function _arithEq(state, ctx) {
  let left = _arithCmp(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '==' || state.tokens[state.i].val === '!=')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithCmp(state, ctx);
    left = (op === '==' ? left === right : left !== right) ? 1 : 0;
  }
  return left;
}

function _arithCmp(state, ctx) {
  let left = _arithShift(state, ctx);
  while (state.tokens[state.i] && ['<', '<=', '>', '>='].includes(state.tokens[state.i].val)) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithShift(state, ctx);
    let r;
    switch (op) {
      case '<':  r = left <  right; break;
      case '<=': r = left <= right; break;
      case '>':  r = left >  right; break;
      case '>=': r = left >= right; break;
    }
    left = r ? 1 : 0;
  }
  return left;
}

function _arithShift(state, ctx) {
  let left = _arithAdd(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '<<' || state.tokens[state.i].val === '>>')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithAdd(state, ctx);
    left = (op === '<<' ? left << right : left >> right) | 0;
  }
  return left;
}

function _arithAdd(state, ctx) {
  let left = _arithMul(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '+' || state.tokens[state.i].val === '-')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithMul(state, ctx);
    left = (op === '+' ? left + right : left - right) | 0;
  }
  return left;
}

function _arithMul(state, ctx) {
  let left = _arithUnary(state, ctx);
  while (state.tokens[state.i] && ['*', '/', '%'].includes(state.tokens[state.i].val)) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithUnary(state, ctx);
    if ((op === '/' || op === '%') && right === 0) return 0;
    let r;
    switch (op) {
      case '*': r = left * right; break;
      case '/': r = Math.trunc(left / right); break;
      case '%': r = left % right; break;
    }
    left = r | 0;
  }
  return left;
}

function _arithUnary(state, ctx) {
  const t = state.tokens[state.i];
  if (t && t.type === 'op') {
    if (t.val === '-') { state.i++; return (-_arithUnary(state, ctx)) | 0; }
    if (t.val === '+') { state.i++; return _arithUnary(state, ctx); }
    if (t.val === '!') { state.i++; return _arithUnary(state, ctx) === 0 ? 1 : 0; }
    if (t.val === '~') { state.i++; return (~_arithUnary(state, ctx)) | 0; }
  }
  return _arithPrimary(state, ctx);
}

function _arithPrimary(state, ctx) {
  const t = state.tokens[state.i];
  if (!t) throw new Error('arith: unexpected end');
  if (t.type === 'num') { state.i++; return t.val | 0; }
  if (t.type === 'var') { state.i++; return _arithLookup(t.val, ctx); }
  if (t.type === 'op' && t.val === '(') {
    state.i++;
    const r = _arithAssign(state, ctx);
    const close = state.tokens[state.i];
    if (!close || close.val !== ')') throw new Error("arith: expected ')'");
    state.i++;
    return r;
  }
  throw new Error(`arith: unexpected token "${t.val}"`);
}

// Expand $vars and $(cmd) inside a raw string (for here-doc bodies that
// weren't quoted). Reuses parseWordParts to get structure.
async function _expandTextString(text, ctx) {
  const { parseWordParts } = await import('./word-parts.js');
  const parts = parseWordParts(text);
  let out = '';
  for (const p of parts) out += await _expandPart(p, ctx);
  return out;
}

// ── glob matching (for case patterns) ──

function _globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; }
      else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close;
      }
    }
    else if ('.+^$()|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re);
}

function _globMatch(pattern, value) {
  const re = new RegExp('^(' + _globToRegExp(pattern).source + ')$');
  return re.test(value);
}

// -- builtins-typed.js --

// Typed-pipe-aware built-ins. These produce or consume Typed table values
// instead of (or in addition to) text. The shell auto-registers them via
// defaultBuiltins(); third-party builtins from the GCU stack (e.g. a
// future sadpan-backed `read-csv`) can override.
//
// Demo surface for v0:
//
//   from-csv FILE | where 'COL > N' | select COL1 COL2 | to-csv
//
// `from-csv` produces a Typed table; `where` and `select` consume and
// produce Typed tables (passing through unchanged when their input is text
// — they parse the text as CSV on the fly); `to-csv` serialises back to
// text. Mix-and-match with text builtins works because Typed.toString()
// returns the canonical CSV text, so e.g. `from-csv f.csv | head -n 5`
// degrades gracefully (head reads the CSV text and slices the first 5
// lines, ignoring that columns are involved).


function defaultTypedBuiltins() {
  return {
    'from-csv':  _fromCsv,
    'to-csv':    _toCsv,
    'from-json': _fromJson,
    'to-json':   _toJson,
    where:       _where,
    select:      _select,
    'first':     _first,
    'last':      _last,
    display:     _display,
    plot:        _plot,
  };
}

// Read a CSV from file (or stdin) and emit a Typed table downstream.
async function _fromCsv(argv, ctx) {
  const path = argv[1];
  let text;
  try {
    if (path) {
      if (!ctx.vfs) {
        await ctx.stderr('from-csv: no VFS configured\n');
        return 1;
      }
      const abs = path.startsWith('/') ? path
        : (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + path;
      text = await ctx.vfs.readFile(abs, 'text');
    } else {
      // No path → drain stdin (handles string, typed, async-iterable queue).
      const v = await drainInput(ctx);
      text = typeof v === 'string' ? v : String(v);
    }
  } catch (e) {
    await ctx.stderr(`from-csv: ${e.message}\n`);
    return 1;
  }
  const table = parseCSV(text);
  await ctx.stdout(mkTyped('table', table, () => serializeCSV(table)));
  return 0;
}

// Convert Typed table → CSV text. Idempotent on text input.
async function _toCsv(_argv, ctx) {
  const v = await drainInput(ctx);
  if (isTyped(v) && v.kind === 'table') {
    await ctx.stdout(serializeCSV(v.value));
    return 0;
  }
  // Already text — pass through.
  await ctx.stdout(typeof v === 'string' ? v : String(v ?? ''));
  return 0;
}

// where 'COL OP VALUE' — filter table rows. Operators: == != > < >= <=
// VALUE may be a number (compared numerically) or a quoted-or-bare string.
// On text input, parses as CSV first; on Typed input, operates directly.
async function _where(argv, ctx) {
  const expr = argv[1];
  if (!expr) {
    await ctx.stderr('where: missing expression\n');
    return 2;
  }
  const pred = _compilePredicate(expr);
  if (!pred) {
    await ctx.stderr(`where: cannot parse expression "${expr}"\n`);
    return 2;
  }
  const table = await _consumeTable(ctx);
  const colIdx = table.columns.indexOf(pred.col);
  if (colIdx < 0) {
    await ctx.stderr(`where: no column "${pred.col}"\n`);
    return 2;
  }
  const filtered = {
    columns: table.columns,
    rows: table.rows.filter(r => pred.test(r[colIdx])),
  };
  await ctx.stdout(mkTyped('table', filtered, () => serializeCSV(filtered)));
  return 0;
}

// select COL1 COL2 ... — project columns by name. Unknown columns warned
// on stderr; the result drops them but doesn't fail.
async function _select(argv, ctx) {
  const names = argv.slice(1);
  if (names.length === 0) {
    await ctx.stderr('select: missing column names\n');
    return 2;
  }
  const table = await _consumeTable(ctx);
  const indices = names.map(n => {
    const i = table.columns.indexOf(n);
    if (i < 0) ctx.stderr(`select: warning: no column "${n}"\n`);
    return i;
  }).filter(i => i >= 0);
  const projected = {
    columns: indices.map(i => table.columns[i]),
    rows: table.rows.map(r => indices.map(i => r[i])),
  };
  await ctx.stdout(mkTyped('table', projected, () => serializeCSV(projected)));
  return 0;
}

// first [N] / last [N] — slice first/last N rows. Defaults to 5.
async function _first(argv, ctx) {
  const n = argv[1] ? Math.max(0, parseInt(argv[1], 10)) : 5;
  const table = await _consumeTable(ctx);
  const sliced = { columns: table.columns, rows: table.rows.slice(0, n) };
  await ctx.stdout(mkTyped('table', sliced, () => serializeCSV(sliced)));
  return 0;
}
async function _last(argv, ctx) {
  const n = argv[1] ? Math.max(0, parseInt(argv[1], 10)) : 5;
  const table = await _consumeTable(ctx);
  const sliced = { columns: table.columns, rows: table.rows.slice(-n) };
  await ctx.stdout(mkTyped('table', sliced, () => serializeCSV(sliced)));
  return 0;
}

// Common: pull a table out of ctx.stdin, parsing text if needed. Drains
// a streaming-pipe queue down to a single value first (typed if any was
// seen, else concatenated text).
async function _consumeTable(ctx) {
  const v = await drainInput(ctx);
  if (isTyped(v) && v.kind === 'table') return v.value;
  if (isTyped(v) && v.kind === 'array'
      && Array.isArray(v.value)
      && v.value.length > 0
      && typeof v.value[0] === 'object'
      && !Array.isArray(v.value[0])) {
    return _objectArrayToTable(v.value);
  }
  const text = isTyped(v) ? String(v) : (typeof v === 'string' ? v : String(v));
  return parseCSV(text);
}

// ── from-json / to-json ──
//
// from-json [FILE]: read JSON from FILE or stdin, emit a Typed value
// shaped to the JSON's structure:
//   - array of flat objects → kind='table' (where/select usable)
//   - array of primitives or mixed → kind='array'
//   - object → kind='object'
//   - scalar → text (no typing needed)
//
// to-json: consume any Typed value (or JSON text) and serialize to JSON
// text. `--pretty` (or `-p`) for indented output. Tables serialize as
// arrays of objects keyed by column name (the canonical JSON shape).
async function _fromJson(argv, ctx) {
  const path = argv[1];
  let text;
  try {
    if (path) {
      if (!ctx.vfs) {
        await ctx.stderr('from-json: no VFS configured\n');
        return 1;
      }
      const abs = path.startsWith('/') ? path
        : (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + path;
      text = await ctx.vfs.readFile(abs, 'text');
    } else {
      const v = await drainInput(ctx);
      text = typeof v === 'string' ? v : String(v);
    }
  } catch (e) {
    await ctx.stderr(`from-json: ${e.message}\n`);
    return 1;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    await ctx.stderr(`from-json: parse error: ${e.message}\n`);
    return 1;
  }
  // Shape-routing: array of homogeneous flat objects becomes a table.
  if (Array.isArray(parsed) && parsed.length > 0
      && parsed.every(r => r != null && typeof r === 'object' && !Array.isArray(r))) {
    const table = _objectArrayToTable(parsed);
    await ctx.stdout(mkTyped('table', table, () => JSON.stringify(parsed)));
    return 0;
  }
  if (Array.isArray(parsed)) {
    await ctx.stdout(mkTyped('array', parsed, () => JSON.stringify(parsed)));
    return 0;
  }
  if (parsed !== null && typeof parsed === 'object') {
    await ctx.stdout(mkTyped('object', parsed, () => JSON.stringify(parsed)));
    return 0;
  }
  // Scalars: just emit as text.
  await ctx.stdout(JSON.stringify(parsed) + '\n');
  return 0;
}

async function _toJson(argv, ctx) {
  const pretty = argv.slice(1).some(a => a === '--pretty' || a === '-p');
  const indent = pretty ? 2 : 0;
  const v = await drainInput(ctx);
  let obj;
  if (isTyped(v)) {
    if (v.kind === 'table') obj = _tableToObjectArray(v.value);
    else obj = v.value;
  } else if (typeof v === 'string') {
    try { obj = JSON.parse(v); }
    catch { obj = v; }
  } else if (v == null) {
    obj = null;
  } else {
    obj = v;
  }
  await ctx.stdout(JSON.stringify(obj, null, indent) + '\n');
  return 0;
}

// Convert an array of flat objects into a {columns, rows} table.
// Column order = first-seen order across all rows.
function _objectArrayToTable(arr) {
  const colSet = new Set();
  for (const r of arr) for (const k of Object.keys(r)) colSet.add(k);
  const columns = [...colSet];
  const rows = arr.map(r => columns.map(c => r[c] ?? ''));
  return { columns, rows };
}

function _tableToObjectArray(table) {
  const cols = table.columns || [];
  return (table.rows || []).map(row => {
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    return obj;
  });
}

// ── display / plot ──
//
// display: render whatever's in the pipe as text. Tables get
// fixed-width column layout; arrays/objects get JSON; everything
// else passes through as text. Useful for forcing a human-readable
// rendering mid-pipeline or before saving.
//
// plot [--kind line|scatter|bar|hist] [--x COL] [--y COL]: emit a
// Typed 'plot' descriptor that an adapter capable of rich-block
// rendering can show as a chart. Fallback text rendering is an ASCII
// sparkline + summary (min/max/n), so degradation to terminal is
// graceful.
async function _display(_argv, ctx) {
  const v = await drainInput(ctx);
  if (v == null || v === '') return 0;
  if (isTyped(v)) {
    if (v.kind === 'table') {
      await ctx.stdout(formatTable(v.value));
      return 0;
    }
    if (v.kind === 'array' || v.kind === 'object') {
      await ctx.stdout(JSON.stringify(v.value, null, 2) + '\n');
      return 0;
    }
    // Unknown typed kind: fall back to its text rendering.
    await ctx.stdout(String(v));
    return 0;
  }
  await ctx.stdout(typeof v === 'string' ? v : String(v));
  return 0;
}

async function _plot(argv, ctx) {
  const opts = { kind: 'line', x: null, y: null };
  const cols = [];
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--x' && i + 1 < argv.length) { opts.x = argv[++i]; i++; continue; }
    if (a === '--y' && i + 1 < argv.length) { opts.y = argv[++i]; i++; continue; }
    if (a === '--kind' && i + 1 < argv.length) { opts.kind = argv[++i]; i++; continue; }
    if (a.startsWith('--')) { i++; continue; }
    cols.push(a);
    i++;
  }
  const table = await _consumeTable(ctx);
  // Resolve x/y. Default behaviour:
  //   1-positional COL → y=COL, x=row index
  //   2-positional X Y → x=X, y=Y
  //   --y / --x override
  let xCol = opts.x;
  let yCol = opts.y ?? cols[cols.length - 1] ?? table.columns[0];
  if (!opts.x && cols.length >= 2) xCol = cols[0];
  const yIdx = table.columns.indexOf(yCol);
  if (yIdx < 0) {
    await ctx.stderr(`plot: no column "${yCol}"\n`);
    return 2;
  }
  const xIdx = xCol ? table.columns.indexOf(xCol) : -1;
  if (xCol && xIdx < 0) {
    await ctx.stderr(`plot: no column "${xCol}"\n`);
    return 2;
  }
  const ys = table.rows.map(r => Number(r[yIdx])).filter(n => Number.isFinite(n));
  const xs = xIdx >= 0
    ? table.rows.map(r => Number(r[xIdx]))
    : ys.map((_, k) => k);
  const spec = { kind: opts.kind, xCol: xCol ?? '_index', yCol, xs, ys };
  await ctx.stdout(mkTyped('plot', spec, () => _plotAscii(spec)));
  return 0;
}

function _plotAscii(spec) {
  if (spec.ys.length === 0) return '(no data)\n';
  if (spec.kind === 'hist') return _histAscii(spec);
  const min = Math.min(...spec.ys);
  const max = Math.max(...spec.ys);
  const range = max - min || 1;
  const blocks = '▁▂▃▄▅▆▇█';
  let bar = '';
  for (const v of spec.ys) {
    const t = (v - min) / range;
    const k = Math.min(blocks.length - 1, Math.max(0, Math.floor(t * blocks.length)));
    bar += blocks[k];
  }
  const head = `${spec.kind} ${spec.yCol}`;
  const footer = `min=${_fmtNum(min)} max=${_fmtNum(max)} n=${spec.ys.length}`;
  return `${head}\n${bar}\n${footer}\n`;
}

function _histAscii(spec) {
  const n = spec.ys.length;
  if (n === 0) return '(no data)\n';
  const min = Math.min(...spec.ys);
  const max = Math.max(...spec.ys);
  const bins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(n))));
  const w = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of spec.ys) {
    let k = Math.floor((v - min) / w);
    if (k >= bins) k = bins - 1;
    if (k < 0) k = 0;
    counts[k]++;
  }
  const peak = Math.max(...counts);
  const blocks = '▁▂▃▄▅▆▇█';
  let bar = '';
  for (const c of counts) {
    const t = peak ? c / peak : 0;
    const i = Math.min(blocks.length - 1, Math.max(0, Math.floor(t * blocks.length)));
    bar += blocks[i];
  }
  return `hist ${spec.yCol}\n${bar}\nmin=${_fmtNum(min)} max=${_fmtNum(max)} bins=${bins} n=${n}\n`;
}

function _fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

// ── predicate parser for `where` ──
//
// Grammar (v0):
//   COL OP RHS
//   COL  := identifier or quoted string
//   OP   := == | != | >= | <= | > | <
//   RHS  := number | "quoted string" | 'quoted string' | bare identifier
//
// Returns { col, op, test: (cellValue) => bool } or null on parse failure.
function _compilePredicate(expr) {
  const m = expr.match(/^\s*([A-Za-z_][A-Za-z0-9_]*|"[^"]*"|'[^']*')\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!m) return null;
  let col = m[1];
  const op = m[2];
  let rhs = m[3];
  if ((col.startsWith('"') && col.endsWith('"')) ||
      (col.startsWith("'") && col.endsWith("'"))) col = col.slice(1, -1);
  // Unquote RHS if it's a quoted string; otherwise try numeric.
  let rhsVal;
  if ((rhs.startsWith('"') && rhs.endsWith('"')) ||
      (rhs.startsWith("'") && rhs.endsWith("'"))) {
    rhsVal = rhs.slice(1, -1);
  } else if (/^-?\d+(?:\.\d+)?$/.test(rhs)) {
    rhsVal = Number(rhs);
  } else {
    rhsVal = rhs;
  }
  const numericCompare = typeof rhsVal === 'number';
  const test = (cell) => {
    let a = cell;
    let b = rhsVal;
    if (numericCompare) {
      a = Number(cell);
      if (Number.isNaN(a)) return false;
    } else {
      a = String(cell ?? '');
      b = String(b);
    }
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a >  b;
      case '<':  return a <  b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
    return false;
  };
  return { col, op, test };
}

// -- pkg-cmd.js --

// pkg — the geas-side of the pkg-spec CLI. Lives alongside the other
// builtins so users can `pkg install npm:leaflet` from a geas terminal
// in Auditable Works or a `!pkg install ...` cell in a notebook.
//
// Spec: spec_inbox/auditable-pkg-spec.md.
//
// Subcommands (v1):
//   pkg install <alias>      — fetch, verify, write to /lib + lockfile;
//                              also fetches package.json + LICENSE from the
//                              registry CDN so aggregateLicenses picks it up
//   pkg install              — restore every entry from /lib/.gcu-lock.json
//   pkg list                 — list installed modules with SPDX badges
//   pkg licenses             — aggregate license table across the workspace
//                              (delegates to @gcu/licenses aggregateLicenses)
//   pkg freeze               — print the workspace lockfile
//   pkg remove <alias>       — drop the entry + its /lib directory
//   pkg help                 — usage
//
// v1 always installs to workspace /lib. The --project flag (per-notebook
// installs to /projects/self/lib/) is deferred — needs the cell-side
// install() builtin to coordinate, which is its own design step.

const LIB_ROOT = '/lib';
const LOCKFILE = LIB_ROOT + '/.gcu-lock.json';

// pkg-spec §3.3 alias prefixes → URLs. Duplicated from
// src/js/cell-builtins/modules.js (different package; coreutils
// extraction will deduplicate later).
function _aliasToUrl(key) {
  if (key.startsWith('npm:'))   return { url: 'https://esm.sh/' + key.slice(4) };
  if (key.startsWith('jsr:'))   return { url: 'https://esm.sh/jsr/' + key.slice(4) };
  if (key.startsWith('gh:'))    return { url: 'https://esm.sh/gh/' + key.slice(3) };
  if (key.startsWith('@gcu/'))  return { url: 'https://esm.sh/' + key + '/bundled',
                                         fallback: 'https://esm.sh/' + key };
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return { url: 'https://esm.sh/' + key };
  return null;
}

// pkg-spec §3.1 key → /lib path. Duplicated from src/js/persist.js.
//
// Path slug is FNV-1a 32-bit hex — pure JS, deterministic, low-collision
// for the volumes we care about. Crypto-grade SHA-256 isn't required
// here (paths aren't security-sensitive), and pkg runs inside a geas
// worker which may not have crypto.subtle when the worker's blob URL
// inherits a non-secure context (file:// parents are the usual cause).
function _shortSlug(s) {
  let hash = 2166136261;   // FNV offset basis (32-bit)
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function _keyToLibPath(key) {
  if (key.startsWith('npm:'))    return LIB_ROOT + '/npm/'    + key.slice('npm:'.length);
  if (key.startsWith('jsr:'))    return LIB_ROOT + '/jsr/'    + key.slice('jsr:'.length);
  if (key.startsWith('gh:'))     return LIB_ROOT + '/gh/'     + key.slice('gh:'.length);
  if (key.startsWith('local:'))  return LIB_ROOT + '/local/'  + _shortSlug(key);
  if (key.startsWith('http://') || key.startsWith('https://'))
                                 return LIB_ROOT + '/url/'    + _shortSlug(key);
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return LIB_ROOT + '/' + key;
  return LIB_ROOT + '/url/' + _shortSlug(key);
}

// SRI hash over the un-compressed bytes. pkg-spec §4.1. Optional — when
// the worker's context lacks crypto.subtle (blob:file:// origins),
// returns null and pkg records the install without an integrity field.
function _toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function _sha256SRI(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256-' + _toBase64(new Uint8Array(buf));
}

// esm.sh wrapper unwrap (bounded). Matches modules.js install path.
async function _fetchAndUnwrap(startUrl) {
  const wrapperRe = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?export\s+\*\s+from\s*["']([^"']+)["'];?\s*$/;
  let currentUrl = startUrl;
  for (let hop = 0; hop < 3; hop++) {
    const resp = await fetch(currentUrl);
    if (!resp.ok) {
      if (hop === 0) return { ok: false, status: resp.status };
      throw new Error(`Failed to fetch ${currentUrl}: ${resp.status}`);
    }
    const text = await resp.text();
    const m = text.trim().match(wrapperRe);
    if (m) { currentUrl = new URL(m[1], resp.url).href; continue; }
    return { ok: true, source: text, finalUrl: resp.url };
  }
  throw new Error('Too many esm.sh wrapper redirects');
}

async function _readLockfile(vfs) {
  try {
    const raw = await vfs.readFile(LOCKFILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj.modules || typeof obj.modules !== 'object') obj.modules = {};
    if (!obj.version) obj.version = 1;
    return obj;
  } catch { return { version: 1, modules: {} }; }
}

async function _writeLockfile(vfs, lockfile) {
  await vfs.writeFile(LOCKFILE, JSON.stringify(lockfile, null, 2));
}

// pkg install <file.gcupkg>  — sideload an extension package per
// EXTENSION_SPEC §6.1. Reads bytes from the VFS (path) or a URL (http(s):
// prefix), runs parseGcupkg + installGcupkg, prints a summary.
//
// The archive bundle is concat'd into the geas bundle (see ext/geas/build.js);
// gcupkg.js's parser takes it as a parameter. Both `archive` and
// `parseGcupkg` / `installGcupkg` are in scope by the time this runs.
async function _installGcupkgFile(ctx, source) {
  const vfs = ctx.vfs;
  if (typeof parseGcupkg !== 'function' || typeof installGcupkg !== 'function') {
    await ctx.stderr('pkg: gcupkg loader not bundled in this build\n');
    return 1;
  }
  if (typeof archive === 'undefined' || !archive) {
    await ctx.stderr('pkg: @gcu/archive not bundled (required for .gcupkg)\n');
    return 1;
  }

  // Source can be a VFS path or an http(s) URL. (Worker-relative imports
  // not supported — too risky on file:// origins.)
  let bytes;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    try {
      const resp = await fetch(source);
      if (!resp.ok) { await ctx.stderr(`pkg: fetch ${source} failed (${resp.status})\n`); return 1; }
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      await ctx.stderr(`pkg: fetch ${source}: ${e.message}\n`);
      return 1;
    }
  } else {
    // VFS read. Pass 'bytes' encoding so the backend doesn't UTF-8 decode
    // (silent corruption of binary, same trap as the archive read path).
    try {
      bytes = await vfs.readFile(source, 'bytes');
    } catch (e) {
      await ctx.stderr(`pkg: cannot read ${source}: ${e.message}\n`);
      return 1;
    }
    if (typeof bytes === 'string') {
      // Backend ignored the 'bytes' hint — convert defensively.
      bytes = new TextEncoder().encode(bytes);
    }
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  }

  let parsed;
  try {
    parsed = await parseGcupkg(bytes, { archive });
  } catch (e) {
    await ctx.stderr(`pkg: ${e.message}\n`);
    return 1;
  }

  let result;
  try {
    result = await installGcupkg(parsed, {
      vfs,
      installedModules: (typeof window !== 'undefined' && window._installedModules) || null,
    });
  } catch (e) {
    await ctx.stderr(`pkg: installGcupkg failed: ${e.message}\n`);
    return 1;
  }

  // Summary. Includes the suggested load() calls so the user knows how
  // to reach the extension from a cell after install.
  const name = parsed.meta.name;
  const version = parsed.meta.version;
  await ctx.stdout(`installed ${name}@${version} → ${result.libPath}\n`);
  if (parsed.meta.spdx) {
    const verdict = parsed.integrity.ok === false ? ' (integrity mismatch — see meta)' : '';
    await ctx.stdout(`  license: ${parsed.meta.spdx}${verdict}\n`);
  }
  if (result.exampleCount > 0) {
    await ctx.stdout(`  examples: ${result.exampleCount} → ${result.exampleRoot}\n`);
  }
  if (result.docsCount > 0) {
    await ctx.stdout(`  docs: ${result.docsCount} → ${result.docsRoot}\n`);
  }
  await ctx.stdout(`  load: load("${name}")${result.hasAdder ? `; load("${name}/adder")` : ''}\n`);
  return 0;
}

// pkg install <alias>  — one entry, end-to-end.
async function _installOne(ctx, alias) {
  const vfs = ctx.vfs;
  if (!vfs) { await ctx.stderr('pkg: no VFS in this context\n'); return 1; }

  // .gcupkg path — sideload an extension package. Bypasses the URL/alias
  // resolution since the bytes are already on the VFS or fetchable.
  if (alias.endsWith('.gcupkg') || alias.includes('.gcupkg?')) {
    return _installGcupkgFile(ctx, alias);
  }

  // Registry name (Works only) — a bare name (no alias-prefix, no path) may be
  // a content-registry entry. Delegate the full install to the shell via the
  // host bridge so a code extension's surfaces register live and the install
  // lands in the one ledger the Library reads. Falls through if not found.
  if (typeof ctx.host === 'function' && !alias.includes(':') && !alias.includes('/')) {
    let found;
    try { found = await _findRegistryEntry(ctx, alias); }
    catch { found = null; }
    if (found) {
      if (found.entry.kind === 'gcudat') {
        await ctx.stdout(`pkg: "${alias}" is a ${found.entry.datKind || 'data'} pack — install it from Tools → Library\n`);
        return 0;
      }
      await ctx.stdout(`installing ${alias}@${found.entry.version || '?'} from ${found.sourceName}…\n`);
      let dest;
      try { dest = await ctx.host('RegistryInstall', [found.source, alias]); }
      catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
      if (!dest) { await ctx.stderr('pkg: install cancelled\n'); return 1; }
      await ctx.stdout(`installed ${alias} → ${dest}\n  (reload Works if its surfaces don't appear)\n`);
      return 0;
    }
  }

  let url, fallback;
  if (alias.startsWith('local:')) {
    // local: — read the surface VFS, no fetch.
    const fsPath = alias.slice('local:'.length);
    let source;
    try { source = await vfs.readFile(fsPath, 'utf8'); }
    catch (e) { await ctx.stderr(`pkg: cannot read ${fsPath}: ${e.message}\n`); return 1; }
    const dir = _keyToLibPath(alias);
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.writeFile(dir + '/source', source);
    const meta = { alias, url: alias, kind: 'local',
      installedAt: new Date().toISOString(), size: source.length };
    await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));
    const lockfile = await _readLockfile(vfs);
    lockfile.modules[alias] = meta;
    await _writeLockfile(vfs, lockfile);
    await ctx.stdout(`installed ${alias} (${source.length} bytes, local)\n`);
    return 0;
  }

  if (alias.startsWith('http://') || alias.startsWith('https://')) {
    url = alias;
  } else {
    const r = _aliasToUrl(alias);
    if (!r) { await ctx.stderr(`pkg: don't know how to resolve "${alias}"\n`); return 1; }
    url = r.url; fallback = r.fallback;
  }

  let result;
  try { result = await _fetchAndUnwrap(url); }
  catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
  if (!result.ok && fallback) {
    try { result = await _fetchAndUnwrap(fallback); }
    catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
  }
  if (!result.ok) {
    await ctx.stderr(`pkg: fetch ${url} failed (${result.status})\n`);
    return 1;
  }

  const source = result.source;
  const finalUrl = result.finalUrl;
  const sourceBytes = new TextEncoder().encode(source);
  const integrity = await _sha256SRI(sourceBytes);

  const dir = _keyToLibPath(alias);
  await vfs.mkdir(dir, { recursive: true }).catch(() => {});
  await vfs.writeFile(dir + '/source', source);
  const meta = { alias, url: finalUrl, kind: 'js',
    installedAt: new Date().toISOString(), size: sourceBytes.length };
  if (integrity) meta.integrity = integrity;

  // Best-effort license capture — fetches package.json + LICENSE from the
  // registry's CDN (esm.sh → jsdelivr for npm, jsr.io for jsr, etc.) via
  // the @gcu/licenses URL-aware handlers. Writes both files alongside the
  // source so aggregateLicenses(vfs)'s walkLib picks the entry up without
  // any pkg-specific knowledge. Records a small license hint on meta so
  // `pkg list` can show it without re-traversing the FS.
  //
  // Failures here are NEVER fatal to the install — the package is already
  // on disk; the licence info is enrichment.
  const licInfo = await _captureLicense(ctx, dir, finalUrl);
  if (licInfo) meta.license = licInfo;

  await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));

  const lockfile = await _readLockfile(vfs);
  lockfile.modules[alias] = meta;
  await _writeLockfile(vfs, lockfile);

  await ctx.stdout(`installed ${alias} (${sourceBytes.length} bytes) → ${finalUrl}\n`);
  if (licInfo && licInfo.spdx) {
    await ctx.stdout(`  license: ${licInfo.spdx}${licInfo.spdxSource ? ` (${licInfo.spdxSource})` : ''}\n`);
  }
  return 0;
}

// Resolve @gcu/licenses symbols. In the geas worker bundle they're
// IIFE-isolated and re-exposed under `_lic`-prefixed names (to avoid
// collisions with same-named geas symbols — tokenize, formatTable);
// outside that context (tests, dev tooling) callers can inject via
// globalThis. Returns null when no source has the symbol.
function _resolveLicensesSym(name) {
  // The bare references must be wrapped in typeof to be safe when undeclared
  // (typeof of an unresolvable reference returns 'undefined', never throws).
  if (name === 'fetchLicense') {
    if (typeof _licFetchLicense === 'function') return _licFetchLicense;
    if (typeof fetchLicense === 'function') return fetchLicense;
  } else if (name === 'aggregateLicenses') {
    if (typeof _licAggregateLicenses === 'function') return _licAggregateLicenses;
    if (typeof aggregateLicenses === 'function') return aggregateLicenses;
  } else if (name === 'formatTable') {
    if (typeof _licFormatTable === 'function') return _licFormatTable;
    if (typeof formatTable === 'function') return formatTable;
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') {
    return globalThis[name];
  }
  return null;
}

// _captureLicense — best-effort. Returns the meta hint to store, or null
// on any failure (network, missing registry support, etc.). Always swallows
// errors; the install continues regardless.
//
// Writes two artifacts to <dir> when available:
//   <dir>/package.json  — minimal { name, version, license } so walkLib's
//                          spdxFromPackageJson picks it up
//   <dir>/LICENSE       — raw license text
//
// Returns the small hint:
//   { spdx, spdxSource, fetchedFrom, copyright? }
async function _captureLicense(ctx, dir, finalUrl) {
  const fetchLic = _resolveLicensesSym('fetchLicense');
  if (!fetchLic) return null;  // licenses bundle not loaded
  let result;
  try {
    result = await fetchLic(finalUrl);
  } catch (e) {
    // network / parsing failure — silent.
    return null;
  }
  if (!result) return null;

  // Persist what we have. package.json shape mirrors the minimal subset
  // walkLib's spdxFromPackageJson reads — name + version + license.
  if (result.spdx) {
    const pkgJson = {
      name: result.pkg || null,
      version: result.version || null,
      license: result.spdx,
    };
    try { await ctx.vfs.writeFile(dir + '/package.json', JSON.stringify(pkgJson, null, 2)); }
    catch { /* non-fatal */ }
  }
  if (result.text) {
    try { await ctx.vfs.writeFile(dir + '/LICENSE', result.text); }
    catch { /* non-fatal */ }
  }

  return {
    spdx: result.spdx || null,
    spdxSource: result.spdxSource || null,
    fetchedFrom: result.fetchedFrom || null,
    copyright: result.copyright || null,
  };
}

// pkg install (no args) — restore every entry from the lockfile.
async function _installFromLockfile(ctx) {
  const vfs = ctx.vfs;
  const lockfile = await _readLockfile(vfs);
  const aliases = Object.keys(lockfile.modules);
  if (aliases.length === 0) {
    await ctx.stdout('pkg: lockfile is empty\n');
    return 0;
  }
  let failed = 0;
  for (const alias of aliases) {
    const rc = await _installOne(ctx, alias);
    if (rc !== 0) failed++;
  }
  if (failed > 0) {
    await ctx.stderr(`pkg: ${failed}/${aliases.length} installs failed\n`);
    return 1;
  }
  return 0;
}

async function _list(ctx) {
  const lockfile = await _readLockfile(ctx.vfs);
  const aliases = Object.keys(lockfile.modules).sort();
  if (aliases.length === 0) {
    await ctx.stdout('(no modules installed)\n');
    return 0;
  }
  for (const alias of aliases) {
    const m = lockfile.modules[alias];
    const size = m.size ? `${m.size}b` : '?';
    const kind = m.kind || '?';
    const spdx = (m.license && m.license.spdx) ? m.license.spdx : '-';
    await ctx.stdout(`${alias.padEnd(30)}  ${kind.padEnd(6)}  ${spdx.padEnd(14)}  ${size}\n`);
  }
  return 0;
}

// pkg licenses — aggregate license table over the workspace VFS, formatted
// for the terminal. Picks up everything walkLib + walkVarModules + walkSys
// reach (pkg-managed /lib, install()'d /var/modules, build-time /sys/licenses).
async function _licenses(ctx) {
  const agg = _resolveLicensesSym('aggregateLicenses');
  const fmt = _resolveLicensesSym('formatTable');
  if (!agg || !fmt) {
    await ctx.stderr('pkg: @gcu/licenses not loaded in this build\n');
    return 1;
  }
  let table;
  try { table = await agg(ctx.vfs); }
  catch (e) {
    await ctx.stderr(`pkg: aggregateLicenses failed: ${e.message || e}\n`);
    return 1;
  }
  if (!table || table.length === 0) {
    await ctx.stdout('(no licensed components found)\n');
    return 0;
  }
  await ctx.stdout(fmt(table, { format: 'text' }) + '\n');
  return 0;
}

async function _freeze(ctx) {
  const lockfile = await _readLockfile(ctx.vfs);
  await ctx.stdout(JSON.stringify(lockfile, null, 2) + '\n');
  return 0;
}

async function _remove(ctx, alias) {
  const vfs = ctx.vfs;
  const lockfile = await _readLockfile(vfs);
  if (!(alias in lockfile.modules)) {
    await ctx.stderr(`pkg: ${alias} not installed\n`);
    return 1;
  }
  const dir = _keyToLibPath(alias);
  try { await vfs.rm(dir, { recursive: true }); }
  catch (e) { /* directory may not exist if lockfile drifted */ }
  delete lockfile.modules[alias];
  await _writeLockfile(vfs, lockfile);
  await ctx.stdout(`removed ${alias}\n`);
  return 0;
}

// ── content registry (Works only — via the host-RPC bridge) ──────────
// The geas worker can't see the registry's source list (shell meta) or run a
// full shell-side install (surface registration), so these delegate to the
// `works` Shell through ctx.host. Absent host bridge → "Works only".
async function _eachRegistryEntry(ctx, fn) {
  const sources = await ctx.host('RegistrySources');
  for (const s of (sources || [])) {
    let reg;
    try { reg = (await ctx.host('RegistryFetch', [s.url])).registry; }
    catch { continue; }
    for (const e of (reg.entries || [])) await fn(e, s);
  }
}

async function _search(ctx, query) {
  if (typeof ctx.host !== 'function') { await ctx.stderr('pkg search: the content registry is only available in Auditable Works\n'); return 1; }
  const q = (query || '').toLowerCase().trim();
  let any = false;
  try {
    await _eachRegistryEntry(ctx, async (e, s) => {
      const hay = ((e.title || '') + ' ' + (e.name || '') + ' ' + (e.description || '') + ' ' + (e.tags || []).join(' ') + ' ' + (e.datKind || '')).toLowerCase();
      if (q && !hay.includes(q)) return;
      any = true;
      const kind = e.kind === 'gcupkg' ? 'ext' : (e.datKind || 'data');
      await ctx.stdout(`${String(e.name || '').padEnd(18)} ${String(e.version || '').padEnd(8)} ${kind.padEnd(5)} ${e.title || ''}  (${s.name || s.url})\n`);
    });
  } catch (e) { await ctx.stderr(`pkg search: ${e.message}\n`); return 1; }
  if (!any) await ctx.stdout(q ? 'no matches.\n' : '(no registry entries)\n');
  return 0;
}

async function _sources(ctx) {
  if (typeof ctx.host !== 'function') { await ctx.stderr('pkg sources: the content registry is only available in Auditable Works\n'); return 1; }
  let sources;
  try { sources = await ctx.host('RegistrySources'); }
  catch (e) { await ctx.stderr(`pkg sources: ${e.message}\n`); return 1; }
  if (!sources || !sources.length) { await ctx.stdout('(no sources configured)\n'); return 0; }
  for (const s of sources) await ctx.stdout(`${String(s.name || s.url).padEnd(22)} ${s.url}\n`);
  return 0;
}

// Find a registry entry by exact name across configured sources.
async function _findRegistryEntry(ctx, name) {
  let hit = null;
  await _eachRegistryEntry(ctx, async (e, s) => { if (!hit && e.name === name) hit = { entry: e, source: s.url, sourceName: s.name || s.url }; });
  return hit;
}

async function _help(ctx) {
  await ctx.stdout([
    'usage: pkg <subcommand> [args...]',
    '',
    'subcommands:',
    '  install <name>             install a registry entry by name (Works)',
    '  install <alias>            fetch + verify, write to /lib + lockfile',
    '  install <path.gcupkg>      sideload a packed extension (EXTENSION_SPEC §6.1)',
    '  install                    re-install every entry from /lib/.gcu-lock.json',
    '  search [query]             search the content registry (Works)',
    '  sources                    list configured registry sources (Works)',
    '  list                       list installed modules with SPDX badges',
    '  licenses                   aggregate license table across the workspace',
    '  freeze                     print the workspace lockfile',
    '  remove <alias>             delete the entry + its /lib directory',
    '  help                       show this message',
    '',
    'alias prefixes (pkg-spec §3.3):',
    '  @gcu/<name>         GCU package via esm.sh',
    '  npm:<name>          npm package via esm.sh',
    '  jsr:<name>          jsr.io package via esm.sh',
    '  gh:<user>/<repo>    GitHub repo via esm.sh',
    '  local:/<vfs-path>   surface VFS, no integrity, no caching',
    '  /path.gcupkg        VFS-path .gcupkg file — sideload',
    '  https://…/x.gcupkg  fetched .gcupkg — sideload',
    '',
  ].join('\n'));
  return 0;
}

async function _pkg(argv, ctx) {
  const sub = argv[1];
  switch (sub) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':  return _help(ctx);
    case 'install':  return argv[2] ? _installOne(ctx, argv[2]) : _installFromLockfile(ctx);
    case 'search':   return _search(ctx, argv.slice(2).join(' '));
    case 'sources':  return _sources(ctx);
    case 'list':     return _list(ctx);
    case 'licenses': return _licenses(ctx);
    case 'freeze':   return _freeze(ctx);
    case 'remove':
    case 'rm':       if (!argv[2]) { await ctx.stderr('pkg: remove needs <alias>\n'); return 1; }
                     return _remove(ctx, argv[2]);
    default:         await ctx.stderr(`pkg: unknown subcommand "${sub}" (try 'pkg help')\n`);
                     return 1;
  }
}

// -- profile-cmd.js --

// profile — the geas-side of distribution profiles (gcu-distributions-spec).
// Lives alongside pkg-cmd.js; same shape: a worker-hosted builtin that
// delegates the shell-coupled work to Auditable Works over the host-RPC
// bridge (ctx.host → works Shell.Profile* methods). Absent host bridge →
// "Works only", like pkg's registry subcommands.
//
// Subcommands (v1):
//   profile list                 — baked distribution profiles (+ which is current)
//   profile current              — the workspace's provisioned marker
//   profile export [path]       — snapshot installed packages + settings as a
//                                  .gcuprofile; write to a VFS path or stdout
//   profile provision <name>    — provision a baked profile by name
//   profile provision <file|url> — provision a .gcuprofile from the VFS or a URL
//   profile help                 — usage
//
// Trust model: provisioning installs without per-package prompts (the user
// authorized the profile by invoking the command — same contract as the setup
// screen); any NEW registry source a profile declares still gets the shell's
// trust dialog before it's added.

async function _requireHost(ctx, sub) {
  if (typeof ctx.host === 'function') return true;
  await ctx.stderr(`profile ${sub}: distribution profiles are only available in Auditable Works\n`);
  return false;
}

async function _profileList(ctx) {
  if (!(await _requireHost(ctx, 'list'))) return 1;
  let profiles, marker;
  try {
    profiles = await ctx.host('ProfileList');
    marker = await ctx.host('ProfileProvisioned');
  } catch (e) { await ctx.stderr(`profile list: ${e.message}\n`); return 1; }
  if (!profiles || !profiles.length) {
    await ctx.stdout('(no baked profiles — this is a monolith build; profiles ship with works-core)\n');
    return 0;
  }
  for (const p of profiles) {
    const cur = marker && marker.profile === p.name ? '*' : ' ';
    const pkgs = (p.packages || []).length;
    await ctx.stdout(`${cur} ${String(p.name).padEnd(20)} ${String(pkgs + ' pkg' + (pkgs === 1 ? '' : 's')).padEnd(8)} ${p.title || ''}${p.description ? ' — ' + p.description : ''}\n`);
  }
  return 0;
}

async function _profileCurrent(ctx) {
  if (!(await _requireHost(ctx, 'current'))) return 1;
  let marker;
  try { marker = await ctx.host('ProfileProvisioned'); }
  catch (e) { await ctx.stderr(`profile current: ${e.message}\n`); return 1; }
  if (!marker) { await ctx.stdout('(not provisioned)\n'); return 0; }
  await ctx.stdout(`profile:   ${marker.profile}\n`);
  if (marker.at) await ctx.stdout(`when:      ${new Date(marker.at).toISOString()}\n`);
  if (marker.installed && marker.installed.length) await ctx.stdout(`installed: ${marker.installed.join(', ')}\n`);
  if (marker.failed && marker.failed.length) await ctx.stdout(`failed:    ${marker.failed.join(', ')}\n`);
  return 0;
}

// profile export [path] — no path prints the .gcuprofile JSON to stdout
// (redirectable: `profile export > my.gcuprofile`); with a path, writes the
// file and derives the profile name from its basename.
async function _profileExport(ctx, path) {
  if (!(await _requireHost(ctx, 'export'))) return 1;
  const opts = {};
  if (path) {
    const base = path.split('/').filter(Boolean).pop() || '';
    const name = base.replace(/\.gcuprofile$/i, '').trim();
    if (name) opts.name = name;
  }
  let spec;
  try { spec = await ctx.host('ProfileExport', [opts]); }
  catch (e) { await ctx.stderr(`profile export: ${e.message}\n`); return 1; }
  const json = JSON.stringify(spec, null, 2) + '\n';
  if (!path) { await ctx.stdout(json); return 0; }
  if (!ctx.vfs) { await ctx.stderr('profile export: no VFS in this context\n'); return 1; }
  try { await ctx.vfs.writeFile(path, json); }
  catch (e) { await ctx.stderr(`profile export: cannot write ${path}: ${e.message}\n`); return 1; }
  await ctx.stdout(`exported ${spec.name} → ${path} (${(spec.packages || []).length} packages)\n`);
  return 0;
}

// profile provision <name | vfs-path | url> [--no-starter] — a baked profile
// by name, or a raw .gcuprofile read from the VFS / fetched from a URL.
// --no-starter skips seeding the profile's welcome notebook.
async function _profileProvision(ctx, args) {
  if (!(await _requireHost(ctx, 'provision'))) return 1;
  const popts = args.includes('--no-starter') ? { skipStarter: true } : {};
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { await ctx.stderr('profile provision: needs a profile name, .gcuprofile path, or URL\n'); return 1; }

  const isUrl = /^https?:\/\//.test(target);
  const isPath = !isUrl && (target.includes('/') || /\.gcuprofile$/i.test(target));
  let report;
  try {
    if (isUrl || isPath) {
      let text;
      if (isUrl) {
        const resp = await fetch(target);
        if (!resp.ok) { await ctx.stderr(`profile provision: fetch ${target} failed (${resp.status})\n`); return 1; }
        text = await resp.text();
      } else {
        if (!ctx.vfs) { await ctx.stderr('profile provision: no VFS in this context\n'); return 1; }
        text = await ctx.vfs.readFile(target, 'utf8');
      }
      let spec;
      try { spec = JSON.parse(text); }
      catch { await ctx.stderr(`profile provision: ${target} is not valid .gcuprofile JSON\n`); return 1; }
      await ctx.stdout(`provisioning ${spec.title || spec.name || 'custom'}…\n`);
      report = await ctx.host('ProfileProvisionSpec', [spec, popts]);
    } else {
      await ctx.stdout(`provisioning ${target}…\n`);
      report = await ctx.host('ProfileProvision', [target, popts]);
    }
  } catch (e) { await ctx.stderr(`profile provision: ${e.message}\n`); return 1; }

  const inst = (report && report.installed) || [];
  const fail = (report && report.failed) || [];
  if (inst.length) await ctx.stdout(`installed: ${inst.join(', ')}\n`);
  if (!inst.length && !fail.length) await ctx.stdout('nothing to install (shell-only profile)\n');
  if (report && report.starter) await ctx.stdout(`welcome: ${report.starter}\n`);
  if (fail.length) {
    await ctx.stderr(`failed: ${fail.join(', ')} (offline? declined source? — re-run to retry)\n`);
    return 1;
  }
  return 0;
}

async function _profileHelp(ctx) {
  await ctx.stdout([
    'usage: profile <subcommand> [args...]',
    '',
    'subcommands:',
    '  list                       baked distribution profiles (* = current)',
    '  current                    this workspace\'s provisioned marker',
    '  export [path]              snapshot installed packages + settings as a',
    '                             .gcuprofile (no path → stdout)',
    '  provision <name>           provision a baked profile by name',
    '  provision <file|url>       provision a .gcuprofile from the VFS or a URL',
    '    --no-starter             skip seeding the profile\'s welcome notebook',
    '  help                       show this message',
    '',
    'Auditable Works only — profiles are a works-core (lean shell) feature;',
    'export also works in monolith builds (the snapshot is host-agnostic).',
    '',
  ].join('\n'));
  return 0;
}

async function _profile(argv, ctx) {
  const sub = argv[1];
  switch (sub) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':    return _profileHelp(ctx);
    case 'list':      return _profileList(ctx);
    case 'current':
    case 'status':    return _profileCurrent(ctx);
    case 'export':    return _profileExport(ctx, argv[2]);
    case 'provision': return _profileProvision(ctx, argv.slice(2));
    default:          await ctx.stderr(`profile: unknown subcommand "${sub}" (try 'profile help')\n`);
                      return 1;
  }
}

// -- builtins-archive.js --

// Archive-format builtins for geas — POSIX-baseline flag surface wrapping
// @gcu/archive. Designed to extract cleanly into @gcu/coreutils when that
// package becomes its own thing (see ext/geas/README.md "@gcu/coreutils
// extraction" roadmap).
//
// Each builtin is `async (argv, ctx) => exitCode`, matching geas's contract.
// ctx exposes: stdin, stdout, stderr, vfs, cwd, env.
//
// Flag coverage matches archive-spec §4.4 — POSIX-baseline only. Not a
// reimplementation of GNU tar; users wanting --exclude-from / --xform / etc.
// can compose with grep / find pipelines.
//
// @gcu/archive resolution: geas's build.js prepends the pre-built archive
// bundle (ext/archive/index.js) so `archive` and `walkVfsTree` are in scope
// here at runtime in the geas worker. For node-test usage (where this file
// is loaded directly, not through the concat build), we fall back to a
// dynamic import — the relative path resolves via Node's ESM loader.

let _archive = null;
let _walk = null;
let _resolved = false;
async function _resolveArchive() {
  if (_resolved) return;
  _resolved = true;
  // First check: globalThis already has it from the concat-prepended bundle.
  if (typeof archive !== 'undefined' && archive && typeof archive.list === 'function') {
    // eslint-disable-next-line no-undef
    _archive = archive;
  }
  if (typeof walkVfsTree === 'function') {
    // eslint-disable-next-line no-undef
    _walk = walkVfsTree;
  }
  if (_archive && _walk) return;
  // Fallback for test / standalone usage: dynamic import.
  try {
    const mod = await import('../../archive/index.js');
    if (!_archive && mod.archive && typeof mod.archive.list === 'function') _archive = mod.archive;
    if (!_walk && typeof mod.walkVfsTree === 'function') _walk = mod.walkVfsTree;
  } catch { /* ignore — surfaces as a clear error below */ }
}

// Print + return 127 (POSIX command-not-found-ish) when archive is missing.
// Used at the top of every builtin.
async function _requireArchive(ctx, name) {
  await _resolveArchive();
  if (!_archive) {
    await ctx.stderr(`${name}: @gcu/archive not loaded in this build\n`);
    return null;
  }
  return _archive;
}

async function _loadWalk() {
  await _resolveArchive();
  return _walk;
}

// ── Helpers shared with the geas builtins module ────────────────────────
// Re-declared locally to avoid a circular import; identical to the ones in
// builtins.js (geas's main file).

function _arResolvePath(p, ctx) {
  if (p == null) return p;
  if (p.startsWith('/')) return _arNormalizePath(p);
  const base = ctx.cwd && ctx.cwd.endsWith('/') ? ctx.cwd : (ctx.cwd || '/') + '/';
  return _arNormalizePath(base + p);
}

function _arNormalizePath(p) {
  const parts = String(p).split('/');
  const stack = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

function _arBasename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || '';
}

// Strip a recognized archive extension off a basename. Used by tar -x and
// unzip when no -C / -d is given (extract here, sibling-named directory).
const _ARCHIVE_EXT_RE = /\.(zip|tar|tar\.gz|tgz|tar\.zst|tzst|tar\.xz|txz|tar\.bz2|tbz2|gz|zst)$/i;
function _stripArchiveExt(name) {
  return name.replace(_ARCHIVE_EXT_RE, '');
}

// Append text to ctx.stdout. Adds a trailing newline if missing — keeps the
// `> output.txt` redirection case clean.
async function _print(ctx, s) {
  if (s == null) return;
  const str = String(s);
  await ctx.stdout(str.endsWith('\n') ? str : str + '\n');
}

// Format a list entry the way `tar -tv` / `unzip -l` do — size right-aligned
// + path. Doesn't try to mimic mode bits / dates; archives often don't carry
// reliable mtimes anyway.
function _formatListing(entries, opts = {}) {
  const verbose = !!opts.verbose;
  if (!verbose) return entries.map(e => e.path).join('\n');
  const lines = [];
  for (const e of entries) {
    if (e.type === 'directory') {
      lines.push(`         <dir>  ${e.path}`);
    } else {
      const size = String(e.size ?? 0).padStart(12);
      lines.push(`${size}  ${e.path}`);
    }
  }
  return lines.join('\n');
}

// Parse a flag cluster like `czf` or `xzvf` — returns a Set of single-char
// flag names. The caller drives flag-aware logic (decode args, set mode, etc.).
function _clusterToSet(s) {
  const set = new Set();
  for (const ch of s) set.add(ch);
  return set;
}

// ── tar ─────────────────────────────────────────────────────────────────
//
// Usage:
//   tar -c[zf] FILE [-C DIR] [PATHS...]   create
//   tar -x[zf] FILE [-C DIR]              extract
//   tar -t[zf] FILE [-v]                  list
//
// Recognized flags:
//   -c create   -x extract   -t list
//   -z gzip     -j bz2 (read-only)   -J xz (read-only)   --zstd zstd (read-only)
//   -f FILE     -C DIR     -v verbose
//
// The first non-flag positional after the flag cluster is treated as the
// FILE if -f was given but no value followed it inline (the BSD/GNU "tar
// czf out.tar.gz dir/" calling convention). The rest are PATHS for create
// mode or ignored for extract/list mode in v0.
//
// Easter egg: -x AND -c together is the impossible flag combination from
// xkcd #1168 ("To disarm the bomb, simply enter a valid tar command…").
// We fetch the comic image (hotlink-permitted) into /tmp/tar.png and tell
// the user to open it. Documented as intentional — strip with care.

async function _tar(argv, ctx) {
  // Two phases of parsing — first separate long options (--zstd, --xkcd,
  // etc.) and the leading flag cluster, then walk the remaining positionals
  // for -f/-C values and paths.
  let isLong = (a) => a.startsWith('--');
  let mode = null;       // 'c' | 'x' | 't'
  let useGz = false;
  let useBz2 = false;
  let useXz = false;
  let useZst = false;
  let file = null;
  let chdir = null;
  let verbose = false;
  let bomb = false;       // xkcd egg trigger
  let positionals = [];

  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '--zstd')  { useZst = true; i++; continue; }
    if (a === '--xkcd')  { bomb = true; i++; continue; }   // explicit alias
    if (a === '-' || !a.startsWith('-') || a.length === 1) {
      positionals.push(a); i++; continue;
    }
    // Short flag cluster — every char is one flag. Some flags consume the
    // next positional argument (f for the file, C for the chdir target).
    const cluster = a.slice(1);
    const flags = _clusterToSet(cluster);
    if (flags.has('c')) mode = 'c';
    if (flags.has('x')) mode = (mode === 'c') ? null : 'x';
    if (flags.has('t')) mode = (mode === 'c' || mode === 'x') ? null : 't';
    if (flags.has('c') && flags.has('x')) bomb = true;     // xkcd trigger
    if (flags.has('z')) useGz = true;
    if (flags.has('j')) useBz2 = true;
    if (flags.has('J')) useXz = true;
    if (flags.has('v')) verbose = true;
    // -f and -C each consume the next argv. POSIX tar also allows them
    // inlined (-fout.tar) but for v0 we require the value as a separate arg.
    if (flags.has('f')) { file = argv[++i] || null; }
    if (flags.has('C')) { chdir = argv[++i] || null; }
    i++;
  }

  if (bomb) return _tarXkcd(ctx);

  if (!ctx.vfs) { await ctx.stderr('tar: no VFS configured\n'); return 1; }
  if (!file)    { await ctx.stderr('tar: missing -f FILE\n');    return 2; }
  if (!mode)    { await ctx.stderr('tar: missing -c / -x / -t mode\n'); return 2; }

  const archive = await _requireArchive(ctx, 'tar'); if (!archive) return 127;

  // Pre-flight: tar.xz / tar.bz2 / tar.zst writes aren't possible yet.
  if (mode === 'c' && (useXz || useBz2 || useZst)) {
    await ctx.stderr('tar: -j / -J / --zstd encode not available in this build\n');
    return 1;
  }

  const filePath = _arResolvePath(file, ctx);
  const cwdPath  = chdir ? _arResolvePath(chdir, ctx) : (ctx.cwd || '/');

  try {
    if (mode === 't') {
      const entries = await archive.list({ vfs: ctx.vfs, path: filePath });
      await _print(ctx, _formatListing(entries, { verbose }));
      return 0;
    }
    if (mode === 'x') {
      // No -C → extract into cwd. We pass the cwd directly; the sink will
      // create entries underneath it. Auto-rename on collision keeps it safe.
      const result = await archive.extract(
        { vfs: ctx.vfs, path: filePath },
        { vfs: ctx.vfs, path: cwdPath },
        { overwrite: 'rename' }
      );
      if (verbose) await _print(ctx, (result.paths || []).join('\n'));
      return 0;
    }
    if (mode === 'c') {
      // Determine the compress format from the file extension. -z forces
      // tar.gz regardless of name; otherwise we look at the path.
      const lower = filePath.toLowerCase();
      let format = 'tar';
      if (useGz || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) format = 'tar.gz';
      // Sources to include — one per positional. Each can be a file or a dir.
      const sources = positionals.length > 0 ? positionals : ['.'];
      // The archive lib's compress walks ONE source path. For multiple, we
      // build a writer and add each source's tree manually.
      const writer = archive.createWriter(
        { vfs: ctx.vfs, path: filePath },
        { format }
      );
      for (const src of sources) {
        const srcAbs = _arResolvePath(src, ctx);
        // Walk the source. Filenames inside the archive are RELATIVE to the
        // source — for `tar -czf out.tar.gz dir/`, entries are dir/foo not
        // /abs/path/dir/foo.
        const walkVfsTree = await _loadWalk();
        if (!walkVfsTree) throw new Error('@gcu/archive walker not available');
        const entries = await walkVfsTree(ctx.vfs, srcAbs);
        // Prefix entries with the source's basename so `dir/x.txt` lands
        // as `dir/x.txt`, not just `x.txt`.
        const prefix = _arBasename(srcAbs);
        for (const e of entries) {
          const archivePath = prefix ? `${prefix}/${e.path}` : e.path;
          if (e.type === 'directory') await writer.addDirectory(archivePath);
          else                         await writer.addFile(archivePath, e.bytes);
          if (verbose) await _print(ctx, archivePath);
        }
      }
      await writer.close();
      return 0;
    }
  } catch (e) {
    await ctx.stderr(`tar: ${e.message || e}\n`);
    return 1;
  }
  return 0;
}

// Use _loadWalk() (the candidate-chain resolver above) for tar/zip's
// create paths.

// xkcd #1168 — "tar". Hotlink xkcd.com is allowed for the comic image asset
// (https://xkcd.com/about/hotlinking — see "ok to hotlink"). We grab the
// PNG, write it to /tmp/tar.png, and point the user at it. If fetch fails
// (CORS, offline, fetch unavailable in the worker), we degrade gracefully
// to just the comic dialogue.
async function _tarXkcd(ctx) {
  const url = 'https://imgs.xkcd.com/comics/tar.png';
  const dialogue =
    'Rob! You use Unix! Come quick!\n' +
    '\n' +
    'To disarm the bomb, simply enter a valid `tar` command on your first try.\n' +
    'No googling. You have ten seconds.\n' +
    '\n' +
    '…Rob?\n' +
    '\n' +
    "I'm so sorry.\n" +
    '\n' +
    '— xkcd #1168 — https://xkcd.com/1168/\n';
  try {
    if (typeof fetch !== 'function') throw new Error('no fetch');
    const r = await fetch(url);
    if (!r || !r.ok) throw new Error('fetch ' + (r ? r.status : 'failed'));
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (ctx.vfs) {
      try { await ctx.vfs.mkdir('/tmp', { recursive: true }); } catch {}
      await ctx.vfs.writeFile('/tmp/tar.png', bytes);
      await _print(ctx, dialogue + '\n(saved to /tmp/tar.png — open it in the file tree to view)');
      return 0;
    }
  } catch { /* fall through to text-only */ }
  await _print(ctx, dialogue);
  return 0;
}

// ── gzip / gunzip ───────────────────────────────────────────────────────
//
// gzip [-d -k -c -N] FILE...
//   -d  decompress    -k  keep input    -c  write to stdout
//   -1..-9  compression level (forwarded to fflate; ignored on -d)
//
// gunzip = gzip -d (alias)

async function _gzipImpl(argv, ctx, defaultDecompress) {
  let decompress = defaultDecompress;
  let keep = false;
  let toStdout = false;
  // -1..-9 are ignored in v0 (fflate level handled by archive.gzip default);
  // we still consume them so they don't get classified as filenames.
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    for (const ch of a.slice(1)) {
      if (ch === 'd') decompress = true;
      else if (ch === 'k') keep = true;
      else if (ch === 'c') toStdout = true;
      else if (ch >= '0' && ch <= '9') { /* level ignored in v0 */ }
      else { await ctx.stderr(`gzip: unknown option -${ch}\n`); return 2; }
    }
  }

  if (!ctx.vfs) { await ctx.stderr('gzip: no VFS configured\n'); return 1; }
  if (positionals.length === 0) {
    await ctx.stderr('gzip: stdin/stdout mode not yet implemented; supply a FILE\n');
    return 2;
  }

  const archive = await _requireArchive(ctx, 'gzip'); if (!archive) return 127;

  let anyError = 0;
  for (const f of positionals) {
    const src = _arResolvePath(f, ctx);
    try {
      if (decompress) {
        if (toStdout) {
          // Pipe gunzipped bytes to stdout as text. Binary files printed to
          // a terminal aren't useful — that's a shell concern, not ours.
          const map = await archive.gunzip(
            { vfs: ctx.vfs, path: src }, 'memory');
          const [, bytes] = [...map.entries()][0];
          await ctx.stdout(new TextDecoder().decode(bytes));
        } else {
          // Strip .gz to derive the output name.
          const dst = src.replace(/\.gz$/i, '');
          if (dst === src) {
            await ctx.stderr(`gzip: ${f}: not a .gz file\n`);
            anyError = 1; continue;
          }
          await archive.gunzip(
            { vfs: ctx.vfs, path: src }, { vfs: ctx.vfs, path: dst });
          if (!keep) try { await ctx.vfs.unlink(src); } catch {}
        }
      } else {
        if (toStdout) {
          // gzip the input bytes; ctx.stdout sinks strings, so this only
          // really works downstream of a `> file` redirect. Worker stdouts
          // may be type-coercing — for v0 we accept the limitation.
          const map = await archive.gzip(
            { vfs: ctx.vfs, path: src }, 'memory');
          const [, bytes] = [...map.entries()][0];
          // Surface as latin-1 string to preserve binary bytes through
          // string-typed stdout sinks. Caller redirecting to a file should
          // get the right bytes back.
          let s = '';
          for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
          await ctx.stdout(s);
        } else {
          const dst = src + '.gz';
          await archive.gzip(
            { vfs: ctx.vfs, path: src }, { vfs: ctx.vfs, path: dst });
          if (!keep) try { await ctx.vfs.unlink(src); } catch {}
        }
      }
    } catch (e) {
      await ctx.stderr(`gzip: ${f}: ${e.message || e}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _gzip(argv, ctx)   { return _gzipImpl(argv, ctx, false); }
async function _gunzip(argv, ctx) { return _gzipImpl(argv, ctx, true);  }

// ── zstd / unzstd ───────────────────────────────────────────────────────
// Same shape as gzip but compress isn't available (fzstd is decode-only).
// In v0 zstd without -d returns a clear error pointing at the gap.

async function _zstdImpl(argv, ctx, defaultDecompress) {
  let decompress = defaultDecompress;
  let keep = false;
  let toStdout = false;
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    for (const ch of a.slice(1)) {
      if (ch === 'd') decompress = true;
      else if (ch === 'k') keep = true;
      else if (ch === 'c') toStdout = true;
      else if (ch >= '0' && ch <= '9') { /* level ignored */ }
      else { await ctx.stderr(`zstd: unknown option -${ch}\n`); return 2; }
    }
  }

  if (!decompress) {
    await ctx.stderr('zstd: encode not available in this build (fzstd is decode-only). '
      + 'Use gzip / tar.gz for compression for now.\n');
    return 1;
  }
  if (!ctx.vfs) { await ctx.stderr('zstd: no VFS configured\n'); return 1; }
  if (positionals.length === 0) {
    await ctx.stderr('zstd: stdin/stdout mode not yet implemented; supply a FILE\n');
    return 2;
  }

  const archive = await _requireArchive(ctx, 'zstd'); if (!archive) return 127;

  let anyError = 0;
  for (const f of positionals) {
    const src = _arResolvePath(f, ctx);
    try {
      if (toStdout) {
        const map = await archive.unzstd(
          { vfs: ctx.vfs, path: src }, 'memory');
        const [, bytes] = [...map.entries()][0];
        await ctx.stdout(new TextDecoder().decode(bytes));
      } else {
        const dst = src.replace(/\.zst$/i, '');
        if (dst === src) {
          await ctx.stderr(`zstd: ${f}: not a .zst file\n`);
          anyError = 1; continue;
        }
        await archive.unzstd(
          { vfs: ctx.vfs, path: src }, { vfs: ctx.vfs, path: dst });
        if (!keep) try { await ctx.vfs.unlink(src); } catch {}
      }
    } catch (e) {
      await ctx.stderr(`zstd: ${f}: ${e.message || e}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _zstd(argv, ctx)   { return _zstdImpl(argv, ctx, false); }
async function _unzstd(argv, ctx) { return _zstdImpl(argv, ctx, true);  }

// ── zip / unzip ─────────────────────────────────────────────────────────
//
// zip [-r] [-N] FILE.zip paths...
//   -r recurse — we always recurse in v0; flag accepted for compatibility
//   -0..-9  level (forwarded to fflate)
//
// unzip [-l | -p] [-d DIR] [-o] FILE.zip [paths...]
//   -l  list, don't extract       -p  print one entry to stdout
//   -d  destination directory    -o  overwrite without prompt

async function _zip(argv, ctx) {
  let level = 6;
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    for (const ch of a.slice(1)) {
      if (ch === 'r') { /* always recursive */ }
      else if (ch >= '0' && ch <= '9') level = ch.charCodeAt(0) - 48;
      else { await ctx.stderr(`zip: unknown option -${ch}\n`); return 2; }
    }
  }
  if (!ctx.vfs)               { await ctx.stderr('zip: no VFS configured\n'); return 1; }
  if (positionals.length < 2) { await ctx.stderr('zip: need FILE.zip + at least one path\n'); return 2; }

  const archive = await _requireArchive(ctx, 'zip'); if (!archive) return 127;

  const dst = _arResolvePath(positionals[0], ctx);
  const sources = positionals.slice(1);
  try {
    const writer = archive.createWriter(
      { vfs: ctx.vfs, path: dst }, { format: 'zip', level });
    const walkVfsTree = await _loadWalk();
    if (!walkVfsTree) throw new Error('@gcu/archive walker not available');
    for (const src of sources) {
      const srcAbs = _arResolvePath(src, ctx);
      const entries = await walkVfsTree(ctx.vfs, srcAbs);
      const prefix = _arBasename(srcAbs);
      for (const e of entries) {
        const archivePath = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === 'directory') await writer.addDirectory(archivePath);
        else                         await writer.addFile(archivePath, e.bytes);
      }
    }
    await writer.close();
    return 0;
  } catch (e) {
    await ctx.stderr(`zip: ${e.message || e}\n`);
    return 1;
  }
}

async function _unzip(argv, ctx) {
  let list = false, toStdout = false, overwrite = false;
  let dest = null;
  let positionals = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    const cluster = a.slice(1);
    let skip = false;
    for (let k = 0; k < cluster.length && !skip; k++) {
      const ch = cluster[k];
      if (ch === 'l') list = true;
      else if (ch === 'p') toStdout = true;
      else if (ch === 'o') overwrite = true;
      else if (ch === 'd') {
        // -dDIR (inline) or -d DIR (next arg).
        const rest = cluster.slice(k + 1);
        dest = rest || argv[++i] || null;
        skip = true;
      }
      else { await ctx.stderr(`unzip: unknown option -${ch}\n`); return 2; }
    }
  }

  if (!ctx.vfs)              { await ctx.stderr('unzip: no VFS configured\n'); return 1; }
  if (positionals.length === 0) { await ctx.stderr('unzip: need FILE.zip\n'); return 2; }

  const archive = await _requireArchive(ctx, 'unzip'); if (!archive) return 127;

  const src = _arResolvePath(positionals[0], ctx);
  const innerPaths = positionals.slice(1);

  try {
    if (list) {
      const entries = await archive.list({ vfs: ctx.vfs, path: src });
      await _print(ctx, _formatListing(entries, { verbose: true }));
      return 0;
    }
    if (toStdout) {
      // -p prints the named entries to stdout. With no entries listed,
      // print all of them. Text-only — binary entries print as garbled
      // strings, same as real unzip.
      const targets = innerPaths.length > 0
        ? innerPaths
        : (await archive.list({ vfs: ctx.vfs, path: src }))
            .filter(e => e.type === 'file').map(e => e.path);
      for (const p of targets) {
        const bytes = await archive.read({ vfs: ctx.vfs, path: src }, p);
        if (bytes) await ctx.stdout(new TextDecoder().decode(bytes));
      }
      return 0;
    }
    // Extract — into -d DIR, into a sibling-named dir if dest unset, or
    // into cwd. Match the convention of common unzip wrappers.
    let destPath;
    if (dest) destPath = _arResolvePath(dest, ctx);
    else      destPath = ctx.cwd || '/';
    await archive.extract(
      { vfs: ctx.vfs, path: src },
      { vfs: ctx.vfs, path: destPath },
      { overwrite: overwrite ? 'overwrite' : 'rename' }
    );
    return 0;
  } catch (e) {
    await ctx.stderr(`unzip: ${e.message || e}\n`);
    return 1;
  }
}

// ── Public ──────────────────────────────────────────────────────────────

function archiveBuiltins() {
  return {
    tar:    _tar,
    gzip:   _gzip,
    gunzip: _gunzip,
    zstd:   _zstd,
    unzstd: _unzstd,
    zip:    _zip,
    unzip:  _unzip,
  };
}

// -- buffer.js --

// buffer.js — the in-memory document model for ed.
//
// `lines` is a 0-indexed array of strings (no trailing newlines). The
// classic ed `current line` cursor is 1-indexed; 0 means "buffer is
// empty." `dirty` flips on any mutation; `undo` snapshots state before
// every buffer-changing command so `u` rolls back exactly one step
// (POSIX one-level undo).

function createBuffer() {
  return {
    lines: [],
    cur: 0,
    filename: null,
    dirty: false,
    lastSearch: null,
    lastSubstitute: null,   // { re: RegExp, repl: string, flags: string }
    lastError: '',
    prompt: '* ',
    showPrompt: true,       // GNU-ish default; --posix turns it off
    posix: false,
    verboseErrors: true,    // toggled by `H` in posix mode
    cutBuffer: [],          // for `d`/`c`'s implicit cut + `u` reach
    quitPending: false,     // first `q` with dirty buffer warns; second confirms
    // Single-level undo snapshot. Captured BEFORE each mutating command.
    undoSnap: null,
  };
}

// Snapshot current state for `u`. Called before any mutation.
function snapshot(buf) {
  buf.undoSnap = {
    lines: buf.lines.slice(),
    cur: buf.cur,
    dirty: buf.dirty,
    lastSearch: buf.lastSearch,
    lastSubstitute: buf.lastSubstitute,
  };
}

function undo(buf) {
  if (!buf.undoSnap) return false;
  const snap = buf.undoSnap;
  // Snapshot CURRENT state as the new undo so `u` is its own inverse.
  const inverse = {
    lines: buf.lines.slice(),
    cur: buf.cur,
    dirty: buf.dirty,
    lastSearch: buf.lastSearch,
    lastSubstitute: buf.lastSubstitute,
  };
  buf.lines = snap.lines;
  buf.cur = snap.cur;
  buf.dirty = snap.dirty;
  buf.lastSearch = snap.lastSearch;
  buf.lastSubstitute = snap.lastSubstitute;
  buf.undoSnap = inverse;
  return true;
}

// Insert `newLines` into `buf` AFTER `at` (1-indexed; 0 = before line 1).
// Updates cur to the last inserted line. Marks dirty.
function insertAfter(buf, at, newLines) {
  if (newLines.length === 0) return;
  buf.lines.splice(at, 0, ...newLines);
  buf.cur = at + newLines.length;
  buf.dirty = true;
}

// Delete inclusive range [from, to] (1-indexed). Updates cur to the
// line that was just after the deleted block (or last line if at end).
function deleteRange(buf, from, to) {
  const cut = buf.lines.splice(from - 1, to - from + 1);
  buf.cutBuffer = cut;
  buf.cur = Math.min(from, buf.lines.length);
  if (buf.cur < 1 && buf.lines.length > 0) buf.cur = 1;
  buf.dirty = true;
  return cut;
}

// Move inclusive range [from, to] to AFTER `dest` (1-indexed).
// Errors if dest falls inside the range.
function moveRange(buf, from, to, dest) {
  if (dest >= from - 1 && dest <= to) {
    throw new Error('invalid destination');
  }
  const cut = buf.lines.splice(from - 1, to - from + 1);
  // After the cut, line numbers from `from` onward have shifted down by
  // cut.length. Adjust dest accordingly.
  const adjustedDest = dest >= to ? dest - cut.length : dest;
  buf.lines.splice(adjustedDest, 0, ...cut);
  buf.cur = adjustedDest + cut.length;
  buf.dirty = true;
}

// Copy (transfer) inclusive range [from, to] to AFTER `dest` (1-indexed).
function transferRange(buf, from, to, dest) {
  const copy = buf.lines.slice(from - 1, to);
  buf.lines.splice(dest, 0, ...copy);
  buf.cur = dest + copy.length;
  buf.dirty = true;
}

// Replace one line. Used by `s` per-line and `c` after insert.
function replaceLine(buf, n, text) {
  buf.lines[n - 1] = text;
  buf.cur = n;
  buf.dirty = true;
}

// -- regex.js --

// regex.js — translate ed-flavoured patterns to JS RegExp.
//
// Ed defaults to BRE (Basic Regular Expressions). The differences from
// JS regex that matter in practice:
//
//   - `\(` `\)`        — groups (parentheses are literal in BRE)
//   - `\|`             — alternation (pipe is literal in BRE)
//   - `\{m,n\}`        — counted repetition
//   - `\<` `\>`        — word boundaries (JS uses `\b` for both)
//   - `+` `?`          — literal characters in BRE (JS treats as operators)
//   - `\+` `\?`        — repetition operators in some BRE flavours
//   - `.` `^` `$` `*`  — same as JS
//   - `[abc]` `[^abc]` — same as JS
//   - `\n` in replace  — backreference (not newline)
//
// We translate the ed-style escapes into JS regex source. Anyone targeting
// strict POSIX BRE will hit edge cases; we ship the convenient subset that
// covers what's actually typed at an ed prompt.

function edToJsRegex(edPattern, flags) {
  let out = '';
  let i = 0;
  while (i < edPattern.length) {
    const c = edPattern[i];
    if (c === '\\') {
      const next = edPattern[i + 1];
      switch (next) {
        case '(': out += '(';  i += 2; continue;
        case ')': out += ')';  i += 2; continue;
        case '|': out += '|';  i += 2; continue;
        case '{': out += '{';  i += 2; continue;
        case '}': out += '}';  i += 2; continue;
        case '<': out += '\\b'; i += 2; continue;
        case '>': out += '\\b'; i += 2; continue;
        case '+': out += '+';  i += 2; continue;
        case '?': out += '?';  i += 2; continue;
        case '.': out += '\\.'; i += 2; continue;
        case '*': out += '\\*'; i += 2; continue;
        case '[': out += '\\['; i += 2; continue;
        case ']': out += '\\]'; i += 2; continue;
        case '^': out += '\\^'; i += 2; continue;
        case '$': out += '\\$'; i += 2; continue;
        case '/': out += '/';   i += 2; continue;
        default:
          // \n, \t, \\, \d etc. — pass through verbatim.
          out += '\\' + (next != null ? next : '');
          i += next != null ? 2 : 1;
          continue;
      }
    }
    if (c === '(' || c === ')' || c === '|' || c === '{' || c === '}'
        || c === '+' || c === '?') {
      // Literal in BRE → escape for JS.
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return new RegExp(out, flags);
}

// Apply an ed substitution: `repl` may contain `&` (whole match) and
// `\1` .. `\9` (backreferences). We rewrite to JS replacement syntax
// (`$&`, `$1`..) then call String.prototype.replace.
function _edReplToJs(repl) {
  let out = '';
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c === '\\') {
      const next = repl[i + 1];
      if (next >= '0' && next <= '9') {
        out += '$' + next;
        i += 2;
        continue;
      }
      if (next === '&') { out += '&'; i += 2; continue; }
      if (next === '\\') { out += '\\\\'; i += 2; continue; }
      // Other escapes pass through (\n → newline etc.)
      out += '\\' + (next != null ? next : '');
      i += next != null ? 2 : 1;
      continue;
    }
    if (c === '&')  { out += '$&';   i++; continue; }
    if (c === '$')  { out += '$$';   i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function applySubstitute(line, re, repl, global) {
  const jsRepl = _edReplToJs(repl);
  if (global) {
    const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return line.replace(gre, jsRepl);
  }
  return line.replace(re, jsRepl);
}

// -- address.js --

// address.js — parse and resolve ed addresses.
//
// Supported forms:
//   <n>           absolute line number
//   .             current line
//   $             last line
//   +n / -n       offset from current line
//   +<n> / -<n>   same with explicit number
//   /pat/         forward search from current line (wraps to top)
//   ?pat?         backward search from current line (wraps to bottom)
//   addr1,addr2   range
//   addr1;addr2   range, with side-effect of moving cur to addr1 first
//
// Returns: { range, rest } where `range` is { from, to, explicit } and
// `rest` is the remainder of the command line (the bare command + args).
// `explicit` reports whether an address was given so commands can pick
// sensible defaults.


function _resolveSingle(spec, buf) {
  if (spec.type === 'num')   return spec.value;
  if (spec.type === 'cur')   return buf.cur;
  if (spec.type === 'last')  return buf.lines.length;
  if (spec.type === 'offset') {
    return _resolveSingle(spec.from, buf) + spec.delta;
  }
  if (spec.type === 'search') {
    const re = edToJsRegex(spec.pattern, '');
    return _doSearch(buf, re, spec.forward);
  }
  throw new Error('bad address');
}

function _doSearch(buf, re, forward) {
  const N = buf.lines.length;
  if (N === 0) throw new Error('no match');
  const start = buf.cur;
  for (let i = 1; i <= N; i++) {
    const idx = forward
      ? ((start + i - 1) % N) + 1
      : ((start - i - 1 + N * 2) % N) + 1;
    if (re.test(buf.lines[idx - 1])) return idx;
  }
  throw new Error('no match');
}

// Parse the address portion of `line`. Returns { range, rest }.
// `range`: { from, to, explicit, semi } where semi=true if the `;`
// separator was used (caller updates buf.cur to from before resolving to).
function parseAddress(line) {
  let i = 0;
  function skipWS() { while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++; }

  function parseOne() {
    skipWS();
    if (i >= line.length) return null;
    let base = null;
    const c = line[i];
    if (c === '.') { base = { type: 'cur' }; i++; }
    else if (c === '$') { base = { type: 'last' }; i++; }
    else if (c >= '0' && c <= '9') {
      let n = 0;
      while (i < line.length && line[i] >= '0' && line[i] <= '9') {
        n = n * 10 + (line.charCodeAt(i) - 48);
        i++;
      }
      base = { type: 'num', value: n };
    } else if (c === '/' || c === '?') {
      const close = c;
      const forward = c === '/';
      i++;
      let pat = '';
      while (i < line.length && line[i] !== close) {
        if (line[i] === '\\' && i + 1 < line.length) { pat += line[i] + line[i+1]; i += 2; }
        else { pat += line[i]; i++; }
      }
      if (i < line.length) i++;   // consume the closing delimiter
      base = { type: 'search', pattern: pat, forward };
    }
    // Offsets — repeatable: `.+3-1+2` works (each adds to running sum).
    let delta = 0;
    skipWS();
    while (i < line.length && (line[i] === '+' || line[i] === '-')) {
      const sign = line[i] === '+' ? 1 : -1;
      i++;
      let mag = 1;
      let hasNum = false;
      let n = 0;
      while (i < line.length && line[i] >= '0' && line[i] <= '9') {
        n = n * 10 + (line.charCodeAt(i) - 48);
        i++;
        hasNum = true;
      }
      if (hasNum) mag = n;
      delta += sign * mag;
      skipWS();
    }
    if (base === null && delta === 0) return null;
    if (base === null) base = { type: 'cur' };   // bare +/-N → relative to .
    if (delta !== 0) return { type: 'offset', from: base, delta };
    return base;
  }

  const a1 = parseOne();
  skipWS();
  let sep = null;
  let a2 = null;
  if (i < line.length && (line[i] === ',' || line[i] === ';')) {
    sep = line[i];
    i++;
    a2 = parseOne();
  }
  const rest = line.slice(i);
  return {
    range: { a1, a2, sep, explicit: a1 != null || sep != null },
    rest,
  };
}

// Resolve the parsed range against the buffer. Returns { from, to, semi }.
// Throws on out-of-range / no-match.
function resolveRange(range, buf, defaults) {
  let from, to;
  const { a1, a2, sep } = range;

  if (sep === ',' || sep === ';') {
    // Shortcuts: `,` alone = 1,$  ; `;` alone = .,$
    const r1 = a1 != null
      ? _resolveSingle(a1, buf)
      : (sep === ',' ? 1 : buf.cur);
    // `;` semantics: set cur to r1 before resolving a2.
    if (sep === ';') buf.cur = r1;
    const r2 = a2 != null ? _resolveSingle(a2, buf) : buf.lines.length;
    from = r1; to = r2;
  } else if (a1) {
    const r = _resolveSingle(a1, buf);
    from = to = r;
  } else {
    // No address — use defaults.
    from = defaults.from;
    to = defaults.to;
  }

  // Validate. Lines are 1..N; 0 is allowed only for addr-before-line-1 in
  // a few commands (e.g. `0a` to insert at the top); callers handle that.
  const N = buf.lines.length;
  if (from < 0 || from > N) throw new Error('invalid address');
  if (to < from || to > N) throw new Error('invalid address');
  return { from, to };
}

// Convenience: resolve a single address (used by `m` `t` `r` for the
// destination argument).
function resolveDest(line, buf) {
  const { range, rest } = parseAddress(line);
  if (!range.a1) throw new Error('missing destination');
  const dest = _resolveSingle(range.a1, buf);
  return { dest, rest };
}

// -- commands.js --

// commands.js — ed command implementations.
//
// Each command receives (state, range, rest, ctx) where:
//   state — the buffer state from createBuffer()
//   range — { from, to } already resolved + defaulted
//   rest  — remainder of command line (args after the command char)
//   ctx   — geas builtin context: stdout, stderr, vfs, readLine
//
// Return value: 'quit' to end the main loop, undefined otherwise.
// Throws on user errors (caught by the main loop and printed).


// the same as `.`.
async function _readInputLines(ctx) {
  const lines = [];
  for (;;) {
    let r;
    try { r = await ctx.readLine({ prompt: '' }); }
    catch (e) { break; }
    if (!r || r.eof) break;
    if (r.line === '.') break;
    lines.push(r.line);
  }
  return lines;
}

// `a` — append after the given address (default `.`). Then enter input mode.
async function cmdAppend(state, range, rest, ctx) {
  const at = range.to;   // even when from!=to, append uses the upper bound
  const lines = await _readInputLines(ctx);
  if (lines.length === 0) return;
  snapshot(state);
  insertAfter(state, at, lines);
}

// `i` — insert before the given address (default `.`). Equivalent to
// `a` at `addr - 1`, except `0i` and `1i` both insert at the very top.
async function cmdInsert(state, range, rest, ctx) {
  const at = Math.max(0, range.from - 1);
  const lines = await _readInputLines(ctx);
  if (lines.length === 0) return;
  snapshot(state);
  insertAfter(state, at, lines);
}

// `c` — change. Delete the range, then enter input mode to replace.
async function cmdChange(state, range, rest, ctx) {
  const lines = await _readInputLines(ctx);
  snapshot(state);
  if (range.from > 0) deleteRange(state, range.from, range.to);
  insertAfter(state, range.from - 1, lines);
}

// `d` — delete the range. Cur moves to the line after; cut goes to cut buffer.
function cmdDelete(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  snapshot(state);
  deleteRange(state, range.from, range.to);
}

// `p` — print the range. Cur lands on the last printed line.
async function cmdPrint(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    await ctx.stdout(state.lines[i - 1] + '\n');
  }
  state.cur = range.to;
}

// `n` — print with line numbers.
async function cmdNumber(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    await ctx.stdout(`${i}\t${state.lines[i - 1]}\n`);
  }
  state.cur = range.to;
}

// `l` — list with visible non-printing chars.
async function cmdList(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    const v = state.lines[i - 1]
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f\x7f]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'));
    await ctx.stdout(v + '$\n');
  }
  state.cur = range.to;
}

// `=` — print line number of address (default $).
async function cmdEquals(state, range, rest, ctx) {
  await ctx.stdout(`${range.to}\n`);
}

// `j` — join range (default `.,.+1`) into one line, no separator.
function cmdJoin(state, range, rest, ctx) {
  if (range.from === range.to) return;   // no-op, matches POSIX
  snapshot(state);
  const joined = state.lines.slice(range.from - 1, range.to).join('');
  state.lines.splice(range.from - 1, range.to - range.from + 1, joined);
  state.cur = range.from;
  state.dirty = true;
}

// `u` — undo.
function cmdUndo(state, range, rest, ctx) {
  if (!undo(state)) throw new Error('nothing to undo');
}

// `m addr` — move range to AFTER addr.
function cmdMove(state, range, rest, ctx) {
  const { dest } = resolveDest(rest, state);
  snapshot(state);
  moveRange(state, range.from, range.to, dest);
}

// `t addr` — transfer (copy) range to AFTER addr.
function cmdTransfer(state, range, rest, ctx) {
  const { dest } = resolveDest(rest, state);
  snapshot(state);
  transferRange(state, range.from, range.to, dest);
}

// `s/pat/repl/[flags]` — substitute. Flags: `g` (all matches), number
// (Nth match — not implemented v1), `p` (print after), `i` (case-fold —
// GNU extension).
async function cmdSubstitute(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  const m = _parseSubstitute(rest, state);
  if (!m) throw new Error('bad substitute');
  const re = edToJsRegex(m.pattern, m.iflag ? 'i' : '');
  let matched = 0;
  snapshot(state);
  for (let i = range.from; i <= range.to; i++) {
    const before = state.lines[i - 1];
    const after = applySubstitute(before, re, m.repl, m.gflag);
    if (after !== before) {
      replaceLine(state, i, after);
      matched++;
      if (m.pflag) await ctx.stdout(after + '\n');
    }
  }
  if (matched === 0) throw new Error('no match');
  state.lastSubstitute = m;
}

function _parseSubstitute(rest, state) {
  // s<delim>pat<delim>repl<delim>flags
  // Delimiter is the first character after `s`. `/` is conventional.
  rest = rest.trimStart();
  if (rest.length === 0) {
    // `s` with no args — re-run last s on the current line.
    if (!state.lastSubstitute) return null;
    return state.lastSubstitute;
  }
  const delim = rest[0];
  if (delim === ' ' || delim === '\t' || delim === '\n') return null;
  let i = 1;
  function readField() {
    let out = '';
    while (i < rest.length && rest[i] !== delim) {
      if (rest[i] === '\\' && i + 1 < rest.length) {
        out += rest[i] + rest[i + 1];
        i += 2;
      } else {
        out += rest[i];
        i++;
      }
    }
    if (i < rest.length) i++;   // consume delim
    return out;
  }
  const pattern = readField();
  const repl = readField();
  const flagStr = rest.slice(i).trim();
  return {
    pattern, repl,
    gflag: flagStr.includes('g'),
    pflag: flagStr.includes('p'),
    iflag: flagStr.includes('i'),
  };
}

// `g/pat/cmd` — global: run cmd on every matching line in range.
// `v/pat/cmd` — inverse: run cmd on every NON-matching line. (Skip v in v1.)
//
// Implementation: mark all matching lines first, then run cmd on each
// (resolving line numbers as the buffer shrinks/grows).
async function cmdGlobal(state, range, rest, ctx, runCommand) {
  // rest looks like `/pat/cmd`
  rest = rest.trimStart();
  if (rest.length === 0) throw new Error('bad global');
  const delim = rest[0];
  let i = 1;
  let pat = '';
  while (i < rest.length && rest[i] !== delim) {
    if (rest[i] === '\\' && i + 1 < rest.length) { pat += rest[i] + rest[i+1]; i += 2; }
    else { pat += rest[i]; i++; }
  }
  if (i < rest.length) i++;
  const cmd = rest.slice(i).trim() || 'p';
  const re = edToJsRegex(pat, '');
  // Mark matches by line content (an immutable signature, so we don't
  // confuse index after edits). Walk a copy of the lines.
  const targets = [];
  for (let n = range.from; n <= range.to; n++) {
    if (re.test(state.lines[n - 1])) targets.push(state.lines[n - 1]);
  }
  snapshot(state);
  for (const sig of targets) {
    // Find the (probably-moved) line index by content. Naive but
    // matches what ed does — global iterates over each matched line
    // once.
    const idx = state.lines.indexOf(sig) + 1;
    if (idx <= 0) continue;
    state.cur = idx;
    await runCommand(`${idx}${cmd}`);
  }
}

// `w [file]` — write buffer to file. With `>>file`, append.
async function cmdWrite(state, range, rest, ctx, append) {
  rest = rest.trim();
  let target = state.filename;
  if (rest.length > 0) {
    if (rest.startsWith('>>')) { append = true; rest = rest.slice(2).trim(); }
    if (rest.length > 0) target = rest;
  }
  if (!target) throw new Error('no current filename');
  const block = state.lines.slice(range.from - 1, range.to).join('\n')
    + (state.lines.length > 0 ? '\n' : '');
  if (append) {
    let prev = '';
    try { prev = await ctx.vfs.readFile(target, 'utf8'); } catch { /* */ }
    await ctx.vfs.writeFile(target, prev + block);
  } else {
    await ctx.vfs.writeFile(target, block);
  }
  if (!state.filename) state.filename = target;
  state.dirty = false;
  await ctx.stdout(`${block.length}\n`);
}

// `r [file]` — read file AFTER the given address (default $).
async function cmdRead(state, range, rest, ctx) {
  const target = rest.trim() || state.filename;
  if (!target) throw new Error('no current filename');
  let content;
  try { content = await ctx.vfs.readFile(target, 'utf8'); }
  catch { throw new Error(`cannot open ${target}`); }
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  snapshot(state);
  insertAfter(state, range.to, lines);
  await ctx.stdout(`${content.length}\n`);
}

// `e [file]` — discard buffer, edit new file.
async function cmdEdit(state, range, rest, ctx) {
  if (state.dirty && !state.quitPending) {
    state.quitPending = true;
    throw new Error('warning: buffer modified');
  }
  state.quitPending = false;
  const target = rest.trim() || state.filename;
  if (!target) throw new Error('no current filename');
  let content;
  try { content = await ctx.vfs.readFile(target, 'utf8'); }
  catch { throw new Error(`cannot open ${target}`); }
  snapshot(state);
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  state.lines = lines;
  state.filename = target;
  state.cur = lines.length;
  state.dirty = false;
  await ctx.stdout(`${content.length}\n`);
}

// `f [file]` — get or set current filename.
async function cmdFilename(state, range, rest, ctx) {
  rest = rest.trim();
  if (rest.length > 0) state.filename = rest;
  if (state.filename) await ctx.stdout(state.filename + '\n');
}

// `q` — quit. First call with dirty buffer warns; second confirms.
async function cmdQuit(state, range, rest, ctx) {
  if (state.dirty && !state.quitPending) {
    state.quitPending = true;
    throw new Error('warning: buffer modified');
  }
  return 'quit';
}

// `Q` — force quit. No warning.
function cmdForceQuit(state, range, rest, ctx) {
  return 'quit';
}

// `wq [file]` — write + quit (GNU shortcut).
async function cmdWriteQuit(state, range, rest, ctx) {
  await cmdWrite(state, range, rest, ctx, false);
  return 'quit';
}

// `H` — toggle verbose-error mode (POSIX default off; we default on).
function cmdToggleH(state, range, rest, ctx) {
  state.verboseErrors = !state.verboseErrors;
}

// `P` — toggle prompt visibility.
function cmdToggleP(state, range, rest, ctx) {
  state.showPrompt = !state.showPrompt;
}

// -- api.js --

// api.js — ed main loop. Exposed as runEd(argv, ctx); geas's pkg
// command pattern wraps this into a one-line builtin.




const DEFAULTS_CURRENT_LINE = (buf) => ({ from: buf.cur, to: buf.cur });
const DEFAULTS_WHOLE_BUFFER = (buf) => ({ from: 1, to: buf.lines.length });
const DEFAULTS_LAST_LINE    = (buf) => ({ from: buf.lines.length, to: buf.lines.length });
const DEFAULTS_JOIN         = (buf) => ({ from: buf.cur, to: Math.min(buf.cur + 1, buf.lines.length) });

const COMMANDS = {
  a: { fn: cmdAppend,     defaults: DEFAULTS_CURRENT_LINE },
  i: { fn: cmdInsert,     defaults: DEFAULTS_CURRENT_LINE },
  c: { fn: cmdChange,     defaults: DEFAULTS_CURRENT_LINE },
  d: { fn: cmdDelete,     defaults: DEFAULTS_CURRENT_LINE },
  p: { fn: cmdPrint,      defaults: DEFAULTS_CURRENT_LINE },
  n: { fn: cmdNumber,     defaults: DEFAULTS_CURRENT_LINE },
  l: { fn: cmdList,       defaults: DEFAULTS_CURRENT_LINE },
  '=': { fn: cmdEquals,   defaults: DEFAULTS_LAST_LINE },
  j: { fn: cmdJoin,       defaults: DEFAULTS_JOIN },
  u: { fn: cmdUndo,       defaults: DEFAULTS_CURRENT_LINE },
  m: { fn: cmdMove,       defaults: DEFAULTS_CURRENT_LINE },
  t: { fn: cmdTransfer,   defaults: DEFAULTS_CURRENT_LINE },
  s: { fn: cmdSubstitute, defaults: DEFAULTS_CURRENT_LINE },
  g: { fn: cmdGlobal,     defaults: DEFAULTS_WHOLE_BUFFER },
  w: { fn: cmdWrite,      defaults: DEFAULTS_WHOLE_BUFFER },
  r: { fn: cmdRead,       defaults: DEFAULTS_LAST_LINE },
  e: { fn: cmdEdit,       defaults: DEFAULTS_CURRENT_LINE },
  f: { fn: cmdFilename,   defaults: DEFAULTS_CURRENT_LINE },
  q: { fn: cmdQuit,       defaults: DEFAULTS_CURRENT_LINE },
  Q: { fn: cmdForceQuit,  defaults: DEFAULTS_CURRENT_LINE },
  H: { fn: cmdToggleH,    defaults: DEFAULTS_CURRENT_LINE },
  P: { fn: cmdToggleP,    defaults: DEFAULTS_CURRENT_LINE },
};

function _parseArgs(argv) {
  // argv[0] = 'ed', argv[1..] = options + filename.
  const opts = { posix: false, script: false, prompt: null, filename: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--posix') opts.posix = true;
    else if (a === '--script' || a === '-s' || a === '-q') opts.script = true;
    else if (a.startsWith('--prompt=')) opts.prompt = a.slice('--prompt='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { /* unknown — silently ignore in v1 */ }
    else opts.filename = a;
  }
  return opts;
}

const HELP = `usage: ed [--posix] [--script] [--prompt=STR] [FILE]

A line-oriented text editor in the POSIX ed tradition with GNU-ish
defaults (visible prompt, verbose errors, wq shortcut).

commands:
  a/i/c   append / insert / change (enter input mode; '.' alone to end)
  d       delete
  p/n/l   print / number / list with control-char escapes
  =       print line number of address (default $)
  j       join consecutive lines
  m/t     move / transfer lines to AFTER address
  u       undo (one level)
  s/p/r/g substitute   s/old/new/[gpi]
  g/p/c   global       g/pattern/command
  e/f/r/w edit / filename / read-into / write
  wq      write and quit
  q/Q     quit / force quit
  H/P     toggle verbose errors / prompt

addresses:
  N       line N        .  current
  $       last line     +N -N   relative
  /pat/   forward       ?pat?   backward
  a1,a2   range         ,   1,$    ;   .,$
`;

async function runEd(argv, ctx) {
  const opts = _parseArgs(argv);
  if (opts.help) {
    await ctx.stdout(HELP);
    return 0;
  }

  const buf = createBuffer();
  if (opts.posix) {
    buf.posix = true;
    buf.showPrompt = false;
    buf.verboseErrors = false;
  }
  if (opts.prompt != null) {
    buf.prompt = opts.prompt;
    buf.showPrompt = true;
  }

  if (opts.filename) {
    buf.filename = opts.filename;
    try {
      const content = await ctx.vfs.readFile(opts.filename, 'utf8');
      const lines = content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      buf.lines = lines;
      buf.cur = lines.length;
      await ctx.stdout(`${content.length}\n`);
    } catch {
      // ed convention: report no-file as a single `?` (or verbose).
      if (buf.verboseErrors) await ctx.stderr(`${opts.filename}: cannot open\n`);
      else await ctx.stderr('?\n');
    }
  }

  // The dispatcher. Recursive callable for `g/pat/cmd`.
  async function runCommand(line) {
    if (line === '') {
      // Empty line — move to next line and print it.
      if (buf.cur < buf.lines.length) buf.cur++;
      if (buf.cur >= 1) await ctx.stdout(buf.lines[buf.cur - 1] + '\n');
      return;
    }
    const { range: rangeSpec, rest } = parseAddress(line);
    // The command char.
    let cmdChar, args;
    if (rest.length === 0) {
      // Address-only line: jump to that line and print it.
      if (!rangeSpec.explicit) return;
      const r = resolveRange(rangeSpec, buf, DEFAULTS_CURRENT_LINE(buf));
      buf.cur = r.to;
      if (buf.cur >= 1) await ctx.stdout(buf.lines[buf.cur - 1] + '\n');
      return;
    }
    cmdChar = rest[0];
    args = rest.slice(1);
    // `wq` two-char shortcut.
    if (cmdChar === 'w' && args[0] === 'q') {
      const r = resolveRange(rangeSpec, buf, DEFAULTS_WHOLE_BUFFER(buf));
      const result = await cmdWriteQuit(buf, r, args.slice(1), ctx);
      return result;
    }
    const spec = COMMANDS[cmdChar];
    if (!spec) throw new Error(`unknown command: ${cmdChar}`);
    const r = resolveRange(rangeSpec, buf, spec.defaults(buf));
    // `g` needs the dispatcher for recursive execution.
    if (cmdChar === 'g') {
      return await cmdGlobal(buf, r, args, ctx, runCommand);
    }
    // `w` extra: `>>` append handling.
    if (cmdChar === 'w') {
      return await cmdWrite(buf, r, args, ctx, false);
    }
    return await spec.fn(buf, r, args, ctx);
  }

  // Main REPL.
  for (;;) {
    let cmdLine;
    try {
      const promptStr = buf.showPrompt ? buf.prompt : '';
      const r = await ctx.readLine({ prompt: promptStr });
      if (!r || r.eof) break;
      cmdLine = r.line != null ? r.line : '';
    } catch (e) {
      await ctx.stderr(`ed: ${e.message || e}\n`);
      break;
    }
    let result;
    try { result = await runCommand(cmdLine); }
    catch (e) {
      buf.lastError = e.message;
      if (buf.verboseErrors) await ctx.stderr(`? ${e.message}\n`);
      else await ctx.stderr('?\n');
      // Don't clear quitPending here — it's set BY the warning thrower
      // and consumed by the next q/e to confirm.
      continue;
    }
    // A successful command clears the quit-pending flag.
    buf.quitPending = false;
    if (result === 'quit') break;
  }

  return 0;
}

// -- ops.js --

// op (proto) — the op descriptor model, harvested into geas FIRST (op-over-geas: the
// substrate's first real consumer). Lives here until a 2nd consumer proves the shape →
// then extract @gcu/op. Design: spec_inbox/gcu-works-substrate-specs/op-effect-and-frontends-NOTE.md.
//
// Effect-class = orthogonal FACETS (the schema behaviour derives from) + named PRESETS (the
// one-word declared API). Nothing here persists yet, so the vocabulary stays revisable.

// ── the facet vocabulary (freeze-grade once a ledger persists it; not yet) ──
const WRITES = ['none', 'view', 'doc', 'fs', 'net'];   // what the op mutates (net incl. devices)
const REVERSE = ['recompute', 'snapshot', 'inverse', 'none'];   // how it undoes

// named presets → facet tuples (declare a preset; the TUPLE is what behaviour reads)
const EFFECT_PRESETS = {
  pure:        { writes: 'none', reverse: 'recompute', pure: true },
  read:        { writes: 'none', reverse: 'recompute', pure: false },
  view:        { writes: 'view', reverse: 'snapshot',  pure: false },
  edit:        { writes: 'doc',  reverse: 'snapshot',  pure: false },
  write:       { writes: 'fs',   reverse: 'snapshot',  pure: false },
  egress:      { writes: 'net',  reverse: 'none',      pure: false },
  destructive: { writes: 'doc',  reverse: 'none',      pure: false },
};

// resolve a declared effect (a preset name OR an explicit partial tuple) → the full tuple
function effectFacets(effect) {
  if (typeof effect === 'string') {
    const f = EFFECT_PRESETS[effect];
    if (!f) throw new Error(`op: unknown effect preset "${effect}"`);
    return f;
  }
  return { writes: 'none', reverse: 'recompute', pure: false, ...effect };   // explicit edge-case tuple
}

// ── behaviour derivations: each reads the ONE facet it cares about (not a switch on preset) ──
function gateOf(facets) {                     // agent / confirm gate
  const base = facets.writes === 'net' ? 'always'
    : (facets.writes === 'doc' || facets.writes === 'fs') ? 'confirm'
      : 'free';                                      // none / view
  return (facets.reverse === 'none' && base === 'confirm') ? 'double' : base;   // irreversible → escalate
}
const undoOf = (facets) => facets.reverse;                                   // recompute|snapshot|inverse|none
const cacheable = (facets) => facets.pure && facets.writes === 'none';       // flowsheet may cache + stale-on-input
const dirtiesDoc = (facets) => facets.writes === 'doc';
const ledgered = (facets) => facets.writes === 'doc' || facets.writes === 'fs' || facets.writes === 'net';

// ── coherence validator: rejects the nonsense tuples facets can over-generate ──
function validateEffect(effect) {
  const f = effectFacets(effect);
  if (!WRITES.includes(f.writes)) return `bad writes "${f.writes}"`;
  if (!REVERSE.includes(f.reverse)) return `bad reverse "${f.reverse}"`;
  if (f.pure && f.writes !== 'none') return `pure op cannot write (writes:${f.writes})`;
  if (f.writes === 'none' && f.reverse !== 'recompute') return `non-writing op must be reverse:recompute`;
  if (f.writes === 'net' && f.reverse === 'recompute') return `network op cannot be reverse:recompute`;
  return null;
}

// ── the geas builtins, classified by effect — coreutils are the textbook effect cases, so this
// table is the facet taxonomy's acceptance test. Each descriptor is the SINGLE source the doc
// projection renders: `summary` = the NAME line; optional `synopsis` (string | string[]),
// `doc` (DESCRIPTION prose, \n\n-separated paragraphs ok), `examples` (string[]), `seeAlso`
// (related command names). Synopses reflect the flags geas ACTUALLY parses, not the full
// GNU surface — they're honest about this implementation. ──
const GEAS_OPS = {
  // pure — output is a function of args/stdin, no side effect
  echo: {
    effect: 'pure', summary: 'write arguments to stdout',
    synopsis: 'echo [-neE] [arg ...]',
    doc: 'Write each argument to stdout, separated by single spaces and followed by a newline. `-n` suppresses the trailing newline; `-e` enables backslash escape interpretation (\\n, \\t, …); `-E` disables it (the default). Flags combine, e.g. -ne.',
    examples: ['echo hello world', 'echo -n "no trailing newline"', 'echo -e "col1\\tcol2"'],
    seeAlso: ['printf'],
  },
  printf: {
    effect: 'pure', summary: 'format and print data',
    synopsis: 'printf format [arg ...]',
    doc: 'Format and print ARGs under the control of FORMAT — literal text, backslash escapes, and % conversion specs (%s string, %d integer, %x hex, %f float, …). The format is reused until all arguments are consumed.',
    examples: ['printf "%s = %d\\n" count 42', 'printf "%05.2f\\n" 3.14159'],
    seeAlso: ['echo'],
  },
  seq: {
    effect: 'pure', summary: 'print a sequence of numbers',
    synopsis: 'seq [-s sep] [first [incr]] last',
    doc: 'Print numbers from FIRST (default 1) to LAST, stepping by INCR (default 1), one per line. `-s` sets the separator instead of a newline.',
    examples: ['seq 5', 'seq 2 2 10', 'seq -s , 1 5'],
  },
  true: {
    effect: 'pure', summary: 'do nothing, successfully',
    doc: 'Do nothing and exit with status 0. Used as a no-op or to force a success status, e.g. in `while true` loops.',
    seeAlso: ['false', ':'],
  },
  false: {
    effect: 'pure', summary: 'do nothing, unsuccessfully',
    doc: 'Do nothing and exit with status 1 (failure). The counterpart to `true`.',
    seeAlso: ['true', ':'],
  },
  ':': {
    effect: 'pure', summary: 'the null command — expand args, return success',
    synopsis: ': [arg ...]',
    doc: 'The null command. Expands its arguments (so expansion side effects happen) and returns success without doing anything else. Common as a no-op placeholder or a `while :` infinite loop.',
    seeAlso: ['true'],
  },
  test: {
    effect: 'pure', summary: 'evaluate a conditional expression',
    synopsis: 'test expression',
    doc: 'Evaluate a conditional EXPRESSION, exiting 0 (true) or 1 (false). File tests: -e exists, -f regular file, -d directory, -s non-empty, -r/-w/-x access. String tests: -z empty, -n non-empty, = / !=. Numeric: -eq -ne -lt -le -gt -ge. Combine with -a (and), -o (or).',
    examples: ['test -f /etc/works.json', 'test "$count" -gt 10'],
    seeAlso: ['['],
  },
  '[': {
    effect: 'pure', summary: 'evaluate a conditional expression (test)',
    synopsis: '[ expression ]',
    doc: 'An alias for `test` that requires a closing `]` as its final argument, so conditionals read naturally as `[ -f file ]`.',
    examples: ['[ -d /tmp ] && echo present'],
    seeAlso: ['test'],
  },
  sort: {
    effect: 'pure', summary: 'sort lines of text',
    synopsis: 'sort [-nru] [file ...]',
    doc: 'Sort the lines of FILEs (or stdin). Lexicographic by default; `-n` numeric, `-r` reverse, `-u` discard duplicate lines.',
    examples: ['sort names.txt', 'sort -nr scores.txt', 'ls | sort'],
    seeAlso: ['uniq'],
  },
  uniq: {
    effect: 'pure', summary: 'filter adjacent repeated lines',
    synopsis: 'uniq [-cdu] [file]',
    doc: 'Collapse adjacent matching lines (sort the input first for global uniqueness). `-c` prefix each line with its repeat count, `-d` only repeated lines, `-u` only non-repeated lines.',
    examples: ['sort log.txt | uniq', 'sort log.txt | uniq -c'],
    seeAlso: ['sort'],
  },
  cut: {
    effect: 'pure', summary: 'select fields/columns from each line',
    synopsis: ['cut -f list [-d delim] [file ...]', 'cut -c list [file ...]'],
    doc: 'Select portions of each line. `-f` picks delimited fields (delimiter set by `-d`, default TAB); `-c` picks character positions. LIST is comma/range-separated, e.g. 1,3-5.',
    examples: ['cut -d, -f1,3 data.csv', 'cut -c1-10 file.txt'],
    seeAlso: ['tr', 'grep'],
  },
  tr: {
    effect: 'pure', summary: 'translate or delete characters',
    synopsis: 'tr [-cds] set1 [set2]',
    doc: 'Translate, squeeze, or delete characters from stdin. By default maps each char of SET1 to SET2. `-d` deletes SET1, `-s` squeezes runs of SET1 to one, `-c` complements (operate on chars NOT in SET1).',
    examples: ['tr a-z A-Z', 'tr -d " "', 'echo "a   b" | tr -s " "'],
    seeAlso: ['cut'],
  },
  base64: {
    effect: 'pure', summary: 'base64 encode/decode',
    synopsis: 'base64 [-d] [file]',
    doc: 'Base64-encode stdin or FILE (output wrapped at 76 columns), or decode with `-d`.',
    examples: ['echo hi | base64', 'cat token.b64 | base64 -d'],
    seeAlso: ['md5sum', 'sha256sum'],
  },
  md5sum: {
    effect: 'pure', summary: 'compute MD5 checksums',
    synopsis: 'md5sum [file ...]',
    doc: 'Compute the MD5 checksum of each FILE (or stdin). Prints the hex digest followed by the filename.',
    examples: ['md5sum archive.bin'],
    seeAlso: ['sha256sum', 'base64'],
  },
  sha256sum: {
    effect: 'pure', summary: 'compute SHA-256 checksums',
    synopsis: 'sha256sum [file ...]',
    doc: 'Compute the SHA-256 checksum of each FILE (or stdin). Prints the hex digest followed by the filename.',
    examples: ['sha256sum dist.zip'],
    seeAlso: ['md5sum'],
  },
  // read — reads the fs / session state, no mutation
  pwd: {
    effect: 'read', summary: 'print the working directory',
    synopsis: 'pwd',
    doc: 'Print the absolute pathname of the current working directory.',
    seeAlso: ['cd'],
  },
  cat: {
    effect: 'read', summary: 'concatenate files to stdout',
    synopsis: 'cat [file ...]',
    doc: 'Concatenate FILEs to stdout, in order. With no files, copy stdin through. (geas\'s cat takes no flags.)',
    examples: ['cat README.md', 'cat part1 part2 > whole.txt'],
    seeAlso: ['head', 'tail'],
  },
  ls: {
    effect: 'read', summary: 'list directory contents',
    synopsis: 'ls [-la] [path ...]',
    doc: 'List the contents of each PATH (default: the current directory), sorted by name. `-l` long format (type flag, size, name); `-a` include dotfiles. Flags combine, e.g. -la.',
    examples: ['ls', 'ls -la /home/nb', 'ls /projects'],
    seeAlso: ['tree', 'stat', 'find'],
  },
  tree: {
    effect: 'read', summary: 'list contents as an indented tree',
    synopsis: 'tree [-L level] [path]',
    doc: 'List PATH (default cwd) recursively as an indented tree. `-L` (alias --level) limits how deep the descent goes.',
    examples: ['tree', 'tree -L 2 /projects'],
    seeAlso: ['ls', 'find'],
  },
  stat: {
    effect: 'read', summary: 'display file status',
    synopsis: 'stat [-c format] [file ...]',
    doc: 'Display status (type, size, metadata) for each FILE. `-c` selects a custom format string, e.g. %n name, %s size.',
    examples: ['stat notebook.txt', "stat -c '%s' big.bin"],
    seeAlso: ['ls'],
  },
  find: {
    effect: 'read', summary: 'search for files',
    synopsis: 'find [path] [expression]',
    doc: 'Recursively search PATH for entries matching an EXPRESSION. Tests: -name / -iname (glob), -path, -type f|d, -size, -empty, -maxdepth / -mindepth. Actions: -print (default), -print0 (NUL-separated, pairs with `xargs -0`). Combine with -a (and) / -o (or).',
    examples: ["find . -name '*.txt'", 'find /projects -type d', "find . -name '*.tmp' -print0 | xargs -0 rm"],
    seeAlso: ['ls', 'grep', 'xargs'],
  },
  head: {
    effect: 'read', summary: 'output the first part of files',
    synopsis: 'head [-n count] [file ...]',
    doc: 'Output the first COUNT lines (default 10) of each FILE or stdin. `-n N` sets the count; the shorthand `-N` works too.',
    examples: ['head -n 5 log.txt', 'ls | head'],
    seeAlso: ['tail', 'cat'],
  },
  tail: {
    effect: 'read', summary: 'output the last part of files',
    synopsis: 'tail [-n count] [file ...]',
    doc: 'Output the last COUNT lines (default 10) of each FILE or stdin. `-n N` sets the count; the shorthand `-N` works too.',
    examples: ['tail -n 20 log.txt'],
    seeAlso: ['head', 'cat'],
  },
  wc: {
    effect: 'read', summary: 'count lines, words and bytes',
    synopsis: 'wc [-lwc] [file ...]',
    doc: 'Count lines, words, and bytes of FILEs or stdin. With no flag, prints all three; `-l` lines only, `-w` words, `-c` bytes.',
    examples: ['wc -l file.txt', 'ls | wc -l'],
    seeAlso: ['grep'],
  },
  grep: {
    effect: 'read', summary: 'search text for a pattern',
    synopsis: 'grep [-icnvF] pattern [file ...]',
    doc: 'Print the lines of FILEs (or stdin) matching a regular-expression PATTERN. `-i` ignore case, `-v` invert (print non-matching), `-c` print only a count, `-n` prefix line numbers, `-F` treat the pattern as a fixed string (no regex).',
    examples: ['grep -i error log.txt', "ls | grep '\\.js$'", 'grep -c TODO src.js'],
    seeAlso: ['find', 'cut', 'wc'],
  },
  du: {
    effect: 'read', summary: 'estimate file space usage',
    synopsis: 'du [-hs] [-d depth] [path ...]',
    doc: 'Estimate disk usage of each PATH, summed recursively. `-h` human-readable sizes, `-s` print only the grand total, `-d` limit the reported subtree depth.',
    examples: ['du -sh /projects', 'du -d1 /home'],
    seeAlso: ['df', 'ls'],
  },
  df: {
    effect: 'read', summary: 'report filesystem space usage',
    synopsis: 'df [-h]',
    doc: 'Report space usage of the mounted VFS filesystems. `-h` for human-readable sizes.',
    examples: ['df -h'],
    seeAlso: ['du'],
  },
  which: {
    effect: 'read', summary: 'locate a command',
    synopsis: 'which name ...',
    doc: 'Report, for each NAME, whether it resolves to a builtin, a shell function, or is not found.',
    examples: ['which ls grep frobnicate'],
    seeAlso: ['command', 'op'],
  },
  date: {
    effect: 'read', summary: 'print the date and time',
    synopsis: 'date [+format]',
    doc: 'Print the current date and time. A leading `+FORMAT` controls the output with strftime-style specifiers (%Y %m %d %H %M %S %a %b %e %T).',
    examples: ['date', "date +%Y-%m-%d"],
  },
  env: {
    effect: 'read', summary: 'print the environment',
    synopsis: 'env',
    doc: 'Print the shell environment, one NAME=value pair per line.',
    examples: ['env', 'env | grep PATH'],
    seeAlso: ['export', 'set'],
  },
  read: {
    effect: 'read', summary: 'read a line of input into variables',
    synopsis: 'read [-rs] [-p prompt] [-n n] [-d delim] [-t sec] name ...',
    doc: 'Read one line of input and split it across the NAMEs by $IFS. `-r` raw (no backslash escapes), `-p` print PROMPT first, `-s` silent (no echo), `-n N` stop after N characters, `-d` end at DELIM instead of newline, `-t` time out after SEC seconds.',
    examples: ['read -p "Name: " name', 'read -r line'],
    seeAlso: ['echo'],
  },
  // view — mutates session/shell state (cwd, vars, screen), reversible, not the fs/a doc
  cd: {
    effect: 'view', summary: 'change the working directory',
    synopsis: 'cd [dir]',
    doc: 'Change the working directory to DIR (default $HOME) and update $PWD. Reversible within the session — it touches shell state, not the filesystem.',
    examples: ['cd /projects', 'cd ..', 'cd'],
    seeAlso: ['pwd'],
  },
  clear: {
    effect: 'view', summary: 'clear the terminal screen',
    synopsis: 'clear',
    doc: 'Clear the terminal screen and move the cursor to the top-left.',
  },
  set: {
    effect: 'view', summary: 'set shell options / positional params',
    synopsis: 'set [-o option] [+o option] [arg ...]',
    doc: 'Set or unset shell options and positional parameters. `-o name` enables an option (errexit, nounset, xtrace, …), `+o name` disables it. Bare ARGs replace the positional parameters $1, $2, ….',
    examples: ['set -o errexit', 'set -- a b c'],
    seeAlso: ['export', 'shift'],
  },
  export: {
    effect: 'view', summary: 'mark variables for the environment',
    synopsis: 'export name[=value] ...',
    doc: 'Mark variables for export to the environment of subsequently run commands. With `=value`, assign first.',
    examples: ['export PATH=/bin:/usr/bin', 'export DEBUG=1'],
    seeAlso: ['env', 'set', 'local'],
  },
  local: {
    effect: 'view', summary: 'declare a function-local variable',
    synopsis: 'local name[=value] ...',
    doc: 'Declare variables local to the current shell function; they are unset when the function returns. Valid only inside a function.',
    examples: ['local count=0'],
    seeAlso: ['export', 'set'],
  },
  shift: {
    effect: 'view', summary: 'shift positional parameters',
    synopsis: 'shift [n]',
    doc: 'Shift the positional parameters left by N (default 1): $2 becomes $1, and so on. Used to consume arguments in a loop.',
    examples: ['shift', 'shift 2'],
    seeAlso: ['set'],
  },
  // write — reversible fs mutation
  mkdir: {
    effect: 'write', summary: 'make directories',
    synopsis: 'mkdir [-p] dir ...',
    doc: 'Create each DIRectory. `-p` creates missing parent directories and does not error if the target already exists.',
    examples: ['mkdir build', 'mkdir -p a/b/c'],
    seeAlso: ['rm', 'touch'],
  },
  touch: {
    effect: 'write', summary: 'create files / update timestamps',
    synopsis: 'touch file ...',
    doc: 'Create each FILE empty if it does not exist, or update its modification time if it does.',
    examples: ['touch notes.txt'],
    seeAlso: ['mkdir', 'cat'],
  },
  cp: {
    effect: 'write', summary: 'copy files',
    synopsis: 'cp [-r] source ... dest',
    doc: 'Copy SOURCE to DEST (or into DEST when DEST is a directory). `-r` copies directories recursively. The copy is reversible by removing the new file.',
    examples: ['cp a.txt b.txt', 'cp -r src/ backup/'],
    seeAlso: ['mv', 'rm'],
  },
  mv: {
    effect: 'write', summary: 'move or rename files',
    synopsis: 'mv source ... dest',
    doc: 'Rename SOURCE to DEST, or move one or more SOURCEs into a DEST directory.',
    examples: ['mv old.txt new.txt', 'mv *.png images/'],
    seeAlso: ['cp', 'rm'],
  },
  tee: {
    effect: 'write', summary: 'copy stdin to stdout and to files',
    synopsis: 'tee [-a] file ...',
    doc: 'Copy stdin to stdout AND to each FILE. `-a` appends instead of overwriting.',
    examples: ['ls | tee listing.txt', 'echo log | tee -a app.log'],
    seeAlso: ['cat'],
  },
  // destructive — irreversible loss (fs, not a doc → the explicit tuple, not the doc `destructive` preset)
  rm: {
    effect: { writes: 'fs', reverse: 'none' }, summary: 'remove files and directories',
    synopsis: 'rm [-rf] file ...',
    doc: 'Remove each FILE. `-r` recurses into directories, `-f` ignores missing files and never prompts.\n\nIrreversible — there is no trash. Because the descriptor declares writes:fs + reverse:none, an agent is gated to a double-confirm before this runs.',
    examples: ['rm tmp.txt', 'rm -rf build/'],
    seeAlso: ['mv', 'mkdir'],
  },
  // meta — effect is the UNION of whatever they run (dynamic); conservative default, noted
  eval: {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'run arguments as a command (effect = what it runs)',
    synopsis: 'eval [arg ...]',
    doc: 'Concatenate ARGs into one command and execute it in the current shell. The real effect is whatever that command does; the descriptor\'s classification is a conservative upper bound, since the target is only known at runtime.',
    examples: ['eval "$cmd"'],
    seeAlso: ['source', 'command', 'xargs'],
  },
  source: {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'execute a script in the current shell (effect = the script)',
    synopsis: 'source file [arg ...]',
    doc: 'Read and execute commands from FILE in the CURRENT shell, so its variable and function definitions persist. Effect = the script\'s effect.',
    examples: ['source ~/.geasrc'],
    seeAlso: ['.', 'eval'],
  },
  '.': {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'execute a script in the current shell (source)',
    synopsis: '. file [arg ...]',
    doc: 'Synonym for `source`: execute FILE in the current shell.',
    examples: ['. ./env.sh'],
    seeAlso: ['source'],
  },
  command: {
    effect: 'read', summary: 'run a command, bypassing functions',
    synopsis: 'command name [arg ...]',
    doc: 'Run NAME as a builtin or external command, bypassing any shell function of the same name.',
    examples: ['command ls'],
    seeAlso: ['which', 'eval'],
  },
  xargs: {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'build and run commands from stdin (effect = what it runs)',
    synopsis: 'xargs [-0] [-n max] [-I repl] command ...',
    doc: 'Build and execute command lines from whitespace-separated stdin tokens. `-0` reads NUL-separated input (pairs with `find -print0`), `-n` caps arguments per invocation, `-I` substitutes a replacement string per token. Effect = what the built command does.',
    examples: ["find . -name '*.tmp' -print0 | xargs -0 rm", 'ls | xargs -n1 echo'],
    seeAlso: ['find', 'eval'],
  },
  getopts: {
    effect: 'read', summary: 'parse positional parameters as options',
    synopsis: 'getopts optstring name [arg ...]',
    doc: 'Parse positional parameters as options per OPTSTRING, one option per call, for a `while getopts` loop. Sets NAME to the option letter and $OPTARG / $OPTIND.',
    examples: ['while getopts "vf:" opt; do echo "$opt"; done'],
    seeAlso: ['set', 'shift'],
  },
  exit: {
    effect: 'view', summary: 'exit the shell',
    synopsis: 'exit [n]',
    doc: 'Exit the shell with status N (default: the status of the last command run).',
    examples: ['exit', 'exit 1'],
    seeAlso: ['return'],
  },
  return: {
    effect: 'view', summary: 'return from a shell function',
    synopsis: 'return [n]',
    doc: 'Return from the current shell function with status N (default: the last command\'s status). Valid only inside a function.',
    examples: ['return 0'],
    seeAlso: ['exit'],
  },
  // the doc projection itself (so `man man` / `op op` work)
  man: {
    effect: 'read', summary: 'display the manual for a command',
    synopsis: 'man command',
    doc: 'Display the manual page for COMMAND, rendered from its op descriptor: NAME, SYNOPSIS, the EFFECT class (what it writes, whether it is undoable, how an agent is gated), DESCRIPTION, EXAMPLES, and SEE ALSO.',
    examples: ['man rm', 'man find'],
    seeAlso: ['op', 'which'],
  },
  op: {
    effect: 'read', summary: 'browse the op registry by effect',
    synopsis: ['op [name]', 'op list [--effect=preset] [--writes=facet] [--gate=level]'],
    doc: 'Browse the op registry. With no arguments, list every op with its effect preset. `op list` filters by --effect (pure/read/view/edit/write/egress/destructive), --writes (none/view/doc/fs/net), or --gate (free/confirm/double/always). `op NAME` shows that op\'s manual (same as `man NAME`).',
    examples: ['op', 'op list --writes=fs', 'op list --gate=double', 'op rm'],
    seeAlso: ['man', 'which'],
  },
};

// ── the doc projection: render a descriptor as a man page; browse the registry as a catalog ──
const WRITES_HUMAN = { none: 'no side effects', view: 'changes the session', doc: 'edits the document', fs: 'writes the filesystem', net: 'network / device I/O' };
const REVERSE_HUMAN = { recompute: 'recomputable', snapshot: 'undoable', inverse: 'undoable', none: 'not undoable' };
const GATE_HUMAN = { free: 'runs freely', confirm: 'confirms first', double: 'double-confirms', always: 'always asks' };

// effect → human description (the GCU-distinctive man section: what hand-written pages can't carry)
function describeEffect(effect) {
  const f = effectFacets(effect);
  return { preset: typeof effect === 'string' ? effect : 'custom', writes: WRITES_HUMAN[f.writes], undo: REVERSE_HUMAN[f.reverse], gate: GATE_HUMAN[gateOf(f)] };
}

// indent every line of `text` by `pad` (blank lines stay blank — no trailing whitespace).
const indent = (text, pad = '    ') => String(text).split('\n').map((l) => (l ? pad + l : l)).join('\n');

// `man <command>` — render the op descriptor as a man page (NAME · SYNOPSIS? · EFFECT · DESCRIPTION · …).
async function manCmd(argv, ctx) {
  const name = argv[0];
  if (!name) { await ctx.stderr('usage: man <command>\n'); return 1; }
  const op = GEAS_OPS[name];
  if (!op) { await ctx.stderr(`man: no manual entry for ${name}\n`); return 1; }
  const d = describeEffect(op.effect);
  let s = `NAME\n${indent(`${name} — ${op.summary || ''}`)}\n\n`;
  if (op.synopsis) {
    const forms = Array.isArray(op.synopsis) ? op.synopsis : [op.synopsis];
    s += `SYNOPSIS\n${forms.map((f) => indent(f)).join('\n')}\n\n`;
  }
  s += `EFFECT\n${indent(`${d.preset} · ${d.writes} · ${d.undo} · agent: ${d.gate}`)}\n\n`;
  s += `DESCRIPTION\n${indent(op.doc || op.summary || '')}\n`;
  if (op.examples?.length) s += '\nEXAMPLES\n' + op.examples.map((e) => indent(e)).join('\n') + '\n';
  if (op.seeAlso?.length) s += `\nSEE ALSO\n${indent(op.seeAlso.join(', '))}\n`;
  await ctx.stdout(s);
  return 0;
}

// `op` / `op list [--effect=|--writes=|--gate=]` — the registry as a queryable catalog; `op <name>` → man.
async function opCmd(argv, ctx) {
  const head = argv[0];
  if (head && head !== 'list' && GEAS_OPS[head]) return manCmd([head], ctx);   // `op rm` → man rm
  const rest = head === 'list' ? argv.slice(1) : argv;
  const filters = {};
  for (const a of rest) { const m = /^--(effect|writes|gate)=(.+)$/.exec(a); if (m) filters[m[1]] = m[2]; }
  const rows = [];
  for (const [name, op] of Object.entries(GEAS_OPS)) {
    const f = effectFacets(op.effect), preset = typeof op.effect === 'string' ? op.effect : 'custom';
    if (filters.effect && preset !== filters.effect) continue;
    if (filters.writes && f.writes !== filters.writes) continue;
    if (filters.gate && gateOf(f) !== filters.gate) continue;
    rows.push([name, preset, op.summary || '']);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) { await ctx.stdout('(no ops match)\n'); return 0; }
  const nw = Math.max(4, ...rows.map((r) => r[0].length)), pw = Math.max(6, ...rows.map((r) => r[1].length));
  await ctx.stdout(rows.map((r) => `${r[0].padEnd(nw)}  ${r[1].padEnd(pw)}  ${r[2]}`).join('\n') + '\n');
  return 0;
}

// -- builtins.js --

// Default built-ins for geas. Each is `async (argv, ctx) => exitCode`.
//
// The shell ships with a small POSIX-shape set covering the everyday
// operations a notebook user reaches for: I/O glue (echo, cat), navigation
// (pwd, cd, ls), env management (env, export, exit, :), and conditionals
// (test / [). More complete coverage lives in `@gcu/coreutils` (separate
// package, dispatched via ctx.onCommand when geas doesn't recognise a name).
//
// Built-ins MUST read input from ctx.stdin (a string in v0) and write
// output through `await ctx.stdout(...)` / `ctx.stderr(...)` rather than
// any other channel — that's how pipeline routing reaches them.









// Construct a fresh map of the default builtins. Returns a new Map per call
// so consumers can mutate (add/override) without affecting other shells.
function defaultBuiltins() {
  return new Map(Object.entries({
    ...defaultTypedBuiltins(),
    ...archiveBuiltins(),
    ':':      _colon,
    echo:     _echo,
    printf:   _printf,
    true:     _true,
    false:    _false,
    pwd:      _pwd,
    cd:       _cd,
    env:      _env,
    export:   _export,
    exit:     _exit,
    set:      _set,
    read:     _read,
    which:    _which,
    command:  _command,
    local:    _local,
    return:   _return,
    shift:    _shift,
    clear:    _clear,
    eval:     _eval,
    source:   _source,
    '.':      _source,
    getopts:  _getopts,
    cat:      _cat,
    ls:       _ls,
    test:     _test,
    '[':      _testBracket,
    // Generators
    seq:      _seq,
    sleep:    _sleep,
    date:     _date,
    // Filesystem
    mkdir:    _mkdir,
    rm:       _rm,
    touch:    _touch,
    cp:       _cp,
    mv:       _mv,
    stat:     _stat,
    find:     _find,
    tree:     _tree,
    // Text wranglers
    head:     _head,
    tail:     _tail,
    wc:       _wc,
    grep:     _grep,
    sort:     _sort,
    uniq:     _uniq,
    cut:      _cut,
    tee:      _tee,
    xargs:    _xargs,
    tr:       _tr,
    // Disk / hash / encoding
    du:       _du,
    df:       _df,
    base64:   _base64,
    md5sum:   _md5sum,
    sha256sum: _sha256sum,
    // pkg-spec §5: install / list / freeze / remove modules into /lib.
    pkg:      _pkg,
    // gcu-distributions: list / current / export / provision (Works host bridge).
    profile:  _profile,
    // "ed is the standard text editor." POSIX-ish, GNU-sanded defaults.
    ed:       runEd,
    // the op doc-projection: man pages + the queryable op registry, both from GEAS_OPS.
    man:      manCmd,
    op:       opCmd,
  }));
}

// ── individual builtins ──

async function _colon() { return 0; }

async function _echo(argv, ctx) {
  const args = argv.slice(1);
  let newline = true;
  let interpret = false;
  // `-n` no trailing newline; `-e` enable backslash interpretation
  // (bash default off); `-E` explicitly off. Flag combos like `-ne`
  // accepted. Anything else is treated as a positional argument.
  while (args.length && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    if (args[0].includes('e')) interpret = true;
    if (args[0].includes('E')) interpret = false;
    args.shift();
  }
  let text = args.join(' ');
  if (interpret) text = _printfBackslashArg(text);
  await ctx.stdout(text + (newline ? '\n' : ''));
  return 0;
}

async function _true() { return 0; }
async function _false() { return 1; }

async function _pwd(_argv, ctx) {
  await ctx.stdout((ctx.cwd || '/') + '\n');
  return 0;
}

async function _cd(argv, ctx) {
  let target = argv[1];
  if (!target || target === '~') {
    target = ctx.env.get('HOME') || '/';
  } else if (target === '-') {
    target = ctx.env.get('OLDPWD');
    if (!target) {
      await ctx.stderr('cd: OLDPWD not set\n');
      return 1;
    }
    await ctx.stdout(target + '\n');
  } else if (target.startsWith('~/')) {
    target = (ctx.env.get('HOME') || '') + target.slice(1);
  }
  // Make absolute via the existing cwd if needed.
  if (!target.startsWith('/')) {
    const base = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    target = base + target;
  }
  // Normalise simple `..` / `.` segments.
  target = _bNormalizePath(target);
  // Verify target exists if we have a VFS (otherwise trust the caller).
  if (ctx.vfs) {
    try {
      const st = await ctx.vfs.stat(target);
      if (st && st.type !== 'directory') {
        await ctx.stderr(`cd: not a directory: ${target}\n`);
        return 1;
      }
    } catch {
      await ctx.stderr(`cd: no such directory: ${target}\n`);
      return 1;
    }
  }
  ctx.env.set('OLDPWD', ctx.cwd);
  ctx.cwd = target;
  ctx.env.set('PWD', target);
  return 0;
}

async function _env(argv, ctx) {
  // `env` with no args lists the environment.
  // `env NAME=value... cmd args...` runs cmd with overlaid env (v0: just
  // sets in current env; no "run" semantics).
  const overlays = [];
  let i = 1;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
    overlays.push(argv[i]);
    i++;
  }
  if (overlays.length === 0 && i >= argv.length) {
    // List.
    for (const [k, v] of ctx.env) {
      await ctx.stdout(`${k}=${v}\n`);
    }
    return 0;
  }
  // Apply overlays.
  for (const a of overlays) {
    const eq = a.indexOf('=');
    ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
  }
  if (i < argv.length) {
    // env NAME=value cmd args… — run the remaining via the builtin lookup.
    const rest = argv.slice(i);
    const name = rest[0];
    if (ctx.builtins.has(name)) {
      return await ctx.builtins.get(name)(rest, ctx);
    }
    if (ctx.onCommand) {
      return await ctx.onCommand(name, rest, ctx);
    }
    await ctx.stderr(`env: ${name}: command not found\n`);
    return 127;
  }
  return 0;
}

async function _export(argv, ctx) {
  // `export NAME=value` — for v0 just sets in ctx.env (POSIX would mark
  // as "exportable to subprocesses"; we don't distinguish).
  // `export NAME` — marks an existing variable for export.
  // `export` (no args) — lists exported vars.
  if (argv.length === 1) {
    for (const [k, v] of ctx.env) await ctx.stdout(`export ${k}=${v}\n`);
    return 0;
  }
  for (const a of argv.slice(1)) {
    const eq = a.indexOf('=');
    if (eq >= 0) {
      ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
    } else {
      // export of existing var — already in env, no-op
    }
  }
  return 0;
}

async function _exit(argv, _ctx) {
  const code = argv[1] !== undefined ? Number(argv[1]) : 0;
  // Thrown signal; _execProgram catches and stops the script.
  throw { exitCode: Number.isFinite(code) ? (code & 0xff) : 0, _exit: true };
}

async function _cat(argv, ctx) {
  const files = argv.slice(1);
  if (files.length === 0) {
    // No args: pipe stdin through. _bReadInput handles both string stdin
    // AND Typed stdin (via Typed.toString()), so a typed-pipe upstream
    // degrades gracefully.
    await ctx.stdout(await _bReadInput([], ctx));
    return 0;
  }
  if (!ctx.vfs) {
    await ctx.stderr('cat: no VFS configured\n');
    return 1;
  }
  let anyError = 0;
  for (const f of files) {
    const path = _bResolvePath(f, ctx);
    try {
      const text = await ctx.vfs.readFile(path, 'text');
      await ctx.stdout(text);
    } catch (e) {
      await ctx.stderr(`cat: ${f}: ${e.message || 'cannot read'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _ls(argv, ctx) {
  if (!ctx.vfs) {
    await ctx.stderr('ls: no VFS configured\n');
    return 1;
  }
  // Parse args. v0 supports `-l` (long format) and `-a` (show dotfiles).
  let longFmt = false, showHidden = false;
  const paths = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      if (a.includes('l')) longFmt = true;
      if (a.includes('a')) showHidden = true;
      continue;
    }
    paths.push(a);
  }
  if (paths.length === 0) paths.push(ctx.cwd || '/');

  let anyError = 0;
  for (let p of paths) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      if (st.type === 'file') {
        await ctx.stdout(p + '\n');
        continue;
      }
      const entries = await ctx.vfs.readdir(path);
      const names = entries
        .map(e => typeof e === 'string' ? e : e.name)
        .filter(n => showHidden || !n.startsWith('.'))
        .sort();
      if (longFmt) {
        for (const n of names) {
          let line = n;
          try {
            const childPath = path.endsWith('/') ? path + n : path + '/' + n;
            const cst = await ctx.vfs.stat(childPath);
            const flag = cst.type === 'directory' ? 'd' : '-';
            const size = cst.size ?? 0;
            line = `${flag} ${String(size).padStart(8)}  ${n}`;
          } catch { /* fall through with bare name */ }
          await ctx.stdout(line + '\n');
        }
      } else {
        for (const n of names) await ctx.stdout(n + '\n');
      }
    } catch (e) {
      await ctx.stderr(`ls: ${p}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// `test` / `[` — POSIX conditional. v0 covers the common operators; full
// POSIX-spec eval (including `-a` / `-o` / parens) is on the roadmap.
async function _testBracket(argv, ctx) {
  // The `[` builtin requires the last arg to be `]`. Strip it then defer.
  if (argv[argv.length - 1] !== ']') {
    await ctx.stderr('[: missing `]\'\n');
    return 2;
  }
  return await _test(argv.slice(0, -1), ctx);
}

// POSIX test grammar (precedence low → high):
//
//   expr      := or-expr
//   or-expr   := and-expr ( '-o' and-expr )*
//   and-expr  := not-expr ( '-a' not-expr )*
//   not-expr  := '!' not-expr | atom
//   atom      := '(' expr ')' | unary-atom | binary-atom | nonempty-atom
//
// Recursive descent. The compiled predicate is a `(ctx) → Promise<bool>`
// that the outer _test runs once, then translates bool → exit code
// (0 = true, 1 = false, 2 = parse error).
const _TEST_UNARY_OPS = new Set([
  '-z', '-n', '-e', '-f', '-d', '-s', '-r', '-w', '-x',
]);
const _TEST_BINARY_OPS = new Set([
  '=', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge',
]);

async function _test(argv, ctx) {
  const args = argv.slice(1);
  if (args.length === 0) return 1;
  // 1-arg fast path: true iff non-empty. Skipping the parser here lets
  // `[ ( ]` or `[ -a ]` etc. work as plain non-empty tests (POSIX-friendly
  // — single-arg test never invokes operator parsing).
  if (args.length === 1) return args[0].length > 0 ? 0 : 1;
  let predicate;
  try {
    predicate = _testCompile(args);
  } catch (e) {
    await ctx.stderr(`test: ${e.message}\n`);
    return 2;
  }
  try {
    const r = await predicate(ctx);
    return r ? 0 : 1;
  } catch (e) {
    await ctx.stderr(`test: ${e.message || e}\n`);
    return 2;
  }
}

function _testCompile(tokens) {
  const state = { tokens, i: 0 };
  const expr = _testParseOr(state);
  if (state.i !== tokens.length) {
    throw new Error(`unexpected token "${tokens[state.i]}"`);
  }
  return expr;
}

function _testParseOr(state) {
  let left = _testParseAnd(state);
  while (state.tokens[state.i] === '-o') {
    state.i++;
    const right = _testParseAnd(state);
    const l = left, r = right;
    left = async (ctx) => (await l(ctx)) || (await r(ctx));
  }
  return left;
}

function _testParseAnd(state) {
  let left = _testParseNot(state);
  while (state.tokens[state.i] === '-a') {
    state.i++;
    const right = _testParseNot(state);
    const l = left, r = right;
    left = async (ctx) => (await l(ctx)) && (await r(ctx));
  }
  return left;
}

function _testParseNot(state) {
  if (state.tokens[state.i] === '!') {
    state.i++;
    const inner = _testParseNot(state);
    return async (ctx) => !(await inner(ctx));
  }
  return _testParseAtom(state);
}

function _testParseAtom(state) {
  const t = state.tokens[state.i];
  if (t === undefined) throw new Error('missing operand');
  if (t === '(') {
    state.i++;
    const inner = _testParseOr(state);
    if (state.tokens[state.i] !== ')') throw new Error("missing ')'");
    state.i++;
    return inner;
  }
  // 3-arg binary atom: lookahead at i+1.
  const next = state.tokens[state.i + 1];
  if (next !== undefined && _TEST_BINARY_OPS.has(next)) {
    const a = state.tokens[state.i];
    const op = state.tokens[state.i + 1];
    const b = state.tokens[state.i + 2];
    if (b === undefined) throw new Error(`${op}: missing right operand`);
    state.i += 3;
    return async (ctx) => (await _testBinary(a, op, b, ctx)) === 0;
  }
  // 2-arg unary atom.
  if (_TEST_UNARY_OPS.has(t)) {
    const op = state.tokens[state.i];
    const val = state.tokens[state.i + 1];
    if (val === undefined) throw new Error(`${op}: missing argument`);
    state.i += 2;
    return async (ctx) => (await _testUnary(op, val, ctx)) === 0;
  }
  // 1-arg atom: true iff non-empty. Consumes one token regardless of
  // its content (so a bare `X` or `Y` inside a larger expr works).
  state.i++;
  return async () => t.length > 0;
}

async function _testUnary(op, val, ctx) {
  switch (op) {
    case '-z': return val.length === 0 ? 0 : 1;
    case '-n': return val.length > 0 ? 0 : 1;
    case '-e': case '-f': case '-d': case '-s': case '-r': case '-w': case '-x': {
      if (!ctx.vfs) return 1;
      try {
        const st = await ctx.vfs.stat(_bResolvePath(val, ctx));
        if (op === '-e' || op === '-r' || op === '-w' || op === '-x') return 0;
        if (op === '-f') return st.type === 'file' ? 0 : 1;
        if (op === '-d') return st.type === 'directory' ? 0 : 1;
        if (op === '-s') return (st.size ?? 0) > 0 ? 0 : 1;
      } catch { return 1; }
    }
    case '!': {
      // ! VAL — true iff VAL is empty
      return val.length === 0 ? 0 : 1;
    }
  }
  return 2;
}

async function _testBinary(a, op, b, _ctx) {
  switch (op) {
    case '=':   return a === b ? 0 : 1;
    case '!=':  return a !== b ? 0 : 1;
    case '-eq': return _num(a) === _num(b) ? 0 : 1;
    case '-ne': return _num(a) !== _num(b) ? 0 : 1;
    case '-lt': return _num(a) <   _num(b) ? 0 : 1;
    case '-le': return _num(a) <=  _num(b) ? 0 : 1;
    case '-gt': return _num(a) >   _num(b) ? 0 : 1;
    case '-ge': return _num(a) >=  _num(b) ? 0 : 1;
  }
  return 2;
}

function _num(x) { return Number(x); }

// ── helpers ──

function _bResolvePath(p, ctx) {
  if (p.startsWith('/')) return _bNormalizePath(p);
  const base = ctx.cwd && ctx.cwd.endsWith('/') ? ctx.cwd : (ctx.cwd || '/') + '/';
  return _bNormalizePath(base + p);
}

function _bNormalizePath(p) {
  const parts = p.split('/');
  const stack = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

// Argv option parsing helper. Handles `-abc` (combined short flags),
// `-n VALUE` (option arg), `--` (end of options), `-` (stdin placeholder
// kept as a positional). Returns { opts, positionals }.
function _bParseArgs(argv, spec) {
  const opts = {};
  const positionals = [];
  for (const key of Object.keys(spec)) {
    opts[key] = spec[key].default ?? (spec[key].arg ? null : false);
  }
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-') || a.length === 1) {
      positionals.push(a);
      i++;
      continue;
    }
    // Multi-char short cluster: split each.
    const cluster = a.slice(1);
    let consumedNext = false;
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k];
      const matched = Object.keys(spec).find(name => spec[name].short === ch);
      if (!matched) {
        // Unknown flag — let the caller decide. Mark as positional and stop.
        positionals.push('-' + cluster.slice(k));
        break;
      }
      if (spec[matched].arg) {
        // Take the rest of the cluster as the value, or the next argv.
        const rest = cluster.slice(k + 1);
        if (rest.length > 0) { opts[matched] = rest; }
        else { opts[matched] = argv[i + 1]; consumedNext = true; }
        break;
      }
      opts[matched] = true;
    }
    i += consumedNext ? 2 : 1;
  }
  return { opts, positionals };
}

// Read all of stdin or, when paths are given, the concatenated contents
// of those VFS files. Common to head / tail / wc / grep / sort / uniq /
// cut / tee / xargs.
//
// Typed-pipe contract: if stdin drains to a Typed object, fall back to
// its text rendering via toString(). Builtins that don't know about
// types transparently get the canonical text representation.
async function _bReadInput(paths, ctx) {
  if (!paths || paths.length === 0) {
    const v = await drainInput(ctx);
    return typeof v === 'string' ? v : String(v);
  }
  if (!ctx.vfs) throw new Error('VFS not configured');
  const chunks = [];
  for (const p of paths) {
    chunks.push(await ctx.vfs.readFile(_bResolvePath(p, ctx), 'text'));
  }
  return chunks.join('');
}

// ── filesystem builtins ──

async function _mkdir(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('mkdir: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, { p: { short: 'p' } });
  if (positionals.length === 0) {
    await ctx.stderr('mkdir: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      await ctx.vfs.mkdir(path, opts.p ? { recursive: true } : undefined);
    } catch (e) {
      await ctx.stderr(`mkdir: ${p}: ${e.message || 'cannot create'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _rm(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('rm: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, f: { short: 'f' },
  });
  // POSIX combines -R into -r; bash accepts both. We honour either bit.
  const recursive = opts.r;
  const force = opts.f;
  if (positionals.length === 0 && !force) {
    await ctx.stderr('rm: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      if (st.type === 'directory') {
        if (!recursive) {
          await ctx.stderr(`rm: ${p}: is a directory\n`);
          anyError = 1;
          continue;
        }
        // Recursive delete: walk entries, unlink files, rmdir folders.
        await _rmRecursive(ctx.vfs, path);
      } else {
        await ctx.vfs.unlink(path);
      }
    } catch (e) {
      if (!force) {
        await ctx.stderr(`rm: ${p}: ${e.message || 'cannot remove'}\n`);
        anyError = 1;
      }
    }
  }
  return anyError;
}

async function _rmRecursive(vfs, dir) {
  const entries = await vfs.readdir(dir);
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e.name;
    const child = dir.endsWith('/') ? dir + name : dir + '/' + name;
    const st = await vfs.stat(child);
    if (st.type === 'directory') await _rmRecursive(vfs, child);
    else await vfs.unlink(child);
  }
  await vfs.rmdir(dir);
}

// ── cp / mv / stat — thin wrappers over the VFS surface ──
//
// cp [-r] SRC... DST
//   Single SRC, DST is file → copy SRC's bytes to DST (overwrite ok).
//   Multiple SRC or DST is a directory → copy each SRC into DST/<basename>.
//   -r recurses through directory sources, recreating the tree.
//
// mv SRC... DST
//   Same destination rules as cp. Uses vfs.rename when source and dest
//   resolve to the same backend; falls back to copy-then-unlink across
//   backends (the VFS layer typically handles this transparently when
//   you call rename, so we lean on that and fall back only on error).
//
// stat PATH...
//   Prints type, size, and path. Default format is one line per file.
async function _cp(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('cp: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, R: { short: 'R' }, f: { short: 'f' },
  });
  const recursive = opts.r || opts.R;
  if (positionals.length < 2) {
    await ctx.stderr('cp: missing operand (need SRC... DST)\n');
    return 1;
  }
  const dst = positionals[positionals.length - 1];
  const srcs = positionals.slice(0, -1);
  const dstPath = _bResolvePath(dst, ctx);
  let dstIsDir = false;
  try {
    const st = await ctx.vfs.stat(dstPath);
    dstIsDir = st.type === 'directory';
  } catch { /* dst doesn't exist; treat as a file target if single src */ }
  if (srcs.length > 1 && !dstIsDir) {
    await ctx.stderr(`cp: ${dst}: not a directory (need multi-source destination)\n`);
    return 1;
  }
  let anyError = 0;
  for (const src of srcs) {
    const srcPath = _bResolvePath(src, ctx);
    const target = dstIsDir
      ? _bJoinPath(dstPath, _bBasename(srcPath))
      : dstPath;
    try {
      await _cpEntry(ctx, srcPath, target, recursive);
    } catch (e) {
      await ctx.stderr(`cp: ${src}: ${e.message || 'cannot copy'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _cpEntry(ctx, srcPath, dstPath, recursive) {
  const st = await ctx.vfs.stat(srcPath);
  if (st.type === 'directory') {
    if (!recursive) throw new Error('is a directory (use -r)');
    await ctx.vfs.mkdir(dstPath, { recursive: true });
    const entries = await ctx.vfs.readdir(srcPath);
    for (const e of entries) {
      const name = typeof e === 'string' ? e : e.name;
      await _cpEntry(ctx, _bJoinPath(srcPath, name), _bJoinPath(dstPath, name), recursive);
    }
    return;
  }
  // File: copy bytes. Try binary first, fall back to text if the
  // backend doesn't support a raw binary read (some don't).
  let content;
  try {
    content = await ctx.vfs.readFile(srcPath);
  } catch {
    content = await ctx.vfs.readFile(srcPath, 'text');
  }
  await ctx.vfs.writeFile(dstPath, content);
}

async function _mv(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('mv: no VFS configured\n'); return 1; }
  const { positionals } = _bParseArgs(argv, {
    f: { short: 'f' }, n: { short: 'n' },
  });
  if (positionals.length < 2) {
    await ctx.stderr('mv: missing operand (need SRC... DST)\n');
    return 1;
  }
  const dst = positionals[positionals.length - 1];
  const srcs = positionals.slice(0, -1);
  const dstPath = _bResolvePath(dst, ctx);
  let dstIsDir = false;
  try {
    const st = await ctx.vfs.stat(dstPath);
    dstIsDir = st.type === 'directory';
  } catch { /* dst doesn't exist */ }
  if (srcs.length > 1 && !dstIsDir) {
    await ctx.stderr(`mv: ${dst}: not a directory (need multi-source destination)\n`);
    return 1;
  }
  let anyError = 0;
  for (const src of srcs) {
    const srcPath = _bResolvePath(src, ctx);
    const target = dstIsDir
      ? _bJoinPath(dstPath, _bBasename(srcPath))
      : dstPath;
    try {
      // VFS.rename handles same-backend moves natively and may also
      // handle cross-backend (some implementations do copy+unlink
      // internally). If it fails, fall back to recursive copy + remove.
      try {
        await ctx.vfs.rename(srcPath, target);
        continue;
      } catch { /* fall through to copy+unlink */ }
      await _cpEntry(ctx, srcPath, target, /*recursive*/ true);
      // Unlink source (recursive for directories).
      const st = await ctx.vfs.stat(srcPath);
      if (st.type === 'directory') await _rmRecursive(ctx.vfs, srcPath);
      else await ctx.vfs.unlink(srcPath);
    } catch (e) {
      await ctx.stderr(`mv: ${src}: ${e.message || 'cannot move'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _stat(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('stat: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    c: { short: 'c', arg: true }, // -c FORMAT: a stripped-down strftime-like spec
  });
  if (positionals.length === 0) {
    await ctx.stderr('stat: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      const line = opts.c
        ? _statFormat(opts.c, st, p)
        : _statDefault(st, p);
      await ctx.stdout(line + '\n');
    } catch (e) {
      await ctx.stderr(`stat: ${p}: ${e.message || 'cannot stat'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

function _statDefault(st, displayPath) {
  // GNU stat prints a multi-line block; we use a single-line shape
  // that's friendlier to shell pipelines (still parseable). Format:
  //   "<type> <size> <path>"
  // type is one of 'file', 'directory', 'link' (when VFS exposes it).
  const type = st.type || 'unknown';
  const size = st.size ?? 0;
  return `${type.padEnd(9)} ${String(size).padStart(10)}  ${displayPath}`;
}

function _statFormat(fmt, st, displayPath) {
  // POSIX-ish format codes — a subset of GNU's `stat -c`:
  //   %n  filename
  //   %s  size in bytes
  //   %F  type ("regular file", "directory", ...)
  //   %y  mtime (when VFS exposes it; falls back to '-')
  //   %%  literal %
  return fmt.replace(/%./g, (m) => {
    switch (m) {
      case '%n': return displayPath;
      case '%s': return String(st.size ?? 0);
      case '%F': return st.type === 'directory' ? 'directory'
                       : st.type === 'file'      ? 'regular file'
                       : (st.type || 'unknown');
      case '%y': return st.mtime ?? '-';
      case '%%': return '%';
      default:   return m;
    }
  });
}

function _bJoinPath(a, b) {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

function _bBasename(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// ── find — recursive directory walk with predicates ──
//
// find [PATH...] [EXPR...]
//
// Walks each PATH (default: cwd), evaluates EXPR against every entry,
// prints matches one per line. Supported predicates:
//
//   -name PAT       basename glob (* ? [...])
//   -path PAT       full-path glob
//   -iname PAT      case-insensitive -name
//   -type f|d       file vs directory
//   -maxdepth N     don't descend beyond N levels (PATH itself is depth 0)
//   -mindepth N     skip entries shallower than N
//   -size [+-]N[ckMG]  size comparison (c=bytes, k=KiB, M=MiB, G=GiB; default c)
//   -empty          shorthand for `( -type f -size 0c ) -or ( -type d -empty-dir )`
//                   (v0: only the file case; empty directories not detected)
//   -print          explicit print (default action)
//   -print0         null-separated output (-exec scripts love it)
//
// Logical combinators (precedence: ! > -and > -or; -and is implicit):
//
//   ! EXPR | -not EXPR
//   EXPR -and EXPR | EXPR EXPR
//   EXPR -or EXPR
//   ( EXPR )       (each paren needs to be its own argv element)
//
// Notable v0 omissions: -exec, -execdir, -prune, -newer/-mtime, -user,
// regex predicates beyond glob. These are sized-by-need additions.
async function _find(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('find: no VFS configured\n'); return 1; }
  // Split argv into start paths + predicate tokens. POSIX: paths come
  // first, predicates start at the first arg beginning with `-`, `!`,
  // `(`, or matching a known token. (We keep it simple — assume the
  // first arg starting with `-`/`!`/`(`/`,` is the predicate start.)
  const args = argv.slice(1);
  const paths = [];
  let predStart = 0;
  while (predStart < args.length) {
    const a = args[predStart];
    if (a.startsWith('-') || a === '!' || a === '(' || a === ')' || a === ',') break;
    paths.push(a);
    predStart++;
  }
  if (paths.length === 0) paths.push('.');
  const predTokens = args.slice(predStart);
  let predicate;
  try {
    predicate = _findCompile(predTokens);
  } catch (e) {
    await ctx.stderr(`find: ${e.message}\n`);
    return 1;
  }
  const sep = predicate.print0 ? '\0' : '\n';
  let anyError = 0;
  for (const startPath of paths) {
    const abs = _bResolvePath(startPath, ctx);
    try {
      const st = await ctx.vfs.stat(abs);
      await _findWalk({
        absPath: abs,
        displayPath: startPath,
        type: st.type,
        size: st.size ?? 0,
        depth: 0,
      }, predicate, ctx, sep);
    } catch (e) {
      await ctx.stderr(`find: ${startPath}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _findWalk(entry, predicate, ctx, sep) {
  // Apply predicate to this entry. The compiled predicate is a function:
  //   (entry) => { match: bool, print: bool }
  // When `print` is true (explicit -print/-print0 in the expr, or the
  // default action because no print-equivalent appeared), we emit the
  // path. We do this BEFORE descending so directory output matches
  // POSIX find pre-order traversal.
  if (entry.depth >= predicate.minDepth) {
    const r = predicate.fn(entry);
    if (r) {
      await ctx.stdout(entry.displayPath + sep);
    }
  }
  if (entry.type !== 'directory') return;
  if (predicate.maxDepth >= 0 && entry.depth >= predicate.maxDepth) return;
  let names;
  try {
    const entries = await ctx.vfs.readdir(entry.absPath);
    names = entries.map(e => typeof e === 'string' ? e : e.name).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const childAbs = entry.absPath.endsWith('/') ? entry.absPath + name : entry.absPath + '/' + name;
    const childDisp = entry.displayPath.endsWith('/') ? entry.displayPath + name : entry.displayPath + '/' + name;
    let stat;
    try { stat = await ctx.vfs.stat(childAbs); }
    catch { continue; }
    await _findWalk({
      absPath: childAbs,
      displayPath: childDisp,
      type: stat.type,
      size: stat.size ?? 0,
      depth: entry.depth + 1,
    }, predicate, ctx, sep);
  }
}

// Compile a predicate-token list into { fn, maxDepth, minDepth, print0 }.
// fn(entry) returns true iff the entry should be printed. maxDepth/
// minDepth/print0 are pulled out of the token stream rather than
// being encoded in fn — depth gates traversal, separators format output.
// An empty token list matches everything (POSIX `find .` behaviour).
function _findCompile(tokens) {
  const state = { tokens, i: 0, maxDepth: -1, minDepth: 0, print0: false };
  if (tokens.length === 0) {
    return { fn: () => true, maxDepth: -1, minDepth: 0, print0: false };
  }
  const fn = _findParseOr(state);
  if (state.i !== state.tokens.length) {
    throw new Error(`unexpected token "${state.tokens[state.i]}"`);
  }
  return {
    fn,
    maxDepth: state.maxDepth,
    minDepth: state.minDepth,
    print0: state.print0,
  };
}

// Grammar (recursive descent):
//   or   := and ( -or and )*
//   and  := not ( ( -and | <implicit> ) not )*
//   not  := ( '!' | -not ) not | primary
//   primary := '(' or ')' | predicate | action
function _findParseOr(s) {
  let left = _findParseAnd(s);
  while (s.i < s.tokens.length && (s.tokens[s.i] === '-or' || s.tokens[s.i] === '-o')) {
    s.i++;
    const right = _findParseAnd(s);
    const l = left, r = right;
    left = (e) => l(e) || r(e);
  }
  return left;
}

function _findParseAnd(s) {
  let left = _findParseNot(s);
  while (s.i < s.tokens.length) {
    const t = s.tokens[s.i];
    if (t === '-or' || t === '-o' || t === ')' || t === ',') break;
    if (t === '-and' || t === '-a') s.i++;
    const right = _findParseNot(s);
    const l = left, r = right;
    left = (e) => l(e) && r(e);
  }
  return left;
}

function _findParseNot(s) {
  const t = s.tokens[s.i];
  if (t === '!' || t === '-not') {
    s.i++;
    const inner = _findParseNot(s);
    return (e) => !inner(e);
  }
  return _findParsePrimary(s);
}

function _findParsePrimary(s) {
  const t = s.tokens[s.i];
  if (t === undefined) throw new Error('unexpected end of expression');
  if (t === '(') {
    s.i++;
    const inner = _findParseOr(s);
    if (s.tokens[s.i] !== ')') throw new Error("missing ')'");
    s.i++;
    return inner;
  }
  // Predicates & actions: each consumes its tokens and returns a
  // matcher. Actions set s.hadPrint when relevant.
  switch (t) {
    case '-name': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, false);
      return (e) => re.test(_basename(e.displayPath));
    }
    case '-iname': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, true);
      return (e) => re.test(_basename(e.displayPath));
    }
    case '-path': case '-wholename': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, false);
      return (e) => re.test(e.displayPath);
    }
    case '-type': {
      const tp = s.tokens[++s.i]; s.i++;
      return (e) => (tp === 'f' && e.type === 'file') || (tp === 'd' && e.type === 'directory');
    }
    case '-size': {
      const spec = s.tokens[++s.i]; s.i++;
      const cmp = _findCompileSize(spec);
      return (e) => cmp(e.size);
    }
    case '-empty': {
      s.i++;
      return (e) => e.type === 'file' && e.size === 0;
    }
    case '-maxdepth': {
      s.maxDepth = parseInt(s.tokens[++s.i], 10); s.i++;
      return () => true;
    }
    case '-mindepth': {
      s.minDepth = parseInt(s.tokens[++s.i], 10); s.i++;
      return () => true;
    }
    case '-print': {
      s.i++;
      return () => true;
    }
    case '-print0': {
      s.i++;
      s.print0 = true;
      return () => true;
    }
    case '-true': { s.i++; return () => true; }
    case '-false': { s.i++; return () => false; }
    default:
      throw new Error(`unknown predicate "${t}"`);
  }
}

function _basename(p) {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? p : p.slice(slash + 1);
}

function _findGlobToRe(pattern, ignoreCase) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; }
      else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close;
      }
    }
    else if ('.+^$(){}|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}

function _findCompileSize(spec) {
  // POSIX -size spec: [+-]N[bckwMG]. We honour c (bytes), k (KiB),
  // M (MiB), G (GiB). Defaults to 512-byte blocks per POSIX, but we
  // diverge: default unit is bytes — matches everyone's mental model.
  const m = String(spec).match(/^([+-])?(\d+)([ckMG]?)$/);
  if (!m) return () => false;
  const sign = m[1];
  const n = parseInt(m[2], 10);
  const unit = m[3] || 'c';
  const mult = unit === 'k' ? 1024 : unit === 'M' ? 1024 * 1024 : unit === 'G' ? 1024 * 1024 * 1024 : 1;
  const threshold = n * mult;
  if (sign === '+') return (sz) => sz > threshold;
  if (sign === '-') return (sz) => sz < threshold;
  return (sz) => sz === threshold;
}

// tree — list contents of a directory in a tree-like, box-drawn format.
// Flags: `-L N` depth limit, `-a` show dotfiles, `-d` directories only,
// `--noreport` suppress the trailing summary. Multiple roots are walked
// in turn. The summary counts only directories *encountered while walking*
// (excludes the root, matching real `tree`).
async function _tree(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('tree: no VFS configured\n'); return 1; }

  let maxDepth = Infinity, showHidden = false, dirsOnly = false, noReport = false;
  const paths = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-L' || a === '--level') {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        await ctx.stderr(`tree: invalid level: ${args[i]}\n`);
        return 1;
      }
      maxDepth = n;
    } else if (a === '--noreport') {
      noReport = true;
    } else if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      // Short flag cluster: -a, -d, -da, -ad, etc.
      for (const ch of a.slice(1)) {
        if (ch === 'a') showHidden = true;
        else if (ch === 'd') dirsOnly = true;
        else {
          await ctx.stderr(`tree: unknown option: -${ch}\n`);
          return 1;
        }
      }
    } else {
      paths.push(a);
    }
  }
  if (paths.length === 0) paths.push('.');

  let dirCount = 0, fileCount = 0;

  async function walk(dir, prefix, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await ctx.vfs.readdir(dir, { stat: true }); }
    catch (e) {
      await ctx.stderr(`tree: ${dir}: ${e.message || 'cannot read'}\n`);
      return;
    }
    entries = entries
      .map((e) => typeof e === 'string' ? { name: e, type: 'file' } : e)
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .filter((e) => !dirsOnly || e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const last = (i === entries.length - 1);
      const branch = last ? '└── ' : '├── ';
      const slash = e.type === 'directory' ? '/' : '';
      await ctx.stdout(prefix + branch + e.name + slash + '\n');
      if (e.type === 'directory') {
        dirCount++;
        const childPath = dir === '/' ? '/' + e.name : dir + '/' + e.name;
        await walk(childPath, prefix + (last ? '    ' : '│   '), depth + 1);
      } else {
        fileCount++;
      }
    }
  }

  for (const p of paths) {
    const abs = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(abs);
      await ctx.stdout(p + '\n');
      if (st.type === 'directory') await walk(abs, '', 1);
      else fileCount++;
    } catch (e) {
      await ctx.stderr(`tree: ${p}: ${e.message || 'cannot access'}\n`);
      return 1;
    }
  }

  if (!noReport) {
    const dPlural = dirCount === 1 ? 'directory' : 'directories';
    const fPlural = fileCount === 1 ? 'file' : 'files';
    await ctx.stdout(`\n${dirCount} ${dPlural}, ${fileCount} ${fPlural}\n`);
  }
  return 0;
}

async function _touch(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('touch: no VFS configured\n'); return 1; }
  const { positionals } = _bParseArgs(argv, { c: { short: 'c' } });
  if (positionals.length === 0) {
    await ctx.stderr('touch: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      try { await ctx.vfs.stat(path); /* exists — POSIX would update mtime; v0 no-op */ }
      catch { await ctx.vfs.writeFile(path, ''); }
    } catch (e) {
      await ctx.stderr(`touch: ${p}: ${e.message || 'cannot touch'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// ── text wranglers ──

async function _head(argv, ctx) {
  // BSD/GNU shorthand: `head -N` means `head -n N`. _bParseArgs has no
  // way to express "digit run is a flag value," so normalize first.
  const normalized = argv.map(a => /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]).flat();
  const { opts, positionals } = _bParseArgs(normalized, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  // Streaming path when reading from a pipe queue: pull chunks, emit
  // complete lines as they arrive, throw _pipeClosed back upstream once
  // we have N. This is what makes `find /huge | head -1` early-return
  // — upstream's next push sees a closed queue, bails, returns 0.
  const stdinIsQueue = positionals.length === 0
    && ctx.stdin
    && typeof ctx.stdin === 'object'
    && typeof ctx.stdin[Symbol.asyncIterator] === 'function';
  if (stdinIsQueue) {
    return await _headStream(ctx.stdin, n, ctx);
  }
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    const trailingNL = text.endsWith('\n');
    const effective = trailingNL ? lines.slice(0, -1) : lines;
    const take = effective.slice(0, n);
    await ctx.stdout(take.join('\n') + (take.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`head: ${e.message}\n`);
    return 1;
  }
}

async function _headStream(queue, n, ctx) {
  let leftover = '';
  let emitted = 0;
  const out = [];
  try {
    for await (const chunk of queue) {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      const combined = leftover + text;
      const parts = combined.split('\n');
      leftover = parts.pop(); // tail without trailing \n stays in leftover
      for (const line of parts) {
        out.push(line);
        emitted++;
        if (emitted >= n) break;
      }
      if (emitted >= n) {
        // Close the queue so upstream's next push sees _pipeClosed.
        if (typeof queue.close === 'function') queue.close();
        break;
      }
    }
    if (emitted < n && leftover.length > 0) {
      out.push(leftover);
      emitted++;
    }
  } catch (e) {
    if (!e || !e._pipeClosed) {
      await ctx.stderr(`head: ${e.message || e}\n`);
      return 1;
    }
  }
  if (out.length > 0) await ctx.stdout(out.join('\n') + '\n');
  return 0;
}

async function _tail(argv, ctx) {
  const normalized = argv.map(a => /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]).flat();
  const { opts, positionals } = _bParseArgs(normalized, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    const trailingNL = text.endsWith('\n');
    const effective = trailingNL ? lines.slice(0, -1) : lines;
    const take = effective.slice(Math.max(0, effective.length - n));
    await ctx.stdout(take.join('\n') + (take.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`tail: ${e.message}\n`);
    return 1;
  }
}

async function _wc(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    l: { short: 'l' }, w: { short: 'w' }, c: { short: 'c' },
  });
  // Default (no flags) prints lines, words, bytes.
  const showAll = !opts.l && !opts.w && !opts.c;
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.endsWith('\n')
      ? text.split('\n').length - 1
      : (text.length === 0 ? 0 : text.split('\n').length);
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const bytes = text.length;
    const parts = [];
    if (opts.l || showAll) parts.push(String(lines).padStart(8));
    if (opts.w || showAll) parts.push(String(words).padStart(8));
    if (opts.c || showAll) parts.push(String(bytes).padStart(8));
    await ctx.stdout(parts.join('') + '\n');
    return 0;
  } catch (e) {
    await ctx.stderr(`wc: ${e.message}\n`);
    return 1;
  }
}

async function _grep(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    i: { short: 'i' }, v: { short: 'v' }, n: { short: 'n' },
    F: { short: 'F' }, c: { short: 'c' },
  });
  if (positionals.length === 0) {
    await ctx.stderr('grep: missing pattern\n');
    return 2;
  }
  const pattern = positionals[0];
  const files = positionals.slice(1);
  let regex;
  try {
    regex = opts.F
      ? new RegExp(_escapeRe(pattern), opts.i ? 'i' : '')
      : new RegExp(pattern, opts.i ? 'i' : '');
  } catch (e) {
    await ctx.stderr(`grep: bad pattern: ${e.message}\n`);
    return 2;
  }
  try {
    const text = await _bReadInput(files, ctx);
    const lines = text.split('\n');
    const trailing = text.endsWith('\n');
    const effective = trailing ? lines.slice(0, -1) : lines;
    let count = 0;
    const out = [];
    for (let i = 0; i < effective.length; i++) {
      const line = effective[i];
      const matched = regex.test(line);
      if (opts.v ? !matched : matched) {
        count++;
        if (!opts.c) {
          out.push(opts.n ? `${i + 1}:${line}` : line);
        }
      }
    }
    if (opts.c) await ctx.stdout(`${count}\n`);
    else if (out.length > 0) await ctx.stdout(out.join('\n') + '\n');
    return count > 0 ? 0 : 1;
  } catch (e) {
    await ctx.stderr(`grep: ${e.message}\n`);
    return 2;
  }
}

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function _sort(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, n: { short: 'n' }, u: { short: 'u' },
  });
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    let lines = (trailing ? text.slice(0, -1) : text).split('\n');
    if (opts.n) {
      lines.sort((a, b) => {
        const na = parseFloat(a), nb = parseFloat(b);
        if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
        if (Number.isNaN(na)) return -1;
        if (Number.isNaN(nb)) return 1;
        return na - nb;
      });
    } else {
      lines.sort();
    }
    if (opts.r) lines.reverse();
    if (opts.u) lines = [...new Set(lines)];
    await ctx.stdout(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`sort: ${e.message}\n`);
    return 1;
  }
}

async function _uniq(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    c: { short: 'c' }, d: { short: 'd' }, u: { short: 'u' },
  });
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    const lines = (trailing ? text.slice(0, -1) : text).split('\n');
    const out = [];
    let prev = null, runCount = 0;
    const emit = () => {
      if (prev === null) return;
      if (opts.d && runCount < 2) return;
      if (opts.u && runCount >= 2) return;
      if (opts.c) out.push(`${String(runCount).padStart(4)} ${prev}`);
      else out.push(prev);
    };
    for (const l of lines) {
      if (l === prev) { runCount++; continue; }
      emit();
      prev = l;
      runCount = 1;
    }
    emit();
    await ctx.stdout(out.join('\n') + (out.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`uniq: ${e.message}\n`);
    return 1;
  }
}

async function _cut(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    d: { short: 'd', arg: true, default: '\t' },
    f: { short: 'f', arg: true },
    c: { short: 'c', arg: true },
  });
  if (!opts.f && !opts.c) {
    await ctx.stderr('cut: must specify -f or -c\n');
    return 1;
  }
  const ranges = _parseRanges(opts.f || opts.c);
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    const lines = (trailing ? text.slice(0, -1) : text).split('\n');
    const out = [];
    for (const line of lines) {
      if (opts.f) {
        const fields = line.split(opts.d);
        const picked = ranges.flatMap(([a, b]) => {
          const lo = Math.max(1, a) - 1;
          const hi = (b === Infinity ? fields.length : b);
          return fields.slice(lo, hi);
        });
        out.push(picked.join(opts.d));
      } else {
        const picked = ranges.flatMap(([a, b]) => {
          const lo = Math.max(1, a) - 1;
          const hi = (b === Infinity ? line.length : b);
          return [line.slice(lo, hi)];
        });
        out.push(picked.join(''));
      }
    }
    await ctx.stdout(out.join('\n') + (out.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`cut: ${e.message}\n`);
    return 1;
  }
}

// "1,3-5,7-" → [[1,1], [3,5], [7,Infinity]]
function _parseRanges(spec) {
  return spec.split(',').map(part => {
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      return [
        a === '' ? 1 : parseInt(a, 10),
        b === '' ? Infinity : parseInt(b, 10),
      ];
    }
    const n = parseInt(part, 10);
    return [n, n];
  });
}

async function _tee(argv, ctx) {
  if (!ctx.vfs && argv.length > 1) {
    await ctx.stderr('tee: no VFS configured for file targets\n');
    return 1;
  }
  const { opts, positionals } = _bParseArgs(argv, { a: { short: 'a' } });
  // _bReadInput handles Typed stdin via toString fallback.
  const input = await _bReadInput([], ctx);
  await ctx.stdout(input);
  let anyError = 0;
  for (const p of positionals) {
    try {
      const path = _bResolvePath(p, ctx);
      if (opts.a) {
        let prior;
        try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
        await ctx.vfs.writeFile(path, prior + input);
      } else {
        await ctx.vfs.writeFile(path, input);
      }
    } catch (e) {
      await ctx.stderr(`tee: ${p}: ${e.message || 'cannot write'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// ── set — shell options ──
//
// POSIX set covers two responsibilities: flipping shell options (`-e` /
// `-u` / `-o pipefail` / …) and rewriting the positional parameters
// (`set -- a b c` makes `$1=a $2=b $3=c`). With no arguments, lists
// environment variables (the POSIX behaviour; bash also includes shell
// variables — close enough for v0).
async function _set(argv, ctx) {
  if (!ctx.options) ctx.options = { errexit: false, nounset: false, pipefail: false, xtrace: false };
  const knownLong = { errexit: 'errexit', nounset: 'nounset', pipefail: 'pipefail', xtrace: 'xtrace' };
  const knownShort = { e: 'errexit', u: 'nounset', x: 'xtrace' };
  let i = 1;
  let resetPositional = false;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i++; resetPositional = true; break; }
    if (a === '-' || a === '+') { i++; continue; }
    if (a.startsWith('-o') || a.startsWith('+o')) {
      const off = a[0] === '+';
      let opt = a.length > 2 ? a.slice(2) : (argv[++i] || '');
      if (!opt) {
        // List: `set -o` prints each shell option's state.
        for (const k of Object.keys(knownLong)) {
          await ctx.stdout(`${k.padEnd(12)} ${ctx.options[k] ? 'on' : 'off'}\n`);
        }
        i++;
        continue;
      }
      if (!knownLong[opt]) {
        await ctx.stderr(`set: ${opt}: invalid option name\n`);
        return 2;
      }
      ctx.options[knownLong[opt]] = !off;
      i++;
      continue;
    }
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1) {
      const off = a[0] === '+';
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (!knownShort[ch]) {
          await ctx.stderr(`set: -${ch}: unknown option\n`);
          return 2;
        }
        ctx.options[knownShort[ch]] = !off;
      }
      i++;
      continue;
    }
    // First non-option argument: stop parsing flags and treat the rest
    // as positional parameters (POSIX-shape, even without an explicit `--`).
    resetPositional = true;
    break;
  }
  if (resetPositional) {
    ctx.positional = argv.slice(i);
    return 0;
  }
  if (argv.length === 1) {
    const keys = [...ctx.env.keys()].sort();
    for (const k of keys) await ctx.stdout(`${k}=${ctx.env.get(k)}\n`);
  }
  return 0;
}

// ── printf — POSIX format strings ──
//
// printf FORMAT [ARGS...]
//
// Supports %s %d %i %u %o %x %X %e %E %f %F %g %G %c %b %% — plus flags
// (- + space # 0), width (number), precision (.N). The format string is
// reused if there are extra args; if there are no specifiers in the
// format, it's printed once. Backslash escapes in the format are
// interpreted (\n \t \r \\ \a \b \f \v \xHH \0OOO).
async function _printf(argv, ctx) {
  if (argv.length < 2) {
    await ctx.stderr('printf: usage: printf format [arguments]\n');
    return 1;
  }
  const fmt = argv[1];
  const args = argv.slice(2);
  let out = '';
  let argIdx = 0;
  // Apply the format at least once. If specifiers consumed arguments and
  // more remain, reapply (POSIX "reuse" semantics). Guard against
  // formats with zero specifiers so we don't loop.
  let pass = 0;
  while (pass === 0 || argIdx < args.length) {
    const result = _printfApply(fmt, args, argIdx);
    out += result.text;
    pass++;
    if (result.consumed === 0) break;
    argIdx += result.consumed;
    if (pass > 10000) break; // belt-and-braces guard
  }
  await ctx.stdout(out);
  return 0;
}

function _printfApply(fmt, args, startIdx) {
  let out = '';
  let consumed = 0;
  let hadSpecifier = false;
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === '\\' && i + 1 < fmt.length) {
      const r = _printfReadEscape(fmt, i);
      out += r.text;
      i = r.next;
      continue;
    }
    if (c === '%') {
      const spec = _printfParseSpec(fmt, i);
      if (spec.literal) { out += '%'; i = spec.end; continue; }
      hadSpecifier = true;
      const arg = args[startIdx + consumed];
      consumed++;
      out += _printfFormat(spec, arg);
      i = spec.end;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, consumed: hadSpecifier ? consumed : 0 };
}

function _printfReadEscape(fmt, i) {
  const next = fmt[i + 1];
  switch (next) {
    case 'n': return { text: '\n', next: i + 2 };
    case 't': return { text: '\t', next: i + 2 };
    case 'r': return { text: '\r', next: i + 2 };
    case '\\': return { text: '\\', next: i + 2 };
    case '"': return { text: '"', next: i + 2 };
    case "'": return { text: "'", next: i + 2 };
    case 'a': return { text: '\x07', next: i + 2 };
    case 'b': return { text: '\b', next: i + 2 };
    case 'f': return { text: '\f', next: i + 2 };
    case 'v': return { text: '\v', next: i + 2 };
    case '0': {
      let oct = '';
      let j = i + 2;
      while (oct.length < 3 && /[0-7]/.test(fmt[j] || '')) { oct += fmt[j]; j++; }
      return { text: String.fromCharCode(parseInt(oct || '0', 8)), next: j };
    }
    case 'x': {
      let hex = '';
      let j = i + 2;
      while (hex.length < 2 && /[0-9a-fA-F]/.test(fmt[j] || '')) { hex += fmt[j]; j++; }
      if (hex.length === 0) return { text: '\\x', next: j };
      return { text: String.fromCharCode(parseInt(hex, 16)), next: j };
    }
    default: return { text: '\\' + (next ?? ''), next: i + 2 };
  }
}

function _printfParseSpec(fmt, start) {
  let i = start + 1;
  if (fmt[i] === '%') return { literal: true, end: i + 1 };
  const flags = { left: false, plus: false, space: false, hash: false, zero: false };
  while (i < fmt.length && '-+ #0'.includes(fmt[i])) {
    if (fmt[i] === '-') flags.left = true;
    else if (fmt[i] === '+') flags.plus = true;
    else if (fmt[i] === ' ') flags.space = true;
    else if (fmt[i] === '#') flags.hash = true;
    else if (fmt[i] === '0') flags.zero = true;
    i++;
  }
  let width = -1;
  while (/[0-9]/.test(fmt[i] || '')) {
    width = width < 0 ? 0 : width;
    width = width * 10 + Number(fmt[i]);
    i++;
  }
  let precision = -1;
  if (fmt[i] === '.') {
    i++;
    precision = 0;
    while (/[0-9]/.test(fmt[i] || '')) {
      precision = precision * 10 + Number(fmt[i]);
      i++;
    }
  }
  const conv = fmt[i] || '';
  i++;
  return { literal: false, flags, width, precision, conv, end: i };
}

function _printfFormat(spec, rawArg) {
  const { flags, width, precision, conv } = spec;
  const arg = rawArg ?? '';
  let s;
  let isNumeric = true;
  switch (conv) {
    case 's': {
      s = String(arg);
      if (precision >= 0) s = s.slice(0, precision);
      isNumeric = false;
      break;
    }
    case 'b': {
      s = _printfBackslashArg(String(arg));
      if (precision >= 0) s = s.slice(0, precision);
      isNumeric = false;
      break;
    }
    case 'c': {
      s = String(arg).charAt(0);
      isNumeric = false;
      break;
    }
    case 'd': case 'i': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      const neg = n < 0;
      let v = String(Math.abs(n));
      if (precision >= 0) v = v.padStart(precision, '0');
      if (neg) s = '-' + v;
      else if (flags.plus) s = '+' + v;
      else if (flags.space) s = ' ' + v;
      else s = v;
      break;
    }
    case 'u': {
      let n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) n = 0;
      s = String(n);
      if (precision >= 0) s = s.padStart(precision, '0');
      break;
    }
    case 'o': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      s = n.toString(8);
      if (flags.hash && s[0] !== '0') s = '0' + s;
      if (precision >= 0) s = s.padStart(precision, '0');
      break;
    }
    case 'x': case 'X': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      s = n.toString(16);
      if (conv === 'X') s = s.toUpperCase();
      if (precision >= 0) s = s.padStart(precision, '0');
      if (flags.hash && n !== 0) s = (conv === 'X' ? '0X' : '0x') + s;
      break;
    }
    case 'e': case 'E': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? precision : 6;
      s = n.toExponential(p);
      if (conv === 'E') s = s.toUpperCase();
      if (flags.plus && n >= 0) s = '+' + s;
      else if (flags.space && n >= 0) s = ' ' + s;
      break;
    }
    case 'f': case 'F': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? precision : 6;
      s = n.toFixed(p);
      if (flags.plus && n >= 0) s = '+' + s;
      else if (flags.space && n >= 0) s = ' ' + s;
      break;
    }
    case 'g': case 'G': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? (precision === 0 ? 1 : precision) : 6;
      s = n.toPrecision(p);
      if (conv === 'G') s = s.toUpperCase();
      break;
    }
    default: s = '%' + conv;
  }
  if (width > 0 && s.length < width) {
    const padCh = (flags.zero && !flags.left && isNumeric) ? '0' : ' ';
    if (flags.left) s = s.padEnd(width, ' ');
    else if (padCh === '0' && (s[0] === '-' || s[0] === '+' || s[0] === ' ')) {
      s = s[0] + s.slice(1).padStart(width - 1, '0');
    } else {
      s = s.padStart(width, padCh);
    }
  }
  return s;
}

function _printfBackslashArg(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const r = _printfReadEscape(s, i);
      out += r.text;
      i = r.next - 1;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ── read — line input ──
//
// read [-r] [-p prompt] [-d delim] [-n nchars] [-s] [-t timeout] [VAR...]
//
// v0 reads a single line from ctx.stdin, splits on $IFS, and binds the
// resulting fields to the named variables (last var absorbs any trailing
// content). Without VARs, reads into $REPLY. `-r` skips backslash
// processing. `-p PROMPT` writes the prompt to stderr before reading.
// `-s`/`-n`/`-t`/`-d` are accepted for compatibility but not all honoured
// (they need an async input channel from the adapter — coming with the
// worker-side interactive read protocol).
async function _read(argv, ctx) {
  let raw = false, prompt = '';
  let nChars = -1;        // -n N: read at most N chars (default: full line)
  let delim = '\n';       // -d D: terminate on first char of D (bash uses D[0])
  let optS = false;       // -s: silent — passed to the interactive readLine hook
  let optT = null;        // -t SECONDS: timeout, also handled by the hook
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    const flag = argv[i];
    if (flag === '-r') { raw = true; i++; continue; }
    if (flag === '-p') { prompt = argv[i + 1] ?? ''; i += 2; continue; }
    if (flag.startsWith('-p') && flag.length > 2) { prompt = flag.slice(2); i++; continue; }
    if (flag === '-s') { optS = true; i++; continue; }
    if (flag === '-n') {
      const n = parseInt(argv[i + 1], 10);
      if (!Number.isFinite(n) || n < 0) {
        await ctx.stderr(`read: -n: invalid count\n`);
        return 2;
      }
      nChars = n;
      i += 2;
      continue;
    }
    if (flag === '-d') {
      delim = argv[i + 1] ?? '\n';
      i += 2;
      continue;
    }
    if (flag === '-t') {
      const t = parseFloat(argv[i + 1]);
      if (!Number.isFinite(t) || t < 0) {
        await ctx.stderr(`read: -t: invalid timeout\n`);
        return 2;
      }
      optT = t;
      i += 2;
      continue;
    }
    if (flag === '--') { i++; break; }
    await ctx.stderr(`read: ${flag}: unknown option\n`);
    return 2;
  }
  const vars = argv.slice(i);
  const varNames = vars.length > 0 ? vars : ['REPLY'];
  // `read` is line-oriented and needs to mutate the consumed stdin. If
  // stdin arrived as a stream queue (from a pipeline), drain to text
  // first; subsequent `read` calls in the same command keep slicing
  // ctx.stdin string.
  if (typeof ctx.stdin !== 'string') {
    const v = await drainInput(ctx);
    ctx.stdin = typeof v === 'string' ? v : String(v);
  }
  // No stdin queued? Fall through to the interactive `readLine` hook
  // if the host wired one up — that's the path the worker shim uses
  // to bridge to the adapter's line editor (prompt, echo, backspace).
  // Without a hook, EOF is the only answer.
  if (ctx.stdin.length === 0) {
    if (typeof ctx.readLine !== 'function') {
      // Show prompt before reporting EOF — matches bash's `read -p P`
      // shape, which prints the prompt unconditionally.
      if (prompt) {
        try { await ctx.stderr(prompt); } catch { /* ignore */ }
      }
      return 1;
    }
    let res;
    try {
      res = await ctx.readLine({
        prompt,
        silent: optS,
        nChars: nChars >= 0 ? nChars : null,
        delim: delim === '\n' ? null : delim,
        timeout: optT,
        raw,
      });
    } catch (e) {
      await ctx.stderr(`read: ${e.message || e}\n`);
      return 1;
    }
    if (!res || res.eof) return 1;
    if (res.timeout) return 142; // bash convention for -t timeout expiry
    const lineFromHost = typeof res.line === 'string' ? res.line : '';
    return await _readBindVars(lineFromHost, ctx, varNames, raw);
  }
  if (prompt) {
    try { await ctx.stderr(prompt); } catch { /* ignore */ }
  }
  // Consume one record from stdin. Mutate ctx.stdin so subsequent reads
  // in the same command context (e.g. `while read; do ...; done < file`)
  // continue from where we left off.
  let line;
  if (nChars >= 0) {
    // -n: read up to N characters, ignoring delim. nChars=0 reads
    // nothing but still returns 0 (consistent with bash).
    const take = Math.min(nChars, ctx.stdin.length);
    line = ctx.stdin.slice(0, take);
    ctx.stdin = ctx.stdin.slice(take);
  } else {
    // -d (default '\n'): terminate on first occurrence of delim[0].
    // Empty delim ('') means read everything until EOF.
    const ch = delim.length > 0 ? delim[0] : '';
    const idx = ch === '' ? -1 : ctx.stdin.indexOf(ch);
    if (idx < 0) {
      line = ctx.stdin;
      ctx.stdin = '';
    } else {
      line = ctx.stdin.slice(0, idx);
      ctx.stdin = ctx.stdin.slice(idx + 1);
    }
  }
  return await _readBindVars(line, ctx, varNames, raw);
}

// Apply the post-acquire processing common to both stdin-slice and
// interactive-readLine paths: optional backslash de-escape (skipped
// under -r), then IFS-aware splitting into var bindings.
async function _readBindVars(line, ctx, varNames, raw) {
  if (!raw) {
    let processed = '';
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '\\' && k + 1 < line.length) {
        processed += line[k + 1];
        k++;
      } else {
        processed += line[k];
      }
    }
    line = processed;
  }
  const ifs = ctx.env.get('IFS') ?? ' \t\n';
  if (varNames.length === 1) {
    const trimmed = _readTrimIfsWs(line, ifs);
    ctx.env.set(varNames[0], trimmed);
  } else {
    const fields = _readSplitFields(line, ifs, varNames.length);
    for (let k = 0; k < varNames.length; k++) {
      ctx.env.set(varNames[k], fields[k] ?? '');
    }
  }
  return 0;
}

function _readTrimIfsWs(line, ifs) {
  const wsSet = new Set();
  for (const c of ifs) if (c === ' ' || c === '\t' || c === '\n') wsSet.add(c);
  if (wsSet.size === 0) return line;
  let start = 0, end = line.length;
  while (start < end && wsSet.has(line[start])) start++;
  while (end > start && wsSet.has(line[end - 1])) end--;
  return line.slice(start, end);
}

function _readSplitFields(line, ifs, maxFields) {
  const wsSet = new Set(), otherSet = new Set();
  for (const c of ifs) {
    if (c === ' ' || c === '\t' || c === '\n') wsSet.add(c);
    else otherSet.add(c);
  }
  const out = [];
  let i = 0;
  while (i < line.length && wsSet.has(line[i])) i++;
  let cur = '';
  while (i < line.length) {
    if (out.length === maxFields - 1) {
      cur = line.slice(i);
      // Trim trailing whitespace-IFS from the last absorbed field (POSIX read).
      if (wsSet.size > 0) {
        let end = cur.length;
        while (end > 0 && wsSet.has(cur[end - 1])) end--;
        cur = cur.slice(0, end);
      }
      out.push(cur);
      return out;
    }
    const c = line[i];
    if (wsSet.has(c)) {
      out.push(cur);
      cur = '';
      i++;
      while (i < line.length && wsSet.has(line[i])) i++;
      continue;
    }
    if (otherSet.has(c)) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur || out.length < maxFields) out.push(cur);
  while (out.length < maxFields) out.push('');
  return out;
}

// ── eval / source / getopts — script-time builtins ──
//
// `eval` joins its args with spaces and re-parses+executes that string
// in the CURRENT shell context. Mutations to env / cwd / functions
// leak to the caller — that's the whole point. Re-parsing means the
// argument can contain pipes, redirects, control flow, etc.
//
// `source FILE [ARG...]` (and the POSIX `.` alias) reads FILE from
// the VFS and runs its contents in the current scope. Optional args
// after the filename become positional params for the duration of
// the source, then restore on return (mirroring how a function call
// scopes positional). Locals defined in the sourced file leak out
// unless declared `local` inside a function in that file.
async function _eval(argv, ctx) {
  if (argv.length < 2) return 0;
  const source = argv.slice(1).join(' ');
  const { parse } = await import('./parser.js');
  const { execute } = await import('./executor.js');
  const savedPropagate = ctx._propagateExit;
  ctx._propagateExit = true;
  try {
    const ast = parse(source);
    const r = await execute(ast, ctx);
    return r.exitCode;
  } catch (e) {
    if (e && e._exit) throw e;
    if (e && e._return) throw e;
    await ctx.stderr(`eval: ${e.message || e}\n`);
    return 1;
  } finally {
    ctx._propagateExit = savedPropagate;
  }
}

async function _source(argv, ctx) {
  if (argv.length < 2) {
    await ctx.stderr('source: filename required\n');
    return 2;
  }
  if (!ctx.vfs) {
    await ctx.stderr('source: no VFS configured\n');
    return 1;
  }
  const file = argv[1];
  const path = _bResolvePath(file, ctx);
  let text;
  try {
    text = await ctx.vfs.readFile(path, 'text');
  } catch (e) {
    await ctx.stderr(`source: ${file}: ${e.message || 'cannot read'}\n`);
    return 1;
  }
  // Args after the filename rebind $1..$N for the duration. Save the
  // caller's positional, restore in finally so an early `return` or
  // `exit` from the sourced file still unwinds cleanly.
  const sourceArgs = argv.slice(2);
  const savedPositional = ctx.positional;
  const savedPropagate = ctx._propagateExit;
  if (sourceArgs.length > 0) ctx.positional = sourceArgs;
  ctx._propagateExit = true;
  const { parse } = await import('./parser.js');
  const { execute } = await import('./executor.js');
  let exitCode = 0;
  try {
    const ast = parse(text);
    const r = await execute(ast, ctx);
    exitCode = r.exitCode;
  } catch (e) {
    if (e && e._exit) throw e;
    if (e && e._return) {
      exitCode = e.exitCode;
    } else {
      await ctx.stderr(`source: ${e.message || e}\n`);
      exitCode = 1;
    }
  } finally {
    ctx.positional = savedPositional;
    ctx._propagateExit = savedPropagate;
  }
  return exitCode;
}

// getopts OPTSTRING NAME [ARG...]
//
// POSIX flag-parsing helper for shell scripts. OPTSTRING is a letter
// per allowed flag (`a` = bare `-a`, `b:` = `-b ARG`). NAME receives
// the current flag letter; $OPTARG receives the value (when required);
// $OPTIND tracks the next position. Returns 0 while more options
// remain, 1 when done. Typical usage:
//
//   while getopts "n:v" opt; do
//     case "$opt" in
//       n) name=$OPTARG ;;
//       v) verbose=1 ;;
//       *) echo bad; exit 2 ;;
//     esac
//   done
//   shift $((OPTIND - 1))
//
// Args default to $@. State (OPTIND) persists in env between calls.
async function _getopts(argv, ctx) {
  if (argv.length < 3) {
    await ctx.stderr('getopts: usage: getopts optstring name [arg...]\n');
    return 2;
  }
  const optstring = argv[1];
  const name = argv[2];
  // Arg source: explicit > positional.
  const args = argv.length > 3 ? argv.slice(3) : (ctx.positional || []);
  // OPTIND is 1-based in POSIX.
  let optind = parseInt(ctx.env.get('OPTIND') || '1', 10);
  if (!Number.isFinite(optind) || optind < 1) optind = 1;
  const argIdx = optind - 1;
  if (argIdx >= args.length) return 1;
  const cur = args[argIdx];
  if (typeof cur !== 'string' || cur.length < 2 || cur[0] !== '-' || cur === '--') {
    if (cur === '--') ctx.env.set('OPTIND', String(optind + 1));
    return 1;
  }
  const ch = cur[1];
  // Find ch in optstring; treat leading ':' as silent-error mode (we accept it
  // but don't differentiate output styles).
  const silent = optstring.startsWith(':');
  const search = silent ? optstring.slice(1) : optstring;
  const pos = search.indexOf(ch);
  if (pos < 0 || ch === ':') {
    ctx.env.set(name, '?');
    ctx.env.set('OPTARG', ch);
    if (!silent) await ctx.stderr(`getopts: illegal option -- ${ch}\n`);
    ctx.env.set('OPTIND', String(optind + 1));
    return 0;
  }
  const takesArg = search[pos + 1] === ':';
  if (takesArg) {
    // Value can be glued (-nVAL) or in the next argv slot.
    if (cur.length > 2) {
      ctx.env.set('OPTARG', cur.slice(2));
      ctx.env.set(name, ch);
      ctx.env.set('OPTIND', String(optind + 1));
    } else if (argIdx + 1 < args.length) {
      ctx.env.set('OPTARG', args[argIdx + 1]);
      ctx.env.set(name, ch);
      ctx.env.set('OPTIND', String(optind + 2));
    } else {
      // Missing required arg.
      if (silent) {
        ctx.env.set(name, ':');
        ctx.env.set('OPTARG', ch);
      } else {
        await ctx.stderr(`getopts: option requires argument -- ${ch}\n`);
        ctx.env.set(name, '?');
        ctx.env.set('OPTARG', '');
      }
      ctx.env.set('OPTIND', String(optind + 1));
    }
    return 0;
  }
  // Bare flag. May be clustered (`-abc` = -a -b -c) but POSIX says each
  // call returns ONE letter; we handle clustering by consuming chars
  // from the same argv slot until exhausted, only advancing OPTIND
  // when the slot is done.
  if (cur.length > 2) {
    // More flags in this slot — strip the first char and put the rest back.
    args[argIdx] = '-' + cur.slice(2);
    // Note: this mutates the args array. For ctx.positional that's fine
    // (POSIX getopts canonically mutates the positional view).
  } else {
    ctx.env.set('OPTIND', String(optind + 1));
  }
  ctx.env.set(name, ch);
  ctx.env.set('OPTARG', '');
  return 0;
}

// ── local / return / shift — function-frame builtins ──
//
// local NAME[=value] ... — only valid inside a function. Shadows any
// caller binding of NAME for the duration of the current frame; on
// frame pop, the executor restores the prior value (or deletes the
// name if it was previously unset). `local NAME` without `=` keeps
// the existing visible value but still marks it for shadowed
// restoration (so the caller is insulated from later mutation).
async function _local(argv, ctx) {
  if (!ctx._localFrames || ctx._localFrames.length === 0) {
    await ctx.stderr('local: can only be used inside a function\n');
    return 1;
  }
  const frame = ctx._localFrames[ctx._localFrames.length - 1];
  let anyError = 0;
  for (const arg of argv.slice(1)) {
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      await ctx.stderr(`local: ${name}: not a valid identifier\n`);
      anyError = 1;
      continue;
    }
    if (!frame.savedBindings.has(name)) {
      frame.savedBindings.set(name, ctx.env.has(name) ? ctx.env.get(name) : undefined);
    }
    if (eq >= 0) {
      ctx.env.set(name, arg.slice(eq + 1));
    } else if (!ctx.env.has(name)) {
      // `local NAME` with no = and no prior binding: initialize empty,
      // matching bash/dash. (POSIX is silent; this is the consensus.)
      ctx.env.set(name, '');
    }
  }
  return anyError;
}

// return [N] — exit the current function with status N (defaults to
// the last command's exit code). Outside a function, behaves as `exit`
// would (POSIX leaves this undefined; we follow bash's pragmatic shape).
async function _return(argv, ctx) {
  const raw = argv[1];
  const n = raw !== undefined ? Number(raw) : ctx.lastStatus;
  const code = Number.isFinite(n) ? (n & 0xff) : 0;
  // Outside any function frame, treat as exit (POSIX-undefined; bash
  // says "error", but exit-shape is more useful in scripts that get
  // sourced via `.`).
  if (!ctx._localFrames || ctx._localFrames.length === 0) {
    throw { exitCode: code, _exit: true };
  }
  throw { exitCode: code, _return: true };
}

// shift [N] — drop the first N positional parameters (default 1).
// Returns 1 if N is larger than the current count (no shift performed),
// matching POSIX. Useful with `local x=$1; shift` to consume args.
async function _shift(argv, ctx) {
  const n = argv[1] !== undefined ? parseInt(argv[1], 10) : 1;
  if (!Number.isFinite(n) || n < 0) {
    await ctx.stderr('shift: invalid count\n');
    return 1;
  }
  const cur = ctx.positional || [];
  if (n > cur.length) return 1;
  ctx.positional = cur.slice(n);
  return 0;
}

// clear — wipe the terminal. VT100: ESC[2J clears the screen, ESC[H
// homes the cursor. Pure stdout — works on any terminal-shaped sink.
async function _clear(_argv, ctx) {
  await ctx.stdout('\x1b[2J\x1b[H');
  return 0;
}

// ── which / command — name lookup ──

async function _which(argv, ctx) {
  let anyError = 0;
  for (const name of argv.slice(1)) {
    if (ctx.builtins.has(name)) {
      await ctx.stdout(`${name}: shell built-in\n`);
    } else if (ctx.functions.has(name)) {
      await ctx.stdout(`${name}: shell function\n`);
    } else {
      anyError = 1;
    }
  }
  return anyError;
}

async function _command(argv, ctx) {
  // command [-v|-V] NAME [args...] — runs NAME bypassing function lookup,
  // or with -v/-V prints how the name would be resolved.
  let mode = null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    if (argv[i] === '-v') { mode = 'v'; i++; continue; }
    if (argv[i] === '-V') { mode = 'V'; i++; continue; }
    if (argv[i] === '--') { i++; break; }
    i++;
  }
  if (i >= argv.length) return 0;
  const name = argv[i];
  if (mode) {
    if (ctx.builtins.has(name)) {
      await ctx.stdout(mode === 'V' ? `${name} is a shell builtin\n` : `${name}\n`);
      return 0;
    }
    if (ctx.functions.has(name)) {
      await ctx.stdout(mode === 'V' ? `${name} is a shell function\n` : `${name}\n`);
      return 0;
    }
    return 1;
  }
  const rest = argv.slice(i);
  if (ctx.builtins.has(name)) {
    return await ctx.builtins.get(name)(rest, ctx);
  }
  return await ctx.onCommand(name, rest, ctx);
}

// ── seq / sleep / date ──

async function _seq(argv, ctx) {
  const positional = [];
  let sep = '\n';
  let i = 1;
  while (i < argv.length) {
    if (argv[i] === '-s' && i + 1 < argv.length) { sep = argv[++i]; i++; continue; }
    if (argv[i].startsWith('-s') && argv[i].length > 2) { sep = argv[i].slice(2); i++; continue; }
    positional.push(argv[i]);
    i++;
  }
  if (positional.length === 0) {
    await ctx.stderr('seq: missing operand\n');
    return 1;
  }
  let first = 1, increment = 1, last = 0;
  if (positional.length === 1) { last = Number(positional[0]); }
  else if (positional.length === 2) { first = Number(positional[0]); last = Number(positional[1]); }
  else { first = Number(positional[0]); increment = Number(positional[1]); last = Number(positional[2]); }
  if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(increment)) {
    await ctx.stderr('seq: invalid number\n');
    return 1;
  }
  if (increment === 0) {
    await ctx.stderr('seq: increment must be non-zero\n');
    return 1;
  }
  const out = [];
  if (increment > 0) {
    for (let n = first; n <= last + 1e-12; n += increment) out.push(_seqFormatNum(n));
  } else {
    for (let n = first; n >= last - 1e-12; n += increment) out.push(_seqFormatNum(n));
  }
  if (out.length === 0) return 0;
  await ctx.stdout(out.join(sep) + '\n');
  return 0;
}

function _seqFormatNum(n) {
  if (Number.isInteger(n)) return String(n);
  // Round to ~6 sig-figs for fractional sequences; trims runaway FP noise.
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

async function _sleep(argv, ctx) {
  const arg = argv[1];
  if (arg == null) {
    await ctx.stderr('sleep: missing operand\n');
    return 1;
  }
  const m = String(arg).match(/^(\d+(?:\.\d+)?)([smhd])?$/);
  if (!m) {
    await ctx.stderr(`sleep: invalid duration "${arg}"\n`);
    return 1;
  }
  const n = parseFloat(m[1]);
  const unit = m[2] || 's';
  const mult = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1;
  await new Promise(r => setTimeout(r, n * mult * 1000));
  return 0;
}

async function _date(argv, ctx) {
  let fmt = '%a %b %e %T %Y'; // POSIX default
  for (const a of argv.slice(1)) {
    if (a.startsWith('+')) fmt = a.slice(1);
  }
  const d = new Date();
  await ctx.stdout(_formatDate(d, fmt) + '\n');
  return 0;
}

function _formatDate(d, fmt) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return fmt.replace(/%./g, (m) => {
    switch (m) {
      case '%Y': return String(d.getFullYear());
      case '%y': return pad(d.getFullYear() % 100);
      case '%m': return pad(d.getMonth() + 1);
      case '%d': return pad(d.getDate());
      case '%H': return pad(d.getHours());
      case '%I': return pad(((d.getHours() + 11) % 12) + 1);
      case '%M': return pad(d.getMinutes());
      case '%S': return pad(d.getSeconds());
      case '%p': return d.getHours() < 12 ? 'AM' : 'PM';
      case '%a': return dayShort[d.getDay()];
      case '%A': return dayFull[d.getDay()];
      case '%b': case '%h': return monShort[d.getMonth()];
      case '%B': return monFull[d.getMonth()];
      case '%e': return String(d.getDate()).padStart(2, ' ');
      case '%j': return pad(_dayOfYear(d), 3);
      case '%T': return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      case '%R': return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      case '%D': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
      case '%F': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      case '%s': return String(Math.floor(d.getTime() / 1000));
      case '%n': return '\n';
      case '%t': return '\t';
      case '%%': return '%';
      case '%z': {
        const off = -d.getTimezoneOffset();
        const sign = off >= 0 ? '+' : '-';
        const h = pad(Math.floor(Math.abs(off) / 60));
        const mm = pad(Math.abs(off) % 60);
        return `${sign}${h}${mm}`;
      }
      default: return m;
    }
  });
}

function _dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

// ── tr — character translate / delete ──
//
// tr SET1 SET2        translate each SET1 char to the corresponding SET2 char
// tr -d SET           delete every SET char from input
// tr -s SET           squeeze runs of SET chars into one
// tr -c SET1 SET2     complement (operate on chars NOT in SET1)
//
// SET supports character ranges via `-` (e.g. `a-z`, `0-9`) and POSIX
// classes via `[:class:]` (alpha, digit, lower, upper, space, alnum,
// punct, xdigit). Anything more elaborate (escapes, [=eq=]) is v0-future.
async function _tr(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    d: { short: 'd' }, s: { short: 's' }, c: { short: 'c' },
  });
  if (positionals.length === 0) {
    await ctx.stderr('tr: missing operand\n');
    return 1;
  }
  let set1 = _trExpandSet(positionals[0]);
  if (opts.c) {
    // Complement: build the "set of chars NOT in set1" lazily via a predicate.
    const inSet1 = new Set(set1);
    set1 = null; // signal "complement mode" downstream
    var inSet = (ch) => !inSet1.has(ch);
  } else {
    const s1 = new Set(set1);
    var inSet = (ch) => s1.has(ch);
  }
  const text = await _bReadInput([], ctx);
  let out = '';
  if (opts.d) {
    // Delete chars in set.
    for (const ch of text) if (!inSet(ch)) out += ch;
  } else if (positionals.length >= 2) {
    // Translate set1 → set2.
    const set2 = _trExpandSet(positionals[1]);
    const last2 = set2[set2.length - 1] || '';
    const set1Arr = set1 || []; // complement+translate uncommon; skip
    const map = new Map();
    if (set1Arr.length > 0) {
      for (let k = 0; k < set1Arr.length; k++) {
        map.set(set1Arr[k], set2[k] ?? last2);
      }
    }
    for (const ch of text) {
      if (inSet(ch)) {
        // In complement mode, any out-of-set char maps to the last char of set2.
        out += set1 ? (map.get(ch) ?? ch) : last2;
      } else {
        out += ch;
      }
    }
  } else if (opts.s) {
    // Squeeze runs of set chars.
    let prev = '';
    for (const ch of text) {
      if (inSet(ch) && ch === prev) continue;
      out += ch;
      prev = ch;
    }
  } else {
    await ctx.stderr('tr: need SET2 unless -d or -s\n');
    return 1;
  }
  // Optional squeeze pass after translate.
  if (opts.s && positionals.length >= 2 && !opts.d) {
    let squeezed = '';
    let prev = '';
    const set2 = _trExpandSet(positionals[1]);
    const sq = new Set(set2);
    for (const ch of out) {
      if (sq.has(ch) && ch === prev) continue;
      squeezed += ch;
      prev = ch;
    }
    out = squeezed;
  }
  await ctx.stdout(out);
  return 0;
}

const _TR_CLASSES = {
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  digit: '0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  space: ' \t\n\r\v\f',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  xdigit: '0123456789ABCDEFabcdef',
};

function _trExpandSet(spec) {
  // Expand POSIX classes first, then ranges. Returns an array of chars.
  let s = spec;
  s = s.replace(/\[:(\w+):\]/g, (_, cls) => _TR_CLASSES[cls] || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      // Common escapes.
      const next = s[i + 1];
      if (next === 'n') out.push('\n');
      else if (next === 't') out.push('\t');
      else if (next === 'r') out.push('\r');
      else if (next === '\\') out.push('\\');
      else out.push(next);
      i++;
      continue;
    }
    if (i + 2 < s.length && s[i + 1] === '-') {
      // Range a-z.
      const from = s.charCodeAt(i);
      const to = s.charCodeAt(i + 2);
      if (to >= from) {
        for (let cc = from; cc <= to; cc++) out.push(String.fromCharCode(cc));
        i += 2;
        continue;
      }
    }
    out.push(s[i]);
  }
  return out;
}

// ── du / df — disk usage ──
//
// du [-s] [-h] [PATH...]     total bytes per PATH (recursive); -s = summary
// df [-h]                    per-mount usage; size from VFS where exposed
//
// We don't have real block sizes — just sum file sizes from stat. -h
// (human) formats with K/M/G/T suffixes. df enumerates VFS mounts;
// without a real "total" / "used" surface from the VFS, we just report
// what we can walk.
async function _du(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('du: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    s: { short: 's' }, h: { short: 'h' },
  });
  const paths = positionals.length > 0 ? positionals : ['.'];
  let anyError = 0;
  for (const p of paths) {
    try {
      const abs = _bResolvePath(p, ctx);
      const total = await _duWalk(ctx, abs, opts);
      const size = opts.h ? _humanSize(total) : String(total);
      await ctx.stdout(`${size.padEnd(8)}${p}\n`);
    } catch (e) {
      await ctx.stderr(`du: ${p}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _duWalk(ctx, path, opts) {
  const st = await ctx.vfs.stat(path);
  if (st.type !== 'directory') return st.size ?? 0;
  let total = 0;
  let entries;
  try { entries = await ctx.vfs.readdir(path); } catch { return 0; }
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e.name;
    const child = path.endsWith('/') ? path + name : path + '/' + name;
    let cst;
    try { cst = await ctx.vfs.stat(child); } catch { continue; }
    if (cst.type === 'directory') {
      const sub = await _duWalk(ctx, child, opts);
      total += sub;
      if (!opts.s) {
        const sizeStr = opts.h ? _humanSize(sub) : String(sub);
        await ctx.stdout(`${sizeStr.padEnd(8)}${child}\n`);
      }
    } else {
      total += cst.size ?? 0;
    }
  }
  return total;
}

async function _df(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('df: no VFS configured\n'); return 1; }
  const { opts } = _bParseArgs(argv, { h: { short: 'h' } });
  const mounts = (ctx.vfs._mounts && typeof ctx.vfs._mounts.entries === 'function')
    ? [...ctx.vfs._mounts.entries()]
    : [['/', null]];
  await ctx.stdout('Mount     Used    \n');
  for (const [path /*, backend */] of mounts) {
    let used = 0;
    try { used = await _duWalk(ctx, path, { s: true }); } catch { /* ignore */ }
    const usedStr = opts.h ? _humanSize(used) : String(used);
    await ctx.stdout(`${String(path).padEnd(9)} ${usedStr.padEnd(8)}\n`);
  }
  return 0;
}

function _humanSize(n) {
  if (n < 1024) return `${n}`;
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[i];
}

// ── base64 / md5sum / sha256sum — encoding & hashing ──
//
// base64 [-d]           encode (default) or decode stdin/file
// md5sum [FILE...]      MD5 hash via Web Crypto (when available; fallback
//                       to a pure-JS minimal impl)
// sha256sum [FILE...]   SHA-256 via Web Crypto (always-available in Node 16+
//                       and modern browsers)
async function _base64(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, { d: { short: 'd' } });
  const text = await _bReadInput(positionals, ctx);
  if (opts.d) {
    // Decode.
    let result;
    try {
      const stripped = text.replace(/\s+/g, '');
      if (typeof atob === 'function') {
        result = atob(stripped);
      } else {
        result = Buffer.from(stripped, 'base64').toString('binary');
      }
    } catch (e) {
      await ctx.stderr(`base64: decode error: ${e.message}\n`);
      return 1;
    }
    await ctx.stdout(result);
    return 0;
  }
  // Encode.
  let encoded;
  if (typeof btoa === 'function') {
    encoded = btoa(text);
  } else {
    encoded = Buffer.from(text, 'binary').toString('base64');
  }
  // Wrap at 76 chars per RFC; bash's base64 does this by default.
  const lines = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  await ctx.stdout(lines.join('\n') + '\n');
  return 0;
}

async function _md5sum(argv, ctx) {
  return await _hashCmd('md5', argv, ctx);
}

async function _sha256sum(argv, ctx) {
  return await _hashCmd('sha256', argv, ctx);
}

async function _hashCmd(algorithm, argv, ctx) {
  // Multiple files: each line shows `<hex>  <name>`. Stdin: `<hex>  -`.
  const files = argv.slice(1);
  if (files.length === 0) {
    const text = await _bReadInput([], ctx);
    const hex = await _hashHex(algorithm, text);
    await ctx.stdout(`${hex}  -\n`);
    return 0;
  }
  let anyError = 0;
  for (const f of files) {
    try {
      const text = await ctx.vfs.readFile(_bResolvePath(f, ctx), 'text');
      const hex = await _hashHex(algorithm, text);
      await ctx.stdout(`${hex}  ${f}\n`);
    } catch (e) {
      await ctx.stderr(`${algorithm}sum: ${f}: ${e.message || 'cannot read'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _hashHex(algorithm, text) {
  // Web Crypto: SHA-256 always works in modern Node + browsers. MD5
  // isn't supported by Web Crypto (deprecated for security), so for
  // md5 we use a pure-JS implementation inline. SHA-1 / SHA-512 would
  // route to Web Crypto if added later.
  if (algorithm === 'md5') return _md5Hex(text);
  const algoName = algorithm === 'sha256' ? 'SHA-256'
                 : algorithm === 'sha1'   ? 'SHA-1'
                 : 'SHA-512';
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest(algoName, enc.encode(text));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Minimal pure-JS MD5 — RFC 1321. Not cryptographically safe; we ship
// it because md5sum is common in scripts as a checksum (not a cipher).
function _md5Hex(text) {
  // Convert string to UTF-8 bytes.
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const len = bytes.length;
  // Pad: append 0x80, then zeros until length ≡ 56 mod 64, then 64-bit length.
  const padLen = (len % 64 < 56 ? 56 : 120) - (len % 64);
  const total = len + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes, 0);
  buf[len] = 0x80;
  // Length in BITS, little-endian, 64 bits (high 32 bits zero — we won't
  // hash >4GB strings).
  const bitLen = len * 8;
  buf[total - 8] = bitLen & 0xff;
  buf[total - 7] = (bitLen >>> 8) & 0xff;
  buf[total - 6] = (bitLen >>> 16) & 0xff;
  buf[total - 5] = (bitLen >>> 24) & 0xff;
  // Process 64-byte blocks.
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const k = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const s = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
  ];
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  for (let i = 0; i < total; i += 64) {
    const m = new Array(16);
    for (let j = 0; j < 16; j++) {
      const off = i + j * 4;
      m[j] = (buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
    }
    let A = a, B = b, C = c, D = d;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if      (j < 16) { f = F(B, C, D); g = j; }
      else if (j < 32) { f = G(B, C, D); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = H(B, C, D); g = (3 * j + 5) % 16; }
      else             { f = I(B, C, D); g = (7 * j) % 16; }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + f + k[j] + m[g]) | 0, s[j])) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const toHexLE = (n) => {
    let h = '';
    for (let i = 0; i < 4; i++) h += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return h;
  };
  return toHexLE(a) + toHexLE(b) + toHexLE(c) + toHexLE(d);
}

// xargs: build commands from stdin tokens. v0 supports -n (batch size)
// and uses the dispatch in ctx to invoke the named command.
async function _xargs(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    n: { short: 'n', arg: true },
    I: { short: 'I', arg: true },
    zero: { short: '0' },
  });
  const cmdArgv = positionals.length === 0 ? ['echo'] : positionals;
  // Drain via the typed-aware helper — handles streaming-queue input
  // (the common pipeline shape) plus plain string / typed values.
  const stdinDrained = await drainInput(ctx);
  const stdin = typeof stdinDrained === 'string' ? stdinDrained : String(stdinDrained);
  // `-0` reads NUL-separated input — the canonical pairing for
  // `find -print0 | xargs -0`, which is the only safe way to pass
  // filenames containing whitespace or quotes through xargs.
  const tokens = opts.zero
    ? stdin.split('\0').filter(Boolean)
    : stdin.split(/\s+/).filter(Boolean);
  const batchSize = opts.n ? Math.max(1, parseInt(opts.n, 10)) : tokens.length;
  let lastExit = 0;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    let argvCall;
    if (opts.I) {
      // Substitute the placeholder in cmdArgv.
      argvCall = cmdArgv.map(a => a === opts.I ? batch.join(' ') : a);
    } else {
      argvCall = [...cmdArgv, ...batch];
    }
    const name = argvCall[0];
    if (ctx.builtins.has(name)) {
      const r = await ctx.builtins.get(name)(argvCall, ctx);
      lastExit = typeof r === 'number' ? r : 0;
    } else if (ctx.onCommand) {
      lastExit = await ctx.onCommand(name, argvCall, ctx);
    } else {
      await ctx.stderr(`xargs: ${name}: command not found\n`);
      lastExit = 127;
    }
    if (tokens.length === 0) break;
  }
  return lastExit;
}

// -- headless.js --

// Headless terminal adapter — implements the GeasTerminal interface as a
// pure in-memory buffer with simulated input. Used for:
//   - Tests: drive the executor without spinning up a real DOM terminal,
//     inspect captured output/blocks/input-callback registrations directly.
//   - MCP bridge / scripting: when the consumer wants the shell's output as
//     a string rather than rendering it.
//   - Reference implementation: nails down the GeasTerminal contract for
//     adapter authors writing @gcu/term and xterm.js bridges.
//
// Interface (all adapters MUST implement):
//
//   write(text)               — write a chunk of ANSI-bearing text
//   writeBlock(block)         — (optional, caps.richBlocks=true) write a
//                               structured Block (table, canvas, html, …)
//   onInput(cb) → unsubscribe — register a keystroke/input handler
//   size() → { cols, rows }   — current terminal dimensions
//   onResize(cb) → unsubscribe — register a resize handler
//   clear()                   — clear scrollback + any block region
//   caps() → { richBlocks }   — capability negotiation; geas inspects this
//                               at startup to decide whether to send Blocks
//                               or auto-serialize to text
//
// The headless adapter additionally exposes inspection / simulation methods
// for test use:
//
//   output()         → concatenated text written so far (string)
//   capturedBlocks() → array of Block objects writeBlock has received
//   sendInput(text)  → simulate the user typing `text`; fires onInput cbs
//   setSize(c, r)    → simulate a resize; fires onResize cbs

function createHeadlessAdapter(opts = {}) {
  const buffer = [];
  const blocks = [];
  let inputSubs = new Set();
  let resizeSubs = new Set();
  let cols = opts.cols ?? 80;
  let rows = opts.rows ?? 24;
  // Whether structured blocks are accepted. Headless defaults to true so
  // tests can assert the geas executor's typed-pipe output without needing
  // a separate adapter; pass `richBlocks: false` to simulate a text-only
  // terminal (e.g. xterm.js with no inline-block extension).
  const richBlocks = opts.richBlocks ?? true;

  return {
    // ── GeasTerminal interface ──
    write(text) {
      if (text == null) return;
      buffer.push(String(text));
    },
    writeBlock(block) {
      if (!richBlocks) {
        // Caller should check caps() first and serialize on their side, but
        // be defensive: stringify the block as a JSON fallback if we get one.
        try { buffer.push(JSON.stringify(block)); }
        catch { buffer.push(String(block)); }
        return;
      }
      blocks.push(block);
    },
    onInput(cb) {
      inputSubs.add(cb);
      return () => inputSubs.delete(cb);
    },
    size() {
      return { cols, rows };
    },
    onResize(cb) {
      resizeSubs.add(cb);
      return () => resizeSubs.delete(cb);
    },
    clear() {
      buffer.length = 0;
      blocks.length = 0;
    },
    caps() {
      return { richBlocks };
    },

    // ── headless-specific inspection / simulation ──
    output() {
      return buffer.join('');
    },
    capturedBlocks() {
      return blocks.slice();
    },
    sendInput(text) {
      const s = String(text ?? '');
      for (const cb of inputSubs) {
        try { cb(s); }
        catch (e) { /* swallow handler errors so one bad sub doesn't break the rest */ }
      }
    },
    setSize(newCols, newRows) {
      cols = newCols;
      rows = newRows;
      const size = { cols, rows };
      for (const cb of resizeSubs) {
        try { cb(size); }
        catch (e) { /* swallow */ }
      }
    },

    // Number of currently-registered subscribers — useful for tests that
    // verify unsubscribe semantics.
    _subCounts() {
      return { input: inputSubs.size, resize: resizeSubs.size };
    },
  };
}

// -- term.js --

// @gcu/term adapter — implements the GeasTerminal interface on top of a
// `@gcu/term` Terminal instance. The Terminal does the VT/ANSI parsing and
// DOM rendering; this adapter just bridges the two surfaces.
//
// Usage:
//
//   import { Terminal, DomRenderer, Input } from '@gcu/term';
//   import { createTermAdapter } from '@gcu/geas/adapters/term';
//
//   const term = new Terminal(80, 24);
//   const dom = new DomRenderer(term, screenEl);
//   const input = new Input(term, screenEl, hiddenEl, dom);
//   const adapter = createTermAdapter({ terminal: term });
//
//   const client = createGeasClient({ worker, vfs, ...adapterHooks(adapter) });
//
// where `adapterHooks(adapter)` wires onStdout / onStderr / onBlock to the
// adapter's write / writeBlock methods (see the helper at the bottom of
// this file).
//
// v0 capability: richBlocks=false. The Terminal renders to a fixed grid,
// so inline structured blocks (tables, canvases) aren't supported yet.
// Typed pipe output degrades to the canonical text rendering via the
// block's `.text` field. When @gcu/term grows "inline block regions"
// (interleavable DOM nodes between grid rows), flip caps to richBlocks=true
// and writeBlock can insert real widgets.

function createTermAdapter(opts) {
  const { terminal } = opts || {};
  if (!terminal) throw new Error('createTermAdapter: opts.terminal is required');
  const resizeSubs = new Set();
  return {
    write(text) {
      terminal.write(typeof text === 'string' ? text : String(text ?? ''));
    },
    writeBlock(block) {
      // No native inline-block rendering; write the canonical text view.
      // The producer-side typed-pipe output sets .text to the CSV / aligned
      // table rendering, so this degrades gracefully.
      if (block && typeof block.text === 'string') {
        terminal.write(block.text);
      } else {
        try { terminal.write(JSON.stringify(block)); }
        catch { terminal.write(String(block)); }
      }
    },
    onInput(cb) {
      // term.onText fires once per stretch of keyboard-generated bytes,
      // already decoded as a string. Returns an unsubscribe function — pass
      // straight through.
      return terminal.onText(cb);
    },
    size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    onResize(cb) {
      // @gcu/term v0 doesn't emit a resize event — the host triggers
      // resizes externally via term.resize(cols, rows). Callers that drive
      // resizes should also call adapter.notifyResize() so our subs fire.
      resizeSubs.add(cb);
      return () => resizeSubs.delete(cb);
    },
    clear() {
      // VT100: ESC[2J clears screen, ESC[H homes cursor.
      terminal.write('\x1b[2J\x1b[H');
    },
    caps() {
      return { richBlocks: false };
    },

    // Adapter-specific: call when you've externally resized the underlying
    // terminal so any GeasTerminal consumers learn about the new size.
    notifyResize(cols, rows) {
      const size = { cols, rows };
      for (const cb of resizeSubs) {
        try { cb(size); } catch { /* swallow per-listener */ }
      }
    },
  };
}

// Wire an adapter to a GeasClient's stdout/stderr/block sinks +
// interactive-read hook. Convenience so consumers don't have to spell
// out the same callbacks at every createGeasClient call.
function adapterHooks(adapter) {
  return {
    onStdout: (text) => adapter.write(text),
    onStderr: (text) => adapter.write(text),
    onBlock:  (block) => {
      if (adapter.caps().richBlocks && typeof adapter.writeBlock === 'function') {
        adapter.writeBlock(block);
      } else {
        adapter.write(block.text || '');
      }
    },
    onWantInput: makeLineEditor(adapter),
  };
}

// Build a line-editor function bound to an adapter. The returned async
// function matches the `onWantInput` shape: takes line options
// ({prompt, silent, nChars, delim, timeout, raw, onHistory}) and
// resolves to {line} on Enter, {eof: true} on Ctrl+D with empty
// buffer, or {timeout: true} on -t expiry.
//
// Editing controls (the lowest-common-denominator subset):
//   Enter / \r / \n      submit current buffer
//   Backspace / 0x7f     delete last char (echo \b \b)
//   Ctrl+D / 0x04        EOF when buffer empty; otherwise ignored
//   Ctrl+C / 0x03        cancel (resolves with eof — caller treats as
//                        "read interrupted")
//   Up / Down arrow      history recall, IF the caller passes an
//                        `onHistory(dir)` callback (dir: -1 older,
//                        +1 newer) returning the line to show
//   printable chars      append to buffer + echo (unless silent)
//
// CSI escape sequences (cursor keys, function keys) are recognised and
// swallowed cleanly — only Up/Down do anything, and only when
// onHistory is supplied. The editor does NOT do mid-line cursor
// movement, kill-ring, or reverse-search — that's @gcu/readline
// territory. This is "good enough for `read VAR` and a REPL prompt."
function makeLineEditor(adapter) {
  if (!adapter || typeof adapter.onInput !== 'function') {
    return null;
  }
  return function readLine(lineOpts = {}) {
    const { prompt, silent, nChars, delim, timeout, onHistory } = lineOpts;
    return new Promise((resolve) => {
      let buffer = '';
      let done = false;
      let timer = null;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { unsub && unsub(); } catch { /* ignore */ }
        if (!silent && (result.line != null || result.eof)) {
          // Echo the line-terminating newline so the cursor moves down
          // before whatever the program prints next.
          try { adapter.write('\r\n'); } catch { /* ignore */ }
        }
        resolve(result);
      };

      // Replace the visible buffer with `next` — erase the old chars
      // with destructive backspaces, then echo the new text. Used by
      // history recall.
      const replaceBuffer = (next) => {
        if (!silent && buffer.length > 0) {
          try { adapter.write('\b \b'.repeat(buffer.length)); } catch { /* ignore */ }
        }
        buffer = next;
        if (!silent && buffer.length > 0) {
          try { adapter.write(buffer); } catch { /* ignore */ }
        }
      };

      const onChar = (text) => {
        if (done || typeof text !== 'string') return;
        let i = 0;
        while (i < text.length && !done) {
          const ch = text[i];
          // CSI escape sequence: ESC '[' params final-byte. Parse the
          // whole thing so its bytes don't leak into the buffer.
          if (ch === '\x1b' && text[i + 1] === '[') {
            let j = i + 2;
            while (j < text.length && !/[A-Za-z~]/.test(text[j])) j++;
            const finalByte = text[j]; // may be undefined if split chunk
            i = j + 1;
            if ((finalByte === 'A' || finalByte === 'B') && typeof onHistory === 'function') {
              const recalled = onHistory(finalByte === 'A' ? -1 : 1);
              if (typeof recalled === 'string') replaceBuffer(recalled);
            }
            // Other CSI sequences (left/right/home/end/delete) are
            // swallowed silently — no mid-line editing in v0.
            continue;
          }
          // Lone ESC (or an escape sequence we don't model) — skip it.
          if (ch === '\x1b') { i++; continue; }
          if (ch === '\r' || ch === '\n') {
            finish({ line: buffer });
            return;
          }
          if (ch === '\x7f' || ch === '\b') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              if (!silent) {
                try { adapter.write('\b \b'); } catch { /* ignore */ }
              }
            }
            i++;
            continue;
          }
          if (ch === '\x04') {
            // Ctrl+D: EOF only when buffer is empty (POSIX shape).
            if (buffer.length === 0) { finish({ eof: true }); return; }
            i++;
            continue;
          }
          if (ch === '\x03') {
            // Ctrl+C: cancel. Echo `^C` so the user sees feedback,
            // then resolve as eof so `read` returns non-zero.
            try { adapter.write('^C'); } catch { /* ignore */ }
            finish({ eof: true });
            return;
          }
          // Skip other control chars.
          if (ch.charCodeAt(0) < 0x20) { i++; continue; }
          buffer += ch;
          if (!silent) {
            try { adapter.write(ch); } catch { /* ignore */ }
          }
          if (nChars != null && buffer.length >= nChars) {
            finish({ line: buffer });
            return;
          }
          if (delim && ch === delim[0]) {
            // Match bash: the delim char is NOT included in the result.
            finish({ line: buffer.slice(0, -1) });
            return;
          }
          i++;
        }
      };

      // Subscribe BEFORE writing the prompt so a fast typer can't race
      // ahead of us.
      const unsub = adapter.onInput(onChar);
      if (prompt) {
        try { adapter.write(prompt); } catch { /* ignore */ }
      }
      if (timeout != null && timeout > 0) {
        timer = setTimeout(() => finish({ timeout: true }), timeout * 1000);
      }
    });
  };
}

// -- xterm.js --

// xterm.js adapter — implements the GeasTerminal interface on top of an
// `xterm.js` Terminal instance. xterm.js is the industry-standard browser
// terminal (used by VS Code, koma, Hyper, …); the adapter exists so geas
// runs in any host that already vendors it.
//
// Usage:
//
//   import { Terminal as XtermTerminal } from 'xterm';
//   import { createXtermAdapter } from '@gcu/geas/adapters/xterm';
//
//   const term = new XtermTerminal({ cols: 80, rows: 24 });
//   term.open(screenEl);
//   const adapter = createXtermAdapter({ terminal: term });
//
//   const client = createGeasClient({ worker, vfs, ...adapterHooks(adapter) });
//
// v0 capability: richBlocks=false. xterm.js renders to a Canvas/WebGL grid
// with no built-in inline-DOM-block surface, so typed pipe output degrades
// via block.text — matching @gcu/term's behaviour. (xterm.js extensions
// exist for "addons" that could host inline widgets; defer that integration
// until someone reaches for it.)

function createXtermAdapter(opts) {
  const { terminal } = opts || {};
  if (!terminal) throw new Error('createXtermAdapter: opts.terminal is required');
  return {
    write(text) {
      terminal.write(typeof text === 'string' ? text : String(text ?? ''));
    },
    writeBlock(block) {
      if (block && typeof block.text === 'string') {
        terminal.write(block.text);
      } else {
        try { terminal.write(JSON.stringify(block)); }
        catch { terminal.write(String(block)); }
      }
    },
    onInput(cb) {
      // xterm.js: onData returns a disposable with .dispose().
      const sub = terminal.onData(cb);
      return () => { try { sub.dispose(); } catch { /* ignore */ } };
    },
    size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    onResize(cb) {
      // xterm.js fires onResize when fit / resize is called; wrap to match
      // our {cols, rows} payload shape.
      const sub = terminal.onResize((e) => cb({ cols: e.cols, rows: e.rows }));
      return () => { try { sub.dispose(); } catch { /* ignore */ } };
    },
    clear() {
      // xterm.js has a clear() method that wipes scrollback.
      if (typeof terminal.clear === 'function') terminal.clear();
      else terminal.write('\x1b[2J\x1b[H');
    },
    caps() {
      return { richBlocks: false };
    },
  };
}

// adapterHooks is defined once in adapters/term.js — import from there.
// (Both adapters expose the same shape, so a single helper suffices.)

// -- vfs-proxy.js --

// VFS-RPC proxy: lets a worker run geas while the actual @gcu/vfs lives
// on the main thread. Every vfs.X(...) call inside the worker round-trips
// through postMessage. Symmetric API — `serveVFS(target, vfs)` on the
// owning side, `createVfsClient(target)` on the consuming side. `target`
// is any object with `postMessage(msg)` and either `addEventListener('message', cb)`
// or settable `onmessage`.
//
// Why proxy (rather than move VFS into the worker): backends that need DOM
// access (auditable's Comment backend reads/writes a comment node) only
// work on the main thread. Proxying keeps a single VFS instance authoritative
// and lets every worker talk to it.
//
// Message shapes:
//
//   client → server:  { type: 'vfs-call', id, method, args }
//   server → client:  { type: 'vfs-reply', id, ok: true, value }
//                  |  { type: 'vfs-reply', id, ok: false, error: string }
//
// IDs are private to each direction so VFS replies can't conflict with
// other in-band messages (exec/done/stdout/etc.).

// Methods we proxy. Limited to the surface geas builtins actually call;
// add as needed.
const VFS_METHODS = [
  'readFile', 'writeFile', 'readdir', 'stat',
  'mkdir', 'unlink', 'rmdir', 'rename',
  'glob', 'exists', 'cp',
];

// Run on the side that OWNS the real VFS. Listens for vfs-call messages
// and dispatches to the real vfs, sending back vfs-reply.
//
// Returns a `stop()` function that removes the listener.
function serveVFS(target, vfs) {
  const handler = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'vfs-call') return;
    try {
      if (typeof vfs[msg.method] !== 'function') {
        throw new Error(`vfs: unknown method "${msg.method}"`);
      }
      const value = await vfs[msg.method](...(msg.args || []));
      target.postMessage({ type: 'vfs-reply', id: msg.id, ok: true, value });
    } catch (err) {
      target.postMessage({
        type: 'vfs-reply',
        id: msg.id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  };
  _vpAttach(target, handler);
  return () => _vpDetach(target, handler);
}

// Run on the side that CONSUMES vfs through message-passing (typically
// inside a worker). Returns a vfs-shaped proxy whose every call posts a
// message and awaits its reply.
function createVfsClient(target) {
  let nextId = 0;
  const pending = new Map();
  _vpAttach(target, (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'vfs-reply') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(new Error(msg.error));
  });

  const proxy = {};
  for (const method of VFS_METHODS) {
    proxy[method] = (...args) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage({ type: 'vfs-call', id, method, args });
      });
    };
  }
  return proxy;
}

// ── transport helpers ──
// Web Workers use addEventListener('message', cb); Node worker_threads use
// .on('message', cb). Our loopback target uses .addEventListener. Handle
// both shapes transparently.
function _vpAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    // Node worker_threads shape: payload arrives as the bare data, not an event.
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    // Chain so we don't blow away an existing onmessage.
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('vfs-proxy: target has no message-listener surface');
  }
}

function _vpDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
  // For onmessage-style we can't easily detach; the leak is small per worker.
}

// -- host-proxy.js --

// Host-RPC proxy: lets a worker-hosted geas command call back into the host
// realm — the surface that owns the A-Bus connection — to run operations the
// worker can't (e.g. install a code extension whose surfaces must register in
// the shell). Symmetric with vfs-proxy.js: `serveHost(target, handler)` on the
// owning side, `createHostClient(target)` in the worker.
//
// `handler(member, args) → value` decides what a call means; the terminal
// surface forwards it to the `works` Shell over A-Bus (safelisted members).
//
// Message shapes (own namespace, won't collide with vfs/exec/stdout):
//
//   client → server:  { type: 'host-call', id, member, args }
//   server → client:  { type: 'host-reply', id, ok: true, value }
//                  |  { type: 'host-reply', id, ok: false, error: string }

// Run on the side that owns the host capability (the surface). Listens for
// host-call, dispatches to `handler`, replies. Returns a stop() function.
function serveHost(target, handler) {
  const h = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'host-call') return;
    try {
      const value = await handler(msg.member, msg.args || []);
      target.postMessage({ type: 'host-reply', id: msg.id, ok: true, value });
    } catch (err) {
      target.postMessage({ type: 'host-reply', id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
    }
  };
  _hpAttach(target, h);
  return () => _hpDetach(target, h);
}

// Run in the worker. Returns `host(member, args) → Promise<value>`. If the
// host doesn't serve host-call (no handler wired), the promise simply never
// resolves — callers should treat a missing host bridge as "unavailable"
// before calling (ctx.host is null in those contexts).
function createHostClient(target) {
  let nextId = 0;
  const pending = new Map();
  _hpAttach(target, (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'host-reply') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(new Error(msg.error));
  });
  return (member, args = []) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.postMessage({ type: 'host-call', id, member, args });
    });
  };
}

// ── transport helpers (same shape as vfs-proxy.js) ──
function _hpAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('host-proxy: target has no message-listener surface');
  }
}

function _hpDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
}

// -- worker-shim.js --

// Worker shim — run this inside the worker scope after geas is loaded.
//
// Sets up the message protocol that pairs with GeasClient on the main side.
// Owns the long-lived shell instance for this worker; survives across exec
// calls so env mutations / cwd / function definitions persist.
//
// Usage (real worker):
//
//   import { setupGeasWorker } from '@gcu/geas/worker/shim';
//   setupGeasWorker(self);
//
// Usage (in-process / tests):
//
//   setupGeasWorker(loopback.workerSide);
//
// The shim doesn't import the geas API symbols directly here — they're
// passed via the `opts.createShell` factory so the same shim works whether
// geas was bundled or imported piecewise. (Inside the runnable worker
// entry, you'd pass `createShell` from the bundle.)



function setupGeasWorker(target, opts) {
  const { createShell, isTyped } = opts;
  if (typeof createShell !== 'function') {
    throw new Error('setupGeasWorker: opts.createShell is required');
  }
  const vfs = createVfsClient(target);
  // Host-RPC bridge: a function (member, args) → Promise that round-trips to
  // the host realm. Harmless when the host doesn't serve host-call (the call
  // just never resolves) — registry-aware builtins only use it when present
  // and the host wired it, so this is safe to always create.
  const host = createHostClient(target);
  let shell = null;

  // Interactive read state. Each pending read has a unique id; the
  // main side answers with `input-line` / `input-eof` / `input-timeout`
  // tagged by requestId. Lines that arrive ahead of any read request
  // queue in `inputBuffer` (so `client.input("hello\n")` from a test
  // harness or programmatic driver works without an adapter loop).
  let nextReadId = 0;
  const pendingReads = new Map();
  const inputBuffer = [];
  const readLine = (lineOpts) => {
    if (inputBuffer.length > 0) {
      return Promise.resolve({ line: inputBuffer.shift() });
    }
    const id = ++nextReadId;
    return new Promise((resolve, reject) => {
      pendingReads.set(id, { resolve, reject });
      target.postMessage({ type: 'want-input', requestId: id, opts: lineOpts || {} });
    });
  };

  // Forward writes from the shell out to the main side. Typed values get
  // their own message kind so the client can route them to writeBlock.
  const stdoutFn = (v) => {
    if (v && typeof v === 'object' && v.__geas_typed === true) {
      target.postMessage({
        type: 'block',
        kind: v.kind,
        value: v.value,
        text: String(v),
      });
    } else {
      target.postMessage({ type: 'stdout', text: typeof v === 'string' ? v : String(v ?? '') });
    }
  };
  const stderrFn = (text) => {
    target.postMessage({ type: 'stderr', text: typeof text === 'string' ? text : String(text ?? '') });
  };

  const handler = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init': {
        shell = createShell({
          vfs,
          // Only expose the host bridge when the client reported it serves
          // host-call; otherwise a host() call would hang forever.
          host: msg.host ? host : null,
          env: msg.env || {},
          cwd: msg.cwd || '/',
          stdout: stdoutFn,
          stderr: stderrFn,
          readLine,
        });
        target.postMessage({ type: 'init-done' });
        return;
      }
      case 'exec': {
        if (!shell) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: 'shell not initialised',
          });
          return;
        }
        try {
          const r = await shell.exec(msg.source);
          // Report the post-exec cwd so the client can render a
          // working-directory-aware prompt without a separate query.
          target.postMessage({ type: 'done', id: msg.id, exitCode: r.exitCode ?? 0, cwd: shell.cwd });
        } catch (err) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: err && err.message ? err.message : String(err),
            cwd: shell.cwd,
          });
        }
        return;
      }
      // Programmatic input: text becomes a "line." If a `read` is
      // waiting, resolve the oldest one; otherwise queue ahead so the
      // next `read` finds it.
      case 'input': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (pendingReads.size > 0) {
          const firstId = pendingReads.keys().next().value;
          const slot = pendingReads.get(firstId);
          pendingReads.delete(firstId);
          slot.resolve({ line: text });
        } else {
          inputBuffer.push(text);
        }
        return;
      }
      // Adapter-mediated input. Matches a specific pending read by id
      // and resolves it. Three reply kinds: a successful line, EOF
      // (Ctrl+D with empty buffer), or timeout (-t expiry).
      case 'input-line': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ line: typeof msg.line === 'string' ? msg.line : '' });
        }
        return;
      }
      case 'input-eof': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ eof: true });
        }
        return;
      }
      case 'input-timeout': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ timeout: true });
        }
        return;
      }
      case 'resize':
        return;
    }
  };
  _wsAttach(target, handler);
}

function _wsAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('setupGeasWorker: target has no message-listener surface');
  }
}

// -- client.js --

// GeasClient — the main-thread facade around a worker-hosted shell.
//
//   const client = createGeasClient({
//     worker,                          // Worker-like: postMessage + onmessage / addEventListener
//     vfs,                             // @gcu/vfs instance (lives on main)
//     env, cwd,                        // initial shell env / cwd
//     onStdout, onStderr, onBlock,     // optional output sinks (defaults log to console)
//   });
//
//   await client.ready();              // resolves once the worker has init-done'd
//   const { exitCode } = await client.exec('ls /home | grep arthur');
//   await client.terminate();          // tears the worker down
//
// The client owns the VFS service-side of the RPC. It manages exec IDs so
// concurrent exec calls can be tracked (the worker serialises them one at
// a time — concurrency is a future concern; for v0 a second exec() while
// one's in flight queues client-side).



function createGeasClient(opts) {
  const {
    worker,
    vfs,
    env = {},
    cwd = '/',
    onStdout = (t) => { /* default: drop */ },
    onStderr = (t) => { /* default: drop */ },
    onBlock  = (b) => { /* default: render text fallback */ onStdout(b.text); },
    // Interactive read handler. Called when the worker requests input
    // for a `read` builtin. Shape: ({prompt, silent, nChars, delim,
    // timeout, raw}) => Promise<{line?, eof?, timeout?}>.
    //
    // If null, the client posts an EOF reply for every request so
    // `read` returns 1 — matches "no terminal attached" semantics for
    // pure-programmatic clients that haven't wired an adapter.
    onWantInput = null,
    // Optional host-RPC handler: (member, args) => Promise<value>. When set,
    // worker-hosted builtins can call back into this realm (e.g. to install a
    // code extension whose surfaces must register in the shell). Left unset
    // for pure/headless clients — the worker then sees no host bridge.
    host = null,
  } = opts;
  if (!worker) throw new Error('createGeasClient: opts.worker is required');

  // Start serving VFS over the worker channel.
  const stopServe = vfs ? serveVFS(worker, vfs) : (() => {});
  // Start serving host-RPC if a handler was supplied.
  const stopHost = typeof host === 'function' ? serveHost(worker, host) : (() => {});

  // Track pending exec promises by id.
  let nextExecId = 0;
  const pendingExecs = new Map();
  let initReady = null;
  let initResolve = null;
  let initPromise = new Promise((r) => { initResolve = r; });
  // Last known working directory of the worker-hosted shell. Updated
  // from every `done` message so a host REPL can render a cwd-aware
  // prompt without round-tripping a `pwd`.
  let lastCwd = cwd;

  const handler = (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init-done':
        initReady = true;
        initResolve();
        return;
      case 'stdout':
        onStdout(msg.text || '');
        return;
      case 'stderr':
        onStderr(msg.text || '');
        return;
      case 'block':
        onBlock({ kind: msg.kind, value: msg.value, text: msg.text });
        return;
      case 'done': {
        const slot = pendingExecs.get(msg.id);
        if (!slot) return;
        pendingExecs.delete(msg.id);
        // The worker reports cwd on both success and error paths.
        if (typeof msg.cwd === 'string') lastCwd = msg.cwd;
        if (msg.error) slot.reject(new Error(msg.error));
        else slot.resolve({ exitCode: msg.exitCode, cwd: msg.cwd });
        return;
      }
      case 'want-input': {
        // Route to the host's handler (typically a line editor over
        // the terminal adapter). If no handler is wired, reply EOF so
        // the worker's `read` falls back to "no input available."
        const reqId = msg.requestId;
        const lineOpts = msg.opts || {};
        (async () => {
          if (typeof onWantInput !== 'function') {
            worker.postMessage({ type: 'input-eof', requestId: reqId });
            return;
          }
          try {
            const res = await onWantInput(lineOpts);
            if (!res) {
              worker.postMessage({ type: 'input-eof', requestId: reqId });
            } else if (res.timeout) {
              worker.postMessage({ type: 'input-timeout', requestId: reqId });
            } else if (res.eof) {
              worker.postMessage({ type: 'input-eof', requestId: reqId });
            } else {
              worker.postMessage({
                type: 'input-line',
                requestId: reqId,
                line: typeof res.line === 'string' ? res.line : '',
              });
            }
          } catch {
            worker.postMessage({ type: 'input-eof', requestId: reqId });
          }
        })();
        return;
      }
      // vfs-call is handled by serveVFS's own listener attached above.
    }
  };
  _wcAttach(worker, handler);

  // Kick off init.
  worker.postMessage({ type: 'init', env, cwd, host: typeof host === 'function' });

  // Serialise execs: queue them client-side so the worker only sees one at
  // a time. Simpler than expecting the worker to maintain a queue.
  let execChain = Promise.resolve({ exitCode: 0 });
  let terminated = false;

  return {
    ready: () => initPromise,

    // Last-known working directory of the worker shell. Updated after
    // every exec; a REPL host reads this to draw a cwd-aware prompt.
    get cwd() { return lastCwd; },

    exec(source) {
      if (terminated) return Promise.reject(new Error('geas: client terminated'));
      const next = execChain.then(async () => {
        // Re-check after awaiting the prior exec — terminate may have fired
        // while we were queued, in which case we should reject rather than
        // post a message that nothing is listening for.
        if (terminated) throw new Error('geas: client terminated');
        await initPromise;
        if (terminated) throw new Error('geas: client terminated');
        const id = nextExecId++;
        const p = new Promise((resolve, reject) => {
          pendingExecs.set(id, { resolve, reject });
        });
        worker.postMessage({ type: 'exec', id, source });
        return p;
      });
      // Chain so the next exec waits for this one to finish — but don't
      // propagate errors through the chain (an individual failure shouldn't
      // poison subsequent execs).
      execChain = next.catch(() => ({ exitCode: 1 }));
      return next;
    },

    input(text) { if (!terminated) worker.postMessage({ type: 'input', text }); },
    resize(cols, rows) { if (!terminated) worker.postMessage({ type: 'resize', cols, rows }); },

    async terminate() {
      terminated = true;
      stopServe();
      stopHost();
      _wcDetach(worker, handler);
      if (typeof worker.terminate === 'function') {
        try { await worker.terminate(); } catch { /* ignore */ }
      }
      // Reject any execs that have already registered themselves so callers
      // don't hang waiting for a reply that will never arrive.
      for (const [, slot] of pendingExecs) {
        slot.reject(new Error('geas: client terminated'));
      }
      pendingExecs.clear();
    },
  };
}

// ── transport helpers (same shape as vfs-proxy.js) ──
function _wcAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('createGeasClient: worker has no message-listener surface');
  }
}
function _wcDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
}

// -- loopback.js --

// Loopback "worker" — two paired endpoints that route postMessage calls to
// each other's listeners via queueMicrotask. Used for in-process tests so
// node --test can drive the worker harness without spawning real threads.
//
//   const { mainSide, workerSide } = createLoopback();
//   setupGeasWorker(workerSide, { createShell });
//   const client = createGeasClient({ worker: mainSide, vfs, ... });
//
// Both ends expose `addEventListener('message', cb)` / `removeEventListener`
// and `postMessage(msg)`. Messages are structured-cloned via JSON to mirror
// real Worker semantics (no shared refs across the boundary).

function createLoopback() {
  const mainListeners = new Set();
  const workerListeners = new Set();

  const main = {
    postMessage(msg) {
      const cloned = _clone(msg);
      queueMicrotask(() => {
        for (const cb of workerListeners) {
          try { cb({ data: cloned }); } catch (e) { /* swallow per-listener */ }
        }
      });
    },
    addEventListener(type, cb) {
      if (type === 'message') mainListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'message') mainListeners.delete(cb);
    },
    terminate() { mainListeners.clear(); workerListeners.clear(); },
  };
  const worker = {
    postMessage(msg) {
      const cloned = _clone(msg);
      queueMicrotask(() => {
        for (const cb of mainListeners) {
          try { cb({ data: cloned }); } catch (e) { /* swallow */ }
        }
      });
    },
    addEventListener(type, cb) {
      if (type === 'message') workerListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'message') workerListeners.delete(cb);
    },
    terminate() { mainListeners.clear(); workerListeners.clear(); },
  };
  return { mainSide: main, workerSide: worker };
}

// Mimic structured clone: anything JSON-safe round-trips identically;
// anything not (functions, DOM nodes, …) errors at the boundary, matching
// real postMessage semantics. ArrayBuffer / Map / Set get downgraded for v0
// (real structured clone preserves them; loopback's v0 doesn't matter for
// our message shapes which are plain JSON).
function _clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// -- proc-adapter.js --

// @gcu/proc ↔ @gcu/geas adapter.
//
// Bridges proc's Process / module-service shape to the Worker-shape that
// setupGeasWorker (worker side) and createGeasClient (main side) already
// expect. Two helpers — both small enough that the worker-side one is
// expected to be called from an inline wrapper around the geas bundle.
//
// Main side:
//   const proc = await pm.spawn({ module: workerBlobUrl, mode: 'service' });
//   const worker = procToWorker(proc);
//   const client = createGeasClient({ worker, vfs, ... });
//
// Worker side (inside the module-service entrypoint):
//   export default geasProcEntry({ createShell, isTyped, setupGeasWorker });
//
// (The dependencies of geasProcEntry are passed in because the
// module-service entrypoint runs INSIDE the inlined-bundle scope where
// createShell/isTyped/setupGeasWorker are local bindings, not imports.)

// Wrap a proc Process as a Worker-shaped object. The result quacks like a
// browser Worker (postMessage / addEventListener('message') / terminate),
// which is the interface createGeasClient consumes.
function procToWorker(proc) {
  return {
    postMessage(msg) { proc.send(msg); },
    addEventListener(type, fn) {
      if (type === 'message') {
        proc.on((data) => fn({ data }));
      }
      // 'error' / 'messageerror' currently not forwarded — proc's lifecycle
      // surface (proc.state, proc.error, proc.wait()) covers those.
    },
    removeEventListener() {
      // proc.on returns an unsubscribe; we don't track it here because
      // createGeasClient calls removeEventListener once on teardown
      // immediately followed by proc.kill — terminate cleans up the
      // listeners regardless.
    },
    terminate() {
      try { proc.kill('KILL'); } catch (_) { /* ignore */ }
    },
  };
}

// Build a default-export entrypoint for a geas worker that runs under
// proc's module-service mode. The returned function takes the proc ctx
// (with stdin/stdout/stderr/signal/send/on/exit), builds a Worker-shaped
// target around it, hands that to setupGeasWorker, and parks on the
// signal until killed.
//
// deps: { createShell, isTyped, setupGeasWorker } — passed in because
// this module is bundled separately from the inlined geas bundle that
// owns those symbols.
function geasProcEntry(deps) {
  const { createShell, isTyped, setupGeasWorker } = deps;
  if (typeof setupGeasWorker !== 'function') {
    throw new Error('geasProcEntry: setupGeasWorker is required');
  }
  if (typeof createShell !== 'function') {
    throw new Error('geasProcEntry: createShell is required');
  }
  return async function geasEntrypoint(ctx) {
    const target = {
      postMessage(msg) { ctx.send(msg); },
      addEventListener(type, fn) {
        if (type === 'message') {
          ctx.on((data) => fn({ data }));
        }
      },
      removeEventListener() { /* no-op — proc tears down on exit */ },
    };
    setupGeasWorker(target, { createShell, isTyped });
    // Park until killed. setupGeasWorker registered all its handlers
    // already; nothing to do here except keep the entrypoint alive so
    // proc doesn't post EXIT prematurely.
    if (ctx.signal.aborted) return;
    await new Promise((resolve) => {
      ctx.signal.addEventListener('abort', resolve);
    });
  };
}

// -- api.js --

// Public API surface for @gcu/geas.
//
// v0.0.1 (Medium scope): lexer + parser only. Executor, builtins, terminal
// adapters, and the worker harness come in later iterations.
//
// Note on shape: uses `import { x } from './foo.js'; export { x };` rather
// than `export { x } from './foo.js'` so the concat-style build can strip
// both lines and leave api.js's contribution empty in the bundle — the
// footer in build.js then provides a single canonical export.

















//
// Convenience factory that builds a long-lived shell context with the
// default geas built-ins pre-loaded (echo / pwd / cd / env / cat / ls /
// test / [ / true / false / : / export / exit). The returned object has:
//
//   .exec(source)      — parse + execute a script, return {exitCode,...}
//   .env               — Map (mutable; survives across exec calls)
//   .cwd               — string (mutable via cd builtin)
//   .lastStatus        — number, $? after the most recent command
//   .builtins          — Map (add/override entries before/between execs)
//   .functions         — Map of user-defined functions (populated by `name()`)
//
// Caller-supplied stdout/stderr/onCommand/extra builtins overlay the
// defaults. Pass a VFS instance to enable filesystem builtins + redirects.
function createShell(opts = {}) {
  // Normalize ONCE and hold the result — every exec reuses this same
  // ctx, so cwd / env / functions / lastStatus all persist between
  // commands (a fresh-normalize-per-exec would drop `cd`'s effect,
  // since cwd is a primitive copied by value).
  const ctx = normalizeContext({
    vfs:        opts.vfs ?? null,
    host:       opts.host ?? null,
    env:        opts.env instanceof Map ? opts.env : new Map(Object.entries(opts.env || {})),
    cwd:        opts.cwd ?? '/',
    stdin:      '',
    stdout:     opts.stdout ?? (() => { throw new Error('createShell: stdout required'); }),
    stderr:     opts.stderr ?? opts.stdout ?? (() => { throw new Error('createShell: stderr required'); }),
    builtins:   _mergeBuiltins(opts.builtins),
    // POSIX shell convention: an unrecognised command prints
    // "{name}: command not found" to stderr and exits 127. The executor's
    // bare default just returns 127; createShell is the user-facing
    // factory, so this is the right place for the matching stderr write.
    onCommand:  opts.onCommand ?? (async (name, _argv, subCtx) => {
      await subCtx.stderr(`${name}: command not found\n`);
      return 127;
    }),
    functions:  new Map(),
    lastStatus: 0,
    // Interactive read hook. When `read` runs with no stdin available
    // and this is set, it awaits a line from here instead of returning
    // EOF. Shape: (opts) => Promise<{ line?, eof?, timeout? }>. opts
    // carries prompt, silent, nChars, delim, timeout, raw — the read
    // flags that affect line acquisition.
    readLine:   typeof opts.readLine === 'function' ? opts.readLine : null,
  });
  return {
    get env()        { return ctx.env; },
    get cwd()        { return ctx.cwd; },
    get lastStatus() { return ctx.lastStatus; },
    get builtins()   { return ctx.builtins; },
    get functions()  { return ctx.functions; },
    async exec(source) {
      const ast = parse(source);
      return await execute(ast, ctx);
    },
  };
}

function _mergeBuiltins(extra) {
  const base = defaultBuiltins();
  if (!extra) return base;
  const it = extra instanceof Map ? extra.entries() : Object.entries(extra);
  for (const [k, v] of it) base.set(k, v);
  return base;
}

export { tokenize, parse, parseWordParts, execute, defaultBuiltins, createShell, mkTyped, isTyped, NODE, createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, makeLineEditor, createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback, procToWorker, geasProcEntry };
