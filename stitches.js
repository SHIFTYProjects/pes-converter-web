"use strict";

// Stitch geometry helpers. Everything here works in millimetres on plain {x, y} points.
(() => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function pathLength(points, closed) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
    if (closed && points.length > 1) total += dist(points.at(-1), points[0]);
    return total;
  }

  // Evenly spaced points along a polyline. Closed paths do not repeat the first point.
  function resample(points, step, closed = false) {
    if (points.length < 2) return points.slice();
    const pts = closed ? [...points, points[0]] : points;
    const total = pathLength(pts, false);
    if (total <= 0) return [points[0]];
    const count = Math.max(1, Math.round(total / step));
    const out = [];
    let seg = 0, acc = 0;
    const limit = closed ? count : count + 1;
    for (let k = 0; k < limit; k++) {
      const target = k * total / count;
      while (seg < pts.length - 2 && acc + dist(pts[seg], pts[seg + 1]) < target) { acc += dist(pts[seg], pts[seg + 1]); seg++; }
      const a = pts[seg], b = pts[seg + 1], span = dist(a, b) || 1, t = Math.min(1, Math.max(0, (target - acc) / span));
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return out;
  }

  // Arc-length parameterisation with smoothed normals, so motifs can be laid along any path.
  function frame(points, closed) {
    const dense = resample(points, .25, closed);
    if (closed) dense.push(dense[0]);
    const s = [0];
    for (let i = 1; i < dense.length; i++) s.push(s[i - 1] + dist(dense[i - 1], dense[i]));
    const total = s.at(-1);
    const n = dense.length, reach = 4;
    const normals = dense.map((_, i) => {
      const a = closed ? dense[(i - reach + (n - 1) * 4) % (n - 1)] : dense[Math.max(0, i - reach)];
      const b = closed ? dense[(i + reach) % (n - 1)] : dense[Math.min(n - 1, i + reach)];
      const tx = b.x - a.x, ty = b.y - a.y, len = Math.hypot(tx, ty) || 1;
      return { x: -ty / len, y: tx / len };
    });
    let seg = 0;
    const at = (d) => {
      d = Math.max(0, Math.min(total, d));
      if (s[seg] > d) seg = 0;
      while (seg < n - 2 && s[seg + 1] < d) seg++;
      const span = s[seg + 1] - s[seg] || 1, t = (d - s[seg]) / span;
      const a = dense[seg], b = dense[Math.min(n - 1, seg + 1)];
      const na = normals[seg], nb = normals[Math.min(n - 1, seg + 1)];
      const nx = na.x + (nb.x - na.x) * t, ny = na.y + (nb.y - na.y) * t, nl = Math.hypot(nx, ny) || 1;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: nx / nl, ny: ny / nl };
    };
    return { total, at };
  }

  function insidePolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  // Orients a closed path so the frame normal (-ty, tx) points outward: in y-down coordinates that is a
  // negative shoelace sum (counter-clockwise on screen). Motifs then sit outside a border, blanket spikes inside.
  function orientOutward(points) {
    if (points.length < 3) return points;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area < 0 ? points : points.slice().reverse();
  }

  // Splits long stitches and drops tiny ones.
  function limitStitches(points, maxLen, minLen = .3) {
    const out = [];
    for (const p of points) {
      const last = out.at(-1);
      if (!last) { out.push(p); continue; }
      const d = dist(last, p);
      if (d < minLen) continue;
      const pieces = Math.ceil(d / maxLen);
      for (let k = 1; k <= pieces; k++) out.push({ x: last.x + (p.x - last.x) * k / pieces, y: last.y + (p.y - last.y) * k / pieces });
    }
    return out;
  }

  // Motifs are drawn in a unit cell: u runs 0→1 along the path, v is across it (+ is the left side).
  const star = (() => {
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? .17 : .42;
      pts.push([.5 + Math.cos(a) * r * .95, .05 - Math.sin(a) * r]);
    }
    return pts;
  })();
  const MOTIFS = {
    hearts: { base: -.36, loop: [[.5, -.36], [.22, -.02], [.12, .2], [.2, .38], [.36, .44], [.5, .32], [.64, .44], [.8, .38], [.88, .2], [.78, -.02], [.5, -.36]] },
    stars: { base: -.37, loop: star },
    diamonds: { base: 0, loop: [[0, 0], [.5, .45], [1, 0]], mirror: true },
    scallop: { base: 0, loop: Array.from({ length: 9 }, (_, i) => [i / 8, Math.sin(Math.PI * i / 8) * .9]) },
    wave: { base: 0, loop: Array.from({ length: 13 }, (_, i) => [i / 12, Math.sin(Math.PI * 2 * i / 12) * .5]) }
  };

  const STYLES = [
    ["running", "Running"], ["triple", "Triple (bean)"], ["satin", "Satin"], ["zigzag", "Zigzag"],
    ["blanket", "Blanket"], ["scallop", "Scallop"], ["wave", "Wave"], ["cross", "Cross"],
    ["hearts", "Hearts"], ["stars", "Stars"], ["diamonds", "Diamonds"]
  ];

  // Builds the needle path for one decorative line. Returns points in mm.
  // opts: style, width (mm), length (running stitch mm), spacing (satin density mm), closed.
  function lineStitch(points, opts) {
    const style = opts.style || "running", closed = !!opts.closed;
    const width = Math.max(.5, opts.width || 2), L = Math.max(1, Math.min(4, opts.length || 2.5));
    if (points.length < 2) return [];
    const path = closed ? orientOutward(points) : points;
    if (style === "running" || style === "triple") {
      const run = resample(path, L, closed);
      if (closed) run.push(run[0]);
      if (style === "running") return run;
      const out = [run[0]];
      for (let i = 1; i < run.length; i++) out.push(run[i], run[i - 1], run[i]);
      return out;
    }
    const f = frame(path, closed);
    if (f.total < 1) return [];
    const place = (d, v) => { const p = f.at(d); return { x: p.x + p.nx * v, y: p.y + p.ny * v }; };
    if (style === "satin" || style === "zigzag") {
      const spacing = style === "satin" ? Math.max(.25, opts.spacing || .4) : Math.max(.8, width * .55);
      const count = Math.max(2, Math.round(f.total / spacing));
      // Wide satin is split into shorter, staggered stitches so it lies flat (a "fill" band that follows the path).
      const split = opts.split && width > opts.split ? Math.ceil(width / opts.split) : 1;
      const out = [];
      for (let k = 0; k <= count; k++) {
        const d = k * f.total / count, from = k % 2 ? .5 : -.5;
        if (split > 1 && k > 0) {
          const phase = ((k * 3) % 7) / 7;
          for (let j = 1; j < split; j++) {
            const t = (j + (phase - .5) * .8) / split;
            // Travels from the previous side (-from) to this side (from).
            out.push(place(d, from * width * (2 * t - 1)));
          }
        }
        out.push(place(d, from * width));
      }
      return out;
    }
    if (style === "blanket") {
      const period = Math.max(1.5, width * .8), count = Math.max(1, Math.round(f.total / period));
      const out = [];
      for (let k = 0; k <= count; k++) {
        const d = k * f.total / count, base = place(d, 0);
        out.push(base);
        if (k < count || !closed) { out.push(place(d, closed ? -width : width)); out.push(base); }
      }
      return limitStitches(out, L);
    }
    if (style === "cross") {
      const period = Math.max(1.5, width), count = Math.max(1, Math.round(f.total / period)), h = width / 2;
      const out = [place(0, -h)];
      for (let k = 0; k < count; k++) {
        const d0 = k * f.total / count, d1 = (k + 1) * f.total / count;
        out.push(place(d1, h), place(d0, h), place(d1, -h));
      }
      return limitStitches(out, Math.max(L, width * 1.5));
    }
    const motif = MOTIFS[style];
    if (motif) {
      const period = style === "scallop" ? Math.max(2, width * 1.3) : style === "wave" ? Math.max(2, width * 1.6) : Math.max(2.5, width * 1.1);
      const count = Math.max(1, closed ? Math.round(f.total / period) : Math.floor(f.total / period));
      const cell = f.total / count;
      const forward = [];
      for (let k = 0; k < count; k++) {
        const start = k * cell;
        if (motif.base) forward.push(place(start, motif.base * width));
        for (const [u, v] of motif.loop) forward.push(place(start + u * cell, v * width));
      }
      forward.push(place(f.total, (motif.base || 0) * width));
      let out = forward;
      if (motif.mirror) {
        const back = [];
        for (let k = count - 1; k >= 0; k--) {
          const start = k * cell;
          for (const [u, v] of [...motif.loop].reverse()) back.push(place(start + u * cell, -v * width));
        }
        out = forward.concat(back);
      }
      return limitStitches(out, Math.min(L, 2.5), .25);
    }
    return resample(path, L, closed);
  }

  // A path shifted sideways by `distance` mm (positive = the frame normal side).
  function offsetPath(points, distance, closed, step = 1) {
    const f = frame(closed ? orientOutward(points) : points, closed);
    const count = Math.max(2, Math.round(f.total / step)), out = [];
    for (let k = 0; k < (closed ? count : count + 1); k++) {
      const p = f.at(k * f.total / count);
      out.push({ x: p.x + p.nx * distance, y: p.y + p.ny * distance });
    }
    return out;
  }

  // Exact Euclidean distance (pixels) from every mask pixel to the nearest non-mask pixel
  // (Felzenszwalb & Huttenlocher). Its isolines are smooth offsets of the shape, with round corners.
  function exactDistance(mask, w, h) {
    const INF = 1e20, f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
    const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
    const grid = new Float64Array(w * h);
    for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? INF : 0;
    const pass = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
      for (let q = 0; q < n; q++) set(q, d[q]);
    };
    for (let x = 0; x < w; x++) pass(h, (y) => grid[y * w + x], (y, val) => { grid[y * w + x] = val; });
    for (let y = 0; y < h; y++) pass(w, (x) => grid[y * w + x], (x, val) => { grid[y * w + x] = val; });
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
    return out;
  }

  // Two-pass chamfer distance transform (in pixels) of a binary mask.
  function distanceField(mask, w, h) {
    const INF = 1e9, d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
    const a = 1, b = Math.SQRT2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a); else v = Math.min(v, a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      } else v = Math.min(v, a);
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + a); else v = Math.min(v, a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      } else v = Math.min(v, a);
      d[i] = v;
    }
    return d;
  }

  // Marching-squares isolines of a scalar field at `level`, joined into polylines (pixel units).
  function isolines(field, w, h, level) {
    const segs = new Map(), key = (x, y) => `${Math.round(x * 8)},${Math.round(y * 8)}`;
    const add = (a, b) => {
      const ka = key(a.x, a.y), kb = key(b.x, b.y);
      if (ka === kb) return;
      if (!segs.has(ka)) segs.set(ka, []);
      if (!segs.has(kb)) segs.set(kb, []);
      segs.get(ka).push({ k: kb, p: b, a }); segs.get(kb).push({ k: ka, p: a, a: b });
    };
    const lerp = (x0, y0, v0, x1, y1, v1) => { const t = (level - v0) / ((v1 - v0) || 1e-9); return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t }; };
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const v0 = field[y * w + x], v1 = field[y * w + x + 1], v2 = field[(y + 1) * w + x + 1], v3 = field[(y + 1) * w + x];
      const c = (v0 >= level ? 1 : 0) | (v1 >= level ? 2 : 0) | (v2 >= level ? 4 : 0) | (v3 >= level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const top = () => lerp(x, y, v0, x + 1, y, v1), right = () => lerp(x + 1, y, v1, x + 1, y + 1, v2);
      const bottom = () => lerp(x, y + 1, v3, x + 1, y + 1, v2), left = () => lerp(x, y, v0, x, y + 1, v3);
      switch (c) {
        case 1: case 14: add(left(), top()); break;
        case 2: case 13: add(top(), right()); break;
        case 3: case 12: add(left(), right()); break;
        case 4: case 11: add(right(), bottom()); break;
        case 6: case 9: add(top(), bottom()); break;
        case 7: case 8: add(left(), bottom()); break;
        case 5: add(left(), top()); add(right(), bottom()); break;
        case 10: add(top(), right()); add(left(), bottom()); break;
      }
    }
    const used = new Set(), lines = [];
    const edgeId = (k1, k2) => (k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1);
    for (const [start, list] of segs) {
      for (const first of list) {
        if (used.has(edgeId(start, first.k))) continue;
        used.add(edgeId(start, first.k));
        const line = [first.a, first.p];
        let cur = first.k, closed = false;
        for (;;) {
          const next = (segs.get(cur) || []).find((e) => !used.has(edgeId(cur, e.k)));
          if (!next) break;
          used.add(edgeId(cur, next.k));
          if (next.k === start) { closed = true; break; }
          line.push(next.p); cur = next.k;
        }
        if (line.length > 4) lines.push({ points: line, closed });
      }
    }
    return lines;
  }

  window.StitchLib = { STYLES, resample, lineStitch, limitStitches, distanceField, exactDistance, isolines, orientOutward, offsetPath, pathLength };
})();
