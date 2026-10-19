"use strict";

// Stitch previewer: shows the current design's stitch plan or any .pes file opened from disk.
(() => {
  const $ = (s) => document.querySelector(s);
  const dialog = $("#viewer");
  const canvas = $("#viewer-canvas");
  const ctx = canvas.getContext("2d");
  const slider = $("#viewer-progress");
  const view = { scale: 1, x: 0, y: 0 };
  let model = null, hidden = new Set(), playing = null, pan = null, total = 0, progress = 0;

  const bridge = () => window.stitchStudioBridge;
  const setStatus = (text, isError = false) => {
    const el = $("#viewer-status");
    el.textContent = text; el.className = isError ? "error" : "";
  };

  function buildModel(name, source, colors, segs, extra = {}) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, stitches = 0;
    const perColor = colors.map(() => 0);
    for (const seg of segs) {
      const n = seg.p.length / 2 - 1;
      stitches += n; perColor[seg.c] = (perColor[seg.c] || 0) + n;
      for (let i = 0; i < seg.p.length; i += 2) {
        minX = Math.min(minX, seg.p[i]); maxX = Math.max(maxX, seg.p[i]);
        minY = Math.min(minY, seg.p[i + 1]); maxY = Math.max(maxY, seg.p[i + 1]);
      }
    }
    if (!Number.isFinite(minX)) throw new Error("This design contains no stitches.");
    const model = { name, source, colors, segs, stitches, perColor, bounds: { minX, minY, maxX, maxY }, ...extra };
    model.spacing = Math.min(1.2, Math.max(.15, model.rowSpacing ?? estimateRowSpacing(segs) ?? .4));
    return model;
  }

  function fit() {
    const { bounds, hoop } = model;
    let { minX, minY, maxX, maxY } = bounds;
    if (hoop) { minX = Math.min(minX, hoop.minX); minY = Math.min(minY, hoop.minY); maxX = Math.max(maxX, hoop.maxX); maxY = Math.max(maxY, hoop.maxY); }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const pad = 28;
    view.scale = Math.max(.01, Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY)));
    view.x = w / 2 - (minX + maxX) / 2 * view.scale;
    view.y = h / 2 - (minY + maxY) / 2 * view.scale;
    draw();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (model) fit();
  }

  const shadeCache = new Map();
  function shades(hex) {
    let s = shadeCache.get(hex);
    if (s) return s;
    const n = parseInt(hex.slice(1, 7), 16) || 0, r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const mix = (k, t) => `rgb(${Math.round(r + (t - r) * k)},${Math.round(g + (t - g) * k)},${Math.round(b + (t - b) * k)})`;
    s = { base: hex, dark: mix(.55, 0), light: mix(.45, 255) };
    shadeCache.set(hex, s);
    return s;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = $("#viewer-fabric").value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!model) return;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    const px = 1 / view.scale;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (model.hoop && $("#viewer-hoop").checked) {
      const h = model.hoop;
      ctx.strokeStyle = "rgba(49,92,232,.7)"; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeRect(h.minX, h.minY, h.maxX - h.minX, h.maxY - h.minY);
      ctx.setLineDash([]);
    }
    if ($("#viewer-bounds").checked) {
      const b = model.bounds;
      ctx.strokeStyle = "rgba(120,130,150,.8)"; ctx.lineWidth = px; ctx.setLineDash([3 * px, 3 * px]);
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      ctx.setLineDash([]);
    }
    const showJumps = $("#viewer-jumps").checked;
    // Thread is as wide as the row spacing, so rows just touch like a real fill; never thinner than a pixel.
    const base = Math.max(model.spacing, 1.1 * px);
    let remaining = progress, needle = null, prevEnd = null;
    const jumpLines = [];
    for (const seg of model.segs) {
      if (remaining <= 0) break;
      const count = seg.p.length / 2 - 1;
      const shown = Math.min(count, remaining);
      remaining -= shown;
      if (showJumps && seg.j && prevEnd && !hidden.has(seg.c)) jumpLines.push([prevEnd, seg]);
      prevEnd = [seg.p[shown * 2], seg.p[shown * 2 + 1]];
      if (hidden.has(seg.c)) continue;
      // Each segment is layered in sewing order: under-edge, thread colour, thin highlight.
      const shade = shades(model.colors[seg.c]?.hex || "#888888");
      for (const [color, width, offset] of [[shade.dark, base * 1.15, 0], [shade.base, base * .92, 0], [shade.light, base * .25, -base * .15]]) {
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(seg.p[0] + offset, seg.p[1] + offset);
        for (let i = 1; i <= shown; i++) ctx.lineTo(seg.p[i * 2] + offset, seg.p[i * 2 + 1] + offset);
        ctx.stroke();
      }
      needle = prevEnd;
    }
    for (const [from, seg] of jumpLines) {
      ctx.strokeStyle = seg.cc ? "rgba(90,90,110,.7)" : "rgba(230,40,70,.9)";
      ctx.lineWidth = Math.max(.1, 1.2 * px); ctx.setLineDash([3 * px, 2 * px]);
      ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(seg.p[0], seg.p[1]); ctx.stroke();
      ctx.setLineDash([]);
    }    if (needle && progress < total) {
      ctx.fillStyle = "#ff3b6b"; ctx.beginPath(); ctx.arc(needle[0], needle[1], 4 * px, 0, Math.PI * 2); ctx.fill();
    }
    $("#viewer-progress-label").textContent = `${Math.round(progress).toLocaleString()} / ${total.toLocaleString()} stitches`;
  }

  // Median distance between neighbouring fill rows, estimated from long stitches that run in the same direction.
  function estimateRowSpacing(segs) {
    const rows = [];
    for (const seg of segs) {
      const p = seg.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1], len = Math.hypot(dx, dy);
        if (len >= 1.5) rows.push({ mx: (p[i] + p[i + 2]) / 2, my: (p[i + 1] + p[i + 3]) / 2, ux: dx / len, uy: dy / len });
      }
    }
    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (Math.abs(a.ux * b.ux + a.uy * b.uy) < .98) continue;
      const d = Math.abs((b.mx - a.mx) * -a.uy + (b.my - a.my) * a.ux);
      if (d >= .1 && d <= 2) gaps.push(d);
    }
    if (gaps.length < 5) return null;
    gaps.sort((x, y) => x - y);
    return gaps[gaps.length >> 1];
  }

  function formatTime(seconds) {
    const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
  }

  function updateRuntime() {
    const el = $("#viewer-runtime");
    if (!model || !el) return;
    const spm = Math.max(50, Number($("#viewer-speed").value) || 650);
    const secs = model.stitches / spm * 60 + (model.colorChanges || 0) * 30 + (model.trims || 0) * 4 + (model.jumps || 0);
    el.textContent = `${formatTime(secs)} (about ${(secs / 60).toFixed(1)} min)`;
  }

  function renderInfo() {
    const b = model.bounds, wMm = b.maxX - b.minX, hMm = b.maxY - b.minY;
    const rows = [
      ["Source", model.source],
      ["Name", model.name],
      ["Size", `${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm (${(wMm / 25.4).toFixed(2)} × ${(hMm / 25.4).toFixed(2)} in)`],
      ["Stitches", model.stitches.toLocaleString()],
      ["Colors", String(model.colors.length)]
    ];
    const spacing = model.rowSpacing ?? estimateRowSpacing(model.segs);
    rows.push(["Row spacing", spacing ? `${spacing.toFixed(2)} mm${model.rowSpacing ? "" : " (estimated)"}` : "Not detected"]);
    rows.push(["Est. runtime", ""]);
    if (model.jumps != null) rows.push(["Jumps / trims", `${model.jumps.toLocaleString()} / ${model.trims.toLocaleString()}`]);
    if (model.colorChanges != null) rows.push(["Color changes", String(model.colorChanges)]);
    if (model.fileBytes != null) rows.push(["File size", `${model.fileBytes.toLocaleString()} bytes`]);
    if (model.hoop) rows.push(["Hoop", `${((model.hoop.maxX - model.hoop.minX) / 25.4).toFixed(1)} × ${((model.hoop.maxY - model.hoop.minY) / 25.4).toFixed(1)} in`]);
    const info = $("#viewer-info");
    info.replaceChildren();
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      const key = document.createElement("span"); key.textContent = k;
      const val = document.createElement("strong"); val.textContent = v;
      if (k === "Est. runtime") val.id = "viewer-runtime";
      row.append(key, val); info.appendChild(row);
    }
    updateRuntime();
    const list = $("#viewer-threads");
    list.replaceChildren();
    model.colors.forEach((color, index) => {
      const row = document.createElement("label");
      const box = document.createElement("input"); box.type = "checkbox"; box.checked = !hidden.has(index);
      box.addEventListener("change", () => { box.checked ? hidden.delete(index) : hidden.add(index); draw(); });
      const sw = document.createElement("i"); sw.style.background = color.hex;
      const text = document.createElement("span");
      text.textContent = `${index + 1}. ${color.hex.toUpperCase()}${color.desc ? " · " + color.desc : ""}`;
      const n = document.createElement("em"); n.textContent = (model.perColor[index] || 0).toLocaleString();
      row.append(box, sw, text, n); list.appendChild(row);
    });
  }

  function show(next) {
    stop();
    model = next; hidden = new Set();
    total = model.stitches; progress = total;
    slider.max = String(total); slider.value = String(total);
    $("#viewer-empty").hidden = true;
    $("#viewer-hoop-row").hidden = !model.hoop;
    renderInfo(); fit();
  }

  function stop() {
    if (playing) cancelAnimationFrame(playing);
    playing = null; $("#viewer-play").textContent = "▶ Play";
  }
  function play() {
    if (!model) return;
    if (playing) { stop(); return; }
    if (progress >= total) progress = 0;
    $("#viewer-play").textContent = "❚❚ Pause";
    let last = performance.now();
    const step = (now) => {
      progress = Math.min(total, progress + (now - last) / 1000 * Math.max(150, total / 8));
      last = now; slider.value = String(progress); draw();
      if (progress >= total) { stop(); return; }
      playing = requestAnimationFrame(step);
    };
    playing = requestAnimationFrame(step);
  }

  async function showCurrent() {
    try {
      setStatus("Generating stitches for the current design…");
      const design = await bridge().getDesign();
      const mm = 25.4;
      const colors = design.colors.map((hex) => ({ hex }));
      const segs = [];
      let jumpCount = 0, trimCount = 0, changeCount = 0;
      design.segments.forEach((segment, index) => {
        const previous = design.segments[index - 1];
        const joined = design.joins[index];
        const pts = joined ? [previous.points.at(-1), ...joined, ...segment.points] : segment.points;
        if (pts.length < 2) return;
        const colorChange = !!previous && previous.color !== segment.color;
        if (colorChange) changeCount++;
        if (!joined) { jumpCount++; if (previous && !colorChange) trimCount++; }
        segs.push({
          c: segment.color, p: pts.flatMap((pt) => [pt.x * mm, pt.y * mm]),
          j: !joined && !!previous, cc: colorChange
        });
      });
      const rowSpacing = Number($("#spacing").value);
      show(buildModel($("#file-name").value.trim() || "Current design", "Current design (unsaved)", colors, segs, {
        hoop: { minX: 0, minY: 0, maxX: design.hoopW * mm, maxY: design.hoopH * mm },
        jumps: jumpCount, trims: trimCount, colorChanges: changeCount, rowSpacing: Number.isFinite(rowSpacing) ? rowSpacing : null
      }));
      setStatus("Showing the current stitch plan. Output orientation settings apply only to the exported file.");
    } catch (error) {
      setStatus(error.message || "Could not build the preview.", true);
    }
  }

  async function showFile(file) {
    if (!file) return;
    try {
      setStatus(`Reading ${file.name}… the first use downloads the PES reader (internet required).`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await bridge().readPes(bytes);
      const segs = parsed.segs.map((segment, index) => ({
        c: segment.c, p: segment.p.map((v) => v / 10), j: index > 0,
        cc: index > 0 && parsed.segs[index - 1].c !== segment.c
      }));
      const colors = parsed.colors.length ? parsed.colors : [{ hex: "#888888" }];
      show(buildModel(file.name, "PES file", colors, segs, {
        jumps: parsed.jumps, trims: parsed.trims, colorChanges: parsed.colorChanges, fileBytes: bytes.length
      }));
      setStatus(`Loaded ${file.name}.`);
    } catch (error) {
      setStatus(`Could not read that file: ${error.message || error}`, true);
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    resize();
  }

  function clearModel() {
    stop();
    model = null; hidden = new Set(); total = 0; progress = 0;
    $("#viewer-empty").hidden = false;
    draw();
  }

  $("#open-previewer").addEventListener("click", () => { open(); clearModel(); showCurrent(); });
  $("#open-viewer-top").addEventListener("click", () => { open(); clearModel(); showCurrent(); });
  $("#viewer-current").addEventListener("click", showCurrent);
  $("#viewer-open-file").addEventListener("change", (event) => { showFile(event.target.files[0]); event.target.value = ""; });
  $("#viewer-close").addEventListener("click", () => { stop(); dialog.close(); });
  dialog.addEventListener("close", stop);
  $("#viewer-fit").addEventListener("click", () => model && fit());
  $("#viewer-play").addEventListener("click", play);
  slider.addEventListener("input", () => { stop(); progress = Number(slider.value); draw(); });
  for (const id of ["#viewer-fabric", "#viewer-hoop", "#viewer-bounds", "#viewer-jumps"]) $(id).addEventListener("input", draw);
  $("#viewer-speed").addEventListener("input", updateRuntime);
  new ResizeObserver(resize).observe(canvas);

  canvas.addEventListener("wheel", (event) => {
    if (!model) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left, my = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * .0015);
    const next = Math.min(400, Math.max(.05, view.scale * factor));
    const k = next / view.scale;
    view.x = mx - (mx - view.x) * k; view.y = my - (my - view.y) * k; view.scale = next;
    draw();
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    pan = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pan) return;
    view.x = pan.vx + event.clientX - pan.x; view.y = pan.vy + event.clientY - pan.y; draw();
  });
  canvas.addEventListener("pointerup", () => { pan = null; });
  canvas.addEventListener("pointercancel", () => { pan = null; });
})();
