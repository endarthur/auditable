// @gcu/wasm4 — the WASM-4 system font (8×8, 224 glyphs covering 0x20-0xFF).
// VENDORED DATA ASSET, not code: the glyph bytes from WASM-4's native runtime
// (runtimes/native/src/framebuffer.c). MIT © Bruno Garcia / aduros — see
// vendor-licenses.json (name: wasm4). Stored inverted + MSB-first exactly as
// upstream (an on-pixel is a 0 bit), so text() blits it as a 1bpp sprite sheet
// the same way the real runtime does — faithful glyph metrics for real carts.
//
// To refresh: re-fetch framebuffer.c and re-run the extractor (see project_wasm4).

const FONT_FIRST = 0x20, FONT_LAST = 0xff, FONT_BASE = 0xdc00;
const FONT_B64 = "///////////Hx8fPz//P/5OTk///////kwGTk5MBk//vgy+D6QPv/51bN+/ZtXP/jycnjyUzgf/Pz8////////Pnz8/P5/P/n8/n5+fPn///k8cBx5P////n54Hn5//////////Pz5////+B////////////z8///fv379+/f//Hszk5OZvH/+fH5+fn54H/gznxw4cfAf+B8+fD+TmD/+PDkzMB8/P/Az8D+fk5g//Dnz8DOTmD/wE58+fPz8//hzsbh2F5g/+DOTmB+fOH///Pz//Pz////8/P/8/Pn//z58+fz+fz////Af8B////n8/n8+fPn/+DATnzx//H/4N9RVVBf4P/x5M5OQE5Of8DOTkDOTkD/8OZPz8/mcP/BzM5OTkzB/8BPz8DPz8B/wE/PwM/Pz//wZ8/MTmZwf85OTkBOTk5/4Hn5+fn54H/+fn5+fk5g/85MycPByMx/5+fn5+fn4H/OREBASk5Of85GQkBITE5/4M5OTk5OYP/Azk5OQM/P/+DOTk5ITOF/wM5OTEHIzH/hzM/g/k5g/+B5+fn5+fn/zk5OTk5OYP/OTk5EYPH7/85OSkBARE5/zkRg8eDETn/mZmZw+fn5/8B8ePHjx8B/8PPz8/Pz8P/f7/f7/f7/f+H5+fn5+eH/8eT/////////////////wHv9///////////g/mBOYH/Pz8DOTk5g////4E/Pz+B//n5gTk5OYH///+DOQE/g//x54Hn5+fn////gTk5gfmDPz8DOTk5Of/n/8fn5+eB//P/4/Pz8/OHPz8xAwcjMf/H5+fn5+eB////A0lJSUn///8DOTk5Of///4M5OTmD////Azk5Az8///+BOTmB+fn//5GPn5+f////gz+D+QP/5+eB5+fn5////zk5OTmB////mZmZw+f///9JSUlJgf///zkBxwE5////OTk5gfmD//8B48ePAf/z5+fP5+fz/+fn5+fn5+f/n8/P58/Pn////49F4///////////k5P/gykpESkpg/+DOQkRITmD//////////////////////+DESF9IRGD/4MRCX0JEYP/gxE5VRERg/+DERFVORGD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////5//n58fHx//vgykvKYPv/8OZnwOfnwH//6Xb29ul//+ZmcOB54Hn/+fn5//n5+f/w5mH2+GZw/+T/////////8O9Zl5eZr3Dh8OTw///////yZMnk8n/////gfn5///////////////DvUZaRlq9w4P/////////79fv///////n54Hn5/+B/8fz58P/////w+fzx//////37///////////MzMzMwk/wZW1lcH19f/////Pz/////////////fP58fnw//////Hk5PH//////8nk8mTJ///vTu3rdmxff+9O7ep3btx/x271y3ZsX3/x//HnzkBg//f78eTOQE5//fvx5M5ATn/x5PHkzkBOf/Lp8eTOQE5/5P/x5M5ATn/79fHkzkBOf/BhychBych/8OZPz+Zw/fP3+8BPwM/Af/37wE/Az8B/8eTAT8DPwH/k/8BPwM/Af/v94Hn5+eB//fvgefn54H/58OB5+fngf+Z/4Hn5+eB/4eTmQmZk4f/y6cZCQEhMf/f74M5OTmD//fvgzk5OYP/x5ODOTk5g//Lp4M5OTmD/5P/gzk5OYP//7vX79e7//+DOTEpGTmD/9/vOTk5OYP/9+85OTk5g//Hk/85OTmD/5P/OTk5OYP/9++ZmcPn5/8/Azk5OQM//8OZmZOZiZP/3++D+YE5gf/374P5gTmB/8eTg/mBOYH/y6eD+YE5gf+T/4P5gTmB/+/Xg/mBOYH///+D6YEvg////4E/P4H3z9/vgzkBP4P/9++DOQE/g//Hk4M5AT+D/5P/gzkBP4P/3+//x+fngf/37//H5+eB/8eT/8fn54H/k//H5+fngf+bh2eDOTmD/8unAzk5OTn/3++DOTk5g//374M5OTmD/8eTgzk5OYP/y6eDOTk5g/+T/4M5OTmD///n/4H/5/////+DMSkZg//f7zk5OTmB//fvOTk5OYH/x5P/OTk5gf+T/zk5OTmB//fvOTk5gfmDPz8DOTkDPz+T/zk5OYH5gw==";

// 1792 bytes = 224 glyphs × 8 rows. Returned verbatim (already in sprite-sheet
// layout: 8px wide, char c at row (c-0x20)*8).
function packFont() {
  const bin = (typeof atob === "function")
    ? atob(FONT_B64)
    : Buffer.from(FONT_B64, "base64").toString("binary");
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

module.exports = { FONT_FIRST, FONT_LAST, FONT_BASE, FONT_B64, packFont };
