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

  async addFile(path, bytes) {
    if (this._pendingError) throw this._pendingError;
    const buf = bytes instanceof Uint8Array ? bytes
      : (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
    // level=0 → store (no compression); else deflate.
    const file = this._level === 0
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: this._level });
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
  if (format === 'xz' || format === 'bz2' || format === 'tar.xz' || format === 'tar.bz2') {
    throw new Error(`createWriter: ${format} encode requires a lazy-loaded Wasm encoder (not yet wired)`);
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

// Resolve a source to bytes + format, peeling off any outer gz/zst wrapper
// so the caller can dispatch on the inner archive format uniformly.
async function _peelCompression(src) {
  const resolved = await _resolveSourceFormat(src);
  if (resolved.format === 'gz' || resolved.format === 'tar.gz') {
    return _unwrapGz(resolved.bytes, resolved.name);
  }
  if (resolved.format === 'zst' || resolved.format === 'tar.zst') {
    return _unwrapZst(resolved.bytes, resolved.name);
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
  switch (format) {
    case 'tar.xz':
    case 'tar.bz2':
    case 'xz':
    case 'bz2':
      return `archive: ${format} requires a lazy-loaded Wasm decoder (not yet wired)`;
    default:
      return `archive: unsupported format '${format}'`;
  }
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
    if (format === 'gz-single' || format === 'zst-single') {
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
    if (format === 'gz-single' || format === 'zst-single') {
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
    else if (format === 'gz-single' || format === 'zst-single') {
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

    // tar.zst / tar.xz / tar.bz2 can't be written until their encoders are
    // vendored. Be explicit so users don't think it silently no-op'd.
    if (format === 'tar.zst') {
      throw new Error('archive.compress: tar.zst encode not available (fzstd is decode-only)');
    }
    if (format === 'tar.xz' || format === 'tar.bz2' || format === 'xz' || format === 'bz2') {
      throw new Error(`archive.compress: ${format} encode requires a lazy-loaded Wasm encoder (not yet wired)`);
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
export {
  detectFormat, magicForFormat,
  normalizeSource, normalizeSink,
  listZip, readZip,
  listTar, readTar, writeTar,
  gunzipBytes, gzipBytes,
  unzstdBytes, zstdBytes,
  walkVfsTree, buildEntryMap,
  createWriter,
  archive,
};
