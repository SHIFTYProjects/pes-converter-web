"use strict";

// Embroidery file formats, written natively in JavaScript so export works offline with no runtime download.
// PES v1 / PEC output follows pyembroidery 1.5.1's writer byte-for-byte (encode=False), which is the
// structure this app has always exported. DST (Tajima) is provided for other machine brands.
(() => {
  const STITCH = 0, JUMP = 1, TRIM = 2, END = 4, COLOR_CHANGE = 5;

  // Brother PEC thread chart. Index 0 is unused; the machine shows these names on screen.
  const BROTHER = [null,
    [14, 31, 124, "Prussian Blue"], [10, 85, 163, "Blue"], [0, 135, 119, "Teal Green"], [75, 107, 175, "Cornflower Blue"],
    [237, 23, 31, "Red"], [209, 92, 0, "Reddish Brown"], [145, 54, 151, "Magenta"], [228, 154, 203, "Light Lilac"],
    [145, 95, 172, "Lilac"], [158, 214, 125, "Mint Green"], [232, 169, 0, "Deep Gold"], [254, 186, 53, "Orange"],
    [255, 255, 0, "Yellow"], [112, 188, 31, "Lime Green"], [186, 152, 0, "Brass"], [168, 168, 168, "Silver"],
    [125, 111, 0, "Russet Brown"], [255, 255, 179, "Cream Brown"], [79, 85, 86, "Pewter"], [0, 0, 0, "Black"],
    [11, 61, 145, "Ultramarine"], [119, 1, 118, "Royal Purple"], [41, 49, 51, "Dark Gray"], [42, 19, 1, "Dark Brown"],
    [246, 74, 138, "Deep Rose"], [178, 118, 36, "Light Brown"], [252, 187, 197, "Salmon Pink"], [254, 55, 15, "Vermilion"],
    [240, 240, 240, "White"], [106, 28, 138, "Violet"], [168, 221, 196, "Seacrest"], [37, 132, 187, "Sky Blue"],
    [254, 179, 67, "Pumpkin"], [255, 243, 107, "Cream Yellow"], [208, 166, 96, "Khaki"], [209, 84, 0, "Clay Brown"],
    [102, 186, 73, "Leaf Green"], [19, 74, 70, "Peacock Blue"], [135, 135, 135, "Gray"], [216, 204, 198, "Warm Gray"],
    [67, 86, 7, "Dark Olive"], [253, 217, 222, "Flesh Pink"], [249, 147, 188, "Pink"], [0, 56, 34, "Deep Green"],
    [178, 175, 212, "Lavender"], [104, 106, 176, "Wisteria Violet"], [239, 227, 185, "Beige"], [247, 56, 102, "Carmine"],
    [181, 75, 100, "Amber Red"], [19, 43, 26, "Olive Green"], [199, 1, 86, "Dark Fuchsia"], [254, 158, 50, "Tangerine"],
    [168, 222, 235, "Light Blue"], [0, 103, 62, "Emerald Green"], [78, 41, 144, "Purple"], [47, 126, 32, "Moss Green"],
    [255, 204, 204, "Flesh Pink"], [255, 217, 17, "Harvest Gold"], [9, 91, 166, "Electric Blue"], [240, 249, 112, "Lemon Yellow"],
    [227, 243, 91, "Fresh Green"], [255, 153, 0, "Orange"], [255, 240, 141, "Cream Yellow"], [255, 200, 200, "Applique"]
  ];

  const hexToRgb = (hex) => { const n = parseInt(String(hex).slice(1, 7), 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const rgbToHex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  // Python's round() rounds halves to even; matching it keeps thread matching identical to pyembroidery.
  const roundHalfEven = (v) => { const f = Math.floor(v), d = v - f; return d > .5 ? f + 1 : d < .5 ? f : (f % 2 === 0 ? f : f + 1); };
  function colorDistance(a, b) {
    const rm = roundHalfEven((a[0] + b[0]) / 2), r = a[0] - b[0], g = a[1] - b[1], bl = a[2] - b[2];
    return (((512 + rm) * r * r) >> 8) + 4 * g * g + (((767 - rm) * bl * bl) >> 8);
  }
  function nearestIndex(rgb, table) {
    let best = null, bestD = Infinity;
    table.forEach((t, i) => {
      if (!t) return;
      const d = colorDistance(rgb, t);
      if (d <= bestD) { bestD = d; best = i; }
    });
    return best;
  }
  function nearestBrother(hex) {
    const i = nearestIndex(hexToRgb(hex), BROTHER);
    return { index: i, name: BROTHER[i][3], hex: rgbToHex(BROTHER[i][0], BROTHER[i][1], BROTHER[i][2]) };
  }

  class Bytes {
    constructor() { this.buf = new Uint8Array(1 << 16); this.length = 0; }
    ensure(n) {
      if (this.length + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Uint8Array(size); next.set(this.buf.subarray(0, this.length)); this.buf = next;
    }
    u8(v) { this.ensure(1); this.buf[this.length++] = v & 255; }
    bytes(list) { for (const v of list) this.u8(v); }
    u16(v) { this.u8(v); this.u8(v >> 8); }
    u24(v) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); }
    u32(v) { this.u16(v & 0xFFFF); this.u16((v >>> 16) & 0xFFFF); }
    f32(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(d.getUint8(i)); }
    str(s) { for (const ch of new TextEncoder().encode(s)) this.u8(ch); }
    patch16(at, v) { this.buf[at] = v & 255; this.buf[at + 1] = (v >> 8) & 255; }
    patch24(at, v) { this.buf[at] = v & 255; this.buf[at + 1] = (v >> 8) & 255; this.buf[at + 2] = (v >> 16) & 255; }
    patch32(at, v) { this.patch16(at, v & 0xFFFF); this.patch16(at + 2, (v >>> 16) & 0xFFFF); }
    result() { return this.buf.slice(0, this.length); }
  }

  function bounds(cmds) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of cmds) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }

  // ---- PEC ----
  const ICON_W = 48, ICON_H = 38, STRIDE = 6;
  function blankIcon() {
    const g = new Uint8Array(STRIDE * ICON_H);
    const row = (y, bytes) => g.set(bytes, y * STRIDE);
    row(1, [0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]); row(2, [0x08, 0, 0, 0, 0, 0x10]); row(3, [0x04, 0, 0, 0, 0, 0x20]);
    for (let y = 4; y <= 33; y++) row(y, [0x02, 0, 0, 0, 0, 0x40]);
    row(34, [0x04, 0, 0, 0, 0, 0x20]); row(35, [0x08, 0, 0, 0, 0, 0x10]); row(36, [0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]);
    return g;
  }
  function drawIcon(ext, points, g, buffer) {
    const dw = (ext[2] - ext[0]) || 1, dh = (ext[3] - ext[1]) || 1;
    const scale = Math.min((ICON_W - buffer) / dw, (ICON_H - buffer) / dh);
    const tx = -((ext[2] + ext[0]) / 2) * scale + ICON_W / 2, ty = -((ext[3] + ext[1]) / 2) * scale + ICON_H / 2;
    for (const p of points) {
      const x = Math.floor(p[0] * scale + tx), y = Math.floor(p[1] * scale + ty);
      const i = y * STRIDE + Math.trunc(x / 8);
      if (x >= 0 && i >= 0 && i < g.length) g[i] |= 1 << (x % 8);
    }
  }
  function pecValue(out, value, long = false, flag = 0) {
    if (!long && value > -64 && value < 63) { out.u8(value & 0x7F); return; }
    let v = value & 0xFFF; v |= 0x8000; v |= flag << 8;
    out.u8((v >> 8) & 0xFF); out.u8(v & 0xFF);
  }
  function pecEncode(out, cmds) {
    let colorTwo = true, jumping = true, init = true, xx = 0, yy = 0;
    for (const [x, y, cmd] of cmds) {
      const dx = Math.round(x - xx), dy = Math.round(y - yy);
      xx += dx; yy += dy;
      if (cmd === STITCH) {
        if (jumping) { if (dx !== 0 && dy !== 0) { pecValue(out, 0); pecValue(out, 0); } jumping = false; }
        pecValue(out, dx); pecValue(out, dy);
      } else if (cmd === JUMP) {
        jumping = true;
        const flag = init ? 0x10 : 0x20;
        pecValue(out, dx, true, flag); pecValue(out, dy, true, flag);
      } else if (cmd === COLOR_CHANGE) {
        if (jumping) { pecValue(out, 0); pecValue(out, 0); jumping = false; }
        out.bytes([0xFE, 0xB0, colorTwo ? 2 : 1]); colorTwo = !colorTwo;
      } else if (cmd === END) { out.u8(0xFF); break; }
      init = false;
    }
  }
  const validThread = (i) => Number.isInteger(i) && i >= 1 && i < BROTHER.length;
  // Brother thread slot per color block. `forced[k]` (a Brother thread number) is what the user chose
  // for that block; every other color gets the nearest still-unused Brother thread, as pyembroidery does.
  function uniquePalette(threads, forced = []) {
    const table = BROTHER.slice(), chart = new Array(BROTHER.length).fill(null);
    forced.forEach((i) => { if (validThread(i)) table[i] = null; });
    for (const hex of [...new Set(threads.filter((_, k) => !validThread(forced[k])))]) {
      const rgb = hexToRgb(hex), i = nearestIndex(rgb, table);
      if (i === null) break;
      table[i] = null; chart[i] = rgb;
    }
    return threads.map((hex, k) => validThread(forced[k]) ? forced[k] : nearestIndex(hexToRgb(hex), chart));
  }
  function writePec(out, cmds, threads, name, forced = []) {
    const ext = bounds(cmds);
    out.str("LA:" + name.slice(0, 8).padEnd(16, " ") + "\r");
    out.bytes([...new Array(12).fill(0x20), 0xFF, 0x00, ICON_W / 8, ICON_H]);
    const indices = uniquePalette(threads, forced);
    out.bytes(new Array(12).fill(0x20));
    out.u8(indices.length - 1);
    out.bytes(indices);
    for (let i = indices.length; i < 463; i++) out.u8(0x20);
    const start = out.length;
    out.bytes([0, 0]); out.u24(0); out.bytes([0x31, 0xFF, 0xF0]);
    out.u16(roundHalfEven(ext[2] - ext[0])); out.u16(roundHalfEven(ext[3] - ext[1]));
    out.u16(0x1E0); out.u16(0x1B0);
    pecEncode(out, cmds);
    out.patch24(start + 2, out.length - start);
    // Icons: whole design, then one per color block.
    const all = blankIcon();
    drawIcon(ext, cmds.filter((c) => c[2] === STITCH), all, 4);
    out.bytes(all);
    let block = [];
    const flush = () => { const g = blankIcon(); drawIcon(ext, block.filter((c) => c[2] === STITCH), g, 5); out.bytes(g); block = []; };
    for (const c of cmds) { block.push(c); if (c[2] === COLOR_CHANGE) flush(); }
    flush();
  }

  // ---- PES v1 ----
  function writePes({ commands, threads, name = "Design", machineThreads = [] }) {
    const blockCode = (k) => validThread(machineThreads[k]) ? machineThreads[k] : nearestIndex(hexToRgb(threads[k] || threads.at(-1)), BROTHER);
    const cmds = commands;
    if (!cmds.length || cmds.at(-1)[2] !== END) throw new Error("Stitch data must end with END.");
    const blocksNeeded = 1 + cmds.filter((c) => c[2] === COLOR_CHANGE).length;
    if (threads.length !== blocksNeeded) throw new Error(`Thread count (${threads.length}) does not match color blocks (${blocksNeeded}).`);
    const out = new Bytes();
    out.str("#PES0001");
    const pecAt = out.length; out.u32(0);
    out.u16(1); out.u16(1); out.u16(1);
    out.u16(0xFFFF); out.u16(0);
    const [minX, minY, maxX, maxY] = bounds(cmds);
    const cx = (maxX + minX) / 2, cy = (maxY + minY) / 2;
    const left = minX - cx, top = minY - cy, right = maxX - cx, bottom = maxY - cy;
    const width = right - left, height = bottom - top;
    out.u16(7); out.str("CEmbOne");
    for (let i = 0; i < 8; i++) out.u16(0);
    const transX = 350 + 1300 / 2 - width / 2, transY = 100 + height + 1800 / 2 - height / 2;
    out.f32(1); out.f32(0); out.f32(0); out.f32(1); out.f32(transX); out.f32(transY);
    out.u16(1); out.u16(0); out.u16(0); out.u16(Math.trunc(width)); out.u16(Math.trunc(height));
    out.bytes(new Array(8).fill(0));
    const sectionsAt = out.length; out.u16(0);
    out.u16(0xFFFF); out.u16(0);
    out.u16(7); out.str("CSewSeg");
    // Segments: one per run of the same command, as pyembroidery's get_as_command_blocks.
    const adjX = left + cx, adjY = bottom + cy;
    const blocks = [];
    for (const c of cmds) {
      if (blocks.length && blocks.at(-1)[0][2] === c[2]) blocks.at(-1).push(c); else blocks.push([c]);
    }
    let colorIndex = 0, colorCode = blockCode(colorIndex++);
    let stitchedX = 0, stitchedY = 0, section = 0, previousCode = -1, first = true;
    const colorLog = [];
    for (const block of blocks) {
      const command = block[0][2];
      let points, flag;
      if (command === JUMP) {
        const last = block.at(-1);
        points = [[stitchedX - adjX, stitchedY - adjY], [last[0] - adjX, last[1] - adjY]]; flag = 1;
      } else if (command === COLOR_CHANGE) {
        colorCode = blockCode(colorIndex++);
        continue;
      } else if (command === STITCH) {
        points = block.map((s) => { stitchedX = s[0]; stitchedY = s[1]; return [s[0] - adjX, s[1] - adjY]; }); flag = 0;
      } else continue;
      if (!first) out.u16(0x8003);
      first = false;
      if (previousCode !== colorCode) { colorLog.push([section, colorCode]); previousCode = colorCode; }
      out.u16(flag); out.u16(colorCode); out.u16(points.length);
      for (const [x, y] of points) { out.u16(Math.trunc(x)); out.u16(Math.trunc(y)); }
      section++;
    }
    out.u16(colorLog.length);
    for (const [s, c] of colorLog) { out.u16(s); out.u16(c); }
    out.patch16(sectionsAt, section);
    out.u16(0); out.u16(0);
    out.patch32(pecAt, out.length);
    writePec(out, cmds, threads, name, machineThreads);
    return out.result();
  }

  // ---- DST (Tajima) ----
  function dstRecord(x, y, cmd) {
    y = -y;
    let b0 = 0, b1 = 0, b2 = 0;
    const bit = (n) => 1 << n;
    if (cmd === JUMP) b2 |= bit(7);
    if (cmd === STITCH || cmd === JUMP) {
      b2 |= bit(0) | bit(1);
      if (x > 40) { b2 |= bit(2); x -= 81; } if (x < -40) { b2 |= bit(3); x += 81; }
      if (x > 13) { b1 |= bit(2); x -= 27; } if (x < -13) { b1 |= bit(3); x += 27; }
      if (x > 4) { b0 |= bit(2); x -= 9; } if (x < -4) { b0 |= bit(3); x += 9; }
      if (x > 1) { b1 |= bit(0); x -= 3; } if (x < -1) { b1 |= bit(1); x += 3; }
      if (x > 0) { b0 |= bit(0); x -= 1; } if (x < 0) { b0 |= bit(1); x += 1; }
      if (y > 40) { b2 |= bit(5); y -= 81; } if (y < -40) { b2 |= bit(4); y += 81; }
      if (y > 13) { b1 |= bit(5); y -= 27; } if (y < -13) { b1 |= bit(4); y += 27; }
      if (y > 4) { b0 |= bit(5); y -= 9; } if (y < -4) { b0 |= bit(4); y += 9; }
      if (y > 1) { b1 |= bit(7); y -= 3; } if (y < -1) { b1 |= bit(6); y += 3; }
      if (y > 0) { b0 |= bit(7); y -= 1; } if (y < 0) { b0 |= bit(6); y += 1; }
      if (x !== 0 || y !== 0) throw new Error("DST move exceeds 12.1 mm.");
    } else if (cmd === COLOR_CHANGE) b2 = 0xC3;
    else if (cmd === END) b2 = 0xF3;
    return [b0, b1, b2];
  }
  function writeDst({ commands, threads, name = "Design", threadNames = [] }) {
    // DST designs are centered on the origin.
    const [x0, y0, x1, y1] = bounds(commands);
    const ox = Math.round((x0 + x1) / 2), oy = Math.round((y0 + y1) / 2);
    const cmds = commands.map(([x, y, c]) => [x - ox, y - oy, c]);
    const records = [];
    let xx = 0, yy = 0;
    for (const [x, y, cmd] of cmds) {
      if (cmd === TRIM) { records.push(dstRecord(2, 2, JUMP), dstRecord(-4, -4, JUMP), dstRecord(2, 2, JUMP)); continue; }
      if (cmd === STITCH || cmd === JUMP) {
        const dx = Math.round(x - xx), dy = Math.round(y - yy);
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 121));
        let px = 0, py = 0;
        for (let k = 1; k <= steps; k++) {
          const nx = Math.round(dx * k / steps), ny = Math.round(dy * k / steps);
          records.push(dstRecord(nx - px, ny - py, steps > 1 && k < steps && cmd === STITCH ? STITCH : cmd));
          px = nx; py = ny;
        }
        xx += dx; yy += dy;
      } else if (cmd === COLOR_CHANGE) records.push(dstRecord(0, 0, COLOR_CHANGE));
      else if (cmd === END) records.push(dstRecord(0, 0, END));
    }
    const [bx0, by0, bx1, by1] = bounds(cmds);
    const last = cmds.at(-1);
    const pad = (n, w) => String(Math.abs(Math.round(n))).padStart(w, " ");
    let header = `LA:${name.slice(0, 16).padEnd(16, " ")}\r` +
      `ST:${String(records.length).padStart(7, " ")}\r` +
      `CO:${String(commands.filter((c) => c[2] === COLOR_CHANGE).length).padStart(3, " ")}\r` +
      `+X:${pad(bx1, 5)}\r-X:${pad(bx0, 5)}\r+Y:${pad(by1, 5)}\r-Y:${pad(by0, 5)}\r` +
      `AX:${last[0] >= 0 ? "+" : "-"}${pad(last[0], 5)}\rAY:${-last[1] >= 0 ? "+" : "-"}${pad(last[1], 5)}\r` +
      `MX:+${pad(0, 5)}\rMY:+${pad(0, 5)}\rPD:******\r`;
    threads.forEach((hex, i) => {
      const label = String(threadNames[i] || nearestBrother(hex).name).replace(/[,\r\n\x1a]/g, " ").slice(0, 30);
      header += `TC:${hex},${label},\r`;
    });
    const out = new Bytes();
    out.str(header.length < 511 ? header : header.slice(0, 500));
    out.u8(0x1A);
    while (out.length < 512) out.u8(0x20);
    for (const r of records) out.bytes(r);
    return out.result();
  }

  // ---- Readers (for the previewer and for checking exports) ----
  function readPec(bytes, at) {
    let p = at + 3;
    const label = new TextDecoder("latin1").decode(bytes.slice(p, p + 16)).trim(); p += 16;
    p += 0xF;
    p += 2; // icon stride/height
    p += 0xC;
    const colorChanges = bytes[p++];
    const colors = [];
    for (let i = 0; i <= colorChanges; i++) {
      const t = BROTHER[bytes[p + i] % BROTHER.length];
      colors.push(t ? { hex: rgbToHex(t[0], t[1], t[2]), desc: t[3] } : { hex: "#888888", desc: "" });
    }
    p += colorChanges + 1;
    p += 0x1D0 - colorChanges;
    p += 3 + 0x0B; // block length (24-bit) and block header
    const cmds = [];
    let x = 0, y = 0;
    const s7 = (b) => (b > 63 ? b - 128 : b), s12 = (v) => { v &= 0xFFF; return v > 0x7FF ? v - 0x1000 : v; };
    while (p < bytes.length) {
      const v1 = bytes[p++], v2 = bytes[p++];
      if (v2 === undefined || (v1 === 0xFF && v2 === 0x00) || (v1 === 0xFF && p >= bytes.length)) break;
      if (v1 === 0xFE && v2 === 0xB0) { p++; cmds.push([x, y, COLOR_CHANGE]); continue; }
      let jump = false, trim = false, dx, dy, b2 = v2;
      if (v1 & 0x80) {
        if (v1 & 0x20) trim = true;
        if (v1 & 0x10) jump = true;
        dx = s12((v1 << 8) | v2);
        b2 = bytes[p++];
        if (b2 === undefined) break;
      } else dx = s7(v1);
      if (b2 & 0x80) {
        if (b2 & 0x20) trim = true;
        if (b2 & 0x10) jump = true;
        const b3 = bytes[p++];
        if (b3 === undefined) break;
        dy = s12((b2 << 8) | b3);
      } else dy = s7(b2);
      x += dx; y += dy;
      if (jump) cmds.push([x, y, JUMP]);
      else if (trim) { cmds.push([x - dx, y - dy, TRIM]); cmds.push([x, y, JUMP]); }
      else cmds.push([x, y, STITCH]);
    }
    cmds.push([x, y, END]);
    return { name: label, colors, commands: cmds };
  }
  function readPes(bytes) {
    const sig = new TextDecoder("latin1").decode(bytes.slice(0, 4));
    if (sig === "#PEC") return readPec(bytes, 8);
    if (sig !== "#PES") throw new Error("Not a PES file.");
    const at = bytes[8] | bytes[9] << 8 | bytes[10] << 16 | bytes[11] << 24;
    const tryAt = (pos) => { try { const r = readPec(bytes, pos); return r.commands.length > 2 ? r : null; } catch { return null; } };
    let result = at > 0 && at < bytes.length && bytes[at] === 0x4C && bytes[at + 1] === 0x41 ? tryAt(at) : null;
    for (let pos = 0; !result && pos < bytes.length - 3; pos++) {
      if (bytes[pos] === 0x4C && bytes[pos + 1] === 0x41 && bytes[pos + 2] === 0x3A) result = tryAt(pos);
    }
    if (!result) throw new Error("No PEC stitch block found.");
    return result;
  }
  function readDst(bytes) {
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 512));
    const name = (/LA:([^\r\n]*)/.exec(head)?.[1] || "").trim();
    const tc = [...head.matchAll(/TC:(#[0-9a-f]{6}),([^,\r]*)/gi)].map((m) => ({ hex: m[1].toLowerCase(), desc: m[2].trim() }));
    const bit = (b, n) => (b >> n) & 1;
    const cmds = [];
    let x = 0, y = 0, changes = 0;
    for (let p = 512; p + 2 < bytes.length; p += 3) {
      const b0 = bytes[p], b1 = bytes[p + 1], b2 = bytes[p + 2];
      const dx = bit(b2, 2) * 81 - bit(b2, 3) * 81 + bit(b1, 2) * 27 - bit(b1, 3) * 27 + bit(b0, 2) * 9 - bit(b0, 3) * 9 + bit(b1, 0) * 3 - bit(b1, 1) * 3 + bit(b0, 0) - bit(b0, 1);
      const dy = -(bit(b2, 5) * 81 - bit(b2, 4) * 81 + bit(b1, 5) * 27 - bit(b1, 4) * 27 + bit(b0, 5) * 9 - bit(b0, 4) * 9 + bit(b1, 7) * 3 - bit(b1, 6) * 3 + bit(b0, 7) - bit(b0, 6));
      if ((b2 & 0xF3) === 0xF3) break;
      x += dx; y += dy;
      if ((b2 & 0xC3) === 0xC3) { cmds.push([x, y, COLOR_CHANGE]); changes++; }
      else if ((b2 & 0x83) === 0x83) cmds.push([x, y, JUMP]);
      else cmds.push([x, y, STITCH]);
    }
    cmds.push([x, y, END]);
    const palette = ["#1f4e8c", "#c0392b", "#27ae60", "#f39c12", "#8e44ad", "#16a085", "#2c3e50", "#d35400"];
    const colors = Array.from({ length: changes + 1 }, (_, i) => tc[i] || { hex: palette[i % palette.length], desc: "" });
    return { name, colors, commands: cmds };
  }
  function readEmbroidery(bytes, fileName = "") {
    if (/\.dst$/i.test(fileName)) return readDst(bytes);
    return readPes(bytes);
  }

  // Segments for drawing: consecutive stitches in one color, plus counts.
  function toSegments(parsed) {
    const segs = [];
    let cur = null, pos = null, ci = 0, jumps = 0, trims = 0, changes = 0;
    for (const [x, y, cmd] of parsed.commands) {
      if (cmd === END) break;
      if (cmd === STITCH) {
        if (!cur) { cur = { c: Math.min(ci, parsed.colors.length - 1), p: pos ? [pos[0], pos[1]] : [x, y] }; segs.push(cur); }
        cur.p.push(x, y);
      } else if (cmd === COLOR_CHANGE) { cur = null; ci++; changes++; }
      else if (cmd === JUMP) { cur = null; jumps++; }
      else if (cmd === TRIM) { cur = null; trims++; }
      pos = [x, y];
    }
    return { colors: parsed.colors, segs: segs.filter((s) => s.p.length >= 4), jumps, trims, colorChanges: changes };
  }

  // Safety checks on a file as a machine reads it (same rules as check_pes.py).
  function checkCommands(cmds) {
    if (!cmds.length) throw new Error("The file contains no stitches.");
    if (cmds[0][2] !== JUMP) throw new Error("Safety check failed: the file does not begin with a jump to the start point.");
    if (cmds.at(-1)[2] !== END) throw new Error("Safety check failed: the file does not end with END.");
    let still = 0, count = 0;
    for (let i = 1; i < cmds.length; i++) {
      if (cmds[i][2] !== STITCH) { still = 0; continue; }
      count++;
      const step = Math.hypot(cmds[i][0] - cmds[i - 1][0], cmds[i][1] - cmds[i - 1][1]);
      if (step > 121) throw new Error(`Safety check failed: stitch ${i} is ${(step / 10).toFixed(1)} mm long (limit 12.1 mm).`);
      still = step === 0 ? still + 1 : 0;
      if (still > 3) throw new Error(`Safety check failed: repeated stitches in one spot at command ${i} would break thread.`);
    }
    if (count < 20) throw new Error("Safety check failed: the file contains almost no stitches.");
    return count;
  }

  window.EmbFormats = {
    STITCH, JUMP, TRIM, END, COLOR_CHANGE, BROTHER,
    hexToRgb, rgbToHex, nearestBrother, colorDistance,
    writePes, writeDst, readPes, readDst, readEmbroidery, toSegments, checkCommands
  };
})();
