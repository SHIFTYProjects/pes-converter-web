"use strict";

(() => {
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const stage = $("#stage");
  const stageWrap = $(".stage-wrap");
  const objectRoot = $("#objects");
  const selectionRoot = $("#selection-layer");
  const statusEl = $("#status");
  const hoopSizes = { "4x4": [4, 4], "7x5": [7, 5], "5x7": [5, 7], "10x6": [10, 6], "8x8": [8, 8], "12x8": [12, 8], "12x5": [12, 5] };
  const VIEW_MARGIN = .08;
  const state = {
    objects: [], selectedId: null, selectedRegion: null, tool: "select", color: "#0a55a3",
    hoopW: 7, hoopH: 5, zoom: 1, viewX: 0, viewY: 0, drawing: null, erasing: null, drag: null, pan: null, spaceDown: false, history: [], future: [],
    stitches: [], stitchColors: [], selectedPaletteColors: new Set(), hiddenColors: new Set(),
    gapFillSettings: new Map(), edgeColor: null,
    stale: true, busy: false
  };
  const SL = window.StitchLib, EF = window.EmbFormats;
  const FILL_STYLES = [
    ["auto", "Auto (best for each part)"], ["tatami", "Tatami (standard fill)"], ["satin", "Satin"], ["wave", "Wave"], ["chevron", "Chevron"],
    ["diamond", "Diamond"], ["brick", "Brick"], ["crosshatch", "Crosshatch (light)"], ["contour", "Contour (echo)"],
    ["cross", "Cross-stitch"], ["outline", "Outline only"], ["applique", "Appliqué"]
  ];
  const LINE_STYLES = SL.STYLES;
  // A color's own fill style, or the design's fill style when it is set to "Same as design".
  function resolveFill(fill) {
    const valid = (v) => FILL_STYLES.some(([k]) => k === v);
    if (valid(fill)) return fill;
    const design = document.getElementById("default-fill")?.value;
    return valid(design) ? design : "tatami";
  }
  const isLineObject = (obj) => (obj.type === "draw" || obj.type === "shape") && obj.stitchAs === "line";
  let idCounter = 1;
  try {
    localStorage.removeItem("stitch-studio-project");
  } catch (error) {
    console.error("Could not clear a legacy autosaved project from browser storage.", error);
  }

  function message(text, kind = "") {
    statusEl.textContent = text;
    statusEl.title = text;
    statusEl.className = kind;
    // While the previewer is open, show the same message there.
    const viewerStatus = document.getElementById("viewer-status");
    if (viewerStatus && document.getElementById("viewer")?.open) { viewerStatus.textContent = text; viewerStatus.className = kind === "error" ? "error" : ""; }
  }
  function renderDragFrame(obj) {
    const group = objectRoot.querySelector(`[data-object-id="${obj.id}"]`);
    if (group && isLineObject(obj)) { renderObject(obj, group); group.remove(); }
    else if (group) group.setAttribute("transform", transformFor(obj));
    selectionRoot.replaceChildren();
    if ($("#stitch-preview-toggle").checked) {
      state.stitches = [];
      state.stale = true;
    }
    drawSelection(obj);
    updateProperties();
  }
  function uid() { return "shape-" + idCounter++; }
  function node(tag, attrs = {}) {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) element.setAttribute(key, String(value));
    }
    return element;
  }
  function safeColor(value) {
    if (/^#[0-9a-f]{6}$/i.test(value || "")) return value.toLowerCase();
    const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i.exec(value || "");
    if (match) return "#" + match.slice(1).map((part) => Number(part).toString(16).padStart(2, "0")).join("");
    return "#000000";
  }
  function isNearWhite(value) {
    if (!/^#[0-9a-f]{6}$/i.test(value || "")) return false;
    const rgb = [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
    return Math.min(...rgb) >= 220 && Math.max(...rgb) - Math.min(...rgb) <= 35;
  }
  function bounds(obj) {
    const width = obj.width || obj.baseW || .4;
    const height = obj.height || obj.baseH || .4;
    return { x: obj.x, y: obj.y, width, height };
  }
  function rotatedBounds(obj) {
    const b = bounds(obj), radians = (obj.rotation || 0) * Math.PI / 180;
    return {
      x: b.x,
      y: b.y,
      width: Math.abs(b.width * Math.cos(radians)) + Math.abs(b.height * Math.sin(radians)),
      height: Math.abs(b.width * Math.sin(radians)) + Math.abs(b.height * Math.cos(radians))
    };
  }
  function measureRegionBounds(regions, width, height) {
    const svg = node("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
    svg.style.cssText = "position:absolute;left:-10000px;top:-10000px;visibility:hidden;overflow:visible;pointer-events:none";
    document.body.appendChild(svg);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    try {
      for (const region of regions) {
        if (region.fill === "none") continue;
        const path = node("path", { d: region.d });
        svg.appendChild(path);
        const box = path.getBBox();
        const brushRadius = (Number(region.brushWidth) || 0) / 2;
        if ((box.width > 0 || brushRadius > 0) && (box.height > 0 || brushRadius > 0)) {
          minX = Math.min(minX, box.x - brushRadius); minY = Math.min(minY, box.y - brushRadius);
          maxX = Math.max(maxX, box.x + box.width + brushRadius);
          maxY = Math.max(maxY, box.y + box.height + brushRadius);
        }
        path.remove();
      }
    } finally {
      svg.remove();
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  function refreshImageCrop(obj) {
    const next = measureRegionBounds(obj.regions, obj.naturalW, obj.naturalH);
    if (!next) return false;
    const oldWidth = obj.baseW || obj.naturalW, oldHeight = obj.baseH || obj.naturalH;
    const oldX = Number(obj.cropX) || 0, oldY = Number(obj.cropY) || 0;
    const scaleX = obj.width / oldWidth, scaleY = obj.height / oldHeight;
    const radians = (obj.rotation || 0) * Math.PI / 180;
    const offsetX = (next.x + next.width / 2 - oldX - oldWidth / 2) * scaleX * (obj.flipX ? -1 : 1);
    const offsetY = (next.y + next.height / 2 - oldY - oldHeight / 2) * scaleY * (obj.flipY ? -1 : 1);
    obj.x += offsetX * Math.cos(radians) - offsetY * Math.sin(radians);
    obj.y += offsetX * Math.sin(radians) + offsetY * Math.cos(radians);
    obj.width = next.width * scaleX; obj.height = next.height * scaleY;
    obj.baseW = next.width; obj.baseH = next.height;
    obj.cropX = next.x; obj.cropY = next.y;
    return true;
  }
  // The view shows the hoop plus a margin of work table; at zoom 1 the whole hoop fits.
  const viewSize = (zoom = state.zoom) => ({ w: state.hoopW * (1 + VIEW_MARGIN * 2) / zoom, h: state.hoopH * (1 + VIEW_MARGIN * 2) / zoom });
  function fitView() {
    state.zoom = 1; state.viewX = -state.hoopW * VIEW_MARGIN; state.viewY = -state.hoopH * VIEW_MARGIN;
    viewBox();
  }
  function viewBox() {
    const { w, h } = viewSize();
    stage.setAttribute("viewBox", `${state.viewX} ${state.viewY} ${w} ${h}`);
    for (const id of ["hoop-fabric", "hoop-bg", "hoop-major", "hoop-outline"]) {
      const el = $("#" + id);
      el.setAttribute("x", "0"); el.setAttribute("y", "0");
      el.setAttribute("width", state.hoopW); el.setAttribute("height", state.hoopH);
    }
    const ring = $("#hoop-ring"), inset = Math.min(state.hoopW, state.hoopH) * .04;
    ring.setAttribute("x", -inset); ring.setAttribute("y", -inset);
    ring.setAttribute("width", state.hoopW + inset * 2); ring.setAttribute("height", state.hoopH + inset * 2);
    ring.setAttribute("rx", inset * 2); ring.setAttribute("stroke-width", inset * .55);
    const cx = state.hoopW / 2, cy = state.hoopH / 2, t = .18;
    $("#hoop-center").setAttribute("d", `M${cx - t} ${cy}H${cx + t}M${cx} ${cy - t}V${cy + t}M${cx} 0v.15M${cx} ${state.hoopH}v-.15M0 ${cy}h.15M${state.hoopW} ${cy}h-.15`);
    const zoomPercent = Math.round(state.zoom * 100);
    $("#zoom-label").textContent = `${zoomPercent}%`;
    $("#zoom").value = String(Math.max(25, Math.min(800, zoomPercent)));
    updateToolCursor();
  }
  new ResizeObserver(() => updateToolCursor()).observe(stageWrap);
  function zoomCanvas(zoom, anchor) {
    const nextZoom = Math.max(.25, Math.min(8, zoom));
    const { w: oldWidth, h: oldHeight } = viewSize(state.zoom);
    const { w: nextWidth, h: nextHeight } = viewSize(nextZoom);
    const centerX = state.viewX + oldWidth / 2, centerY = state.viewY + oldHeight / 2;
    if (anchor) {
      const fractionX = (anchor.x - state.viewX) / oldWidth;
      const fractionY = (anchor.y - state.viewY) / oldHeight;
      state.viewX = anchor.x - fractionX * nextWidth;
      state.viewY = anchor.y - fractionY * nextHeight;
    } else {
      state.viewX = centerX - nextWidth / 2;
      state.viewY = centerY - nextHeight / 2;
    }
    state.zoom = nextZoom;
    viewBox();
  }
  function svgPoint(event) {
    const point = stage.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(stage.getScreenCTM().inverse());
  }
  function isImage(obj) { return obj.type === "image"; }
  function transformFor(obj) {
    const b = bounds(obj);
    const sx = b.width / (obj.baseW || b.width) * (obj.flipX ? -1 : 1);
    const sy = b.height / (obj.baseH || b.height) * (obj.flipY ? -1 : 1);
    return `translate(${b.x} ${b.y}) rotate(${obj.rotation || 0}) scale(${sx} ${sy}) translate(${-((obj.baseW || b.width) / 2)} ${-((obj.baseH || b.height) / 2)})`;
  }
  // Object-local point (before crop offset) to world inches; the inverse of objectLocalPoint.
  function localToWorld(obj, p) {
    const b = bounds(obj), radians = (obj.rotation || 0) * Math.PI / 180;
    const lx = (p.x - obj.baseW / 2) * b.width / obj.baseW * (obj.flipX ? -1 : 1);
    const ly = (p.y - obj.baseH / 2) * b.height / obj.baseH * (obj.flipY ? -1 : 1);
    return { x: b.x + lx * Math.cos(radians) - ly * Math.sin(radians), y: b.y + lx * Math.sin(radians) + ly * Math.cos(radians) };
  }

  // ---- Fonts: bundled fonts work on every computer and stitch exactly as shown. ----
  const SYSTEM_FONTS = ["Arial", "Arial Black", "Georgia", "Impact", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "Comic Sans MS"];
  const bundledFonts = window.BUNDLED_FONTS || {};
  const fontsReady = (async () => {
    const faces = [];
    for (const [family, weights] of Object.entries(bundledFonts)) {
      for (const [weight, data] of Object.entries(weights)) {
        try {
          const binary = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const face = new FontFace(family, binary.buffer, { weight });
          document.fonts.add(face); faces.push(face.load());
        } catch (error) { console.warn("Font failed to load", family, error); }
      }
    }
    await Promise.allSettled(faces);
  })();
  const FONT_GROUPS = {
    "Script & monogram": ["Alex Brush", "Allura", "Arizonia", "Berkshire Swash", "Cookie", "Courgette", "Dancing Script", "Great Vibes", "Italianno", "Kaushan Script", "Lobster", "Marck Script", "Mr Dafoe", "Norican", "Pacifico", "Parisienne", "Pinyon Script", "Playball", "Rochester", "Sacramento", "Satisfy", "Tangerine", "Yellowtail"],
    "Handwritten": ["Amatic SC", "Caveat", "Gochi Hand", "Indie Flower", "Kalam", "Patrick Hand", "Permanent Marker", "Shadows Into Light"],
    "Bold & block": ["Anton", "Archivo Black", "Bebas Neue", "Bowlby One SC", "Bungee", "Chewy", "Fjalla One", "Knewave", "Lilita One", "Luckiest Guy", "Oswald", "Passion One", "Paytone One", "Racing Sans One", "Rammetto One", "Russo One", "Sigmar One", "Staatliches", "Teko", "Titan One", "Ultra"],
    "Varsity & slab": ["Alfa Slab One", "Arvo", "Bevan", "Graduate", "Holtwood One SC", "Patua One", "Roboto Slab", "Zilla Slab"],
    "Serif": ["Abril Fatface", "Cinzel", "Cinzel Decorative", "Cormorant Garamond", "Crimson Text", "EB Garamond", "Libre Baskerville", "Lora", "Merriweather", "Playfair Display"],
    "Sans serif": ["Baloo 2", "Barlow", "Comfortaa", "Exo 2", "Fredoka", "Josefin Sans", "Lato", "Montserrat", "Nunito", "Open Sans", "Poppins", "Quicksand", "Raleway", "Roboto", "Rubik", "Varela Round", "Work Sans"],
    "Fun & themed": ["Bangers", "Black Ops One", "Bubblegum Sans", "Carter One", "Creepster", "Emilys Candy", "Griffy", "Henny Penny", "Metal Mania", "Mountains of Christmas", "Pirata One", "Press Start 2P", "Righteous", "Rye", "Sancreek", "Special Elite", "UnifrakturMaguntia"]
  };
  function fillFontSelect(extra) {
    const select = $("#font"), current = extra || select.value;
    select.replaceChildren();
    const group = (label, names) => {
      if (!names.length) return;
      const g = document.createElement("optgroup"); g.label = label;
      for (const name of names) { const o = document.createElement("option"); o.value = o.textContent = name; o.style.fontFamily = `"${name}"`; g.appendChild(o); }
      select.appendChild(g);
    };
    const grouped = new Set();
    for (const [label, names] of Object.entries(FONT_GROUPS)) {
      const present = names.filter((n) => bundledFonts[n]);
      present.forEach((n) => grouped.add(n));
      group(label, present);
    }
    group("More built-in fonts", Object.keys(bundledFonts).filter((n) => !grouped.has(n)));
    const system = SYSTEM_FONTS.slice();
    if (current && !bundledFonts[current] && !system.includes(current)) system.push(current);
    group("This computer only", system);
    if (current) select.value = current;
  }
  function fontFaceCss(families) {
    let css = "";
    for (const family of families) {
      const weights = bundledFonts[family];
      if (!weights) continue;
      for (const [weight, data] of Object.entries(weights)) css += `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
    }
    return css;
  }
  const measureCanvas = document.createElement("canvas").getContext("2d");
  // Lays out a text object: measures it with the real font and builds the arc path for curved text.
  function layoutText(obj) {
    const size = Math.max(.05, Number(obj.sizeIn) || .5), text = obj.text || " ";
    const keepScaleX = obj.baseW ? obj.width / obj.baseW : 1, keepScaleY = obj.baseH ? obj.height / obj.baseH : 1;
    measureCanvas.font = `100px "${obj.font || "Arial"}"`;
    const m = measureCanvas.measureText(text);
    const asc = (m.fontBoundingBoxAscent || 80) / 100 * size, desc = (m.fontBoundingBoxDescent || 22) / 100 * size;
    const spacing = (Number(obj.spacing) || 0) / 100 * size;
    const chars = [...text].length;
    const width = Math.max(.1, m.width / 100 * size + spacing * Math.max(0, chars - 1));
    const curve = Math.max(-100, Math.min(100, Number(obj.curve) || 0));
    obj.arc = null;
    if (Math.abs(curve) < 2) {
      obj.baseW = width + size * .08; obj.baseH = asc + desc; obj.baseline = asc;
    } else {
      const sweep = Math.abs(curve) / 100 * Math.PI * 1.5, R = width / sweep, up = curve > 0;
      // Sample the outer/inner glyph extents along the arc to get the box.
      const outer = up ? R + asc : R + desc, inner = up ? Math.max(0, R - desc) : Math.max(0, R - asc);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k <= 48; k++) {
        const phi = -sweep / 2 - .06 + (sweep + .12) * k / 48;
        for (const r of [outer, inner]) {
          const x = r * Math.sin(phi), y = up ? -r * Math.cos(phi) : r * Math.cos(phi);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
      const cx = -x0, cy = -y0, a = sweep / 2;
      const sx = cx - R * Math.sin(a), ex = cx + R * Math.sin(a);
      const yEnd = up ? cy - R * Math.cos(a) : cy + R * Math.cos(a);
      const large = sweep > Math.PI ? 1 : 0;
      obj.arc = `M${sx.toFixed(4)} ${yEnd.toFixed(4)} A${R.toFixed(4)} ${R.toFixed(4)} 0 ${large} ${up ? 1 : 0} ${ex.toFixed(4)} ${yEnd.toFixed(4)}`;
      obj.baseW = x1 - x0; obj.baseH = y1 - y0;
    }
    obj.width = obj.baseW * keepScaleX; obj.height = obj.baseH * keepScaleY;
  }
  // SVG nodes for a text object, drawn in its local box.
  function textNodes(obj, attrs, idPrefix) {
    const group = node("g");
    const common = {
      "font-family": `"${obj.font || "Arial"}", Arial, sans-serif`, "font-size": obj.sizeIn || .4,
      "letter-spacing": (Number(obj.spacing) || 0) / 100 * (obj.sizeIn || .4), ...attrs
    };
    if (obj.arc) {
      const id = `${idPrefix}-arc-${obj.id}`;
      const defs = node("defs"); defs.appendChild(node("path", { id, d: obj.arc })); group.appendChild(defs);
      const text = node("text", { ...common, "text-anchor": "middle" });
      const tp = node("textPath", { href: `#${id}`, startOffset: "50%" });
      tp.textContent = obj.text; text.appendChild(tp); group.appendChild(text);
    } else {
      const text = node("text", { ...common, x: obj.baseW / 2, y: obj.baseline ?? obj.baseH * .73, "text-anchor": "middle" });
      text.textContent = obj.text; group.appendChild(text);
    }
    return group;
  }

  // ---- Decorative lines: path sampling and preview ----
  const samplerSvg = node("svg", { width: 0, height: 0 });
  samplerSvg.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden";
  document.body.appendChild(samplerSvg);
  // Points along an object's path (object-local units), sampled every `step`.
  function samplePath(d, step) {
    const path = node("path", { d });
    samplerSvg.appendChild(path);
    try {
      const total = path.getTotalLength();
      const count = Math.max(2, Math.min(6000, Math.ceil(total / step)));
      const out = [];
      for (let i = 0; i <= count; i++) { const p = path.getPointAtLength(total * i / count); out.push({ x: p.x, y: p.y }); }
      return out;
    } finally { path.remove(); }
  }
  // Needle path of a line object in world millimetres.
  function lineObjectStitches(obj, spacingMm) {
    const scale = Math.max(obj.width / obj.baseW, obj.height / obj.baseH);
    const local = samplePath(obj.d, .2 / 25.4 / Math.max(.05, scale));
    if (local.length < 2) return [];
    const closed = obj.type === "shape" || !!obj.closed;
    const world = local.map((p) => { const w = localToWorld(obj, p); return { x: w.x * 25.4, y: w.y * 25.4 }; });
    if (closed && world.length > 2) world.pop();
    return SL.lineStitch(world, {
      style: obj.lineStyle || "running", width: Number(obj.lineWidth) || 2, closed,
      length: Math.min(2.5, Number($("#stitch-length").value) || 2.5), spacing: Math.max(.3, spacingMm)
    });
  }
  const linePreviewCache = new Map();
  function linePreviewD(obj) {
    const key = [obj.d, obj.lineStyle, obj.lineWidth, obj.width, obj.height, obj.rotation, obj.flipX, obj.flipY, obj.x, obj.y, obj.type].join("|");
    if (linePreviewCache.has(key)) return linePreviewCache.get(key);
    const pts = lineObjectStitches(obj, .4);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${(p.x / 25.4).toFixed(4)} ${(p.y / 25.4).toFixed(4)}`).join("");
    if (linePreviewCache.size > 200) linePreviewCache.clear();
    linePreviewCache.set(key, d);
    return d;
  }
  function hasEdgeAdjustment(color) {
    const settings = state.gapFillSettings.get(color);
    return Boolean(settings && (settings.strokeMm > 0 || settings.smoothMm > 0 || settings.insideMm > 0));
  }
  function isClosedStroke(points, brushIn) {
    if (points.length < 4) return false;
    const first = points[0], last = points[points.length - 1];
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const gap = Math.hypot(first.x - last.x, first.y - last.y);
    return length > brushIn * 3 && gap <= Math.max(brushIn * 2, length * .25);
  }
  function strokePath(points, mapPoint = (point) => point) {
    const mapped = points.map(mapPoint);
    const format = (point) => `${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
    if (mapped.length === 1) return `M${format(mapped[0])} L${format(mapped[0])}`;
    let d = `M${format(mapped[0])}`;
    for (let i = 0; i < mapped.length - 1; i++) {
      const previous = mapped[Math.max(0, i - 1)];
      const current = mapped[i];
      const next = mapped[i + 1];
      const following = mapped[Math.min(mapped.length - 1, i + 2)];
      const control1 = {
        x: current.x + (next.x - previous.x) / 6,
        y: current.y + (next.y - previous.y) / 6
      };
      const control2 = {
        x: next.x - (following.x - current.x) / 6,
        y: next.y - (following.y - current.y) / 6
      };
      d += ` C${format(control1)} ${format(control2)} ${format(next)}`;
    }
    return d;
  }
  // A shape drawn with its color's edge adjustments (outside/inside stroke, smoothing) in its own place in
  // the stack, so colors above it still cover it, exactly as when it is sewn.
  function adjustedShape(obj, color, d, brushWidth, filled, defsHost, attrs = {}) {
    const settings = colorSettings(color);
    const sx = Math.abs(obj.width / (obj.baseW || obj.width)) || 1, sy = Math.abs(obj.height / (obj.baseH || obj.height)) || 1;
    const outside = settings.strokeMm / 25.4 / sx, inside = (Number(settings.insideMm) || 0) / 25.4 / sx;
    const g = node("g", attrs);
    if (settings.smoothMm > 0) {
      const id = `edge-f-${obj.id}-${color.slice(1)}`;
      if (!defsHost.querySelector(`[id="${id}"]`)) {
        const defs = node("defs");
        const filter = node("filter", { id, x: "-10000", y: "-10000", width: "20000", height: "20000", filterUnits: "userSpaceOnUse" });
        filter.appendChild(node("feGaussianBlur", { stdDeviation: `${settings.smoothMm / 25.4 / sx} ${settings.smoothMm / 25.4 / sy}` }));
        const transfer = node("feComponentTransfer");
        transfer.appendChild(node("feFuncA", { type: "discrete", tableValues: "0 1" }));
        filter.appendChild(transfer); defs.appendChild(filter); defsHost.appendChild(defs);
      }
      g.setAttribute("filter", `url(#${id})`);
    }
    const line = { "stroke-linejoin": "round", "stroke-linecap": "round", fill: "none", stroke: color };
    if (brushWidth) {
      g.appendChild(node("path", { ...line, d, fill: filled ? color : "none", "stroke-width": brushWidth + outside }));
      return g;
    }
    // Traced regions list their outer edge first and their holes after it: the outside stroke widens the
    // outer edge, the inside stroke widens the holes' edges (filling into them).
    const subpaths = d.match(/[Mm][^Mm]*/g) || [d];
    g.appendChild(node("path", { d, fill: color }));
    if (outside > 0) g.appendChild(node("path", { ...line, d: subpaths[0], "stroke-width": outside }));
    if (inside > 0 && subpaths.length > 1) g.appendChild(node("path", { ...line, d: subpaths.slice(1).join(" "), "stroke-width": inside }));
    return g;
  }
  function regionPath(obj, region, index, defsHost = selectionRoot) {
    const brushWidth = Number(region.brushWidth) || 0;
    const cursor = state.tool === "fill" || state.tool === "remove" ? "crosshair" : "inherit";
    if (hasEdgeAdjustment(region.fill)) {
      const g = adjustedShape(obj, region.fill, region.d, brushWidth, region.filled, defsHost, { "data-region-index": index, class: "region", "pointer-events": "all" });
      g.style.cursor = cursor;
      return g;
    }
    const attrs = {
      d: region.d, fill: brushWidth && !region.filled ? "none" : region.fill,
      "data-region-index": index, class: "region", "pointer-events": "all"
    };
    if (brushWidth) {
      attrs.stroke = region.fill; attrs["stroke-width"] = brushWidth;
      attrs["stroke-linecap"] = "round"; attrs["stroke-linejoin"] = "round";
    }
    const path = node("path", attrs);
    path.style.cursor = cursor;
    return path;
  }
  function appendObjectMask(parent, obj, prefix, gen = 0, region = null) {
    // Regions hidden when an erasure was made are tracked per region, so recoloring keeps them protected.
    const erasures = (Array.isArray(obj.erasures) ? obj.erasures : [])
      .map((erasure, index) => ({ erasure, index }))
      .filter(({ erasure, index }) => {
        if (index < gen || !region) return index >= gen;
        if (Array.isArray(region.skipErasures)) return !region.skipErasures.includes(index);
        return !(erasure.skip && erasure.skip.includes(region.fill));
      }).map(({ erasure }) => erasure);
    if (!erasures.length) return null;
    const total = Array.isArray(obj.erasures) ? obj.erasures.length : 0;
    const key = region && erasures.length !== total - gen ? `${erasures.length}-${(region.skipErasures || []).join("_") || String(region.fill).replace(/\W/g, "")}` : "all";
    const id = `${prefix}-${obj.id}-erasures-${gen}-${key}`;
    if (parent.querySelector(`[id="${id}"]`)) return `url(#${id})`;
    const width = obj.type === "image" ? Number(obj.naturalW) || obj.baseW : obj.baseW;
    const height = obj.type === "image" ? Number(obj.naturalH) || obj.baseH : obj.baseH;
    const defs = node("defs");
    const mask = node("mask", {
      id, x: 0, y: 0, width, height,
      maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", "mask-type": "luminance"
    });
    mask.appendChild(node("rect", { x: 0, y: 0, width, height, fill: "white" }));
    for (const erasure of erasures) {
      mask.appendChild(node("path", {
        d: erasure.d, fill: "none", stroke: "black", "stroke-width": erasure.width,
        "stroke-linecap": "round", "stroke-linejoin": "round"
      }));
    }
    defs.appendChild(mask);
    parent.appendChild(defs);
    return `url(#${id})`;
  }
  // Erasures only affect regions that existed when the erasure was made.
  function regionHost(content, maskParent, obj, prefix, region) {
    const mask = appendObjectMask(maskParent, obj, prefix,     Number(region.gen) || 0, region);
    if (!mask) return content;
    const host = node("g", { mask });
    content.appendChild(host);
    return host;
  }
  function renderLineObject(obj) {
    const group = node("g", { "data-object-id": obj.id });
    if (state.hiddenColors.has(obj.fill)) return group;
    const local = node("g", { transform: transformFor(obj) });
    const scale = Math.max(obj.width / obj.baseW, obj.height / obj.baseH) || 1;
    local.appendChild(node("path", {
      d: obj.d, fill: "none", stroke: obj.fill, "stroke-opacity": ".13",
      "stroke-width": Math.max(.06, (Number(obj.lineWidth) || 2) / 25.4 + .03) / scale,
      "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "stroke", "data-object-part": "line"
    }));
    group.appendChild(local);
    group.appendChild(node("path", {
      d: linePreviewD(obj), fill: "none", stroke: obj.fill, "stroke-width": .012,
      "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none"
    }));
    return group;
  }
  function renderObject(obj, insertBefore = null) {
    if (isLineObject(obj)) { objectRoot.insertBefore(renderLineObject(obj), insertBefore); return; }
    const group = node("g", {
      "data-object-id": obj.id,
      transform: transformFor(obj),
      "pointer-events": "visiblePainted"
    });
    if (obj.type === "image") {
      const content = node("g", {
        transform: `translate(${-Number(obj.cropX || 0)} ${-Number(obj.cropY || 0)})`
      });
      obj.regions.forEach((region, index) => {
        if (!state.hiddenColors.has(region.fill)) regionHost(content, group, obj, "canvas", region).appendChild(regionPath(obj, region, index, group));
      });
      group.appendChild(content);
    } else if (obj.type === "text") {
      if (state.hiddenColors.has(obj.fill)) return;
      const content = node("g", { mask: appendObjectMask(group, obj, "canvas") });
      // An invisible box makes the whole text easy to grab, not just the letter strokes.
      content.appendChild(node("rect", { x: 0, y: 0, width: obj.baseW, height: obj.baseH, fill: "transparent", "pointer-events": "all" }));
      const textSettings = colorSettings(obj.fill), adjustedText = hasEdgeAdjustment(obj.fill);
      const textStroke = textSettings.strokeMm / 25.4 / (Math.abs(obj.width / obj.baseW) || 1);
      const textGroup = textNodes(obj, {
        fill: obj.fill, "data-object-part": "text",
        ...(adjustedText && textStroke > 0 ? { stroke: obj.fill, "stroke-width": textStroke, "stroke-linejoin": "round" } : {})
      }, "canvas");
      content.appendChild(textGroup);
      group.appendChild(content);
    } else if (obj.type === "shape" || obj.type === "draw") {
      if (state.hiddenColors.has(obj.fill)) return;
      const content = node("g", { mask: appendObjectMask(group, obj, "canvas") });
      const adjusted = hasEdgeAdjustment(obj.fill);
      const brushWidth = obj.type === "draw" ? Number(obj.brushWidth) || 0 : 0;
      if (adjusted) {
        content.appendChild(adjustedShape(obj, obj.fill, obj.d, brushWidth, obj.filled, group, { "data-object-part": "shape", "pointer-events": "visiblePainted" }));
        group.appendChild(content);
        objectRoot.insertBefore(group, insertBefore);
        return;
      }
      const path = node("path", {
        d: obj.d, fill: brushWidth && !obj.filled ? "none" : obj.fill, "fill-opacity": "1",
        "pointer-events": brushWidth && (obj.closed || state.tool === "fill") ? "all" : "visiblePainted",
        stroke: brushWidth ? obj.fill : obj.stroke || "none",
        "stroke-width": brushWidth || obj.strokeWidth || .02,
        "stroke-linecap": brushWidth ? "round" : "butt",
        "stroke-linejoin": brushWidth ? "round" : "miter",
        "data-object-part": "shape"
      });
      content.appendChild(path);
      group.appendChild(content);
    }
    objectRoot.insertBefore(group, insertBefore);
  }
  // Edge adjustments are now drawn in place by renderObject (so higher layers cover them); this only clears
  // anything left over from older drawing.
  function drawEdgePreview() {
    $("#edge-preview").replaceChildren();
    stage.querySelectorAll("[data-edge-filter]").forEach((filter) => filter.remove());
  }
  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll("[data-tool]").forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("#brush-opt").hidden = !["draw", "erase", "line"].includes(tool);
    $("#line-opt").hidden = tool !== "line";
    updateToolCursor();
    render();
  }
  function updateToolCursor() {
    if (state.tool === "draw" || state.tool === "erase" || state.tool === "line") {
      const matrix = stage.getScreenCTM();
      const pxPerInch = matrix ? Math.hypot(matrix.a, matrix.b) : 96;
      const diameter = Math.max(2, Math.min(120, Number($("#brush-size").value) / 25.4 * pxPerInch));
      const side = Math.ceil(diameter + 4), center = side / 2, radius = diameter / 2;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}"><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="white" stroke-width="3"/><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#172033" stroke-width="1"/></svg>`;
      stage.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
    } else {
      stage.style.cursor = state.tool === "select" ? "default" : state.tool === "pick" ? "copy" : "crosshair";
    }
  }
  function selectedObject() { return state.objects.find((obj) => obj.id === state.selectedId) || null; }
  function drawSelection(obj) {
    if (!obj) return;
    const b = bounds(obj), angle = (obj.rotation || 0) * Math.PI / 180;
    const localToWorld = (x, y) => ({
      x: b.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: b.y + x * Math.sin(angle) + y * Math.cos(angle)
    });
    const corners = [
      localToWorld(-b.width / 2, -b.height / 2), localToWorld(b.width / 2, -b.height / 2),
      localToWorld(b.width / 2, b.height / 2), localToWorld(-b.width / 2, b.height / 2)
    ];
    selectionRoot.appendChild(node("path", {
      d: corners.map((p, index) => `${index ? "L" : "M"}${p.x} ${p.y}`).join(" ") + " Z",
      fill: "none", stroke: "#315ce8", "stroke-width": .018, "stroke-dasharray": ".06 .035", "pointer-events": "none"
    }));
    const r = .045;
    for (const [handle, p] of [
      ["nw", corners[0]], ["ne", corners[1]], ["se", corners[2]], ["sw", corners[3]]
    ]) selectionRoot.appendChild(node("rect", {
      x: p.x - r, y: p.y - r, width: r * 2, height: r * 2, rx: .012, fill: "#fff",
      stroke: "#315ce8", "stroke-width": .018, "data-handle": handle, "data-for": obj.id,
      style: "cursor:" + (handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize")
    }));
    const rotateHandle = localToWorld(0, -b.height / 2 - .2);
    const top = localToWorld(0, -b.height / 2);
    selectionRoot.appendChild(node("line", {
      x1: top.x, y1: top.y, x2: rotateHandle.x, y2: rotateHandle.y,
      stroke: "#315ce8", "stroke-width": .014, "pointer-events": "none"
    }));
    selectionRoot.appendChild(node("circle", {
      cx: rotateHandle.x, cy: rotateHandle.y, r: .055, fill: "#fff", stroke: "#315ce8",
      "stroke-width": .018, "data-handle": "rotate", "data-for": obj.id,
      style: "cursor:grab"
    }));
  }
  // Marching outline over every part of the color picked in the Layers & colors tab.
  function drawColorHighlight() {
    const color = state.edgeColor;
    const pane = document.querySelector('[data-pane="layers"]');
    if (!color || !pane || pane.hidden || state.drag || state.hiddenColors.has(color)) return;
    if (state.antsDismissed || !$("#color-ants-toggle").checked) return;
    const root = node("g", { class: "color-hl", "pointer-events": "none", opacity: ".5" });
    const style = (d, width = 0, filled = true) => node("path", {
      d, fill: filled ? "#a8322b" : "none", "fill-opacity": ".18", stroke: "#a8322b",
      "stroke-width": width || 1.6, "stroke-opacity": width ? ".4" : "1", "stroke-dasharray": width ? null : "5 3",
      "vector-effect": width ? null : "non-scaling-stroke", "stroke-linejoin": "round", "stroke-linecap": "round"
    });
    for (const obj of state.objects) {
      const group = node("g", { transform: transformFor(obj) });
      if (obj.type === "image") {
        const inner = node("g", { transform: `translate(${-Number(obj.cropX || 0)} ${-Number(obj.cropY || 0)})` });
        for (const region of obj.regions) {
          if (region.fill !== color) continue;
          const brush = Number(region.brushWidth) || 0;
          inner.appendChild(brush && !region.filled ? style(region.d, brush, false) : style(region.d));
        }
        if (inner.childNodes.length) group.appendChild(inner);
      } else if (obj.fill === color) {
        if (obj.type === "text") group.appendChild(node("rect", { x: 0, y: 0, width: obj.baseW, height: obj.baseH, fill: "#a8322b", "fill-opacity": ".12", stroke: "#a8322b", "stroke-width": 1.6, "stroke-dasharray": "5 3", "vector-effect": "non-scaling-stroke" }));
        else if (obj.type === "draw" && !obj.filled) group.appendChild(style(obj.d, Math.max(Number(obj.brushWidth) || 0, .04), false));
        else group.appendChild(style(obj.d));
      }
      if (group.childNodes.length) root.appendChild(group);
    }
    if (root.childNodes.length) selectionRoot.appendChild(root);
  }
  function drawStitches() {
    if (!state.stitches.length) return;
    // Outlines and borders are always shown as their real stitches; everything else only with the toggle.
    const all = $("#stitch-preview-toggle").checked;
    const deco = state.stitches.filter((s) => s.deco && s.points.length);
    if (deco.length && !all) {
      const byColor = new Map();
      for (const s of deco) {
        const color = state.stitchColors[s.color];
        if (!byColor.has(color)) byColor.set(color, []);
        byColor.get(color).push(s.points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(4)} ${p.y.toFixed(4)}`).join(""));
      }
      for (const [color, paths] of byColor) {
        selectionRoot.appendChild(node("path", {
          d: paths.join(""), fill: "none", stroke: color, "stroke-width": .3 / 25.4,
          "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none"
        }));
      }
    }
    if (!all) return;
    const byColor = new Map();
    for (const segment of state.stitches) {
      if (!segment.points.length) continue;
      const color = state.stitchColors[segment.color];
      if (state.hiddenColors.has(color)) continue;
      if (!byColor.has(color)) byColor.set(color, []);
      const commands = segment.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
      byColor.get(color).push(commands);
    }
    for (const [color, paths] of byColor) {
      selectionRoot.appendChild(node("path", {
        d: paths.join(" "), fill: "none", stroke: color, "stroke-width": .008,
        "stroke-linecap": "round", opacity: .75, "pointer-events": "none"
      }));
    }
  }
  function updateProperties() {
    const obj = selectedObject();
    $("#sec-start").hidden = !!obj;
    $("#sec-trace").hidden = !!obj && obj.type !== "image";
    $("#sec-text").hidden = obj?.type !== "text";
    $("#sec-line").hidden = !(obj && (obj.type === "draw" || obj.type === "shape"));
    $("#sec-transform").hidden = !obj;
    if (obj && (obj.type === "draw" || obj.type === "shape")) {
      const line = isLineObject(obj);
      document.querySelectorAll("[data-sew]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.sew === "line") === line)));
      $("#line-fields").hidden = !line;
      $("#line-style").value = obj.lineStyle || "running";
      $("#line-width").value = String(Number(obj.lineWidth) || 2);
    }
    const kinds = { image: "Traced artwork", text: "Text", shape: "Shape", draw: "Brush stroke" };
    $("#obj-kind").textContent = obj ? (isLineObject(obj) ? "Stitched line" : kinds[obj.type] || "") : "";
    if (document.activeElement !== $("#text-entry")) $("#text-entry").value = obj && obj.type === "text" ? obj.text : "";
    $("#retrace-image").disabled = !obj || obj.type !== "image" || !obj.sourceDataUrl;
    if (obj) {
      $("#obj-x").value = obj.x.toFixed(2); $("#obj-y").value = obj.y.toFixed(2);
      $("#obj-w").value = obj.width.toFixed(2); $("#obj-h").value = obj.height.toFixed(2);
      const selectedFill = state.selectedRegion && state.selectedRegion.id === obj.id
        ? obj.regions[state.selectedRegion.index]?.fill
        : obj.fill;
      $("#obj-fill").value = selectedFill && selectedFill !== "none" ? safeColor(selectedFill) : safeColor(state.color);
      $("#obj-rotation").value = String(Math.round(obj.rotation || 0));
      if (obj.type === "text") {
        if ($("#font").value !== obj.font) fillFontSelect(obj.font || "Arial");
        $("#text-size").value = obj.sizeIn.toFixed(2);
        $("#text-curve").value = String(Number(obj.curve) || 0); $("#text-curve-value").textContent = String(Number(obj.curve) || 0);
        $("#text-spacing").value = String(Number(obj.spacing) || 0); $("#text-spacing-value").textContent = String(Number(obj.spacing) || 0);
      }
      if (obj.type === "image" && Number.isFinite(obj.traceDetail)) {
        $("#trace-detail").value = obj.traceDetail;
        $("#trace-detail-value").textContent = `${obj.traceDetail}%`;
      }
      if (obj.type === "image" && Number.isFinite(obj.traceColors)) $("#trace-colors").value = String(obj.traceColors);
    }
  }
  const EYE_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a15 15 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const ICON_X = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M8 5.5v-2h4v2M5 5.5l.8 11h8.4l.8-11"/></svg>';
  const layerTitle = (obj) => obj.type === "text" ? `“${obj.text}”` : obj.name || (obj.type === "image" ? "Traced artwork" : obj.type === "draw" ? "Freeform path" : "Shape");
  function rowButton(className, html, title, data, disabled = false) {
    const button = document.createElement("button");
    button.type = "button"; button.className = className; button.title = title; button.setAttribute("aria-label", title);
    button.innerHTML = html; button.disabled = disabled;
    Object.assign(button.dataset, data);
    return button;
  }
  function orderArrows(data, upDisabled, downDisabled, noun) {
    const wrap = document.createElement("span"); wrap.className = "layer-reorder";
    wrap.append(
      rowButton("layer-arrow", "▲", `Move ${noun} forward`, { ...data, dir: "up" }, upDisabled),
      rowButton("layer-arrow", "▼", `Move ${noun} backward`, { ...data, dir: "down" }, downDisabled)
    );
    return wrap;
  }
  // One thread-color row: check, recolor, name, eye, order arrows, remove.
  function colorRow(obj, color, { title, sub, upDisabled, downDisabled }) {
    const row = document.createElement("div");
    const single = obj.type !== "image";
    row.className = "swatch" + (single ? "" : " sub") + (color === state.edgeColor ? " current" : "")
      + (single && obj.id === state.selectedId ? " selected" : "") + (state.hiddenColors.has(color) ? " off" : "");
    row.dataset.edgeColor = color; row.dataset.objectId = obj.id;
    const check = document.createElement("input"); check.type = "checkbox"; check.dataset.mergeColor = color;
    check.checked = state.selectedPaletteColors.has(color); check.title = "Check to combine or remove";
    const input = document.createElement("input"); input.type = "color"; input.value = color; input.dataset.paletteColor = color;
    input.setAttribute("aria-label", "Recolor " + color);
    const text = document.createElement("span"); text.className = "tname";
    text.textContent = title; text.title = "Double-click to rename this color";
    const small = document.createElement("small"); small.textContent = sub; text.appendChild(small);
    const tools = document.createElement("span"); tools.className = "row-tools";
    const visible = !state.hiddenColors.has(color);
    const eye = rowButton("color-visibility", visible ? EYE_ON : EYE_OFF, `${visible ? "Hide" : "Show"} this color on canvas`, { toggleColor: color });
    eye.setAttribute("aria-pressed", String(visible));
    tools.append(eye);
    if (single) {
      tools.append(orderArrows({ layerId: obj.id, layerMove: "1" }, upDisabled, downDisabled, "layer"));
      tools.append(rowButton("row-x", ICON_TRASH, "Delete this layer", { deleteLayer: obj.id }));
    } else {
      tools.append(orderArrows({ objectId: obj.id, color, colorMove: "1" }, upDisabled, downDisabled, "color"));
      tools.append(rowButton("row-x", ICON_X, "Remove this color from stitching", { removeColor: color, objectId: obj.id }));
    }
    row.append(check, input, text, tools);
    return row;
  }
  const fillLabel = (color) => (FILL_STYLES.find(([v]) => v === resolveFill(colorSettings(color).fill))?.[1] || "Tatami").replace(/ \(.*\)/, "");
  // The Brother thread the machine will ask for: the user's choice, or the nearest Brother color.
  function machineThread(color) {
    const chosen = Number(colorSettings(color).brother);
    if (chosen >= 1 && chosen <= 63) { const t = EF.BROTHER[chosen]; return { index: chosen, name: t[3], chosen: true }; }
    const near = EF.nearestBrother(color);
    return { index: near.index, name: near.name, chosen: false };
  }
  // Layers and their thread colors in one list. Top rows appear in front.
  function renderLayers() {
    const root = $("#layers"); root.replaceChildren();
    if (!state.objects.length) {
      const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "No layers yet. Upload an image or add text.";
      root.appendChild(empty);
      return;
    }
    const objs = [...state.objects].reverse();
    objs.forEach((obj, visualIndex) => {
      const upDisabled = visualIndex === 0, downDisabled = visualIndex === objs.length - 1;
      if (obj.type === "image") {
        const order = imageColorOrder(obj).reverse();
        const head = document.createElement("div");
        const allHidden = order.length > 0 && order.every((c) => state.hiddenColors.has(c));
        head.className = "layer-row" + (obj.id === state.selectedId ? " selected" : "") + (allHidden ? " off" : "");
        const select = document.createElement("button");
        select.className = "layer"; select.type = "button"; select.dataset.selectId = obj.id;
        const swatch = document.createElement("i");
        swatch.style.background = order.length ? `linear-gradient(135deg, ${order.slice(0, 4).join(", ")})` : "transparent";
        const label = document.createElement("span"); label.textContent = layerTitle(obj);
        const kind = document.createElement("small"); kind.textContent = `${order.length} color${order.length === 1 ? "" : "s"}`;
        select.append(swatch, label, kind);
        const tools = document.createElement("span"); tools.className = "row-tools";
        tools.append(
          rowButton("color-visibility", allHidden ? EYE_OFF : EYE_ON, `${allHidden ? "Show" : "Hide"} this image on canvas`, { toggleObject: obj.id }),
          orderArrows({ layerId: obj.id, layerMove: "1" }, upDisabled, downDisabled, "layer"),
          rowButton("row-x", ICON_TRASH, "Delete this layer", { deleteLayer: obj.id })
        );
        head.append(select, tools);
        root.appendChild(head);
        order.forEach((color, i) => {
          const brother = EF.nearestBrother(color), name = colorSettings(color).name;
          root.appendChild(colorRow(obj, color, {
            title: name || color.toUpperCase(),
            sub: `${name ? color.toUpperCase() + " · " : ""}${machineThread(color).chosen ? "machine: " : brother.hex === color ? "" : "≈ "}${machineThread(color).name} · ${fillLabel(color)}`,
            upDisabled: i === 0, downDisabled: i === order.length - 1
          }));
        });
      } else {
        const color = obj.fill && obj.fill !== "none" ? obj.fill : "#ffffff";
        const brother = EF.nearestBrother(color);
        const kind = isLineObject(obj) ? (LINE_STYLES.find(([v]) => v === obj.lineStyle)?.[1] || "Line") : fillLabel(color);
        const name = colorSettings(color).name;
        root.appendChild(colorRow(obj, color, {
          title: layerTitle(obj), sub: `${name ? name + " · " : ""}${color.toUpperCase()} · ${machineThread(color).name} · ${kind}`, upDisabled, downDisabled
        }));
      }
    });
  }
  function allColors() {
    const counts = new Map();
    for (const obj of state.objects) {
      if (obj.type === "image") {
        for (const region of obj.regions) if (region.fill !== "none") counts.set(region.fill, (counts.get(region.fill) || 0) + 1);
      } else if (obj.fill && obj.fill !== "none") counts.set(obj.fill, (counts.get(obj.fill) || 0) + 1);
    }
    return [...counts.keys()];
  }
  // Colors in sewing order: layer by layer from the bottom, and inside a picture from its bottom color
  // up, so whatever is shown in front is also sewn last (on top).
  function sewingColors() {
    const seen = new Set(), out = [];
    const add = (c) => { if (c && c !== "none" && !seen.has(c)) { seen.add(c); out.push(c); } };
    for (const obj of state.objects) {
      if (obj.type === "image") imageColorOrder(obj).forEach(add);
      else add(obj.fill);
    }
    return out;
  }
  function updateTraceSummary() {
    const selected = selectedObject();
    const objects = selected?.type === "image" ? [selected] : state.objects;
    const colors = new Set();
    let regions = 0;
    for (const obj of objects) {
      if (obj.type === "image") {
        for (const region of obj.regions) {
          if (region.fill === "none") continue;
          colors.add(region.fill);
          regions++;
        }
      } else if (obj.fill && obj.fill !== "none") {
        colors.add(obj.fill);
        regions++;
      }
    }
    $("#trace-summary").textContent = `${selected?.type === "image" ? "Selected image" : "Current design"}: ${colors.size} thread color${colors.size === 1 ? "" : "s"} · ${regions} filled region${regions === 1 ? "" : "s"}`;
  }
  // The thread list now lives inside the Layers list (see renderLayers).
  function renderPalette() {
    renderEdgeColorChoices();
  }
  function renderEdgeColorChoices() {
    const colors = allColors();
    if (!colors.includes(state.edgeColor)) state.edgeColor = colors[0] || null;
    $("#color-settings").hidden = !colors.length;
    if (!state.edgeColor) return;
    $("#layers").querySelectorAll(".swatch").forEach((row) => row.classList.toggle("current", row.dataset.edgeColor === state.edgeColor));
    // Banner showing exactly which color the sliders below will change.
    const brother = EF.nearestBrother(state.edgeColor), banner = $("#edge-color-name");
    banner.className = "editing"; banner.replaceChildren();
    const chip = document.createElement("i"); chip.style.background = state.edgeColor;
    const label = document.createElement("span");
    const customName = colorSettings(state.edgeColor).name;
    label.textContent = `Editing ${customName || state.edgeColor.toUpperCase()}`;
    const sub = document.createElement("small");
    const machine = machineThread(state.edgeColor);
    sub.textContent = `${customName ? state.edgeColor.toUpperCase() + " · " : ""}machine asks for: ${machine.name} (#${machine.index})`
      + (state.activeColor?.color === state.edgeColor ? " · eraser: this color only" : "");
    label.appendChild(sub);
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "btn warn"; remove.id = "remove-edge-color"; remove.textContent = "Remove";
    remove.title = "Remove this color from stitching (Undo brings it back)";
    banner.append(chip, label, remove);
    const settings = selectedGapFillSettings();
    $("#gap-fill").value = String(settings.strokeMm);
    $("#gap-fill-value").textContent = `${settings.strokeMm.toFixed(1)} mm`;
    const inside = Number(settings.insideMm) || 0;
    $("#inside-stroke").value = String(inside);
    $("#inside-stroke-value").textContent = `${inside.toFixed(1)} mm`;
    $("#color-smooth").value = String(settings.smoothMm);
    $("#color-smooth-value").textContent = `${Number(settings.smoothMm).toFixed(2)} mm`;
    $("#color-fill").value = FILL_STYLES.some(([v]) => v === settings.fill) ? settings.fill : "default";
    $("#color-fill").options[0].textContent = `Same as design (${(FILL_STYLES.find(([v]) => v === resolveFill("default"))?.[1] || "Tatami").replace(/ \(.*\)/, "")})`;
    $("#color-machine").value = machine.chosen ? String(machine.index) : "";
    $("#color-machine").options[0].textContent = `Automatic: ${EF.nearestBrother(state.edgeColor).name}`;
    $("#color-angle").value = Number.isFinite(settings.angle) ? String(settings.angle) : "";
  }
  // Per-color settings: edge grow/smooth plus the fill style and an optional angle override.
  function colorSettings(color) {
    return { strokeMm: 0, insideMm: 0, smoothMm: 0, fill: "default", angle: null, ...(state.gapFillSettings.get(color) || {}) };
  }
  function selectedGapFillSettings() {
    const color = state.edgeColor;
    if (!color) return colorSettings(null);
    if (!state.gapFillSettings.has(color)) state.gapFillSettings.set(color, colorSettings(color));
    return state.gapFillSettings.get(color);
  }
  function render() {
    objectRoot.replaceChildren(); selectionRoot.replaceChildren();
    for (const obj of state.objects) renderObject(obj);
    drawBorderPreview();
    drawStitches();
    drawColorHighlight();
    drawSelection(selectedObject());
    updateProperties(); renderLayers(); renderColorOrder(); renderPalette();
    drawEdgePreview();
    updateTraceSummary();
    const stats = state.stitches.length ? state.planStats : null;
    $("#stitch-count").textContent = stats ? stats.stitches.toLocaleString() : "—";
    $("#sew-time").textContent = stats ? (stats.minutes < 1 ? "< 1 min" : `${Math.round(stats.minutes)} min`) : "—";
    $("#sew-time").title = stats ? `At 650 stitches/min, with ${stats.colorChanges} thread change${stats.colorChanges === 1 ? "" : "s"} and ${stats.trims} trim${stats.trims === 1 ? "" : "s"}` : "";
    $("#color-count").textContent = String(allColors().length || "—");
    $("#empty-hint").hidden = state.objects.length > 0;
    $("#undo").disabled = !state.history.length; $("#redo").disabled = !state.future.length;
    const sizeEl = $("#canvas-size");
    if (state.objects.length) {
      const extents = state.objects.map(rotatedBounds);
      const minX = Math.min(...extents.map((b) => b.x - b.width / 2));
      const maxX = Math.max(...extents.map((b) => b.x + b.width / 2));
      const minY = Math.min(...extents.map((b) => b.y - b.height / 2));
      const maxY = Math.max(...extents.map((b) => b.y + b.height / 2));
      const w = maxX - minX, h = maxY - minY;
      $("#design-size").textContent = `${w.toFixed(1)}×${h.toFixed(1)}″`;
      $("#design-size").title = `${(w * 25.4).toFixed(0)} × ${(h * 25.4).toFixed(0)} mm`;
      const fits = minX >= -.001 && minY >= -.001 && maxX <= state.hoopW + .001 && maxY <= state.hoopH + .001;
      sizeEl.innerHTML = "";
      sizeEl.append(fits ? `Design ${w.toFixed(2)} × ${h.toFixed(2)} in · ${state.hoopW} × ${state.hoopH} in hoop` : "Design goes outside the hoop");
      sizeEl.classList.toggle("warn", !fits);
    } else {
      $("#design-size").textContent = "—";
      sizeEl.textContent = `${state.hoopW} × ${state.hoopH} in hoop`;
      sizeEl.classList.remove("warn");
    }
  }
  function serializeState() {
    return JSON.stringify({
      objects: state.objects,
      gapFillSettings: Object.fromEntries(state.gapFillSettings),
      edgeColor: state.edgeColor
    });
  }
  function snapshot() {
    state.history.push(serializeState());
    state.future = [];
    if (state.history.length > 50) state.history.shift();
  }
  function restoreSnapshot(serialized) {
    const snapshot = JSON.parse(serialized);
    editingEdgeSettings = false;
    if (Array.isArray(snapshot)) {
      state.objects = snapshot;
      state.gapFillSettings = new Map();
    } else {
      state.objects = snapshot.objects;
      state.gapFillSettings = new Map(Object.entries(snapshot.gapFillSettings || {}));
      state.edgeColor = snapshot.edgeColor || null;
    }
  }
  function invalidateStitches() {
    state.stale = true; state.stitches = [];
    $("#export-state").textContent = "Planned when you preview or export";
    render();
    // Outlines and borders are shown as their real stitches, so re-plan them shortly after a change.
    const decorations = $("#outline-mode").value !== "off" || $("#border-on").checked;
    if ($("#stitch-preview-toggle").checked || (decorations && state.objects.length)) debounceStitches(decorations ? 600 : 250);
  }
  let stitchTimer = 0;
  function debounceStitches(delay = 250) {
    clearTimeout(stitchTimer);
    stitchTimer = setTimeout(() => {
      if (state.busy) { debounceStitches(delay); return; }
      makeStitches().catch((error) => message(error.message, "error"));
    }, delay);
  }
  function changed() {
    invalidateStitches();
  }
  function makeVectorObject(type, x, y, width, height, fill, d, label) {
    return {
      id: uid(), type, name: label, x, y, width, height, baseW: width, baseH: height,
      fill, d, stroke: "none", strokeWidth: .02
    };
  }
  function applySelectedColor() {
    const obj = selectedObject();
    if (!obj) return;
    snapshot();
    if (state.selectedRegion && state.selectedRegion.id === obj.id && obj.type === "image") {
      const region = obj.regions[state.selectedRegion.index];
      if (region) region.fill = state.color;
    } else if (obj.type === "image") {
      obj.regions.forEach((region) => { region.fill = state.color; });
    } else obj.fill = state.color;
    if (obj.type === "image") refreshImageCrop(obj);
    changed();
  }
  function colorRegionFromTarget(target, remove = false) {
    const group = target.closest("[data-object-id]");
    if (!group) return;
    const obj = state.objects.find((item) => item.id === group.dataset.objectId);
    if (!obj) return;
    if (remove && obj.type !== "image") {
      message("Color Remover applies to traced image regions.", "info");
      return;
    }
    snapshot(); state.selectedId = obj.id;
    const regionIndex = target.closest("[data-region-index]")?.dataset.regionIndex;
    if (obj.type === "image" && regionIndex !== undefined) {
      state.selectedRegion = { id: obj.id, index: Number(regionIndex) };
      const region = obj.regions[Number(regionIndex)];
      region.fill = remove ? "none" : state.color;
      if (region.brushWidth) region.filled = !remove;
    } else {
      state.selectedRegion = null;
      if (obj.type === "image") obj.regions.forEach((region) => { region.fill = remove ? "none" : state.color; if (region.brushWidth) region.filled = !remove; });
      else { obj.fill = state.color; if (obj.brushWidth) obj.filled = true; }
    }
    if (obj.type === "image") refreshImageCrop(obj);
    changed();
    message(remove ? "Traced region removed from stitching." : "Vector region recolored. Stitch plan updated.", "ok");
  }
  function pickColorFromTarget(target) {
    const region = target.closest("[data-region-index]");
    const group = target.closest("[data-object-id]");
    if (!region || !group) {
      message("Click a traced image region to sample its color.", "info");
      return;
    }
    const obj = state.objects.find((item) => item.id === group.dataset.objectId);
    const picked = obj?.regions?.[Number(region.dataset.regionIndex)]?.fill;
    if (!picked || picked === "none") {
      message("That region has no thread color to sample.", "info");
      return;
    }
    syncColorInputs(safeColor(picked));
    state.selectedPaletteColors.clear();
    state.selectedPaletteColors.add(state.color);
    state.selectedId = obj.id;
    state.selectedRegion = { id: obj.id, index: Number(region.dataset.regionIndex) };
    setTool("select");
    message(`Picked ${state.color} from the image region.`, "ok");
  }
  function objectLocalPoint(obj, point) {
    const radians = (obj.rotation || 0) * Math.PI / 180;
    const dx = point.x - obj.x, dy = point.y - obj.y;
    const x = (dx * Math.cos(radians) + dy * Math.sin(radians)) / obj.width * obj.baseW * (obj.flipX ? -1 : 1) + obj.baseW / 2;
    const y = (-dx * Math.sin(radians) + dy * Math.cos(radians)) / obj.height * obj.baseH * (obj.flipY ? -1 : 1) + obj.baseH / 2;
    return obj.type === "image"
      ? { x: x + Number(obj.cropX || 0), y: y + Number(obj.cropY || 0) }
      : { x, y };
  }
  function addErasingPoint(event) {
    const erasing = state.erasing;
    if (!erasing) return;
    const obj = state.objects.find((item) => item.id === erasing.id);
    if (!obj) return;
    const worldPoint = svgPoint(event);
    if (Math.hypot(worldPoint.x - erasing.lastWorld.x, worldPoint.y - erasing.lastWorld.y) < .004) return;
    erasing.points.push(objectLocalPoint(obj, worldPoint));
    erasing.worldPoints.push(worldPoint);
    erasing.lastWorld = worldPoint;
    drawEraserGhost();
  }
  function drawEraserGhost() {
    const erasing = state.erasing;
    selectionRoot.replaceChildren();
    if (!erasing) return;
    selectionRoot.appendChild(node("path", {
      d: strokePath(erasing.worldPoints), fill: "none", stroke: "#ff3b6b", "stroke-opacity": ".45",
      "stroke-width": erasing.worldWidth, "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none"
    }));
  }
  function finishErasing() {
    const erasing = state.erasing;
    state.erasing = null;
    const obj = state.objects.find((item) => item.id === erasing.id);
    if (!obj || !erasing.points.length) {
      message("No selected layer was available to erase.", "info");
      return;
    }
    snapshot();
    obj.erasures = obj.erasures || [];
    // Only the color picked in the Layers list is erased; otherwise every visible color of the layer.
    const onlyColor = obj.type === "image" && state.activeColor?.id === obj.id ? state.activeColor.color : null;
    if (Array.isArray(obj.regions)) {
      const index = obj.erasures.length;
      obj.regions.forEach((region) => {
        region.skipErasures = region.skipErasures || obj.erasures.map((e, i) => (e.skip && e.skip.includes(region.fill) ? i : -1)).filter((i) => i >= 0);
        if (onlyColor ? region.fill !== onlyColor : state.hiddenColors.has(region.fill)) region.skipErasures.push(index);
      });
    }
    const others = onlyColor ? obj.regions.map((r) => r.fill).filter((f) => f !== onlyColor) : [...state.hiddenColors];
    obj.erasures.push({ d: strokePath(erasing.points), width: erasing.width, skip: [...new Set(others)] });
    changed();
    message(onlyColor ? `Erased part of ${colorSettings(onlyColor).name || onlyColor.toUpperCase()} only. Other colors were not touched.` : `Erased part of the selected ${obj.type === "image" ? "image" : "layer"}.`, "ok");
  }
  function startDrag(event, obj, handle) {
    snapshot();
    const p = svgPoint(event), b = bounds(obj);
    const angle = Math.atan2(p.y - b.y, p.x - b.x);
    state.drag = {
      id: obj.id, handle, startX: p.x, startY: p.y,
      x: obj.x, y: obj.y, width: b.width, height: b.height,
      ratio: b.width / Math.max(.001, b.height), rotation: obj.rotation || 0,
      startAngle: angle, moved: false
    };
    stage.setPointerCapture(event.pointerId);
  }
  function startPan(event) {
    const matrix = stage.getScreenCTM();
    state.pan = {
      x: event.clientX, y: event.clientY, viewX: state.viewX, viewY: state.viewY,
      scaleX: Math.hypot(matrix.a, matrix.b), scaleY: Math.hypot(matrix.c, matrix.d),
      moved: false
    };
    stage.focus();
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  stage.addEventListener("pointerdown", (event) => {
    const target = event.target;
    stage.focus();
    if (event.button === 1 || state.spaceDown) { startPan(event); return; }
    const p = svgPoint(event);
    if (state.tool === "erase") {
      let obj = selectedObject();
      if (!obj) {
        const hitId = target.closest("[data-object-id]")?.dataset.objectId;
        obj = state.objects.find((item) => item.id === hitId) || null;
        if (obj) { state.selectedId = obj.id; state.selectedRegion = null; render(); }
      }
      if (!obj) {
        message("Click on a layer or select one before using the eraser.", "info");
        return;
      }
      const brushMm = Number($("#brush-size").value);
      const width = brushMm / 25.4 * obj.baseW / obj.width;
      state.erasing = {
        id: obj.id, points: [objectLocalPoint(obj, p)], lastWorld: p, width,
        worldPoints: [p], worldWidth: brushMm / 25.4
      };
      drawEraserGhost();
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (state.tool === "line") {
      state.drawing = { start: p, points: [p], type: "line", imageId: null };
      stage.setPointerCapture(event.pointerId);
      return;
    }
    if (state.tool === "draw" || state.tool === "rect" || state.tool === "ellipse") {
      let imageId = selectedObject()?.type === "image" ? state.selectedId : null;
      if (state.tool === "draw") {
        const targetGroup = target.closest("[data-object-id]");
        const targetObject = state.objects.find((item) => item.id === targetGroup?.dataset.objectId);
        if (targetObject?.type === "image") {
          imageId = targetObject.id;
          state.selectedId = targetObject.id;
          state.selectedRegion = null;
          render();
        } else if (selectedObject()?.type === "image") imageId = state.selectedId;
      }
      state.drawing = { start: p, points: [p], type: state.tool, imageId };
      stage.setPointerCapture(event.pointerId);
      return;
    }
    const handle = target.closest("[data-handle]");
    if (handle) {
      const obj = state.objects.find((item) => item.id === handle.dataset.for);
      if (obj) startDrag(event, obj, handle.dataset.handle);
      event.preventDefault(); return;
    }
    const group = target.closest("[data-object-id]");
    if (state.tool === "pick") {
      pickColorFromTarget(target); event.preventDefault(); return;
    }
    if (state.tool === "fill" || state.tool === "remove") {
      colorRegionFromTarget(target, state.tool === "remove"); event.preventDefault(); return;
    }
    if (!group) {
      state.antsDismissed = true;
      if (state.tool === "select") { startPan(event); return; }
      state.selectedId = null; state.selectedRegion = null; render(); return;
    }
    const obj = state.objects.find((item) => item.id === group.dataset.objectId);
    if (!obj) return;
    if (state.activeColor?.id !== obj.id) state.activeColor = null;
    state.selectedId = obj.id; state.selectedRegion = null;
    render();
    startDrag(event, obj, null);
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (state.pan) {
      const pan = state.pan;
      const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
      if (Math.hypot(dx, dy) > 2) pan.moved = true;
      state.viewX = pan.viewX - dx / pan.scaleX;
      state.viewY = pan.viewY - dy / pan.scaleY;
      viewBox();
      return;
    }
    const p = svgPoint(event);
    $("#cursor-coords").textContent = `${p.x.toFixed(2)} × ${p.y.toFixed(2)} in`;
    if (state.erasing) {
      addErasingPoint(event);
      return;
    }
    if (state.drawing) {
      if (state.drawing.type === "draw" || state.drawing.type === "line") {
        const previous = state.drawing.points[state.drawing.points.length - 1];
        if (Math.hypot(p.x - previous.x, p.y - previous.y) > .012) state.drawing.points.push(p);
      } else state.drawing.current = p;
      drawShapeGhost(); return;
    }
    if (!state.drag) return;
    const obj = state.objects.find((item) => item.id === state.drag.id);
    if (!obj) return;
    const drag = state.drag;
    if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < .003) return;
    drag.moved = true;
    if (drag.handle === "rotate") {
      const start = drag.startAngle;
      const current = Math.atan2(p.y - drag.y, p.x - drag.x);
      obj.rotation = ((drag.rotation + (current - start) * 180 / Math.PI + 180) % 360 + 360) % 360 - 180;
    } else if (!drag.handle) {
      obj.x = drag.x + p.x - drag.startX;
      obj.y = drag.y + p.y - drag.startY;
    } else {
      const angle = drag.rotation * Math.PI / 180;
      const worldDx = p.x - drag.startX, worldDy = p.y - drag.startY;
      const localDx = worldDx * Math.cos(angle) + worldDy * Math.sin(angle);
      const localDy = -worldDx * Math.sin(angle) + worldDy * Math.cos(angle);
      const sx = drag.handle.includes("e") ? 1 : -1;
      const sy = drag.handle.includes("s") ? 1 : -1;
      const dx = localDx * sx, dy = localDy * sy;
      let width = Math.max(.05, drag.width + dx), height = Math.max(.05, drag.height + dy);
      if ($("#keep-ratio").checked) {
        if (width / height > drag.ratio) height = width / drag.ratio;
        else width = height * drag.ratio;
      }
      obj.width = Math.min(12, width); obj.height = Math.min(12, height);
      const localCenterX = sx * (obj.width - drag.width) / 2;
      const localCenterY = sy * (obj.height - drag.height) / 2;
      obj.x = drag.x + localCenterX * Math.cos(angle) - localCenterY * Math.sin(angle);
      obj.y = drag.y + localCenterX * Math.sin(angle) + localCenterY * Math.cos(angle);
    }
    renderDragFrame(obj);
  });
  stage.addEventListener("pointerup", (event) => {
    if (state.pan) {
      const moved = state.pan.moved;
      state.pan = null;
      if (!moved && state.tool === "select" && !state.spaceDown && event.button === 0) {
        state.selectedId = null; state.selectedRegion = null; render();
      }
      return;
    }
    if (state.erasing) { finishErasing(); return; }
    if (state.drawing) {
      const drawing = state.drawing; state.drawing = null;
      const end = svgPoint(event), start = drawing.start;
      const x0 = Math.min(start.x, end.x), y0 = Math.min(start.y, end.y);
      const width = Math.max(.05, Math.abs(end.x - start.x)), height = Math.max(.05, Math.abs(end.y - start.y));
      snapshot();
      if (drawing.type === "line") {
        const points = drawing.points.filter((p, index, list) => !index || Math.hypot(p.x - list[index - 1].x, p.y - list[index - 1].y) >= .02);
        if (points.length && Math.hypot(end.x - points.at(-1).x, end.y - points.at(-1).y) > .01) points.push(end);
        const length = points.reduce((n, p, i) => n + (i ? Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) : 0), 0);
        if (points.length < 2 || length < .1) { state.history.pop(); render(); message("Drag to draw a stitched line.", "info"); return; }
        const pad = .05;
        const minX = Math.min(...points.map((p) => p.x)) - pad, minY = Math.min(...points.map((p) => p.y)) - pad;
        const maxX = Math.max(...points.map((p) => p.x)) + pad, maxY = Math.max(...points.map((p) => p.y)) + pad;
        const w = maxX - minX, h = maxY - minY;
        const line = makeVectorObject("draw", minX + w / 2, minY + h / 2, w, h, state.color,
          strokePath(points, (point) => ({ x: point.x - minX, y: point.y - minY })), "Stitched line");
        line.stitchAs = "line"; line.lineStyle = $("#tool-line-style").value || "running";
        line.lineWidth = Number($("#brush-size").value) || 3;
        line.brushWidth = line.lineWidth / 25.4;
        line.closed = isClosedStroke(points, .05);
        state.objects.push(line); state.selectedId = line.id; state.selectedRegion = null;
        changed();
        return;
      }
      if (drawing.type === "draw") {
        const points = drawing.points.filter((p, index, list) => !index || Math.hypot(p.x - list[index - 1].x, p.y - list[index - 1].y) >= .01);
        if (points.length && Math.hypot(end.x - points[points.length - 1].x, end.y - points[points.length - 1].y) > .003) points.push(end);
        const brushWidthMm = Number($("#brush-size").value);
        const imageObj = state.objects.find((obj) => obj.id === drawing.imageId && obj.type === "image");
        if (imageObj?.type === "image") {
          const d = strokePath(points, (point) => objectLocalPoint(imageObj, point));
          const brushWidth = brushWidthMm / 25.4 * imageObj.baseW / imageObj.width;
          imageObj.regions.push({ d, fill: state.color, brushWidth, closed: isClosedStroke(points, brushWidthMm / 25.4), gen: imageObj.erasures?.length || 0 });
          refreshImageCrop(imageObj);
          state.selectedRegion = { id: imageObj.id, index: imageObj.regions.length - 1 };
          message("Brush stroke merged into the selected image layer.", "ok");
        } else {
          const radius = brushWidthMm / 25.4 / 2;
          const minX = Math.min(...points.map((p) => p.x)) - radius;
          const minY = Math.min(...points.map((p) => p.y)) - radius;
          const maxX = Math.max(...points.map((p) => p.x)) + radius;
          const maxY = Math.max(...points.map((p) => p.y)) + radius;
          const w = maxX - minX, h = maxY - minY;
          const d = strokePath(points, (point) => ({ x: point.x - minX, y: point.y - minY }));
          const brush = makeVectorObject("draw", minX + w / 2, minY + h / 2, w, h, state.color, d, "Brush stroke");
          brush.brushWidth = brushWidthMm / 25.4;
          brush.closed = isClosedStroke(points, brush.brushWidth);
          state.objects.push(brush);
        }
      } else if (drawing.type === "rect" || drawing.type === "ellipse") {
        const imageObj = state.objects.find((obj) => obj.id === drawing.imageId && obj.type === "image");
        if (imageObj) {
          const cx = x0 + width / 2, cy = y0 + height / 2;
          const outline = drawing.type === "rect"
            ? [[x0, y0], [x0 + width, y0], [x0 + width, y0 + height], [x0, y0 + height]]
            : Array.from({ length: 64 }, (_, i) => {
              const t = i / 64 * Math.PI * 2;
              return [cx + Math.cos(t) * width / 2, cy + Math.sin(t) * height / 2];
            });
          const d = outline.map(([px, py], i) => {
            const local = objectLocalPoint(imageObj, { x: px, y: py });
            return `${i ? "L" : "M"}${local.x.toFixed(4)} ${local.y.toFixed(4)}`;
          }).join(" ") + " Z";
          imageObj.regions.push({ d, fill: state.color, gen: imageObj.erasures?.length || 0 });
          refreshImageCrop(imageObj);
          state.selectedId = imageObj.id;
          state.selectedRegion = { id: imageObj.id, index: imageObj.regions.length - 1 };
          changed();
          message("Shape merged into the selected image layer.", "ok");
          return;
        }
        const d = drawing.type === "rect"
          ? `M0 0 H${width} V${height} H0 Z`
          : `M${width / 2} 0 A${width / 2} ${height / 2} 0 1 1 ${width / 2} ${height} A${width / 2} ${height / 2} 0 1 1 ${width / 2} 0 Z`;
        state.objects.push(makeVectorObject("shape", x0 + width / 2, y0 + height / 2, width, height, state.color, d, drawing.type === "rect" ? "Rectangle" : "Ellipse"));
      } else state.history.pop();
      const last = state.objects[state.objects.length - 1];
      state.selectedId = last?.id || null; changed(); return;
    }
    if (state.drag) {
      const moved = state.drag.moved;
      state.drag = null;
      if (!moved) {
        state.history.pop();
        render();
        return;
      }
      render(); invalidateStitches();
    }
  });
  stage.addEventListener("pointercancel", () => {
    if (state.drag) {
      const previous = state.history.pop();
      if (previous) restoreSnapshot(previous);
    }
    state.drag = null; state.drawing = null; state.erasing = null; state.pan = null; render();
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const anchor = svgPoint(event);
    zoomCanvas(state.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), anchor);
  }, { passive: false });
  function drawShapeGhost() {
    selectionRoot.replaceChildren();
    const d = state.drawing;
    if (!d) return;
    const end = d.current || d.start;
    if (d.type === "line") {
      selectionRoot.appendChild(node("path", {
        d: strokePath(d.points), fill: "none", stroke: state.color, "stroke-width": .014,
        "stroke-dasharray": ".05 .03", "stroke-linecap": "round", "pointer-events": "none"
      }));
    } else if (d.type === "draw") {
      const path = strokePath(d.points);
      const width = Number($("#brush-size").value) / 25.4;
      selectionRoot.appendChild(node("path", {
        d: path, fill: "none", stroke: state.color, "stroke-width": width,
        "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none"
      }));
    } else {
      const x = Math.min(d.start.x, end.x), y = Math.min(d.start.y, end.y), w = Math.abs(end.x - d.start.x), h = Math.abs(end.y - d.start.y);
      const shape = d.type === "rect" ? node("rect", { x, y, width: w, height: h }) : node("ellipse", { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 });
      shape.setAttribute("fill", state.color); shape.setAttribute("opacity", ".55"); selectionRoot.appendChild(shape);
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read that image."));
      reader.readAsDataURL(file);
    });
  }
  async function traceImage(file) {
    if (!window.ImageTracer) throw new Error("The vector tracing library could not load. Check your internet connection and reload the page.");
    if (!file || file.size > 15 * 1024 * 1024) throw new Error("Choose an image smaller than 15 MB.");
    const originalDataUrl = await readAsDataUrl(file);
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element); element.onerror = () => reject(new Error("Could not read that image."));
        element.src = url;
      });
      const traceColors = Number($("#trace-colors").value);
      const traceDetail = Number($("#trace-detail").value);
      const traced = traceImageElement(image, traceColors, traceDetail);
      const regions = $("#ignore-white").checked
        ? traced.regions.filter((region) => !isNearWhite(region.fill))
        : traced.regions;
      const crop = measureRegionBounds(regions, traced.width, traced.height);
      if (!crop) throw new Error("No filled image area remains to place inside the hoop.");
      const hoopW = state.hoopW, hoopH = state.hoopH;
      const fit = Math.min((hoopW - .24) / crop.width, (hoopH - .24) / crop.height);
      snapshot();
      const obj = {
        id: uid(), type: "image", name: file.name || "Traced artwork",
        x: hoopW / 2, y: hoopH / 2, width: crop.width * fit, height: crop.height * fit,
        baseW: crop.width, baseH: crop.height, naturalW: traced.width, naturalH: traced.height,
        cropX: crop.x, cropY: crop.y,
        sourceDataUrl: traced.sourceDataUrl, originalDataUrl, traceColors: traced.traceColors, traceDetail,
        regions
      };
      if (!obj.regions.length) throw new Error("Ignoring near-white removed all traced regions. Turn off that option and try again.");
      state.objects.push(obj); state.selectedId = obj.id; state.selectedRegion = null;
      changed();
      message(`Traced ${obj.regions.length} filled regions${traced.monochrome ? " with monochrome tracing" : ` with a palette limit of ${traced.traceColors} colors`}; fitted inside the hoop. The trace summary shows colors actually present.`, "ok");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function buildImagePalette(imageData, count) {
    const data = imageData.data, pixels = data.length / 4;
    const step = Math.max(1, Math.floor(pixels / 20000));
    const samples = [];
    for (let p = 0; p < pixels; p += step) samples.push([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
    const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    // Farthest-point seeding keeps small but distinct colors in the palette.
    const centers = [samples[0].slice()];
    const nearest = samples.map((s) => dist(s, centers[0]));
    while (centers.length < Math.min(count, samples.length)) {
      let best = 0;
      for (let i = 1; i < samples.length; i++) if (nearest[i] > nearest[best]) best = i;
      if (nearest[best] === 0) break;
      centers.push(samples[best].slice());
      for (let i = 0; i < samples.length; i++) nearest[i] = Math.min(nearest[i], dist(samples[i], samples[best]));
    }
    for (let iteration = 0; iteration < 8; iteration++) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (const s of samples) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < centers.length; c++) { const d = dist(s, centers[c]); if (d < bestD) { bestD = d; best = c; } }
        const acc = sums[best]; acc[0] += s[0]; acc[1] += s[1]; acc[2] += s[2]; acc[3]++;
      }
      sums.forEach((acc, c) => { if (acc[3]) centers[c] = [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]]; });
    }
    // Anti-aliased boundaries between two flat colors produce minor clusters lying on the line between
    // them. Dropping those leaves only the real colors, so edges snap cleanly instead of scattering.
    const share = centers.map(() => 0);
    for (const s of samples) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centers.length; c++) { const d = dist(s, centers[c]); if (d < bestD) { bestD = d; best = c; } }
      share[best]++;
    }
    const kept = [];
    centers.map((c, i) => i).sort((a, b) => share[b] - share[a]).forEach((i) => {
      const p = centers[i];
      let blend = share[i] / samples.length < .015 && kept.length >= 2;
      if (blend) {
        blend = false;
        for (let a = 0; a < kept.length && !blend; a++) for (let b = a + 1; b < kept.length && !blend; b++) {
          const A = centers[kept[a]], B = centers[kept[b]], d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
          const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
          if (len2 < 900) continue;
          const t = ((p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1] + (p[2] - A[2]) * d[2]) / len2;
          if (t < .1 || t > .9) continue;
          if (Math.sqrt(dist(p, [A[0] + t * d[0], A[1] + t * d[1], A[2] + t * d[2]])) < 22) blend = true;
        }
      }
      if (!blend) kept.push(i);
    });
    return kept.sort((a, b) => a - b).map((i) => centers[i]).map((c) => ({ r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: 255 }));
  }
  function snapToPalette(imageData, palette) {
    const { width, height, data } = imageData;
    const index = new Uint8Array(width * height);
    const whiteEntry = palette.map((c) => Math.min(c.r, c.g, c.b) >= 220 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 35);
    const white = whiteEntry.indexOf(true);
    const fromWhite = (c) => Math.hypot(255 - c.r, 255 - c.g, 255 - c.b);
    // Anti-aliased edges of a coloured shape are blends of its colour and white. Such palette entries
    // are "tints" of a real thread colour; they are folded back into it (or into the background) by
    // how much of the real colour they contain, instead of becoming separate pale threads.
    const tint = new Map(), roots = [];
    // Colors covering a sizeable area are real fills (e.g. mid-gray), never edge blends.
    const usage = new Float64Array(palette.length), usageStep = Math.max(1, Math.floor(index.length / 40000));
    for (let p = 0, n = 0; p < index.length; p += usageStep, n++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < palette.length; c++) {
        const d = (data[p * 4] - palette[c].r) ** 2 + (data[p * 4 + 1] - palette[c].g) ** 2 + (data[p * 4 + 2] - palette[c].b) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      usage[best]++;
    }
    const usageTotal = usage.reduce((a, b) => a + b, 0) || 1;
    if (white >= 0) {
      const order = palette.map((c, i) => i).filter((i) => !whiteEntry[i]).sort((x, y) => fromWhite(palette[y]) - fromWhite(palette[x]));
      for (const c of order) {
        let best = null;
        if (usage[c] / usageTotal >= .015) { roots.push(c); continue; }
        for (const k of roots) {
          const ar = 255 - palette[k].r, ag = 255 - palette[k].g, ab = 255 - palette[k].b, denom = ar * ar + ag * ag + ab * ab || 1;
          const w = ((255 - palette[c].r) * ar + (255 - palette[c].g) * ag + (255 - palette[c].b) * ab) / denom;
          const err = Math.hypot(255 - w * ar - palette[c].r, 255 - w * ag - palette[c].g, 255 - w * ab - palette[c].b);
          if (w > .1 && w < .6 && err < 16 && (!best || err < best.err)) best = { k, w, err };
        }
        if (best) tint.set(c, best); else roots.push(c);
      }
    }
    const resolve = (c) => {
      const t = tint.get(c);
      return t ? (t.w >= .5 ? t.k : white) : c;
    };
    for (let p = 0; p < index.length; p++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < palette.length; c++) {
        const d = (data[p * 4] - palette[c].r) ** 2 + (data[p * 4 + 1] - palette[c].g) ** 2 + (data[p * 4 + 2] - palette[c].b) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      index[p] = resolve(best);
    }
    // A colour lying between two other palette colours (e.g. gray between black and white) is an
    // anti-aliasing fringe when both of those colours are within a few pixels; otherwise it is a real fill.
    const pairs = palette.map(() => []);
    for (let c = 0; c < palette.length; c++) {
      for (let a = 0; a < palette.length; a++) for (let b = a + 1; b < palette.length; b++) {
        if (a === c || b === c) continue;
        const A = palette[a], B = palette[b], d = [B.r - A.r, B.g - A.g, B.b - A.b];
        const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if (len2 < 900) continue;
        const t = ((palette[c].r - A.r) * d[0] + (palette[c].g - A.g) * d[1] + (palette[c].b - A.b) * d[2]) / len2;
        if (t < .1 || t > .9) continue;
        if (Math.hypot(palette[c].r - A.r - t * d[0], palette[c].g - A.g - t * d[1], palette[c].b - A.b - t * d[2]) < 22) pairs[c].push([a, b, t]);
      }
    }
    if (pairs.some((list) => list.length)) {
      const original = index.slice(), R = 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const c = original[y * width + x], list = pairs[c];
          if (!list.length) continue;
          const present = new Set();
          for (let yy = Math.max(0, y - R); yy <= Math.min(height - 1, y + R); yy++) {
            for (let xx = Math.max(0, x - R); xx <= Math.min(width - 1, x + R); xx++) present.add(original[yy * width + xx]);
          }
          for (const [a, b, t] of list) {
            if (present.has(a) && present.has(b)) { index[y * width + x] = t < .5 ? a : b; break; }
          }
        }
      }
    }
    // Majority filter removes one-pixel slivers left by anti-aliased edges.
    const smoothed = index.slice();
    const counts = new Uint8Array(palette.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) counts[index[(y + dy) * width + x + dx]]++;
        let best = index[y * width + x];
        for (let c = 0; c < counts.length; c++) if (counts[c] > counts[best]) best = c;
        if (counts[best] >= 5) smoothed[y * width + x] = best;
      }
    }
    // Hairline strokes only a pixel or two wide never reach 50% coverage and would vanish as
    // background. Restore pixels on the centre ridge of such a stroke: clearly more covered than the
    // pixel on one side of them and at least as covered as the other. Edges of large shapes have solid
    // colour behind them, so they are not ridges and keep their smooth outline.
    if (white >= 0 && roots.length) {
      const cover = new Float32Array(width * height), owner = new Int16Array(width * height).fill(-1);
      for (let p = 0; p < cover.length; p++) {
        if (smoothed[p] !== white) { cover[p] = 1; continue; }
        const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
        if (Math.min(r, g, b) >= 238) continue;
        let bestErr = Infinity;
        for (const c of roots) {
          const ar = 255 - palette[c].r, ag = 255 - palette[c].g, ab = 255 - palette[c].b, denom = ar * ar + ag * ag + ab * ab || 1;
          const w = Math.max(0, Math.min(1, ((255 - r) * ar + (255 - g) * ag + (255 - b) * ab) / denom));
          const err = Math.hypot(255 - w * ar - r, 255 - w * ag - g, 255 - w * ab - b);
          if (err < bestErr - 1e-6) { bestErr = err; cover[p] = w; owner[p] = c; }
        }
        if (bestErr > 30) { cover[p] = 0; owner[p] = -1; }
      }
      const rescued = [];
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const p = y * width + x;
          if (owner[p] < 0 || cover[p] < .25 || cover[p] >= .5) continue;
          const l = cover[p - 1], r2 = cover[p + 1], u = cover[p - width], d = cover[p + width], w = cover[p];
          const horizontal = w >= Math.max(l, r2) && w > Math.min(l, r2) + .1;
          const vertical = w >= Math.max(u, d) && w > Math.min(u, d) + .1;
          if (horizontal || vertical) rescued.push(p);
        }
      }
      for (const p of rescued) smoothed[p] = owner[p];
    }
    for (let p = 0; p < smoothed.length; p++) {
      const color = palette[smoothed[p]];
      data[p * 4] = color.r; data[p * 4 + 1] = color.g; data[p * 4 + 2] = color.b; data[p * 4 + 3] = 255;
    }
  }
  // Merges thin strips of one colour that are sandwiched between two other non-white colours into
  // the nearer neighbour. These strips are anti-aliasing leftovers that show up as slivers once other
  // colours are hidden. Strips against white are kept so hairline strokes survive.
  function removeThinSlivers(imageData, palette, maxThickness) {
    if (maxThickness < 1) return;
    const { width, height, data } = imageData;
    const keyOf = new Map(palette.map((c, i) => [(c.r << 16) | (c.g << 8) | c.b, i]));
    const index = new Int16Array(width * height);
    for (let p = 0; p < index.length; p++) index[p] = keyOf.get((data[p * 4] << 16) | (data[p * 4 + 1] << 8) | data[p * 4 + 2]) ?? -1;
    const isWhite = (c) => c < 0 || (palette[c].r >= 238 && palette[c].g >= 238 && palette[c].b >= 238);
    const dist = (a, b) => (palette[a].r - palette[b].r) ** 2 + (palette[a].g - palette[b].g) ** 2 + (palette[a].b - palette[b].b) ** 2;
    const sweep = (count, lines, at) => {
      for (let line = 0; line < lines; line++) {
        let start = 0;
        while (start < count) {
          const c = index[at(line, start)];
          let end = start;
          while (end + 1 < count && index[at(line, end + 1)] === c) end++;
          const before = start > 0 ? index[at(line, start - 1)] : -1;
          const after = end + 1 < count ? index[at(line, end + 1)] : -1;
          // A strip with white on both sides is a real hairline; a strip against any other colour is a fringe.
          if (c >= 0 && end - start + 1 <= maxThickness && before >= 0 && after >= 0 && before !== after &&
              !isWhite(c) && !(isWhite(before) && isWhite(after))) {
            const target = dist(c, before) <= dist(c, after) ? before : after;
            for (let i = start; i <= end; i++) index[at(line, i)] = target;
          }
          start = end + 1;
        }
      }
    };
    sweep(width, height, (line, i) => line * width + i);
    sweep(height, width, (line, i) => i * width + line);
    for (let p = 0; p < index.length; p++) {
      if (index[p] < 0) continue;
      const color = palette[index[p]];
      data[p * 4] = color.r; data[p * 4 + 1] = color.g; data[p * 4 + 2] = color.b;
    }
  }
  // Merges specks and thin slivers into the neighbouring color they touch most, so they do not turn
  // into holes (the tracer drops tiny shapes) or stray lines of an in-between color. Returns each
  // color's pixel count, used to stack colors: biggest at the bottom, details on top.
  function mergeSpecks(imageData, traceScale, quality, mergeThin = true) {
    const { width: w, height: h, data } = imageData, n = w * h;
    const keyAt = (p) => (data[p * 4] << 16) | (data[p * 4 + 1] << 8) | data[p * 4 + 2];
    const index = new Int32Array(n), keys = [], keyIndex = new Map();
    for (let p = 0; p < n; p++) {
      const k = keyAt(p);
      let i = keyIndex.get(k);
      if (i === undefined) { i = keys.length; keys.push(k); keyIndex.set(k, i); }
      index[p] = i;
    }
    const total = new Float64Array(keys.length);
    for (let p = 0; p < n; p++) total[index[p]]++;
    const minArea = Math.max(4, traceScale * traceScale * (2 + 10 * (1 - quality)));
    const thin = .9 * traceScale;
    const seen = new Uint8Array(n), stack = new Int32Array(n), members = new Int32Array(n);
    const touchCount = new Float64Array(keys.length);
    for (let start = 0; start < n; start++) {
      if (seen[start]) continue;
      const c = index[start];
      let top = 0, area = 0, edges = 0;
      const touched = [];
      seen[start] = 1; stack[top++] = start;
      while (top) {
        const p = stack[--top], x = p % w;
        members[area++] = p;
        for (let k = 0; k < 4; k++) {
          const q = k === 0 ? (x > 0 ? p - 1 : -1) : k === 1 ? (x < w - 1 ? p + 1 : -1) : k === 2 ? (p >= w ? p - w : -1) : (p < n - w ? p + w : -1);
          if (q < 0) { edges++; continue; }
          const qc = index[q];
          if (qc === c) { if (!seen[q]) { seen[q] = 1; stack[top++] = q; } }
          else { edges++; if (!touchCount[qc]) touched.push(qc); touchCount[qc]++; }
        }
      }
      let target = -1, best = 0;
      for (const t of touched) { if (touchCount[t] > best) { best = touchCount[t]; target = t; } touchCount[t] = 0; }
      if (target < 0) continue;
      const minorColor = total[c] / n < .02;
      const isThin = area / Math.max(1, edges) < thin;
      if (area < minArea || (mergeThin && minorColor && isThin)) {
        const k = keys[target];
        for (let m = 0; m < area; m++) {
          const p = members[m];
          index[p] = target;
          data[p * 4] = k >> 16 & 255; data[p * 4 + 1] = k >> 8 & 255; data[p * 4 + 2] = k & 255;
        }
        total[c] -= area; total[target] += area;
      }
    }
    const area = new Map();
    keys.forEach((k, i) => { if (total[i] > 0) area.set("#" + k.toString(16).padStart(6, "0"), total[i]); });
    return area;
  }
  // Stacks traced regions by color size: the biggest color at the bottom, small details on top.
  function stackRegionsBySize(regions, area) {
    const rank = (fill) => -(area.get(fill) || 0);
    return regions.map((region, i) => ({ region, i }))
      .sort((a, b) => rank(a.region.fill) - rank(b.region.fill) || a.i - b.i)
      .map(({ region }) => region);
  }
  // ---- Perceptual color tracing ----
  // Colors are compared in CIE Lab (distances match what the eye sees), JPEG noise is smoothed away
  // without blurring edges, and each color area is enlarged smoothly before tracing so edges come out as
  // clean curves rather than pixel staircases.
  const LINEAR = Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  function rgbToLab(r, g, b) {
    const R = LINEAR[r], G = LINEAR[g], B = LINEAR[b];
    const f = (t) => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((R * .4124 + G * .3576 + B * .1805) / .95047), y = f(R * .2126 + G * .7152 + B * .0722), z = f((R * .0193 + G * .1192 + B * .9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  function smartQuantize(sourceCanvas, width, height, colorCount, quality) {
    const n = width * height;
    const rgba = sourceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    // 1. Lab image.
    let L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let p = 0; p < n; p++) { const lab = rgbToLab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]); L[p] = lab[0]; A[p] = lab[1]; B[p] = lab[2]; }
    // 2. Edge-preserving smoothing (bilateral filter, two passes): removes JPEG noise and speckle but keeps
    //    the boundaries between colors sharp.
    const radius = 2, sigmaS = 1.6, sigmaR = 7;
    const spatial = [];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) spatial.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS))]);
    for (let pass = 0; pass < 2; pass++) {
      const L2 = new Float32Array(n), A2 = new Float32Array(n), B2 = new Float32Array(n);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x;
        let sw = 0, sl = 0, sa = 0, sb = 0;
        for (const [dx, dy, ws] of spatial) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const q = yy * width + xx, dl = L[q] - L[p], da = A[q] - A[p], db = B[q] - B[p];
          const wgt = ws * Math.exp(-(dl * dl + da * da + db * db) / (2 * sigmaR * sigmaR));
          sw += wgt; sl += wgt * L[q]; sa += wgt * A[q]; sb += wgt * B[q];
        }
        L2[p] = sl / sw; A2[p] = sa / sw; B2[p] = sb / sw;
      }
      L = L2; A = A2; B = B2;
    }
    // 3. Palette: k-means++ in Lab (deterministic), then merge near-duplicate shades.
    let seed = 1234567;
    const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    const step = Math.max(1, Math.floor(n / 60000)), samples = [];
    for (let p = 0; p < n; p += step) samples.push(p);
    const d2 = (p, c) => (L[p] - c[0]) ** 2 + (A[p] - c[1]) ** 2 + (B[p] - c[2]) ** 2;
    // Start with about twice the requested colors so small but distinct colors (a pink nose, a pale
    // shadow) get a center of their own; similar shades are merged back down afterwards.
    const initial = Math.min(48, Math.max(colorCount + 8, colorCount * 2));
    let centers = [[L[samples[0]], A[samples[0]], B[samples[0]]]];
    const nearest = samples.map((p) => d2(p, centers[0]));
    while (centers.length < initial) {
      let total = 0;
      for (const v of nearest) total += v;
      if (total <= 0) break;
      let pick = random() * total, chosen = 0;
      for (let i = 0; i < samples.length; i++) { pick -= nearest[i]; if (pick <= 0) { chosen = i; break; } }
      const p = samples[chosen], c = [L[p], A[p], B[p]];
      centers.push(c);
      samples.forEach((q, i) => { nearest[i] = Math.min(nearest[i], d2(q, c)); });
    }
    for (let iter = 0; iter < 16; iter++) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (const p of samples) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < centers.length; c++) { const d = d2(p, centers[c]); if (d < bd) { bd = d; best = c; } }
        const s = sums[best]; s[0] += L[p]; s[1] += A[p]; s[2] += B[p]; s[3]++;
      }
      centers = sums.filter((s) => s[3]).map((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]]);
    }
    // 4. Label every pixel with its nearest color.
    const k = () => centers.length;
    let label = new Uint8Array(n);
    const assign = () => {
      for (let p = 0; p < n; p++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k(); c++) { const d = d2(p, centers[c]); if (d < bd) { bd = d; best = c; } }
        label[p] = best;
      }
    };
    assign();
    // 5. Drop "blend" colors: anti-aliasing between two real colors forms thin bands of an in-between
    //    shade with almost no solid interior. A real color, however small, has solid areas of its own.
    const between = (c, a, b) => {
      const P = centers[c], Q = centers[a], R = centers[b], d = [R[0] - Q[0], R[1] - Q[1], R[2] - Q[2]];
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (len2 < 100) return null;
      const t = ((P[0] - Q[0]) * d[0] + (P[1] - Q[1]) * d[1] + (P[2] - Q[2]) * d[2]) / len2;
      if (t < .08 || t > .92) return null;
      const off = Math.hypot(P[0] - Q[0] - t * d[0], P[1] - Q[1] - t * d[1], P[2] - Q[2] - t * d[2]);
      return off < 10 ? t : null;
    };
    const count = new Float64Array(k()), interior = new Float64Array(k());
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x, c = label[p];
      count[c]++;
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1 && label[p - 1] === c && label[p + 1] === c && label[p - width] === c && label[p + width] === c) interior[c]++;
    }
    const keep = centers.map((_, c) => {
      if (!count[c]) return false;
      // Anti-aliasing fringes are one or two pixels thick, so almost none of their pixels are interior.
      // Gradient shading bands are thicker and keep their color.
      const solid = interior[c] / count[c], share = count[c] / n;
      if (solid >= .15 || share >= .03) return true;
      for (let a = 0; a < k(); a++) for (let b = a + 1; b < k(); b++) if (a !== c && b !== c && count[a] && count[b] && between(c, a, b) !== null) return false;
      return true; // thin but not an in-between shade: a fine detail line, keep it
    });
    if (keep.some((v) => !v) && keep.some((v) => v)) { centers = centers.filter((_, c) => keep[c]); assign(); }
    // Then merge the most similar pair until no more colors remain than requested (fringes are gone, so
    // they no longer take up slots). After that only practically identical shades (under 3 ΔE) merge; a
    // looser rule would chain the steps of a gradient into one flat color. The cost is mostly how
    // different two colors look, with a slight discount for small areas.
    {
      const weight = new Float64Array(k());
      for (let p = 0; p < n; p++) weight[label[p]]++;
      centers = centers.map((c, i) => [c[0], c[1], c[2], weight[i]]).filter((c) => c[3] > 0);
      const pairCost = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * (.85 + .15 * Math.min(1, Math.min(a[3], b[3]) / (.02 * n)));
      let mergedAny = false;
      for (;;) {
        let bi = -1, bj = -1, best = Infinity, close = false;
        for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
          const a = centers[i], b = centers[j], cost = pairCost(a, b);
          if (cost < best) { best = cost; bi = i; bj = j; close = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 3; }
        }
        if (bi < 0 || (!close && centers.length <= colorCount)) break;
        const a = centers[bi], b = centers[bj], w = a[3] + b[3];
        centers[bi] = [(a[0] * a[3] + b[0] * b[3]) / w, (a[1] * a[3] + b[1] * b[3]) / w, (a[2] * a[3] + b[2] * b[3]) / w, w];
        centers.splice(bj, 1); mergedAny = true;
      }
      if (mergedAny) assign();
    }
    // 6. Pixel-level fringes: a pixel of an in-between color that sits next to both of the colors it lies
    //    between is anti-aliasing; give it to the closer of the two.
    const pairs = centers.map((_, c) => { const list = []; for (let a = 0; a < k(); a++) for (let b = a + 1; b < k(); b++) if (a !== c && b !== c) { const t = between(c, a, b); if (t !== null) list.push([a, b, t]); } return list; });
    if (pairs.some((l) => l.length)) {
      const before = label.slice(), R = 2;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x, list = pairs[before[p]];
        if (!list.length) continue;
        const near = new Set();
        for (let yy = Math.max(0, y - R); yy <= Math.min(height - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(width - 1, x + R); xx++) near.add(before[yy * width + xx]);
        for (const [a, b, t] of list) if (near.has(a) && near.has(b)) { label[p] = t < .5 ? a : b; break; }
      }
    }
    // 7. Remove isolated noise pixels (at most 2 of their own color in the 3×3 around them). Pixels on a
    //    thin line have 3 or more, so mouths, whiskers and outlines survive.
    for (let pass = 0; pass < 2; pass++) {
      const before = label.slice(), votes = new Uint16Array(k());
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const own = before[y * width + x];
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) votes[before[(y + dy) * width + x + dx]]++;
        if (votes[own] > 2) continue;
        let best = own;
        for (let c = 0; c < votes.length; c++) if (votes[c] > votes[best]) best = c;
        if (votes[best] >= 4) label[y * width + x] = best;
      }
    }
    const palette = centers.map((c) => {
      // Lab back to sRGB for the thread color.
      const fy = (c[0] + 16) / 116, fx = fy + c[1] / 500, fz = fy - c[2] / 200;
      const inv = (t) => (t ** 3 > .008856 ? t ** 3 : (t - 16 / 116) / 7.787);
      const X = inv(fx) * .95047, Y = inv(fy), Z = inv(fz) * 1.08883;
      const lin = [X * 3.2406 - Y * 1.5372 - Z * .4986, -X * .9689 + Y * 1.8758 + Z * .0415, X * .0557 - Y * .204 + Z * 1.057];
      const [r, g, b] = lin.map((v) => Math.round(255 * Math.max(0, Math.min(1, v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055))));
      return { r, g, b, a: 255 };
    });
    // 8. Clean specks at the source size, then enlarge each color's area smoothly and let the strongest
    //    one win at every enlarged pixel: edges become smooth curves instead of stair-steps.
    const small = new ImageData(width, height);
    for (let p = 0; p < n; p++) { const c = palette[label[p]]; small.data[p * 4] = c.r; small.data[p * 4 + 1] = c.g; small.data[p * 4 + 2] = c.b; small.data[p * 4 + 3] = 255; }
    mergeSpecks(small, 1, quality, false);
    const keyIndex = new Map(palette.map((c, i) => [(c.r << 16) | (c.g << 8) | c.b, i]));
    for (let p = 0; p < n; p++) label[p] = keyIndex.get((small.data[p * 4] << 16) | (small.data[p * 4 + 1] << 8) | small.data[p * 4 + 2]) ?? label[p];
    const S = Math.max(1, Math.min(6, Math.round(1600 / Math.max(width, height))));
    const W = width * S, H = height * S;
    // Each enlarged pixel takes the color with the most Gaussian-weighted vote from the 4×4 source pixels
    // around it. Boundaries come out as smooth curves; a one-pixel line still wins along its centre.
    const sigma = .5 + .35 * (1 - quality), inv = 1 / (2 * sigma * sigma);
    const winner = new Uint8Array(W * H), votes = new Float32Array(palette.length), touched = [];
    const weights = new Float32Array(S * 4), cols = new Int32Array(S * 4);
    for (let X = 0; X < W; X++) {
      const u = (X + .5) / S - .5, i0 = Math.floor(u) - 1;
      for (let a = 0; a < 4; a++) { cols[X % S * 4 + a] = Math.max(0, Math.min(width - 1, i0 + a)); weights[X % S * 4 + a] = Math.exp(-((i0 + a - u) ** 2) * inv); }
      for (let Y = 0; Y < H; Y++) {
        const v = (Y + .5) / S - .5, j0 = Math.floor(v) - 1;
        for (let b = 0; b < 4; b++) {
          const row = Math.max(0, Math.min(height - 1, j0 + b)) * width, wy = Math.exp(-((j0 + b - v) ** 2) * inv);
          for (let a = 0; a < 4; a++) {
            const c = label[row + cols[X % S * 4 + a]];
            if (!votes[c]) touched.push(c);
            votes[c] += wy * weights[X % S * 4 + a];
          }
        }
        let best = touched[0], bestVote = -1;
        for (const c of touched) { if (votes[c] > bestVote) { bestVote = votes[c]; best = c; } votes[c] = 0; }
        touched.length = 0;
        winner[Y * W + X] = best;
      }
    }
    const traceData = new ImageData(W, H);
    for (let i = 0; i < winner.length; i++) {
      const c = palette[winner[i]];
      traceData.data[i * 4] = c.r; traceData.data[i * 4 + 1] = c.g; traceData.data[i * 4 + 2] = c.b; traceData.data[i * 4 + 3] = 255;
    }
    return { traceData, palette, traceScale: S };
  }
  function traceImageElement(image, colorCount, detail) {
    const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const traceColors = Math.max(2, Math.min(64, Math.round(colorCount)));
    const quality = Math.max(0, Math.min(1, (detail - 10) / 90));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const sourcePixels = context.getImageData(0, 0, width, height).data;
    let sourceDataUrl = canvas.toDataURL("image/png");
    if (sourceDataUrl.length > 1_200_000) {
      sourceDataUrl = canvas.toDataURL("image/webp", .95);
      if (!sourceDataUrl.startsWith("data:image/webp")) sourceDataUrl = canvas.toDataURL("image/jpeg", .92);
    }
    const imageData = context.getImageData(0, 0, width, height);
    let chromatic = 0, inspected = 0;
    for (let i = 0; i < sourcePixels.length; i += 4) {
      if (sourcePixels[i + 3] < 24) continue;
      const red = sourcePixels[i], green = sourcePixels[i + 1], blue = sourcePixels[i + 2];
      const minimum = Math.min(red, green, blue), maximum = Math.max(red, green, blue);
      if (minimum < 245) {
        inspected++;
        if (maximum - minimum > 28) chromatic++;
      }
    }
    const monochrome = traceColors <= 2 && inspected > 0 && chromatic < Math.max(24, inspected * .0005);
    let effectiveColors = traceColors;
    if (monochrome) {
      const histogram = new Uint32Array(256);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const red = imageData.data[i], green = imageData.data[i + 1], blue = imageData.data[i + 2];
        histogram[Math.round(.299 * red + .587 * green + .114 * blue)]++;
      }
      const total = imageData.data.length / 4;
      let sum = 0;
      for (let level = 0; level < 256; level++) sum += level * histogram[level];
      let backgroundWeight = 0, backgroundSum = 0, threshold = 127, bestVariance = -1;
      for (let level = 0; level < 255; level++) {
        backgroundWeight += histogram[level];
        if (!backgroundWeight) continue;
        const foregroundWeight = total - backgroundWeight;
        if (!foregroundWeight) break;
        backgroundSum += level * histogram[level];
        const meanBackground = backgroundSum / backgroundWeight;
        const meanForeground = (sum - backgroundSum) / foregroundWeight;
        const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
        if (variance > bestVariance) { bestVariance = variance; threshold = level; }
      }
      threshold = Math.max(80, Math.min(235, threshold));
      for (let i = 0; i < imageData.data.length; i += 4) {
        const luminance = .299 * imageData.data[i] + .587 * imageData.data[i + 1] + .114 * imageData.data[i + 2];
        const value = luminance <= threshold ? 0 : 255;
        imageData.data[i] = value; imageData.data[i + 1] = value; imageData.data[i + 2] = value;
      }
      effectiveColors = 2;
    }
    let palette = null, traceData = imageData, traceScale = 1, paletteSource = null;
    if (!monochrome && !window.__classicTrace) {
      ({ traceData, palette, traceScale } = smartQuantize(canvas, width, height, effectiveColors, quality));
    } else if (!monochrome) {
      // Small sources are enlarged with smooth interpolation so snapped colour edges follow a smooth curve.
      const longSide = Math.max(image.naturalWidth, image.naturalHeight) * scale;
      traceScale = longSide <= 900 ? Math.max(2, Math.min(4, Math.round(1200 / longSide))) : 1;
      if (traceScale > 1) {
        const big = document.createElement("canvas");
        big.width = width * traceScale; big.height = height * traceScale;
        const bigContext = big.getContext("2d", { willReadFrequently: true });
        bigContext.imageSmoothingEnabled = true; bigContext.imageSmoothingQuality = "high";
        bigContext.fillStyle = "#ffffff"; bigContext.fillRect(0, 0, big.width, big.height);
        bigContext.drawImage(canvas, 0, 0, big.width, big.height);
        paletteSource = bigContext.getImageData(0, 0, big.width, big.height);
        // Pixel-art style edges are rounded by blurring before the colours are snapped.
        if (traceScale >= 3 && "filter" in bigContext) {
          bigContext.filter = `blur(${(traceScale * .7).toFixed(1)}px)`;
          bigContext.fillRect(0, 0, big.width, big.height);
          bigContext.drawImage(canvas, 0, 0, big.width, big.height);
          bigContext.filter = "none";
        }
        traceData = bigContext.getImageData(0, 0, big.width, big.height);
      }
      palette = buildImagePalette(paletteSource || traceData, effectiveColors);
      snapToPalette(traceData, palette);
      removeThinSlivers(traceData, palette, Math.round(traceScale * (1 - quality) * 2.5));
    }
    const colorArea = mergeSpecks(traceData, traceScale, quality, Boolean(window.__classicTrace));
    const svgText = ImageTracer.imagedataToSVG(traceData, {
      numberofcolors: effectiveColors, colorsampling: 0, colorquantcycles: palette ? 1 : 8, layering: 0,
      ...(palette ? { pal: palette } : {}),
      scale: 1 / traceScale,
      ltres: 1.7 - .8 * quality, qtres: 1.7 - .8 * quality,
      // Specks were already merged into their neighbours, so only drop the very tiniest paths (dropping
      // bigger ones would leave holes in the design).
      pathomit: Math.max(2, Math.round((palette ? 3 + 4 * (1 - quality) : 65 - 50 * quality) * traceScale)),
      rightangleenhance: true, viewbox: true
    });
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("The image tracer returned invalid SVG.");
    const regions = [...parsed.querySelectorAll("path[d]")].map((path) => ({
      d: path.getAttribute("d"), fill: safeColor(path.getAttribute("fill") || "#000000")
    })).filter((region) => region.d && region.d.length < 200000);
    if (!regions.length) throw new Error("No editable regions were found. Try a clearer, higher-contrast image.");
    return { width, height, regions: stackRegionsBySize(regions, colorArea), sourceDataUrl, traceColors: effectiveColors, monochrome };
  }
  let liveSnapshotTaken = false;
  async function retraceSelectedImage({ live = false } = {}) {
    const obj = selectedObject();
    if (!obj || obj.type !== "image" || !obj.sourceDataUrl) {
      message("Select an image that has its original artwork available to retrace.", "error");
      return;
    }
    $("#retrace-image").disabled = true;
    message("Retracing image with the selected color count…");
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("Could not load the saved source image for retracing."));
        element.src = obj.originalDataUrl || obj.sourceDataUrl;
      });
      const traceColors = Number($("#trace-colors").value);
      const traceDetail = Number($("#trace-detail").value);
      const traced = traceImageElement(image, traceColors, traceDetail);
      const whiteRemoved = (obj.regions || []).some((region) => region.fill === "none");
      const regions = $("#ignore-white").checked || whiteRemoved
        ? traced.regions.filter((region) => !isNearWhite(region.fill))
        : traced.regions;
      if (!regions.length) throw new Error("Ignoring near-white removed every region. Turn the option off and retrace.");
      if (!live || !liveSnapshotTaken) snapshot();
      if (live) liveSnapshotTaken = true;
      const previousBaseW = obj.baseW, previousBaseH = obj.baseH;
      obj.regions = regions;
      obj.naturalW = traced.width; obj.naturalH = traced.height;
      obj.baseW = previousBaseW; obj.baseH = previousBaseH;
      obj.sourceDataUrl = traced.sourceDataUrl;
      obj.erasures = [];
      obj.traceColors = traced.traceColors; obj.traceDetail = traceDetail;
      refreshImageCrop(obj);
      changed();
      message(`Retraced image into ${regions.length} filled regions${traced.monochrome ? " with monochrome tracing" : ` with a palette limit of ${traced.traceColors} colors`} at ${traceDetail}% cleanup.`, "ok");
    } catch (error) {
      console.error(error);
      message(error.message || "Could not retrace the selected image.", "error");
    } finally {
      $("#retrace-image").disabled = !selectedObject()?.sourceDataUrl;
    }
  }
  async function addText(at = null) {
    await fontsReady;
    const text = $("#text-entry").value.trim() && selectedObject()?.type !== "text" ? $("#text-entry").value.trim() : "Text";
    snapshot();
    const font = $("#font").value || "Archivo Black";
    const obj = {
      id: uid(), type: "text", name: text, text, font, sizeIn: Math.max(.1, Math.min(4, Number($("#text-size").value) || .6)),
      curve: 0, spacing: 0, x: at ? at.x : state.hoopW / 2, y: at ? at.y : state.hoopH / 2, fill: state.color
    };
    await document.fonts.load(`40px "${font}"`).catch(() => {});
    layoutText(obj);
    const fit = Math.min(1, (state.hoopW - .3) / obj.baseW, (state.hoopH - .3) / obj.baseH);
    if (fit < 1) { obj.sizeIn *= fit; obj.baseW = obj.baseH = 0; layoutText(obj); }
    state.objects.push(obj); state.selectedId = obj.id; state.selectedRegion = null;
    showTab("object");
    changed();
    $("#text-entry").value = text;
    $("#text-entry").focus(); $("#text-entry").select();
    message(`Added “${text}” as editable text.`, "ok");
  }
  async function updateText(mutate) {
    const obj = selectedObject();
    if (!obj || obj.type !== "text") return;
    mutate(obj);
    obj.name = obj.text;
    await document.fonts.load(`40px "${obj.font}"`).catch(() => {});
    layoutText(obj);
    changed();
  }
  function deleteSelected() {
    if (!state.selectedId) return;
    snapshot(); state.objects = state.objects.filter((obj) => obj.id !== state.selectedId);
    state.selectedId = null; state.selectedRegion = null; changed();
  }
  function clearCanvas() {
    if (!state.objects.length) {
      message("The canvas is already clear.", "info");
      return;
    }
    if (!window.confirm("Clear all artwork layers from the canvas?")) return;
    snapshot();
    state.objects = [];
    state.selectedId = null; state.selectedRegion = null;
    state.selectedPaletteColors.clear();
    state.stitches = []; state.stitchColors = []; state.stale = true;
    invalidateStitches();
    message("Canvas cleared for this session.", "ok");
  }
  function moveLayer(id, direction) {
    const index = state.objects.findIndex((obj) => obj.id === id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= state.objects.length) return;
    snapshot();
    [state.objects[index], state.objects[targetIndex]] = [state.objects[targetIndex], state.objects[index]];
    changed();
  }
  // Colors of an image from bottom to top, ordered by each color's topmost region.
  function imageColorOrder(obj) {
    const last = new Map();
    obj.regions.forEach((region, index) => { if (region.fill !== "none") last.set(region.fill, index); });
    return [...last.entries()].sort((a, b) => a[1] - b[1]).map(([color]) => color);
  }
  // Color order is shown inside the Layers list.
  function renderColorOrder() {}
  function moveImageColor(color, direction, obj = selectedObject()) {
    if (!obj || obj.type !== "image") return;
    const order = imageColorOrder(obj), index = order.indexOf(color), target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    snapshot();
    [order[index], order[target]] = [order[target], order[index]];
    const rank = new Map(order.map((fill, position) => [fill, position]));
    obj.regions = obj.regions.map((region, position) => ({ region, position }))
      .sort((a, b) => (rank.get(a.region.fill) ?? -1) - (rank.get(b.region.fill) ?? -1) || a.position - b.position)
      .map(({ region }) => region);
    state.selectedRegion = null;
    changed();
  }
  function setHoop(width, height) {
    if (!(Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1 && width <= 14 && height <= 14)) {
      message("Canvas dimensions must each be between 1 and 14 inches.", "error");
      $("#custom-width").value = state.hoopW; $("#custom-height").value = state.hoopH;
      return;
    }
    snapshot();
    state.hoopW = width; state.hoopH = height;
    $("#custom-width").value = width; $("#custom-height").value = height;
    fitView(); invalidateStitches();
  }
  function setNumber(selector, key, min, max) {
    const obj = selectedObject(), value = Number($(selector).value);
    if (!obj || !Number.isFinite(value) || value < min || value > max) return;
    obj[key] = value;
    if (key === "width" && $("#keep-ratio").checked) obj.height = value * obj.baseH / obj.baseW;
    if (key === "height" && $("#keep-ratio").checked) obj.width = value * obj.baseW / obj.baseH;
    changed();
  }
  function combineColors() {
    const selected = new Set(state.selectedPaletteColors);
    if (!selected.size) { message("Check at least one thread color to combine.", "error"); return; }
    const result = $("#merge-color").value;
    snapshot();
    const inheritedSettings = [...selected].map((color) => state.gapFillSettings.get(color)).find(Boolean);
    if (!state.gapFillSettings.has(result) && inheritedSettings) state.gapFillSettings.set(result, { ...inheritedSettings });
    const allSelectedHidden = [...selected].every((color) => state.hiddenColors.has(color));
    selected.forEach((color) => state.hiddenColors.delete(color));
    if (allSelectedHidden) state.hiddenColors.add(result);
    selected.forEach((color) => state.gapFillSettings.delete(color));
    for (const obj of state.objects) {
      if (obj.type === "image") obj.regions.forEach((region) => { if (selected.has(region.fill)) region.fill = result; });
      else if (selected.has(obj.fill)) obj.fill = result;
    }
    state.selectedPaletteColors.clear();
    changed(); message(`Combined ${selected.size} thread color(s) into ${result}.`, "ok");
  }
  function removeSelectedColors() {
    const selected = new Set(state.selectedPaletteColors);
    if (!selected.size) { message("Check at least one thread color to remove.", "error"); return; }
    snapshot();
    for (const obj of state.objects) {
      if (obj.type === "image") {
        obj.regions.forEach((region) => { if (selected.has(region.fill)) region.fill = "none"; });
        refreshImageCrop(obj);
      }
      else if (selected.has(obj.fill)) obj.fill = "none";
    }
    state.selectedPaletteColors.clear(); changed();
    message(`Removed ${selected.size} selected fill color(s) from the stitch plan.`, "ok");
  }
  // Shows the system "Save as" dialog where supported. Returns null when unsupported (falls back to a normal download).
  async function pickSaveHandle(suggestedName, description, mime, extension) {
    if (!window.showSaveFilePicker) return null;
    try {
      // The `id` makes the Save dialog reopen in the folder used last time for this kind of file.
      return await window.showSaveFilePicker({ id: extension === ".json" ? "shifty-projects" : "shifty-stitch-files", startIn: "documents", suggestedName, types: [{ description, accept: { [mime]: [extension] } }] });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      return null;
    }
  }
  async function saveBlob(blob, name, handle) {
    if (!handle) { download(blob, name); return name; }
    const writable = await handle.createWritable();
    await writable.write(blob); await writable.close();
    return handle.name;
  }
  async function exportProject() {
    let handle;
    const fileName = `${designName()}.json`;
    try { handle = await pickSaveHandle(fileName, "Shifty Stitch project", "application/json", ".json"); }
    catch (error) { return; }
    const blob = new Blob([JSON.stringify({
      version: 1, app: "shifty-stitch-2", name: $("#file-name").value.trim(), hoopW: state.hoopW, hoopH: state.hoopH, objects: state.objects,
      edgeAdjustments: Object.fromEntries(state.gapFillSettings), edgeColor: state.edgeColor, settings: getSettings()
    })], { type: "application/json" });
    try {
      const saved = await saveBlob(blob, fileName, handle);
      message(`Project saved as ${saved}.`, "ok");
    } catch (error) {
      message(`Could not save the project: ${error.message || error}`, "error");
    }
  }
  const SETTING_IDS = ["default-fill", "spacing", "angle", "stitch-length", "underlay", "pull-comp", "pattern-size", "outline-mode", "outline-width", "outline-gap", "outline-color", "outline-color2", "outline-target", "lock-stitches", "output-orientation", "export-format",
    "border-on", "border-shape", "border-style", "border-width", "border-gap", "border-color", "border-edge", "baste-on", "knockdown-on", "knockdown-color", "trim-over", "min-stitch"];
  function getSettings() {
    return Object.fromEntries(SETTING_IDS.map((id) => { const el = $("#" + id); return [id, el.type === "checkbox" ? el.checked : el.value]; }));
  }
  function applySettings(settings) {
    for (const id of SETTING_IDS) {
      const el = $("#" + id);
      if (!(id in settings)) continue;
      if (el.type === "checkbox") el.checked = !!settings[id]; else el.value = String(settings[id]);
    }
    $("#outline-fields").hidden = $("#outline-mode").value === "off";
    $("#border-fields").classList.toggle("off", !$("#border-on").checked);
  }
  function designName() {
    return ($("#file-name").value.replace(/\.(pes|dst|json)$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().replace(/[. ]+$/, "")) || "Embroidery design";
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function openProject(file) {
    const data = JSON.parse(await file.text());
    if (data.version !== 1 || !Array.isArray(data.objects)) throw new Error("Unsupported project file.");
    for (const obj of data.objects) {
      if (!obj.id || !["image", "text", "shape", "draw"].includes(obj.type)) throw new Error("Project includes an invalid object.");
      if (obj.type === "image" && (!Array.isArray(obj.regions) || obj.regions.some((r) => typeof r.d !== "string"))) throw new Error("Project includes invalid vector data.");
    }
    snapshot(); editingEdgeSettings = false; state.objects = data.objects; state.hoopW = Number(data.hoopW) || 7; state.hoopH = Number(data.hoopH) || 5;
    state.gapFillSettings = new Map(Object.entries(data.edgeAdjustments || {}));
    state.edgeColor = typeof data.edgeColor === "string" ? data.edgeColor : null;
    for (const obj of state.objects) {
      if (obj.type !== "image") continue;
      obj.naturalW = Number(obj.naturalW || obj.baseW);
      obj.naturalH = Number(obj.naturalH || obj.baseH);
      obj.cropX = Number(obj.cropX) || 0; obj.cropY = Number(obj.cropY) || 0;
      refreshImageCrop(obj);
    }
    state.selectedId = null; state.selectedRegion = null;
    for (const obj of state.objects) {
      const suffix = Number(/(\d+)$/.exec(obj.id)?.[1]);
      if (Number.isFinite(suffix)) idCounter = Math.max(idCounter, suffix + 1);
    }
    const hoopOption = Object.entries(hoopSizes).find(([, size]) => size[0] === state.hoopW && size[1] === state.hoopH);
    $("#hoop").value = hoopOption ? hoopOption[0] : "custom"; $("#custom-row").hidden = Boolean(hoopOption);
    $("#custom-width").value = state.hoopW; $("#custom-height").value = state.hoopH;
    if (data.settings) applySettings(data.settings);
    if (typeof data.name === "string") $("#file-name").value = data.name;
    await fontsReady;
    for (const obj of state.objects) {
      if (obj.type !== "text") continue;
      await document.fonts.load(`40px "${obj.font || "Arial"}"`).catch(() => {});
      // Older projects measured text roughly; re-measure while keeping the letter scale the user chose.
      layoutText(obj);
    }
    fitView(); changed();
  }

  const regionBoxCache = new WeakMap();
  // Bounding box of a region's path in image coordinates, or null when it cannot be bounded safely.
  function regionBox(region) {
    if (regionBoxCache.has(region) && regionBoxCache.get(region).d === region.d) return regionBoxCache.get(region).box;
    let box = null;
    if (!/[^MLQCZ0-9eE.,+\s-]/.test(region.d)) {
      const numbers = region.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
      const pad = (Number(region.brushWidth) || 0) / 2 + .01;
      if (numbers.length >= 2) {
        box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
        for (let i = 0; i + 1 < numbers.length; i += 2) {
          const x = Number(numbers[i]), y = Number(numbers[i + 1]);
          box.x1 = Math.min(box.x1, x - pad); box.x2 = Math.max(box.x2, x + pad);
          box.y1 = Math.min(box.y1, y - pad); box.y2 = Math.max(box.y2, y + pad);
        }
      }
    }
    regionBoxCache.set(region, { d: region.d, box });
    return box;
  }
  // Traced regions never overlap each other, so only drawn strokes/shapes (which carry `gen`) can overlap anything.
  function regionCoverMask(obj, index, group) {
    const region = obj.regions[index], lowerIsOverlay = region.gen !== undefined, box = regionBox(region);
    const above = [];
    for (let j = index + 1; j < obj.regions.length; j++) {
      const other = obj.regions[j];
      if (other.fill === "none" || (!lowerIsOverlay && other.gen === undefined)) continue;
      const otherBox = regionBox(other);
      if (box && otherBox && (otherBox.x2 < box.x1 || otherBox.x1 > box.x2 || otherBox.y2 < box.y1 || otherBox.y1 > box.y2)) continue;
      above.push(other);
    }
    if (!above.length) return null;
    const id = `stitch-${obj.id}-region-cover-${index}`;
    const w = Number(obj.naturalW) || obj.baseW, h = Number(obj.naturalH) || obj.baseH;
    const mask = node("mask", {
      id, x: -w, y: -h, width: w * 3, height: h * 3,
      maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", "mask-type": "luminance"
    });
    mask.appendChild(node("rect", { x: -w, y: -h, width: w * 3, height: h * 3, fill: "white" }));
    for (const other of above) {
      const brushWidth = Number(other.brushWidth) || 0;
      mask.appendChild(node("path", {
        d: other.d, fill: brushWidth && !other.filled ? "none" : "#000",
        stroke: brushWidth ? "#000" : "none", "stroke-width": brushWidth,
        "stroke-linecap": "round", "stroke-linejoin": "round"
      }));
    }
    const defs = node("defs"); defs.appendChild(mask); group.appendChild(defs);
    return `url(#${id})`;
  }
  function colorSceneSvg(color, angle, ppu, above = false) {
    const w = Math.ceil(state.hoopW * 25.4 * ppu), h = Math.ceil(state.hoopH * 25.4 * ppu);
    const root = node("svg", { xmlns: NS, width: w, height: h, viewBox: `0 0 ${state.hoopW} ${state.hoopH}` });
    const gRoot = node("g"), defs = node("defs");
    // Draws one object's shapes whose fill satisfies `match`, painted in `paint`.
    const buildGroup = (obj, match, paint, prefix) => {
      const group = node("g", { transform: transformFor(obj) });
      // Stitched lines are sewn on top of fills, so they neither fill nor cover anything.
      if (isLineObject(obj)) return group;
      const mask = obj.type === "image" ? null : appendObjectMask(group, obj, prefix);
      const content = node("g", { mask });
      const colorPath = (d, fill, parent = content, brushWidth = 0, filled = false, cover = null) => {
        if (!match(fill)) return;
        parent.appendChild(node("path", {
          d, fill: brushWidth && !filled ? "none" : paint,
          stroke: brushWidth ? paint : "none",
          "stroke-width": brushWidth,
          "stroke-linecap": "round", "stroke-linejoin": "round",
          mask: cover
        }));
      };
      if (obj.type === "image") {
        const imageContent = node("g", {
          transform: `translate(${-Number(obj.cropX || 0)} ${-Number(obj.cropY || 0)})`
        });
        obj.regions.forEach((region, index) => {
          if (!match(region.fill)) return;
          // Higher regions in the same image cover this one, so their overlap is only stitched once.
          const cover = prefix === "stitch" ? regionCoverMask(obj, index, group) : null;
          colorPath(region.d, region.fill, regionHost(imageContent, group, obj, prefix, region), Number(region.brushWidth) || 0, region.filled, cover);
        });
        group.appendChild(imageContent);
      } else if (obj.type === "text") {
        if (match(obj.fill)) {
          content.appendChild(textNodes(obj, { fill: paint }, prefix));
          group.appendChild(content);
        }
      } else {
        colorPath(obj.d, obj.fill, content, obj.type === "draw" ? Number(obj.brushWidth) || 0 : 0, obj.filled);
        group.appendChild(content);
      }
      return group;
    };
    if (above) {
      // Everything that sits above `color`: higher colors in the same picture and all higher layers.
      // A stroke on `color` may grow under nothing of this (it would show on top of it otherwise).
      const first = state.objects.findIndex((obj) => !isLineObject(obj) && (obj.type === "image" ? obj.regions.some((r) => r.fill === color) : obj.fill === color));
      state.objects.forEach((obj, index) => {
        if (first < 0 || index < first) return;
        let match;
        if (index === first) {
          if (obj.type !== "image") return;
          const order = imageColorOrder(obj), higher = new Set(order.slice(order.indexOf(color) + 1));
          match = (fill) => higher.has(fill);
        } else match = (fill) => Boolean(fill) && fill !== "none" && fill !== color;
        const group = buildGroup(obj, match, "#000", "above");
        if (group.childNodes.length) gRoot.appendChild(group);
      });
      const aboveFonts = new Set(state.objects.filter((obj) => obj.type === "text").map((obj) => obj.font));
      if (aboveFonts.size) { const style = node("style"); style.textContent = fontFaceCss(aboveFonts); defs.appendChild(style); }
      root.appendChild(defs); root.appendChild(gRoot);
      return { svg: new XMLSerializer().serializeToString(root), width: w, height: h };
    }
    state.objects.forEach((obj, index) => {
      const group = buildGroup(obj, (fill) => fill === color, color, "stitch");
      if (!group.childNodes.length) return;
      // Anything in a higher layer covers this object, so it is not stitched underneath it.
      const above = state.objects.slice(index + 1)
        .map((other) => buildGroup(other, (fill) => Boolean(fill) && fill !== "none", "#000", "cover"))
        .filter((g) => g.childNodes.length);
      if (!above.length) { gRoot.appendChild(group); return; }
      const mask = node("mask", {
        id: `cover-${index}`, x: -50, y: -50, width: state.hoopW + 100, height: state.hoopH + 100,
        maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", "mask-type": "luminance"
      });
      mask.appendChild(node("rect", { x: -50, y: -50, width: state.hoopW + 100, height: state.hoopH + 100, fill: "white" }));
      above.forEach((g) => mask.appendChild(g));
      defs.appendChild(mask);
      const wrapper = node("g", { mask: `url(#cover-${index})` });
      wrapper.appendChild(group); gRoot.appendChild(wrapper);
    });
    const fonts = new Set(state.objects.filter((obj) => obj.type === "text").map((obj) => obj.font));
    if (fonts.size) {
      const style = node("style");
      style.textContent = fontFaceCss(fonts);
      defs.appendChild(style);
    }
    root.appendChild(defs); root.appendChild(gRoot);
    return { svg: new XMLSerializer().serializeToString(root), width: w, height: h };
  }
  function loadSvgImage(text) {
    const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" }), url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not rasterize the vector stitch regions.")); };
      image.src = url;
    });
  }
  // Square dilation of a 0/1 mask by r pixels (two separable distance sweeps).
  function dilateMask(mask, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0, last = -1e9; x < w; x++) { if (mask[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
      for (let x = w - 1, last = 1e9; x >= 0; x--) { if (mask[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0, last = -1e9; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
      for (let y = h - 1, last = 1e9; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
    }
    return out;
  }
  // Outside stroke: grows a color outward, toward anything it does not enclose.
  // Inside stroke: grows it into the areas it encloses (its holes), like a stroke drawn on the inner edge.
  function strokeColorMask(canvas, outsidePx, insidePx, forbid = null) {
    if (outsidePx <= 0 && insidePx <= 0) return;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    const image = context.getImageData(0, 0, w, h), data = image.data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 80 ? 1 : 0;
    // Empty pixels reachable from the canvas border are outside the color; the rest are its holes.
    const outside = new Uint8Array(w * h), stack = new Int32Array(w * h);
    let top = 0;
    const seed = (i) => { if (!outside[i] && !mask[i]) { outside[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (top) {
      const i = stack[--top], x = i % w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (i >= w) seed(i - w);
      if (i < w * (h - 1)) seed(i + w);
    }
    const out = outsidePx > 0 ? dilateMask(mask, w, h, Math.ceil(outsidePx)) : null;
    const inn = insidePx > 0 ? (Math.ceil(insidePx) === Math.ceil(outsidePx) ? out : dilateMask(mask, w, h, Math.ceil(insidePx))) : null;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) continue;
      if (forbid && forbid[i]) continue; // never grow under a color that sits above this one
      if ((out && outside[i] && out[i]) || (inn && !outside[i] && inn[i])) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = 255; }
    }
    context.putImageData(image, 0, 0);
  }
  function expandColorMask(canvas, radiusPx) {
    if (radiusPx <= 0) return;
    const context = canvas.getContext("2d");
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { width, height, data } = imageData;
    const radius = Math.ceil(radiusPx);
    const source = new Uint8Array(width * height);
    const horizontal = new Uint8Array(width * height);
    for (let pixel = 0; pixel < source.length; pixel++) source[pixel] = data[pixel * 4 + 3];
    const maxFilterLine = (input, output, length, stride, base) => {
      const counts = new Uint32Array(256);
      let maximum = 0;
      for (let position = 0; position <= Math.min(radius, length - 1); position++) {
        const value = input[base + position * stride];
        counts[value]++; maximum = Math.max(maximum, value);
      }
      for (let position = 0; position < length; position++) {
        output[base + position * stride] = maximum;
        // Window for the next position is [position + 1 - radius, position + 1 + radius].
        const leaving = position - radius;
        const entering = position + radius + 1;
        if (leaving >= 0) {
          const value = input[base + leaving * stride];
          if (--counts[value] === 0 && value === maximum) {
            while (maximum > 0 && counts[maximum] === 0) maximum--;
          }
        }
        if (entering < length) {
          const value = input[base + entering * stride];
          counts[value]++;
          maximum = Math.max(maximum, value);
        }
      }
    };
    for (let y = 0; y < height; y++) maxFilterLine(source, horizontal, width, 1, y * width);
    for (let x = 0; x < width; x++) maxFilterLine(horizontal, source, height, width, x);
    for (let pixel = 0; pixel < source.length; pixel++) {
      data[pixel * 4 + 3] = source[pixel];
      if (source[pixel] && data[pixel * 4 + 3]) {
        data[pixel * 4] = 255; data[pixel * 4 + 1] = 255; data[pixel * 4 + 2] = 255;
      }
    }
    context.putImageData(imageData, 0, 0);
  }
  function smoothColorMask(canvas, radiusPx) {
    if (radiusPx <= 0) return;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const source = document.createElement("canvas");
    source.width = canvas.width; source.height = canvas.height;
    source.getContext("2d").drawImage(canvas, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.filter = `blur(${radiusPx}px)`;
    context.drawImage(source, 0, 0);
    context.filter = "none";
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < imageData.data.length; index += 4) {
      imageData.data[index] = imageData.data[index] > 127 ? 255 : 0;
    }
    context.putImageData(imageData, 0, 0);
  }
  const mmToIn = (p) => ({ x: p.x / 25.4, y: p.y / 25.4 });
  // Rasterizes the visible area of one or more colors into a square canvas rotated by `angle`.
  // Returns a 0/1 mask and a mapping from canvas pixels back to hoop inches.
  async function rasterColors(colorList, angle, ppu, gapFillMm = 0, smoothMm = 0, insideMm = 0) {
    const w = Math.ceil(state.hoopW * 25.4 * ppu), h = Math.ceil(state.hoopH * 25.4 * ppu);
    const side = Math.ceil(Math.hypot(w, h));
    const canvas = document.createElement("canvas"); canvas.width = side; canvas.height = side;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.translate(side / 2, side / 2); context.rotate(angle * Math.PI / 180);
    for (const color of colorList) {
      const scene = colorSceneSvg(color, angle, ppu);
      const image = await loadSvgImage(scene.svg);
      context.drawImage(image, -scene.width / 2, -scene.height / 2, scene.width, scene.height);
    }
    smoothColorMask(canvas, smoothMm * ppu);
    // Stroke sliders are stroke widths, so each side grows by half the value (as before).
    let forbid = null;
    if ((gapFillMm > 0 || insideMm > 0) && colorList.length === 1) {
      // Everything drawn above this color, rasterized the same way, marks where the stroke may not grow.
      const above = colorSceneSvg(colorList[0], angle, ppu, true);
      const blocker = document.createElement("canvas"); blocker.width = side; blocker.height = side;
      const blockCtx = blocker.getContext("2d", { willReadFrequently: true });
      blockCtx.translate(side / 2, side / 2); blockCtx.rotate(angle * Math.PI / 180);
      const aboveImage = await loadSvgImage(above.svg);
      blockCtx.drawImage(aboveImage, -above.width / 2, -above.height / 2, above.width, above.height);
      const blockPixels = blockCtx.getImageData(0, 0, side, side).data;
      forbid = new Uint8Array(side * side);
      for (let i = 0; i < forbid.length; i++) forbid[i] = blockPixels[i * 4 + 3] > 80 ? 1 : 0;
    }
    strokeColorMask(canvas, gapFillMm * ppu / 2, insideMm * ppu / 2, forbid);
    context.setTransform(1, 0, 0, 1, 0, 0);
    const pixels = context.getImageData(0, 0, side, side).data;
    const alpha = new Uint8Array(side * side);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3] > 80 ? 1 : 0;
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    const toInches = (px, py) => {
      const xr = (px - side / 2) / ppu, yr = (py - side / 2) / ppu;
      return { x: state.hoopW / 2 + (xr * c + yr * s) / 25.4, y: state.hoopH / 2 + (-xr * s + yr * c) / 25.4 };
    };
    return { side, alpha, toInches, ppu };
  }
  // Rows of fill. `cuts(rowIndex, aMm, bMm, lengthMm)` gives needle positions between the run ends (in travel
  // order, measured along the row in mm); `offset(xPx)` bends rows for wave and chevron fills.
  function rowFill(raster, color, spacingMm, cuts, offset = null) {
    const { side, alpha, ppu } = raster, step = spacingMm * ppu, segments = [];
    for (let rowIndex = 0, y = 0; y < side; rowIndex++, y += step) {
      const runs = []; let start = -1;
      for (let x = 0; x <= side; x++) {
        let ink = false;
        if (x < side) {
          const yy = Math.min(side - 1, Math.round(offset ? y + offset(x) : y));
          ink = yy >= 0 && alpha[yy * side + x] === 1;
        }
        if (ink && start < 0) start = x;
        if (!ink && start >= 0) { if (x - start >= 2) runs.push([start, x - 1]); start = -1; }
      }
      if (rowIndex % 2) runs.reverse();
      for (const [x1, x2] of runs) {
        const forward = rowIndex % 2 === 0;
        const a = (forward ? x1 : x2) / ppu, b = (forward ? x2 : x1) / ppu, length = Math.abs(b - a);
        if (length < .35) continue;
        const xs = [a, ...cuts(rowIndex, a, b, length), b];
        const points = xs.map((xm) => raster.toInches(xm * ppu, offset ? y + offset(xm * ppu) : y));
        // Rows closer than 1 mm form a solid cover that later travel stitches can hide under.
        if (points.length > 1) segments.push({ color, points, cover: spacingMm <= 1 });
      }
    }
    return segments;
  }
  // Classic tatami: needle points every stitch length, staggered row to row so no lines show.
  const tatamiCuts = (stitchMm) => (rowIndex, a, b, length) => {
    const dir = b >= a ? 1 : -1, phase = ((rowIndex * 3) % 7) / 7 * stitchMm, out = [];
    for (let d = phase; d < length - .6; d += stitchMm) if (d > .6) out.push(a + dir * d);
    return out;
  };
  // Needle points at fixed positions along the row (so they line up into a visible pattern).
  function alignedCuts(positionsFor, maxGap) {
    return (rowIndex, a, b) => {
      const lo = Math.min(a, b) + .6, hi = Math.max(a, b) - .6;
      const list = positionsFor(rowIndex, lo, hi).filter((x) => x > lo && x < hi).sort((p, q) => p - q);
      const filled = [];
      let prev = Math.min(a, b);
      for (const x of [...list, Math.max(a, b)]) {
        const gap = x - prev, pieces = Math.ceil(gap / maxGap);
        for (let k = 1; k < pieces; k++) filled.push(prev + gap * k / pieces);
        if (x < Math.max(a, b)) filled.push(x);
        prev = x;
      }
      return b >= a ? filled : filled.reverse();
    };
  }
  const repeatAt = (period, phase, lo, hi) => {
    const out = [];
    for (let k = Math.floor((lo - phase) / period); k * period + phase <= hi; k++) out.push(k * period + phase);
    return out;
  };
  function satinCuts(rowIndex, a, b, length) {
    // Satin spans the whole width; very wide columns are split so no stitch is over 7 mm.
    if (length <= 7) return [];
    const n = Math.ceil(length / 6), dir = b >= a ? 1 : -1, shift = rowIndex % 2 ? .5 : 0, out = [];
    for (let k = 1; k < n; k++) out.push(a + dir * length * Math.min(.95, (k - .25 + shift * .5) / n));
    return out;
  }
  // Fill for one color in the chosen style. Returns stitch segments (inches).
  // Auto fill: how auto-digitizing in professional software works, simplified. Each separate part of the
  // color is measured: narrow parts (columns up to 7 mm wide) become satin with stitches across the column,
  // wider parts become tatami with rows along the part's length; each gets matching underlay.
  async function autoFillSegments(color, opt) {
    const { spacing, stitchMm, grow, smooth, shrink, ppu, underlay, fixedAngle } = opt;
    const A = 4; // analysis resolution, pixels per mm
    const base = await rasterColors([color], 0, A, grow, smooth, shrink);
    const { side, alpha } = base;
    const labels = new Int32Array(side * side), comps = [], stack = new Int32Array(side * side);
    for (let start = 0; start < alpha.length; start++) {
      if (!alpha[start] || labels[start]) continue;
      const id = comps.length + 1, c = { id, n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, maxD: 0 };
      let top = 0; stack[top++] = start; labels[start] = id;
      while (top) {
        const i = stack[--top], x = i % side, y = (i - x) / side;
        c.n++; c.sx += x; c.sy += y; c.sxx += x * x; c.syy += y * y; c.sxy += x * y;
        const visit = (j) => { if (alpha[j] && !labels[j]) { labels[j] = id; stack[top++] = j; } };
        if (x > 0) visit(i - 1);
        if (x < side - 1) visit(i + 1);
        if (y > 0) visit(i - side);
        if (y < side - 1) visit(i + side);
      }
      comps.push(c);
    }
    if (!comps.length) return [];
    const dist = SL.distanceField(alpha, side, side);
    for (let i = 0; i < labels.length; i++) if (labels[i]) { const c = comps[labels[i] - 1]; if (dist[i] > c.maxD) c.maxD = dist[i]; }
    const norm = (deg, step) => ((Math.round(deg / step) * step) % 180 + 180) % 180;
    const groups = new Map();
    for (const c of comps) {
      if (c.n / (A * A) < .5) continue; // specks under half a square millimetre
      const widthMm = 2 * c.maxD / A;
      const mx = c.sx / c.n, my = c.sy / c.n;
      const vx = c.sxx / c.n - mx * mx, vy = c.syy / c.n - my * my, cov = c.sxy / c.n - mx * my;
      const axis = .5 * Math.atan2(2 * cov, vx - vy) * 180 / Math.PI; // the part's long direction (y down)
      const kind = widthMm <= 7 ? "satin" : "tatami";
      // Rows run along the long direction; satin stitches cross it.
      let angle = kind === "satin" ? norm(-(axis + 90), 10) : norm(-axis, 15);
      if (kind === "tatami" && Number.isFinite(fixedAngle)) angle = fixedAngle;
      const key = `${kind}|${angle}`;
      if (!groups.has(key)) groups.set(key, { kind, angle, ids: new Set(), width: 0 });
      const g = groups.get(key); g.ids.add(c.id); g.width = Math.max(g.width, widthMm);
    }
    // Rasters at each angle are shared between groups; each use gets its own copy of the mask.
    const rasterCache = new Map();
    const rasterFor = async (angle, ids) => {
      if (!rasterCache.has(angle)) rasterCache.set(angle, await rasterColors([color], angle, ppu, grow, smooth, shrink));
      const r = rasterCache.get(angle), mask = r.alpha.slice();
      const labelAt = (bx, by) => (bx >= 0 && by >= 0 && bx < side && by < side ? labels[by * side + bx] : 0);
      for (let py = 0; py < r.side; py++) for (let px = 0; px < r.side; px++) {
        const i = py * r.side + px;
        if (!mask[i]) continue;
        const p = r.toInches(px, py);
        const bx = Math.round((p.x - state.hoopW / 2) * 25.4 * A + side / 2), by = Math.round((p.y - state.hoopH / 2) * 25.4 * A + side / 2);
        let id = labelAt(bx, by);
        for (let k = 0; !id && k < 8; k++) id = labelAt(bx + [1, -1, 0, 0, 1, 1, -1, -1][k], by + [0, 0, 1, -1, 1, -1, 1, -1][k]);
        if (!ids.has(id)) mask[i] = 0;
      }
      return { ...r, alpha: mask };
    };
    const underlaySpacing = underlay === "heavy" ? Math.max(.3, spacing) : underlay === "medium" ? Math.max(.45, spacing * 1.5) : Math.max(.65, spacing * 2);
    const out = [];
    // Large fills first, satin details last so they sit on top.
    const ordered = [...groups.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "tatami" ? -1 : 1));
    for (const g of ordered) {
      if (g.kind === "tatami") {
        if (underlay !== "none") out.push(...orderSegments(rowFill(await rasterFor(g.angle + 90, g.ids), color, underlaySpacing, tatamiCuts(3)), underlaySpacing));
        out.push(...orderSegments(rowFill(await rasterFor(g.angle, g.ids), color, spacing, tatamiCuts(stitchMm)), spacing));
      } else {
        // Satin underlay: a couple of runs along the column (center/edge runs) when it is wide enough.
        if (g.width >= 2 && underlay !== "none") {
          const runSpacing = Math.max(1, g.width / 3);
          out.push(...orderSegments(rowFill(await rasterFor(g.angle + 90, g.ids), color, runSpacing, tatamiCuts(3)), runSpacing));
        }
        const satinSpacing = Math.max(.38, spacing);
        out.push(...orderSegments(rowFill(await rasterFor(g.angle, g.ids), color, satinSpacing, satinCuts), satinSpacing));
      }
    }
    return out;
  }
  async function fillSegments(color, style, opt) {
    if (style === "auto") return autoFillSegments(color, opt);
    const { angle, spacing, stitchMm, patternMm, grow, smooth, shrink = 0, ppu } = opt;
    if (style === "crosshatch") {
      const segs = [];
      for (const a of [angle + 45, angle - 45]) {
        const r = await rasterColors([color], a, ppu, grow, smooth, shrink);
        segs.push(...orderSegments(rowFill(r, color, Math.max(1, patternMm / 2), tatamiCuts(2.5)), patternMm / 2));
      }
      return segs;
    }
    if (style === "contour") {
      const r = await rasterColors([color], 0, 4, grow, smooth, shrink), gap = Math.max(.6, patternMm / 2.5);
      const field = SL.distanceField(r.alpha, r.side, r.side);
      let max = 0;
      for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i];
      const segs = [];
      for (let level = gap * r.ppu * .5; level < max; level += gap * r.ppu) {
        for (const line of SL.isolines(field, r.side, r.side, level)) {
          const mm = line.points.map((p) => { const q = r.toInches(p.x, p.y); return { x: q.x * 25.4, y: q.y * 25.4 }; });
          if (SL.pathLength(mm, line.closed) < 2) continue;
          const run = SL.resample(mm, Math.min(2.5, stitchMm), line.closed);
          if (line.closed) run.push(run[0]);
          segs.push({ color, points: run.map(mmToIn), link: gap * 2.5 });
        }
      }
      return orderSegments(segs, gap);
    }
    if (style === "cross") {
      const r = await rasterColors([color], angle, 4, grow, smooth, shrink), cell = Math.max(1.5, Math.min(6, patternMm * .6)), cellPx = cell * r.ppu;
      const n = Math.floor(r.side / cellPx), segs = [];
      const inked = (i, j) => {
        let hits = 0;
        for (const fy of [.25, .5, .75]) for (const fx of [.25, .5, .75]) {
          const x = Math.floor((i + fx) * cellPx), y = Math.floor((j + fy) * cellPx);
          if (r.alpha[y * r.side + x]) hits++;
        }
        return hits >= 5;
      };
      const P = (i, j) => r.toInches(i * cellPx, j * cellPx);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if (!inked(i, j)) continue;
          let k = i;
          while (k + 1 < n && inked(k + 1, j)) k++;
          const pts = [P(i, j + 1)];
          for (let c = i; c <= k; c++) pts.push(P(c + 1, j), P(c + 1, j + 1));
          for (let c = k; c >= i; c--) pts.push(P(c, j), P(c, j + 1));
          segs.push({ color, points: pts, link: cell * 1.6 });
          i = k;
        }
      }
      return orderSegments(segs, cell);
    }
    const r = await rasterColors([color], angle, ppu, grow, smooth, shrink);
    if (style === "satin") return orderSegments(rowFill(r, color, Math.max(.3, spacing), satinCuts), Math.max(.3, spacing));
    if (style === "wave" || style === "chevron") {
      const amp = patternMm * .35 * r.ppu, wavelength = patternMm * 3 * r.ppu;
      const offset = style === "wave"
        ? (x) => amp * Math.sin(2 * Math.PI * x / wavelength)
        : (x) => { const u = (x / wavelength) % 1; return amp * (Math.abs(u * 4 - 2) - 1); };
      return orderSegments(rowFill(r, color, spacing, tatamiCuts(stitchMm), offset), spacing);
    }
    if (style === "diamond") {
      const P = patternMm;
      const cuts = alignedCuts((row, lo, hi) => {
        const u = ((row * spacing) / P) % 1, phi = (1 - Math.abs(2 * u - 1)) * P / 2;
        return [...repeatAt(P, phi, lo, hi), ...repeatAt(P, -phi, lo, hi)];
      }, Math.max(stitchMm, 2) * 1.6);
      return orderSegments(rowFill(r, color, spacing, cuts), spacing);
    }
    if (style === "brick") {
      const P = patternMm, band = Math.max(1, Math.round(P / 2 / spacing));
      const cuts = alignedCuts((row, lo, hi) => repeatAt(P, (Math.floor(row / band) % 2) * P / 2, lo, hi), Math.max(stitchMm, 2) * 1.6);
      return orderSegments(rowFill(r, color, spacing, cuts), spacing);
    }
    return orderSegments(rowFill(r, color, spacing, tatamiCuts(stitchMm)), spacing);
  }
  // Outer edges of a set of colors as closed paths in mm (holes filled when `solid`).
  async function colorContours(colorList, ppu, growMm = 0, solid = false, shrinkMm = 0) {
    const r = await rasterColors(colorList, 0, ppu, growMm * 2, 0, shrinkMm);
    let mask = r.alpha;
    const w = r.side, h = r.side;
    if (solid) {
      const outside = new Uint8Array(w * h), stack = [];
      const seed = (x, y) => { const i = y * w + x; if (!outside[i] && !mask[i]) { outside[i] = 1; stack.push(i); } };
      for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
      for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i - x) / w;
        if (x > 0) seed(x - 1, y);
        if (x < w - 1) seed(x + 1, y);
        if (y > 0) seed(x, y - 1);
        if (y < h - 1) seed(x, y + 1);
      }
      mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = outside[i] ? 0 : 1;
    }
    return traceOuterContours(mask, w, h).map((contour) => smoothClosedPath(contour, 9).map((p) => {
      const q = r.toInches(p.x, p.y);
      return { x: q.x * 25.4, y: q.y * 25.4 };
    }));
  }
  // Orders fill rows to minimise jumps and trims. Rows are first grouped into connected regions
  // (rows lying next to each other), and each region is sewn completely, as one serpentine, before
  // moving to the nearest next region. Within a region several start points are tried and the
  // one with the fewest/shortest jumps wins.
  // Where the needle is after everything ordered so far, so each new pass starts close by (fewer, shorter jumps).
  let orderNeedle = null;
  function orderSegments(segments, spacingMm = .4) {
    if (segments.length < 2) {
      if (segments.length) orderNeedle = segments[0].points.at(-1);
      return segments.slice();
    }
    const mm = 25.4, n = segments.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const reach = spacingMm * 1.6, hash = new Map(), key = (x, y) => `${x}|${y}`;
    segments.forEach((segment, index) => {
      const pts = segment.points;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1].x * mm, ay = pts[i - 1].y * mm, bx = pts[i].x * mm, by = pts[i].y * mm;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacingMm));
        for (let k = 0; k <= steps; k++) {
          const x = ax + (bx - ax) * k / steps, y = ay + (by - ay) * k / steps;
          const cx = Math.floor(x / reach), cy = Math.floor(y / reach);
          for (let i2 = cx - 1; i2 <= cx + 1; i2++) for (let j2 = cy - 1; j2 <= cy + 1; j2++) {
            for (const other of hash.get(key(i2, j2)) || []) {
              if (other.index === index) continue;
              if (Math.hypot(other.x - x, other.y - y) <= reach) parent[find(index)] = find(other.index);
            }
          }
          const bucket = hash.get(key(cx, cy)) || [];
          if (!hash.has(key(cx, cy))) hash.set(key(cx, cy), bucket);
          bucket.push({ x, y, index });
        }
      }
    });
    const groups = new Map();
    segments.forEach((segment, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(segment);
    });
    const endsOf = (segment) => [segment.points[0], segment.points.at(-1)];
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) * mm;
    // Greedy nearest-neighbour walk through one region from a given first row and direction.
    const walk = (rows, startIndex, startFlip) => {
      const rest = rows.slice(), order = [];
      let first = rest.splice(startIndex, 1)[0], cost = 0, jumps = 0;
      if (startFlip) first = { ...first, points: first.points.slice().reverse() };
      order.push(first);
      let end = first.points.at(-1);
      while (rest.length) {
        let best = 0, bestDist = Infinity, bestFlip = false;
        for (let i = 0; i < rest.length; i++) {
          const pts = rest[i].points;
          const head = dist(pts[0], end), tail = dist(pts.at(-1), end);
          if (head < bestDist) { best = i; bestDist = head; bestFlip = false; }
          if (tail < bestDist) { best = i; bestDist = tail; bestFlip = true; }
        }
        let [next] = rest.splice(best, 1);
        if (bestFlip) next = { ...next, points: next.points.slice().reverse() };
        if (bestDist > 1.2) { jumps++; cost += bestDist; }
        order.push(next); end = next.points.at(-1);
      }
      return { order, cost: jumps * 10 + cost };
    };
    const regions = [...groups.values()];
    const ordered = [];
    let end = orderNeedle;
    while (regions.length) {
      // Pick the region whose nearest row end is closest to where the needle is.
      let regionIndex = 0, regionDist = Infinity;
      if (end) {
        regions.forEach((rows, r) => {
          for (const row of rows) for (const p of endsOf(row)) {
            const d = dist(p, end);
            if (d < regionDist) { regionDist = d; regionIndex = r; }
          }
        });
      }
      const [rows] = regions.splice(regionIndex, 1);
      // Candidate starts: the four extreme row ends of the region, plus the end closest to the needle.
      const candidates = [];
      const addCandidate = (score) => {
        let best = null;
        rows.forEach((row, i) => endsOf(row).forEach((p, side) => {
          const s = score(p);
          if (!best || s < best.s) best = { i, flip: side === 1, s };
        }));
        if (best) candidates.push(best);
      };
      addCandidate((p) => p.x); addCandidate((p) => -p.x);
      addCandidate((p) => p.y); addCandidate((p) => -p.y);
      if (end) addCandidate((p) => dist(p, end));
      let result = null;
      const tries = rows.length > 1500 ? candidates.slice(-1) : candidates;
      const seen = new Set();
      for (const c of tries) {
        const id = `${c.i}|${c.flip}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const attempt = walk(rows, c.i, c.flip);
        const entry = end ? dist(attempt.order[0].points[0], end) : 0;
        const total = attempt.cost + (entry > 1.2 ? 10 + entry : 0);
        if (!result || total < result.total) result = { order: attempt.order, total };
      }
      ordered.push(...result.order);
      end = result.order.at(-1).points.at(-1);
    }
    orderNeedle = end;
    return ordered;
  }
  function fillHoles(mask, w, h) {
    const outside = new Uint8Array(w * h), stack = new Int32Array(w * h);
    let top = 0;
    const seed = (i) => { if (!outside[i] && !mask[i]) { outside[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (top) {
      const i = stack[--top], x = i % w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (i >= w) seed(i - w);
      if (i < w * (h - 1)) seed(i + w);
    }
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < solid.length; i++) solid[i] = outside[i] ? 0 : 1;
    return solid;
  }
  // Distance map around a set of colors (holes filled), in pixels at `ppu` per mm.
  async function designDistance(colorList, ppu = 5) {
    const r = await rasterColors(colorList, 0, ppu);
    const solid = fillHoles(r.alpha, r.side, r.side);
    const outside = new Uint8Array(solid.length);
    for (let i = 0; i < solid.length; i++) outside[i] = solid[i] ? 0 : 1;
    return { r, side: r.side, ppu, dist: SL.exactDistance(outside, r.side, r.side) };
  }
  // Closed curves at a fixed distance (mm) from the design: smooth offsets with round corners.
  function offsetLoops(field, mm) {
    const { dist, side, ppu, r } = field;
    return SL.isolines(dist, side, side, mm * ppu)
      .filter((l) => l.closed && SL.pathLength(l.points, true) > 3 * ppu)
      .map((l) => l.points.map((p) => { const q = r.toInches(p.x, p.y); return { x: q.x * 25.4, y: q.y * 25.4 }; }));
  }
  // A satin (or split "fill") band from gapMm to gapMm + widthMm around the design. Each stitch crosses the
  // band along the distance gradient and stops where the band ends, so inside corners get shorter stitches
  // instead of crossing ones and the whole border is one continuous, even column.
  function satinBand(field, gapMm, widthMm, spacingMm, splitMm = 0) {
    const { dist, side, ppu, r } = field;
    const at = (x, y) => {
      const x0 = Math.max(0, Math.min(side - 2, Math.floor(x))), y0 = Math.max(0, Math.min(side - 2, Math.floor(y)));
      const fx = x - x0, fy = y - y0, i = y0 * side + x0;
      return dist[i] * (1 - fx) * (1 - fy) + dist[i + 1] * fx * (1 - fy) + dist[i + side] * (1 - fx) * fy + dist[i + side + 1] * fx * fy;
    };
    const d1 = gapMm * ppu, d2 = (gapMm + widthMm) * ppu, mid = (d1 + d2) / 2, toMm = (p) => { const q = r.toInches(p.x, p.y); return { x: q.x * 25.4, y: q.y * 25.4 }; };
    const bands = [];
    for (const loop of SL.isolines(dist, side, side, mid)) {
      if (!loop.closed || SL.pathLength(loop.points, true) < 4 * ppu) continue;
      const run = SL.resample(loop.points, spacingMm * ppu, true);
      const edge = (p, dir, target) => {
        const e = 1.5, gx = at(p.x + e, p.y) - at(p.x - e, p.y), gy = at(p.x, p.y + e) - at(p.x, p.y - e), gl = Math.hypot(gx, gy) || 1;
        let q = p, last = at(p.x, p.y);
        for (let s = .5; s < widthMm * ppu * 1.5; s += .5) {
          const c = { x: p.x + dir * gx / gl * s, y: p.y + dir * gy / gl * s }, v = at(c.x, c.y);
          if (dir > 0 ? v >= target : v <= target) { q = c; break; }
          if (dir > 0 ? v < last - .05 : v > last + .05) break; // crossed the middle of a corner: stop
          q = c; last = v;
        }
        return toMm(q);
      };
      const rails = run.map((p) => ({ inner: edge(p, -1, Math.max(.3, d1)), outer: edge(p, 1, d2) }));
      const points = [];
      rails.forEach((rail, k) => {
        const to = k % 2 ? rail.outer : rail.inner, from = k % 2 ? rail.inner : rail.outer;
        if (splitMm && k > 0) {
          const n = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / splitMm), phase = ((k * 3) % 7) / 7;
          for (let j = 1; j < n; j++) { const t = (j + (phase - .5) * .8) / n; points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }); }
        }
        points.push(to);
      });
      if (points.length) points.push(points[0]);
      bands.push({ points, center: SL.resample(loop.points.map(toMm), 2.5, true) });
    }
    return bands;
  }
  // Sews a satin band: a center run underneath, optional edge runs, then the band itself.
  function bandSegments(field, colorIndex, gapMm, widthMm, spacingMm, { fill = false, edgeRun = true } = {}) {
    const out = [];
    for (const band of satinBand(field, gapMm, widthMm, Math.max(.35, spacingMm), fill ? 3.5 : widthMm > 7 ? 6 : 0)) {
      out.push({ color: colorIndex, points: [...band.center, band.center[0]].map(mmToIn) });
      out.push({ color: colorIndex, points: band.points.map(mmToIn) });
    }
    if (edgeRun && widthMm >= 2.5) {
      // Edge runs hold the band's edges crisp; sewn under it, so put them first.
      const edges = [...offsetLoops(field, gapMm + .5), ...offsetLoops(field, gapMm + widthMm - .5)]
        .map((loop) => ({ color: colorIndex, points: SL.lineStitch(loop, { style: "running", closed: true, length: 2.5 }).map(mmToIn) }));
      out.unshift(...edges);
    }
    return out;
  }
  // Outline around the whole design (or around every color) in any line stitch.
  // Outline around the whole design (or around every color). Bands (satin, fill, double) are built from
  // the exact distance to the design, so they are smooth, continuous and never cross at corners.
  async function outlineSegments(artColors, colorIndex, color2Index = colorIndex) {
    const mode = $("#outline-mode").value;
    const widthMm = Math.max(.5, Math.min(12, Number($("#outline-width").value) || 2));
    const gapMm = Math.max(0, Math.min(10, Number($("#outline-gap").value) || 0));
    const spacing = Math.max(.35, Number($("#spacing").value) || .4);
    const groups = $("#outline-target").value === "colors" ? artColors.map((c) => [c]) : [artColors];
    const segments = [];
    for (const group of groups) {
      const field = await designDistance(group, 5);
      if (mode === "satin" || mode === "fill") {
        segments.push(...bandSegments(field, colorIndex, gapMm, widthMm, spacing, { fill: mode === "fill" }));
      } else if (mode === "satin-edge") {
        // A satin band with a fine triple-stitched line just outside it, often in a second color.
        segments.push(...bandSegments(field, colorIndex, gapMm, widthMm, spacing));
        for (const loop of offsetLoops(field, gapMm + widthMm + .9)) {
          segments.push({ color: color2Index, points: SL.lineStitch(loop, { style: "triple", closed: true, length: 2 }).map(mmToIn) });
        }
      } else if (mode === "double") {
        // Two satin rings: the main band, a small gap, then a slimmer outer ring.
        const outer = Math.max(1.2, widthMm * .5);
        segments.push(...bandSegments(field, colorIndex, gapMm, widthMm, spacing));
        segments.push(...bandSegments(field, color2Index, gapMm + widthMm + .8, outer, spacing, { edgeRun: false }));
      } else if (mode === "bold") {
        // Closely spaced parallel loops fill the width with a solid, flat band.
        for (let d = gapMm + .2; d <= gapMm + widthMm; d += .35) {
          for (const loop of offsetLoops(field, d)) segments.push({ color: colorIndex, points: SL.lineStitch(loop, { style: "running", closed: true, length: 2 }).map(mmToIn) });
        }
      } else {
        // Running, triple and decorative motifs follow a smooth curve around the design.
        const reach = mode === "running" || mode === "triple" ? gapMm + .4 : gapMm + widthMm / 2;
        for (const loop of offsetLoops(field, reach)) {
          const points = SL.lineStitch(loop, { style: mode, width: widthMm, closed: true, length: 2.5, spacing });
          if (points.length > 1) segments.push({ color: colorIndex, points: points.map(mmToIn) });
        }
      }
    }
    const outside = segments.some((s) => s.points.some((p) => p.x < 0 || p.y < 0 || p.x > state.hoopW || p.y > state.hoopH));
    if (outside) throw new Error("The outline goes outside the hoop. Make it narrower, reduce its gap, or make the design a little smaller.");
    return segments;
  }
  function traceOuterContours(mask, w, h) {
    const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const seen = new Uint8Array(w * h), contours = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const start = y * w + x;
        if (!mask[start] || seen[start]) continue;
        let area = 0;
        const flood = [start]; seen[start] = 1;
        while (flood.length) {
          const i = flood.pop(), ix = i % w, iy = (i - ix) / w; area++;
          for (const [dx, dy] of dirs) {
            const nx = ix + dx, ny = iy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (mask[ni] && !seen[ni]) { seen[ni] = 1; flood.push(ni); }
          }
        }
        if (area < 40) continue;
        const points = [{ x, y }];
        let px = x, py = y, back = 0, steps = 0;
        while (steps++ < 400000) {
          let found = false;
          for (let i = 1; i <= 8; i++) {
            const [dx, dy] = dirs[(back + i) % 8];
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) continue;
            const [qx, qy] = dirs[(back + i - 1) % 8];
            const rx = px + qx - nx, ry = py + qy - ny;
            back = dirs.findIndex(([ax, ay]) => ax === rx && ay === ry);
            px = nx; py = ny; found = true;
            break;
          }
          if (!found || (px === x && py === y && back === 0)) break;
          points.push({ x: px, y: py });
        }
        if (points.length > 12) contours.push(points);
      }
    }
    return contours;
  }
  function smoothClosedPath(points, window) {
    const n = points.length, half = Math.floor(window / 2);
    return points.map((_, i) => {
      let sx = 0, sy = 0;
      for (let k = -half; k <= half; k++) { const p = points[(i + k + n) % n]; sx += p.x; sy += p.y; }
      return { x: sx / (half * 2 + 1), y: sy / (half * 2 + 1) };
    });
  }
  function resampleClosedPath(points, step) {
    const n = points.length, lengths = [0];
    for (let i = 1; i <= n; i++) {
      const a = points[i - 1], b = points[i % n];
      lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const total = lengths[n], count = Math.max(0, Math.round(total / step));
    const result = [];
    let segment = 0;
    for (let k = 0; k < count; k++) {
      const target = k * total / count;
      while (segment < n - 1 && lengths[segment + 1] < target) segment++;
      const a = points[segment], b = points[(segment + 1) % n];
      const span = lengths[segment + 1] - lengths[segment] || 1, t = (target - lengths[segment]) / span;
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return result;
  }
  // Centerline (mm) of a patch-shaped border around bounds b, pushed out by `reach`.
  function borderShapePath(shape, b, reach, width) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, w = b.x1 - b.x0, h = b.y1 - b.y0, pts = [];
    if (shape === "circle" || shape === "oval") {
      const rx = shape === "circle" ? Math.hypot(w, h) / 2 + reach : w / 2 * Math.SQRT2 + reach;
      const ry = shape === "circle" ? rx : h / 2 * Math.SQRT2 + reach;
      for (let k = 0; k < 360; k++) pts.push({ x: cx + rx * Math.cos(k * Math.PI / 180), y: cy + ry * Math.sin(k * Math.PI / 180) });
      return pts;
    }
    const hw = w / 2 + reach, hh = h / 2 + reach;
    const r = shape === "rounded" ? Math.min(hw, hh, 6 + width) : .01;
    const corners = [[hw - r, hh - r, 0], [-hw + r, hh - r, 90], [-hw + r, -hh + r, 180], [hw - r, -hh + r, 270]];
    for (const [ox, oy, start] of corners) for (let a = 0; a <= 90; a += 5) {
      const t = (start + a) * Math.PI / 180;
      pts.push({ x: cx + ox + r * Math.cos(t), y: cy + oy + r * Math.sin(t) });
    }
    return pts;
  }
  // Live canvas preview of the border from the Advanced tab.
  function drawBorderPreview() {
    stage.querySelector("#border-preview-filter")?.remove();
    if (!$("#border-on")?.checked || !state.objects.length) return;
    const width = Math.max(1, Math.min(20, Number($("#border-width").value) || 4)), gap = Math.max(0, Math.min(20, Number($("#border-gap").value) || 0));
    const color = safeColor($("#border-color").value), shape = $("#border-shape").value;
    const group = node("g", { "pointer-events": "none", opacity: ".9" });
    // Once planned, the real border stitches are drawn instead (see drawStitches).
    if (shape === "follow" && state.stitches.some((s) => s.deco)) return;
    if (shape === "follow") {
      const pad = 2;
      const filter = node("filter", { id: "border-preview-filter", filterUnits: "userSpaceOnUse", x: -pad, y: -pad, width: state.hoopW + pad * 2, height: state.hoopH + pad * 2 });
      filter.appendChild(node("feMorphology", { in: "SourceAlpha", operator: "dilate", radius: (gap + width) / 25.4, result: "outer" }));
      filter.appendChild(node("feMorphology", { in: "SourceAlpha", operator: "dilate", radius: gap / 25.4, result: "inner" }));
      filter.appendChild(node("feComposite", { in: "outer", in2: "inner", operator: "out", result: "band" }));
      filter.appendChild(node("feFlood", { "flood-color": color }));
      filter.appendChild(node("feComposite", { in2: "band", operator: "in" }));
      stage.querySelector("defs").appendChild(filter);
      const clone = objectRoot.cloneNode(true);
      clone.removeAttribute("id");
      clone.querySelectorAll("[id]").forEach((el) => el.setAttribute("id", "bp-" + el.getAttribute("id")));
      clone.querySelectorAll("[mask]").forEach((el) => el.removeAttribute("mask"));
      clone.setAttribute("filter", "url(#border-preview-filter)");
      group.appendChild(clone);
    } else {
      const ext = state.objects.map(rotatedBounds);
      const b = {
        x0: Math.min(...ext.map((e) => e.x - e.width / 2)) * 25.4, y0: Math.min(...ext.map((e) => e.y - e.height / 2)) * 25.4,
        x1: Math.max(...ext.map((e) => e.x + e.width / 2)) * 25.4, y1: Math.max(...ext.map((e) => e.y + e.height / 2)) * 25.4
      };
      const pts = borderShapePath(shape, b, gap + width / 2, width);
      group.appendChild(node("path", {
        d: pts.map((p, i) => `${i ? "L" : "M"}${(p.x / 25.4).toFixed(4)} ${(p.y / 25.4).toFixed(4)}`).join("") + "Z",
        fill: "none", stroke: color, "stroke-width": width / 25.4, "stroke-linejoin": "round"
      }));
    }
    selectionRoot.appendChild(group);
  }
  // Advanced tab: border around the design (sewn last), basting box and knockdown base (sewn first).
  async function addAdvancedSegments(segments, colors, fillColors, spacing) {
    const colorIndexOf = (hex) => { let i = colors.indexOf(hex); if (i < 0) { colors.push(hex); i = colors.length - 1; } return i; };
    const num = (id, lo, hi, fallback) => Math.max(lo, Math.min(hi, Number.isFinite(Number($(id).value)) ? Number($(id).value) : fallback));
    const artColors = colors.filter((c, i) => fillColors.has(c) && colors.indexOf(c) === i);
    // Design bounds in mm, from everything planned so far.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of segments) for (const p of s.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    if (!Number.isFinite(x0)) return;
    [x0, y0, x1, y1] = [x0 * 25.4, y0 * 25.4, x1 * 25.4, y1 * 25.4];
    const hoopMm = { w: state.hoopW * 25.4, h: state.hoopH * 25.4 };
    const inHoop = (pts) => pts.every((p) => p.x >= 0 && p.y >= 0 && p.x <= hoopMm.w && p.y <= hoopMm.h);

    if ($("#border-on").checked) {
      const width = num("#border-width", 1, 20, 4), gap = num("#border-gap", 0, 20, 1.5);
      const shape = $("#border-shape").value, fill = $("#border-style").value === "fill";
      const reach = gap + width / 2;
      const borderIndex = colorIndexOf(safeColor($("#border-color").value));
      let paths = [];
      if (shape === "follow" && artColors.length) {
        // Smooth, continuous band that follows the design (same engine as the satin outline).
        const field = await designDistance(artColors, 5);
        const band = bandSegments(field, borderIndex, gap, width, spacing, { fill, edgeRun: $("#border-edge").value === "on" });
        if (!band.every((s) => inHoop(s.points.map((p) => ({ x: p.x * 25.4, y: p.y * 25.4 }))))) {
          throw new Error("The border goes outside the hoop. Make the border narrower, reduce the gap, or make the design smaller.");
        }
        segments.push(...band.map((s) => ({ ...s, deco: true })));
      } else {
        paths = [borderShapePath(shape === "follow" ? "oval" : shape, { x0, y0, x1, y1 }, reach, width)];
      }
      for (const path of paths) {
        if (!inHoop(SL.offsetPath(path, width / 2, true, 3)) || !inHoop(SL.offsetPath(path, -width / 2, true, 3))) {
          throw new Error("The border goes outside the hoop. Make the border narrower, reduce the gap, or make the design smaller.");
        }
        // Underlay: a center run, plus edge runs when the edge run option is on, then the band itself.
        const under = [SL.lineStitch(path, { style: "running", closed: true, length: 2.5 })];
        if ($("#border-edge").value === "on" && width >= 2.5) {
          for (const side of [1, -1]) {
            const edge = SL.offsetPath(path, side * (width / 2 - .5), true, 1);
            under.push(SL.lineStitch(edge, { style: "running", closed: true, length: 2.5 }));
          }
        }
        for (const run of under) segments.push({ color: borderIndex, points: run.map(mmToIn), deco: true });
        const band = SL.lineStitch(path, { style: "satin", width, closed: true, spacing: Math.max(.38, spacing), split: fill ? 3.5 : 7 });
        segments.push({ color: borderIndex, points: band.map(mmToIn), deco: true });
      }
    }

    const first = [];
    const knockdown = $("#knockdown-on").checked && artColors.length;
    const firstColor = knockdown ? colorIndexOf(safeColor($("#knockdown-color").value)) : segments[0].color;
    if ($("#baste-on").checked) {
      const m = 5;
      const bx0 = Math.max(1, x0 - m), by0 = Math.max(1, y0 - m), bx1 = Math.min(hoopMm.w - 1, x1 + m), by1 = Math.min(hoopMm.h - 1, y1 + m);
      const box = [{ x: bx0, y: by0 }, { x: bx1, y: by0 }, { x: bx1, y: by1 }, { x: bx0, y: by1 }, { x: bx0, y: by0 }];
      first.push({ color: firstColor, points: SL.limitStitches(box, 5).map(mmToIn) });
    }
    if (knockdown) {
      // A light open crosshatch under the whole design, slightly larger, to flatten towel loops.
      for (const a of [45, 135]) {
        const r = await rasterColors(artColors, a, 4, 2);
        first.push(...orderSegments(rowFill(r, null, 2, tatamiCuts(4)), 2).map((s) => ({ ...s, color: firstColor })));
      }
    }
    segments.unshift(...first);
  }
  async function makeStitches() {
    if (!state.objects.length) throw new Error("Add traced artwork, a shape, or text before generating stitches.");
    const objectBounds = state.objects.map(rotatedBounds);
    const minX = Math.min(...objectBounds.map((b) => b.x - b.width / 2));
    const maxX = Math.max(...objectBounds.map((b) => b.x + b.width / 2));
    const minY = Math.min(...objectBounds.map((b) => b.y - b.height / 2));
    const maxY = Math.max(...objectBounds.map((b) => b.y + b.height / 2));
    if (minX < 0 || minY < 0 || maxX > state.hoopW || maxY > state.hoopH) {
      throw new Error("The design extends outside the selected hoop. Move or resize every object inside the hoop before exporting.");
    }
    const colors = sewingColors();
    if (!colors.length) throw new Error("No filled regions are available to stitch.");
    const spacing = Number($("#spacing").value), angle = Number($("#angle").value);
    if (!Number.isFinite(spacing) || spacing < .1 || spacing > 1.2) throw new Error("Row spacing must be between 0.1 and 1.2 mm.");
    if (!Number.isFinite(angle) || angle < 0 || angle > 179) throw new Error("Fill angle must be between 0 and 179 degrees.");
    const stitchMm = Math.max(1.5, Math.min(7, Number($("#stitch-length").value) || 3));
    const patternMm = Math.max(2, Math.min(12, Number($("#pattern-size").value) || 4));
    const pullComp = Math.max(0, Math.min(1, Number($("#pull-comp").value) || 0));
    if (state.busy) return;
    state.busy = true; $("#export-pes").disabled = true;
    message("Generating stitches…", "busy");
    try {
      const segments = [], ppu = 8;
      orderNeedle = null;
      const fillColors = new Set(state.objects.filter((obj) => !isLineObject(obj)).flatMap((obj) => obj.type === "image" ? obj.regions.map((r) => r.fill) : [obj.fill]));
      const checkSize = () => {
        if (segments.reduce((total, seg) => total + seg.points.length, 0) > 150000) throw new Error("This design exceeds 150,000 planned stitches. Increase row spacing or simplify the artwork.");
      };
      // Appliqué adds stop colors to `colors`, so walk a copy of the original list.
      for (const color of colors.slice()) {
        if (!fillColors.has(color)) continue;
        const colorIndex = colors.indexOf(color);
        const settings = colorSettings(color);
        if (!Number.isFinite(Number(settings.strokeMm)) || settings.strokeMm < 0 || settings.strokeMm > 2
          || !Number.isFinite(Number(settings.smoothMm)) || settings.smoothMm < 0 || settings.smoothMm > 5
          || !(Number(settings.insideMm) >= 0 && Number(settings.insideMm) <= 2)) {
          throw new Error(`Invalid grow or smooth settings for ${color}.`);
        }
        const style = resolveFill(settings.fill);
        const colorAngle = Number.isFinite(settings.angle) ? settings.angle : angle;
        const grow = settings.strokeMm + pullComp * 2, smooth = settings.smoothMm, shrink = (Number(settings.insideMm) || 0) + pullComp * 2;
        const tag = (list, index = colorIndex) => list.map((segment) => ({ ...segment, color: index }));
        if (style === "applique") {
          // Placement line, stop for fabric, tack-down, stop to trim, then a satin cover edge.
          const contours = await colorContours([color], 6, grow / 2, false, shrink);
          const loops = (fn) => contours.filter((c) => SL.pathLength(c, true) > 3).map((c) => ({ color, points: fn(c).map(mmToIn) }));
          segments.push(...tag(loops((c) => SL.lineStitch(c, { style: "running", closed: true, length: 2.5 }))));
          colors.push(color);
          segments.push(...tag(loops((c) => SL.lineStitch(c, { style: "satin", width: 1.5, spacing: 1.6, closed: true })), colors.length - 1));
          colors.push(color);
          segments.push(...tag(loops((c) => SL.lineStitch(c, { style: "satin", width: 3, spacing: Math.max(.35, spacing), closed: true })), colors.length - 1));
          checkSize();
          continue;
        }
        if (style === "outline") {
          const contours = await colorContours([color], 6, grow / 2, false, shrink);
          segments.push(...tag(contours.filter((c) => SL.pathLength(c, true) > 3)
            .map((c) => ({ color, points: SL.lineStitch(c, { style: "triple", closed: true, length: 2.5 }).map(mmToIn) }))));
          checkSize();
          continue;
        }
        const underlay = $("#underlay").value;
        if (underlay !== "none" && ["tatami", "satin", "wave", "chevron", "diamond", "brick"].includes(style)) {
          const underlaySpacing = underlay === "heavy" ? Math.max(.3, spacing)
            : underlay === "medium" ? Math.max(.45, spacing * 1.5)
              : Math.max(.65, spacing * 2);
          const r = await rasterColors([color], colorAngle + 90, ppu, grow, smooth, shrink);
          segments.push(...tag(orderSegments(rowFill(r, color, underlaySpacing, tatamiCuts(3)), underlaySpacing)));
        }
        segments.push(...tag(await fillSegments(color, style, {
          angle: colorAngle, spacing, stitchMm, patternMm, grow, smooth, shrink, ppu,
          underlay, fixedAngle: Number.isFinite(settings.angle) ? settings.angle : null
        })));
        checkSize();
      }
      if ($("#outline-mode").value !== "off") {
        const artColors = colors.filter((c, i) => fillColors.has(c) && colors.indexOf(c) === i);
        const outlineColor = safeColor($("#outline-color").value);
        let outlineIndex = colors.indexOf(outlineColor);
        if (outlineIndex < 0) { colors.push(outlineColor); outlineIndex = colors.length - 1; }
        const second = safeColor($("#outline-color2").value);
        let secondIndex = colors.indexOf(second);
        if (secondIndex < 0) { colors.push(second); secondIndex = colors.length - 1; }
        if (artColors.length) segments.push(...(await outlineSegments(artColors, outlineIndex, secondIndex)).map((s) => ({ ...s, deco: true })));
      }
      // Stitched lines go last, on top, grouped by color to avoid extra thread changes.
      const lines = state.objects.filter(isLineObject).filter((obj) => obj.fill && obj.fill !== "none");
      for (const color of [...new Set(lines.map((obj) => obj.fill))]) {
        const colorIndex = colors.indexOf(color);
        const lineSegs = lines.filter((obj) => obj.fill === color)
          .map((obj) => ({ color: colorIndex, points: lineObjectStitches(obj, spacing).map(mmToIn) }))
          .filter((seg) => seg.points.length > 1);
        segments.push(...orderSegments(lineSegs, 1));
      }
      await addAdvancedSegments(segments, colors, fillColors, spacing);
      checkSize();
      if (!segments.length) throw new Error("No stitches were generated. Increase trace detail or add larger filled regions.");
      const usedColorIndices = [...new Set(segments.map((segment) => segment.color))].sort((a, b) => a - b);
      const remappedColors = new Map(usedColorIndices.map((colorIndex, index) => [colorIndex, index]));
      segments.forEach((segment) => { segment.color = remappedColors.get(segment.color); });
      state.stitchColors = usedColorIndices.map((colorIndex) => colors[colorIndex]);
      state.stitches = segments; state.stale = false;
      // Count what the machine will actually sew, including travel runs and tie stitches.
      const counts = { 0: 0, 1: 0, 2: 0, 5: 0 };
      for (const c of buildCommands().commands) counts[c[2]] = (counts[c[2]] || 0) + 1;
      state.planStats = {
        stitches: counts[EF.STITCH], jumps: counts[EF.JUMP], trims: counts[EF.TRIM], colorChanges: counts[EF.COLOR_CHANGE],
        minutes: counts[EF.STITCH] / 650 + counts[EF.COLOR_CHANGE] * .5 + counts[EF.TRIM] * 4 / 60 + counts[EF.JUMP] / 60
      };
      const total = state.planStats.stitches;
      $("#export-state").textContent = "Stitch plan is ready.";
      render(); message(`Stitch preview generated: ${total.toLocaleString()} estimated stitches.`, "ok");
      return segments;
    } catch (error) {
      message(error.message || String(error), "error");
      throw error;
    } finally {
      state.busy = false; $("#export-pes").disabled = false;
    }
  }
  // For each segment: null when it needs a trim + jump, otherwise the list of intermediate travel
  // points (possibly empty) to sew from the previous segment's end. Tiny gaps are stitched directly.
  // Larger gaps are crossed with a running stitch that follows existing same-colour stitching
  // (A* over a coverage grid), so it is buried in the fill and never crosses open fabric.
  function planJoins(stitches = state.stitches, spacingMm = Number($("#spacing").value) || .2) {
    const trimOver = Number($("#trim-over").value);
    // A trim costs far more machine time than a few hidden travel stitches, so travel can be long.
    const mm = 25.4, joinLimit = Number.isFinite(trimOver) ? Math.max(.5, Math.min(5, trimOver)) : 1.2, maxTravel = 100, cell = Math.max(.3, spacingMm * 1.2), stitchMm = 3;
    const keyOf = (cx, cy) => cx * 8192 + cy;
    const cover = new Map();
    // Thread-color block of each segment (a new block starts at every color change).
    const blockOf = [];
    stitches.forEach((seg, i) => { blockOf.push(i && seg.color !== stitches[i - 1].color ? blockOf[i - 1] + 1 : (blockOf[i - 1] || 0)); });
    // For each cell, the last block whose dense fill (tatami/satin rows) covers it. Travel stitches may run
    // under any area that a later color will sew over, the way professional software hides them.
    const coveredLater = new Map();
    const mark = (seg, fn) => {
      for (let i = 0; i < seg.points.length; i++) {
        const q = seg.points[i], p = seg.points[Math.max(0, i - 1)];
        const ax = p.x * mm, ay = p.y * mm, bx = q.x * mm, by = q.y * mm;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell * .5)));
        for (let k = 0; k <= steps; k++) fn(keyOf(Math.floor((ax + (bx - ax) * k / steps) / cell), Math.floor((ay + (by - ay) * k / steps) / cell)));
      }
    };
    stitches.forEach((seg, index) => {
      let set = cover.get(seg.color);
      if (!set) cover.set(seg.color, set = new Set());
      mark(seg, (k) => set.add(k));
      if (seg.cover) mark(seg, (k) => { if ((coveredLater.get(k) ?? -1) < blockOf[index]) coveredLater.set(k, blockOf[index]); });
    });
    const lineCovered = (ok, a, b) => {
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell * .5));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        if (!ok(keyOf(Math.floor((a.x + (b.x - a.x) * t) / cell), Math.floor((a.y + (b.y - a.y) * t) / cell)))) return false;
      }
      return true;
    };
    const travel = (color, from, to, block) => {
      const own = cover.get(color);
      const set = { has: (k) => own.has(k) || (coveredLater.get(k) ?? -1) > block };
      const ok = (k) => set.has(k);
      const a = { x: from.x * mm, y: from.y * mm }, b = { x: to.x * mm, y: to.y * mm };
      const toInches = (p) => ({ x: p.x / mm, y: p.y / mm });
      const straight = Math.hypot(b.x - a.x, b.y - a.y);
      let route = null;
      if (lineCovered(ok, a, b)) route = [a, b];
      else {
        const sx = Math.floor(a.x / cell), sy = Math.floor(a.y / cell), gx = Math.floor(b.x / cell), gy = Math.floor(b.y / cell);
        const h = (x, y) => Math.hypot(x - gx, y - gy) * cell;
        const best = new Map([[keyOf(sx, sy), 0]]), from2 = new Map();
        const heap = [[h(sx, sy), sx, sy]];
        const push = (item) => {
          heap.push(item); let i = heap.length - 1;
          while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
        };
        const pop = () => {
          const top = heap[0], last = heap.pop();
          if (heap.length) {
            heap[0] = last; let i = 0;
            for (;;) {
              const l = 2 * i + 1, r = l + 1; let m = i;
              if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
              if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
              if (m === i) break;
              [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
            }
          }
          return top;
        };
        let found = false;
        while (heap.length) {
          const [, x, y] = pop();
          if (x === gx && y === gy) { found = true; break; }
          const g = best.get(keyOf(x, y));
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy, nk = keyOf(nx, ny);
            if (!set.has(nk) && !(nx === gx && ny === gy)) continue;
            const cost = g + (dx && dy ? 1.414 : 1) * cell;
            if (cost > maxTravel || cost >= (best.get(nk) ?? Infinity)) continue;
            best.set(nk, cost); from2.set(nk, keyOf(x, y));
            push([cost + h(nx, ny), nx, ny]);
          }
        }
        if (!found) return null;
        const cells = [];
        for (let k = keyOf(gx, gy); k !== undefined; k = from2.get(k)) cells.push(k);
        cells.reverse();
        const pts = cells.map((k) => ({ x: (Math.floor(k / 8192) + .5) * cell, y: ((k % 8192) + .5) * cell }));
        pts[0] = a; pts[pts.length - 1] = b;
        route = [a];
        for (let i = 0; i < pts.length - 1;) {
          let j = pts.length - 1;
          while (j > i + 1 && !lineCovered(ok, pts[i], pts[j])) j--;
          route.push(pts[j]); i = j;
        }
      }
      const out = [];
      for (let i = 1; i < route.length; i++) {
        const p = route[i - 1], q = route[i], pieces = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / stitchMm));
        for (let k = 1; k <= pieces; k++) if (i < route.length - 1 || k < pieces) out.push(toInches({ x: p.x + (q.x - p.x) * k / pieces, y: p.y + (q.y - p.y) * k / pieces }));
      }
      return out;
    };
    return stitches.map((segment, index) => {
      const previous = stitches[index - 1];
      if (!previous || previous.color !== segment.color) return null;
      const from = previous.points.at(-1), to = segment.points[0];
      const gap = Math.hypot(to.x - from.x, to.y - from.y) * mm;
      // Decorative fills (contour, cross-stitch) may step straight to the neighbouring row.
      if (gap <= joinLimit || (segment.link && gap <= Math.min(segment.link, 6))) return [];
      return travel(segment.color, from, to, blockOf[index]);
    });
  }
  // Machine commands for the current stitch plan in 0.1 mm units, with the design's top-left at (0, 0).
  function buildCommands() {
    const events = [];
    const orientation = $("#output-orientation").value;
    const flipX = orientation === "mirror-x" || orientation === "rotate-180" ? -1 : 1;
    const flipY = orientation === "mirror-y" || orientation === "rotate-180" ? -1 : 1;
    const toPesPoint = (point) => ({
      x: (point.x - state.hoopW / 2) * 254 * flipX,
      y: (point.y - state.hoopH / 2) * 254 * flipY
    });
    const joins = planJoins();
    const lock = $("#lock-stitches").checked, TIE = 6;
    const minStitch = Math.max(0, Math.min(10, (Number($("#min-stitch").value) || 0) * 10));
    // Adds a stitch, skipping repeats and too-short stitches, and splitting anything longer than 12 mm.
    const addStitch = (color, p, keep = false) => {
      const prev = events.at(-1);
      if (prev && Math.round(prev.x) === Math.round(p.x) && Math.round(prev.y) === Math.round(p.y)) return;
      if (!keep && minStitch && prev && prev.cmd === "stitch" && Math.hypot(p.x - prev.x, p.y - prev.y) < minStitch) return;
      if (prev) {
        const d = Math.hypot(p.x - prev.x, p.y - prev.y), pieces = Math.ceil(d / 120);
        for (let k = 1; k < pieces; k++) events.push({ cmd: "stitch", color, x: prev.x + (p.x - prev.x) * k / pieces, y: prev.y + (p.y - prev.y) * k / pieces });
      }
      events.push({ cmd: "stitch", color, x: p.x, y: p.y });
    };
    // Direction from `from` to the first point at least 0.4 mm away along `list`.
    const direction = (from, list) => {
      for (const q of list) {
        const dx = q.x - from.x, dy = q.y - from.y, l = Math.hypot(dx, dy);
        if (l >= 4) return { x: dx / l, y: dy / l };
      }
      return null;
    };
    state.stitches.forEach((segment, index) => {
      const colorIndex = segment.color;
      const pts = segment.points.map(toPesPoint);
      const first = pts[0];
      const previous = state.stitches[index - 1];
      const lastPoint = previous && previous.color === colorIndex ? previous.points.at(-1) : null;
      if (joins[index]) {
        // Connections are sewn so the machine does not cut the thread between every row.
        for (const point of joins[index]) addStitch(colorIndex, toPesPoint(point));
        addStitch(colorIndex, first);
      } else {
        if (lastPoint) events.push({ cmd: "trim", color: colorIndex, x: toPesPoint(lastPoint).x, y: toPesPoint(lastPoint).y });
        events.push({ cmd: "jump", color: colorIndex, x: first.x, y: first.y });
        const u = lock ? direction(first, pts.slice(1)) : null;
        if (u) { addStitch(colorIndex, { x: first.x + u.x * TIE, y: first.y + u.y * TIE }, true); addStitch(colorIndex, first, true); }
      }
      for (const point of pts.slice(1)) addStitch(colorIndex, point);
      const next = state.stitches[index + 1];
      if (lock && (!next || !joins[index + 1])) {
        const end = pts.at(-1), u = direction(end, pts.slice(0, -1).reverse());
        if (u) { addStitch(colorIndex, { x: end.x + u.x * TIE, y: end.y + u.y * TIE }, true); addStitch(colorIndex, end, true); }
      }
      if (next && next.color !== colorIndex) {
        const pesPoint = pts.at(-1);
        events.push({ cmd: "color", color: next.color, x: pesPoint.x, y: pesPoint.y });
      }
    });
    if (!events.length) throw new Error("There are no stitches to export.");
    // The machine reads the PEC stitch block with the design's top-left corner at (0,0)
    // (as other PES writers do). A centered design shows only its bottom-right quadrant.
    let offsetX = Infinity, offsetY = Infinity;
    for (const e of events) { if (e.x < offsetX) offsetX = e.x; if (e.y < offsetY) offsetY = e.y; }
    for (const event of events) { event.x = Math.round(event.x - offsetX); event.y = Math.round(event.y - offsetY); }
    const hoopLimitX = state.hoopW * 254 + 2;
    const hoopLimitY = state.hoopH * 254 + 2;
    if (events.some((event) => !Number.isFinite(event.x) || !Number.isFinite(event.y)
      || event.x > hoopLimitX || event.y > hoopLimitY)) {
      throw new Error("Generated stitch coordinates exceed the selected hoop. Regenerate the stitch plan and check the design bounds.");
    }
    const C = EF;
    const commands = [];
    for (const e of events) {
      const cmd = e.cmd === "stitch" ? C.STITCH : e.cmd === "jump" ? C.JUMP : e.cmd === "trim" ? C.TRIM : C.COLOR_CHANGE;
      const prev = commands.at(-1);
      // PEC moves are 12-bit; split very long jumps (only possible on the largest hoops).
      if (cmd === C.JUMP && prev) {
        const pieces = Math.ceil(Math.max(Math.abs(e.x - prev[0]), Math.abs(e.y - prev[1])) / 2000);
        for (let k = 1; k < pieces; k++) commands.push([Math.round(prev[0] + (e.x - prev[0]) * k / pieces), Math.round(prev[1] + (e.y - prev[1]) * k / pieces), C.JUMP]);
      }
      commands.push([e.x, e.y, cmd]);
    }
    const last = commands.at(-1);
    commands.push([last[0], last[1], C.END]);
    const threads = [state.stitchColors[events[0].color], ...events.filter((e) => e.cmd === "color").map((e) => state.stitchColors[e.color])];
    return { commands, threads };
  }
  async function exportPes() {
    const format = $("#export-format").value === "dst" ? "dst" : "pes";
    const baseName = designName(), fileName = `${baseName}.${format}`;
    let handle;
    try { handle = await pickSaveHandle(fileName, format === "dst" ? "Tajima DST embroidery file" : "Brother PES embroidery file", "application/octet-stream", "." + format); }
    catch (error) { message("Export cancelled.", "info"); return; }
    try {
      if (state.stale || !state.stitches.length) await makeStitches();
      const { commands, threads } = buildCommands();
      const bytes = format === "dst"
        ? EF.writeDst({ commands, threads, name: baseName, threadNames: threads.map((hex) => colorSettings(hex).name || "") })
        : EF.writePes({ commands, threads, name: baseName, machineThreads: threads.map((hex) => { const m = machineThread(hex); return m.chosen ? m.index : null; }) });
      // Read the file back the way a machine does and check it before saving.
      const parsed = format === "dst" ? EF.readDst(bytes) : EF.readPes(bytes);
      const sewn = EF.checkCommands(parsed.commands);
      if (format === "pes") {
        if (new TextDecoder().decode(bytes.slice(0, 8)) !== "#PES0001" || bytes.length < 600) throw new Error("The PES writer returned an incomplete file.");
        if (parsed.colors.length !== threads.length) throw new Error("PES check failed: thread colors do not match the color changes.");
      }
      const saved = await saveBlob(new Blob([bytes], { type: "application/octet-stream" }), fileName, handle);
      const stops = threads.length - 1;
      message(`Saved ${saved}: ${format.toUpperCase()} generated and reopened for validation (${bytes.length.toLocaleString()} bytes, ${sewn.toLocaleString()} stitches, ${threads.length} thread${threads.length === 1 ? "" : "s"}${stops ? `, ${stops} color change${stops === 1 ? "" : "s"}` : ""}). Verify in Brother software and test on scrap fabric before sewing.`, "ok");
    } catch (error) {
      console.error(error);
      const details = String(error.message || error).split("\n").filter(Boolean).slice(-1)[0];
      message(details || "Could not create the embroidery file.", "error");
    }
  }

  // ---------------------------------------------------------------- UI wiring
  document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  function syncColorInputs(color) {
    state.color = color;
    for (const id of ["#active-color", "#obj-fill"]) $(id).value = color;
    const brother = EF.nearestBrother(color);
    $("#thread-chip").style.background = color;
    $("#thread-name").textContent = brother.hex === color ? brother.name : `≈ ${brother.name}`;
    $("#thread-btn").title = `Thread color ${color.toUpperCase()} · nearest Brother thread: ${brother.name}`;
  }
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle("active", on); tab.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll("[data-pane]").forEach((pane) => { pane.hidden = pane.dataset.pane !== name; });
  }
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { showTab(tab.dataset.tab); render(); }));

  // Thread picker: Brother's 63 standard colors plus any custom color.
  const pop = $("#thread-pop"), grid = $("#brother-grid");
  EF.BROTHER.forEach((thread, index) => {
    if (!thread || index === 64) return;
    const button = document.createElement("button");
    const hex = EF.rgbToHex(thread[0], thread[1], thread[2]);
    button.type = "button"; button.style.background = hex; button.dataset.hex = hex;
    button.title = `${thread[3]} · Brother #${index}`; button.setAttribute("aria-label", thread[3]);
    grid.appendChild(button);
  });
  function pickThread(hex) {
    syncColorInputs(hex);
    const obj = selectedObject();
    const regionSelected = obj?.type === "image" && state.selectedRegion?.id === obj.id;
    if (obj && (obj.type !== "image" || regionSelected)) applySelectedColor();
  }
  grid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-hex]");
    if (!button) return;
    pickThread(button.dataset.hex);
    pop.hidden = true; $("#thread-btn").setAttribute("aria-expanded", "false");
  });
  $("#thread-btn").addEventListener("click", () => {
    pop.hidden = !pop.hidden; $("#thread-btn").setAttribute("aria-expanded", String(!pop.hidden));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!pop.hidden && !pop.contains(event.target) && !$("#thread-btn").contains(event.target)) {
      pop.hidden = true; $("#thread-btn").setAttribute("aria-expanded", "false");
    }
  });
  $("#active-color").addEventListener("input", (event) => syncColorInputs(event.target.value));
  $("#active-color").addEventListener("change", (event) => pickThread(event.target.value));
  $("#obj-fill").addEventListener("input", (event) => syncColorInputs(event.target.value));
  $("#obj-fill").addEventListener("change", (event) => {
    const obj = selectedObject(); if (!obj) return;
    syncColorInputs(event.target.value);
    applySelectedColor();
  });

  // Style lists
  for (const id of ["#line-style", "#tool-line-style"]) for (const [value, label] of LINE_STYLES) $(id).add(new Option(label, value));
  $("#tool-line-style").value = "triple";
  const OUTLINE_STYLES = [
    ["satin", "Smooth satin border"], ["fill", "Filled band"], ["satin-edge", "Satin + edge line"], ["double", "Double satin rings"],
    ["bold", "Bold stroke"], ["running", "Thin running stitch"], ["triple", "Triple running stitch"], ["zigzag", "Zigzag"],
    ["blanket", "Blanket"], ["scallop", "Scallop"], ["wave", "Wave"], ["cross", "Cross"], ["hearts", "Hearts"], ["stars", "Stars"], ["diamonds", "Diamonds"]
  ];
  for (const [value, label] of OUTLINE_STYLES) $("#outline-mode").add(new Option(label, value));
  $("#color-fill").add(new Option("Same as design", "default"));
  for (const [value, label] of FILL_STYLES) { $("#color-fill").add(new Option(label, value)); $("#default-fill").add(new Option(label, value)); }
  $("#default-fill").value = "tatami";
  $("#color-machine").add(new Option("Automatic", ""));
  EF.BROTHER.forEach((t, i) => { if (t && i < 64) $("#color-machine").add(new Option(`${i} · ${t[3]}`, String(i))); });

  // Machine thread: which Brother thread the machine asks for. The design colors stay as they are.
  $("#color-machine").addEventListener("change", () => {
    if (!state.edgeColor) return;
    snapshot();
    const value = Number($("#color-machine").value), settings = selectedGapFillSettings();
    if (value >= 1 && value <= 63) settings.brother = value; else delete settings.brother;
    render();
    const m = machineThread(state.edgeColor);
    message(`Your machine will ask for ${m.name} (#${m.index}) for this color.`, "ok");
  });
  $("#default-fill").addEventListener("change", () => {
    invalidateStitches();
    if ($("#default-fill").value === "auto") message("Auto fill: each part gets satin or tatami, with its own angle and underlay, based on its shape and size.", "info");
  });

  // Advanced tab
  const syncBorderFields = () => $("#border-fields").classList.toggle("off", !$("#border-on").checked);
  for (const id of ["#border-on", "#border-shape", "#border-style", "#border-width", "#border-gap", "#border-color", "#border-edge",
    "#baste-on", "#knockdown-on", "#knockdown-color", "#trim-over", "#min-stitch"]) {
    $(id).addEventListener("change", () => { syncBorderFields(); invalidateStitches(); });
  }
  syncBorderFields();
  // Fabric presets, roughly what digitizing software suggests for each fabric.
  // Row spacing, underlay and pull compensation that suit each fabric, plus the stabilizer to use.
  const FABRICS = {
    towel: { spacing: .35, underlay: "heavy", pull: .3, knockdown: true, label: "towel / terry cloth", tip: "Tear-away stabilizer underneath and water-soluble topping on top so stitches don't sink into the loops." },
    denim: { spacing: .38, underlay: "light", pull: .15, knockdown: false, label: "denim / jeans", tip: "Tear-away or light cut-away stabilizer. Use a size 90 denim needle." },
    hoodie: { spacing: .4, underlay: "medium", pull: .3, knockdown: false, label: "cotton hoodie / sweatshirt", tip: "Cut-away stabilizer (it stretches). Hoop the stabilizer, not just the fabric." },
    tee: { spacing: .42, underlay: "medium", pull: .3, knockdown: false, label: "cotton T-shirt", tip: "No-show mesh cut-away stabilizer, fused on, keeps knits from puckering. Keep designs light." },
    polo: { spacing: .4, underlay: "medium", pull: .25, knockdown: false, label: "polo shirt (piqué)", tip: "Cut-away stabilizer plus water-soluble topping to stop the textured knit poking through." },
    fleece: { spacing: .4, underlay: "heavy", pull: .3, knockdown: true, label: "fleece / minky", tip: "Cut-away stabilizer and water-soluble topping. Don't press fleece with a hot iron." },
    athletic: { spacing: .42, underlay: "medium", pull: .3, knockdown: false, label: "athletic / performance shirt", tip: "No-show mesh cut-away stabilizer and a ballpoint needle; avoid very dense designs." },
    canvas: { spacing: .38, underlay: "light", pull: .1, knockdown: false, label: "canvas tote / duck cloth", tip: "Tear-away stabilizer. Sturdy fabric: dense designs sew well." },
    quilting: { spacing: .4, underlay: "light", pull: .2, knockdown: false, label: "quilting cotton", tip: "Medium tear-away stabilizer. Starch the fabric first for crisp results." },
    cap: { spacing: .4, underlay: "medium", pull: .25, knockdown: false, label: "cap / hat", tip: "Tear-away cap backing. Keep the design low and centered on the front panel." },
    felt: { spacing: .38, underlay: "medium", pull: .15, knockdown: false, label: "felt / patches", tip: "Tear-away or water-soluble stabilizer. Add a satin border on the Advanced tab for a patch edge." },
    leather: { spacing: .45, underlay: "light", pull: .1, knockdown: false, label: "leather / vinyl", tip: "Tear-away stabilizer, a leather needle and a lighter design: every hole is permanent." },
    silk: { spacing: .45, underlay: "light", pull: .1, knockdown: false, label: "silk / thin fabric", tip: "Water-soluble or no-show mesh stabilizer and a fine needle; keep designs light." }
  };
  $("#fabric-preset").addEventListener("change", () => {
    const preset = FABRICS[$("#fabric-preset").value];
    $("#fabric-tip").textContent = preset ? preset.tip : "";
  });
  $("#apply-fabric").addEventListener("click", () => {
    const preset = FABRICS[$("#fabric-preset").value];
    if (!preset) { message("Choose what you are sewing on first.", "info"); return; }
    $("#spacing").value = String(preset.spacing); $("#underlay").value = preset.underlay;
    $("#pull-comp").value = String(preset.pull); $("#knockdown-on").checked = preset.knockdown;
    $("#fabric-tip").textContent = preset.tip;
    invalidateStitches();
    message(`Set for ${preset.label}: row spacing ${preset.spacing} mm, ${preset.underlay} underlay, pull comp. ${preset.pull} mm${preset.knockdown ? ", knockdown base on" : ""}. ${preset.tip}`, "ok");
  });

  // A slider or field that edits live: one undo step per drag.
  function liveEdit(element, apply) {
    let editing = false;
    element.addEventListener("input", () => { if (!editing) { snapshot(); editing = true; } apply(); });
    element.addEventListener("change", () => { if (!editing) snapshot(); apply(); editing = false; });
  }

  $("#ignore-white").addEventListener("change", (event) => {
    const obj = selectedObject();
    if (!event.target.checked) {
      if (obj?.type === "image") message("Retrace the selected image to bring the near-white regions back.", "info");
      return;
    }
    if (obj?.type !== "image") return;
    const whites = obj.regions.filter((region) => isNearWhite(region.fill));
    if (!whites.length) return;
    snapshot();
    obj.regions.forEach((region) => { if (isNearWhite(region.fill)) region.fill = "none"; });
    refreshImageCrop(obj);
    changed(); message(`Ignored ${whites.length} near-white traced region(s).`, "ok");
  });
  $("#hoop").addEventListener("change", () => {
    $("#custom-row").hidden = $("#hoop").value !== "custom";
    if ($("#hoop").value !== "custom") setHoop(...hoopSizes[$("#hoop").value]);
    else setHoop(Number($("#custom-width").value), Number($("#custom-height").value));
  });
  $("#custom-width").addEventListener("change", () => setHoop(Number($("#custom-width").value), Number($("#custom-height").value)));
  $("#custom-height").addEventListener("change", () => setHoop(Number($("#custom-width").value), Number($("#custom-height").value)));
  $("#brush-size").addEventListener("input", (event) => {
    const size = Number(event.target.value);
    $("#brush-size-label").textContent = `${size.toFixed(1)} mm`;
    updateToolCursor();
    if (state.drawing?.type === "draw") drawShapeGhost();
  });
  $("#trace-colors").addEventListener("change", () => {
    if (selectedObject()?.type === "image") message("Color count changed. Retrace the selected image to apply it.", "info");
  });
  let liveTraceTimer = null, liveTraceBusy = false;
  $("#trace-detail").addEventListener("input", (event) => {
    $("#trace-detail-value").textContent = `${event.target.value}%`;
    const obj = selectedObject();
    if (obj?.type !== "image" || !obj.sourceDataUrl) return;
    clearTimeout(liveTraceTimer);
    liveTraceTimer = setTimeout(async () => {
      if (liveTraceBusy) return;
      liveTraceBusy = true;
      try { await retraceSelectedImage({ live: true }); } finally { liveTraceBusy = false; }
    }, 250);
  });
  $("#trace-detail").addEventListener("change", () => {
    clearTimeout(liveTraceTimer);
    if (!liveTraceBusy && selectedObject()?.type === "image" && selectedObject().sourceDataUrl) {
      liveTraceBusy = true;
      retraceSelectedImage({ live: true }).finally(() => { liveTraceBusy = false; liveSnapshotTaken = false; });
    } else liveSnapshotTaken = false;
  });
  $("#zoom").addEventListener("input", (event) => zoomCanvas(Number(event.target.value) / 100));
  $("#zoom-in").addEventListener("click", () => zoomCanvas(state.zoom * 1.25));
  $("#zoom-out").addEventListener("click", () => zoomCanvas(state.zoom / 1.25));
  $("#fit-view").addEventListener("click", fitView);

  async function importPicture(file) {
    if (!file) return;
    message(`Tracing ${file.name}…`, "busy");
    showTab("object");
    await new Promise((resolve) => setTimeout(resolve, 30));
    try { await traceImage(file); }
    catch (error) { console.error(error); message(error.message, "error"); }
  }
  $("#artwork-file").addEventListener("change", async (event) => {
    await importPicture(event.target.files[0]);
    event.target.value = "";
  });
  // Drag a picture (or a saved project) onto the hoop.
  stageWrap.addEventListener("dragover", (event) => {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) return;
    event.preventDefault(); $("#drop-hint").hidden = false;
  });
  stageWrap.addEventListener("dragleave", (event) => { if (!stageWrap.contains(event.relatedTarget)) $("#drop-hint").hidden = true; });
  stageWrap.addEventListener("drop", async (event) => {
    event.preventDefault(); $("#drop-hint").hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (/\.json$/i.test(file.name)) {
      try { await openProject(file); message("Project opened.", "ok"); } catch (error) { message(error.message || "Could not open the project.", "error"); }
    } else if (/\.(pes|dst)$/i.test(file.name)) message("To look at an embroidery file, open the PES viewer and choose Open .pes / .dst file.", "info");
    else await importPicture(file);
  });

  $("#retrace-image").addEventListener("click", () => retraceSelectedImage());
  $("#add-text").addEventListener("click", () => addText());
  $("#add-text-btn").addEventListener("click", () => addText());
  $("#add-shape-btn").addEventListener("click", () => { setTool("rect"); message("Drag on the canvas to draw a filled rectangle.", "info"); });
  $("#delete-selection").addEventListener("click", deleteSelected);
  $("#clear-canvas").addEventListener("click", clearCanvas);
  $("#bring-front").addEventListener("click", () => {
    const obj = selectedObject(); if (!obj) return;
    snapshot(); state.objects = [...state.objects.filter((item) => item.id !== obj.id), obj]; changed();
  });
  $("#send-back").addEventListener("click", () => {
    const obj = selectedObject(); if (!obj) return;
    snapshot(); state.objects = [obj, ...state.objects.filter((item) => item.id !== obj.id)]; changed();
  });
  function withSelected(fn) {
    const obj = selectedObject(); if (!obj) return;
    snapshot(); fn(obj); changed();
  }
  $("#flip-h").addEventListener("click", () => withSelected((obj) => { obj.flipX = !obj.flipX; }));
  $("#flip-v").addEventListener("click", () => withSelected((obj) => { obj.flipY = !obj.flipY; }));
  $("#center-obj").addEventListener("click", () => withSelected((obj) => { obj.x = state.hoopW / 2; obj.y = state.hoopH / 2; }));
  function duplicateSelected() {
    const obj = selectedObject(); if (!obj) return;
    snapshot();
    const copy = JSON.parse(JSON.stringify(obj));
    copy.id = uid(); copy.x += .2; copy.y += .2;
    state.objects.push(copy); state.selectedId = copy.id; state.selectedRegion = null;
    changed(); message("Duplicated.", "ok");
  }
  $("#duplicate").addEventListener("click", duplicateSelected);
  for (const [selector, key, min, max] of [["#obj-x", "x", -14, 28], ["#obj-y", "y", -14, 28], ["#obj-w", "width", .05, 14], ["#obj-h", "height", .05, 14]]) {
    $(selector).addEventListener("change", () => { if (selectedObject()) snapshot(); setNumber(selector, key, min, max); });
  }
  $("#obj-rotation").addEventListener("change", () => {
    const obj = selectedObject(), angle = Number($("#obj-rotation").value);
    if (!obj || !Number.isFinite(angle) || angle < -180 || angle > 180) return;
    snapshot(); obj.rotation = angle; changed();
  });

  // Text
  $("#text-entry").addEventListener("focus", () => { if (selectedObject()?.type === "text") snapshot(); });
  $("#text-entry").addEventListener("input", () => updateText((obj) => { obj.text = $("#text-entry").value || " "; }));
  $("#text-entry").addEventListener("keydown", (event) => { if (event.key === "Enter") event.target.blur(); });
  $("#font").addEventListener("change", () => {
    if (selectedObject()?.type !== "text") return;
    snapshot(); updateText((obj) => { obj.font = $("#font").value; });
  });
  $("#text-size").addEventListener("change", () => {
    const size = Number($("#text-size").value);
    if (selectedObject()?.type !== "text" || !Number.isFinite(size) || size < .1 || size > 4) return;
    snapshot();
    updateText((obj) => {
      // Keep the letters exactly the requested height: drop any stretch from earlier resizing.
      obj.sizeIn = size; obj.width = obj.baseW; obj.height = obj.baseH;
    });
  });
  liveEdit($("#text-curve"), () => {
    $("#text-curve-value").textContent = $("#text-curve").value;
    updateText((obj) => { obj.curve = Number($("#text-curve").value); });
  });
  liveEdit($("#text-spacing"), () => {
    $("#text-spacing-value").textContent = $("#text-spacing").value;
    updateText((obj) => { obj.spacing = Number($("#text-spacing").value); });
  });
  stage.addEventListener("dblclick", () => {
    if (selectedObject()?.type !== "text") return;
    showTab("object"); $("#text-entry").focus(); $("#text-entry").select();
  });

  // Sew-as for shapes and brush strokes
  document.querySelectorAll("[data-sew]").forEach((button) => button.addEventListener("click", () => {
    const obj = selectedObject();
    if (!obj || (obj.type !== "draw" && obj.type !== "shape")) return;
    const line = button.dataset.sew === "line";
    if (isLineObject(obj) === line) return;
    snapshot();
    obj.stitchAs = line ? "line" : "fill";
    if (line && !obj.lineStyle) {
      obj.lineStyle = obj.type === "shape" ? "satin" : "triple";
      obj.lineWidth = obj.brushWidth ? Math.max(.5, Math.round(obj.brushWidth * 25.4 * 2) / 2) : 3;
    }
    changed();
  }));
  $("#line-style").addEventListener("change", () => withSelected((obj) => { if (isLineObject(obj)) obj.lineStyle = $("#line-style").value; }));
  $("#line-width").addEventListener("change", () => {
    const width = Math.max(.5, Math.min(10, Number($("#line-width").value) || 2));
    withSelected((obj) => { if (isLineObject(obj)) { obj.lineWidth = width; if (obj.type === "draw") obj.brushWidth = width / 25.4; } });
  });

  // Layers & colors: one list with eye, order arrows and remove buttons on every row.
  function removeColorFromLayer(obj, color) {
    if (!obj || obj.type !== "image") return;
    const hits = obj.regions.filter((region) => region.fill === color);
    if (!hits.length) return;
    snapshot();
    hits.forEach((region) => { region.fill = "none"; if (region.brushWidth) region.filled = false; });
    refreshImageCrop(obj);
    state.selectedRegion = null;
    changed();
    message(`Removed ${color.toUpperCase()} (${hits.length} region${hits.length === 1 ? "" : "s"}) from stitching. Undo brings it back.`, "ok");
  }
  $("#layers").addEventListener("click", (event) => {
    const find = (attr) => event.target.closest(`[${attr}]`);
    const objectOf = (id) => state.objects.find((obj) => obj.id === id);
    let el;
    if ((el = find("data-layer-move"))) {
      moveLayer(el.dataset.layerId, el.dataset.dir === "up" ? 1 : -1);
      return;
    }
    if ((el = find("data-color-move"))) {
      moveImageColor(el.dataset.color, el.dataset.dir === "up" ? 1 : -1, objectOf(el.dataset.objectId));
      return;
    }
    if ((el = find("data-delete-layer"))) {
      state.selectedId = el.dataset.deleteLayer; state.selectedRegion = null;
      deleteSelected();
      return;
    }
    if ((el = find("data-remove-color"))) {
      removeColorFromLayer(objectOf(el.dataset.objectId), el.dataset.removeColor);
      return;
    }
    if ((el = find("data-toggle-color"))) {
      const color = el.dataset.toggleColor;
      if (state.hiddenColors.has(color)) state.hiddenColors.delete(color);
      else state.hiddenColors.add(color);
      render();
      return;
    }
    if ((el = find("data-toggle-object"))) {
      const colors = imageColorOrder(objectOf(el.dataset.toggleObject) || { regions: [] });
      const allHidden = colors.every((c) => state.hiddenColors.has(c));
      colors.forEach((c) => (allHidden ? state.hiddenColors.delete(c) : state.hiddenColors.add(c)));
      render();
      return;
    }
    if ((el = find("data-select-id"))) {
      state.selectedId = el.dataset.selectId; state.selectedRegion = null; state.activeColor = null; render();
      return;
    }
    const row = find("data-edge-color");
    if (!row) return;
    // The eraser and the edge sliders now work on this color only.
    state.activeColor = row.closest(".sub") ? { id: row.dataset.objectId, color: row.dataset.edgeColor } : null;
    editingEdgeSettings = false;
    state.edgeColor = row.dataset.edgeColor;
    state.antsDismissed = false;
    // Clicking the checkbox or color box must not rebuild the list (that would close the color picker).
    if (event.target.closest("input")) { renderEdgeColorChoices(); return; }
    // Already selected: keep the list as it is so a double-click can rename the color.
    if (state.selectedId === row.dataset.objectId && row.classList.contains("current")) return;
    state.selectedId = row.dataset.objectId; state.selectedRegion = null;
    render();
  });
  // Double-click a color's name to rename it. Names are for you; the machine shows Brother's thread names.
  $("#layers").addEventListener("dblclick", (event) => {
    const label = event.target.closest(".tname");
    const row = label?.closest("[data-edge-color]");
    if (!row || label.querySelector("input")) return;
    const color = row.dataset.edgeColor;
    const input = document.createElement("input");
    input.type = "text"; input.maxLength = 40; input.value = colorSettings(color).name || "";
    input.placeholder = color.toUpperCase(); input.setAttribute("aria-label", "Color name");
    input.style.cssText = "height:24px;font-size:12px;padding:0 5px;width:100%";
    label.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) {
        const name = input.value.trim();
        if (name !== (colorSettings(color).name || "")) {
          snapshot();
          if (!state.gapFillSettings.has(color)) state.gapFillSettings.set(color, colorSettings(color));
          const settings = state.gapFillSettings.get(color);
          if (name) settings.name = name; else delete settings.name;
          message(name ? `Named ${color.toUpperCase()} “${name}”. Your Brother machine will still show ${EF.nearestBrother(color).name}.` : "Color name cleared.", "ok");
        }
      }
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  });
  $("#layers").addEventListener("change", (event) => {
    const input = event.target.closest("[data-palette-color]"); if (!input) return;
    const previous = input.dataset.paletteColor, next = input.value;
    if (previous === next) return;
    snapshot();
    remapColors(new Map([[previous, next]]));
    changed();
  });
  $("#layers").addEventListener("change", (event) => {
    const check = event.target.closest("[data-merge-color]");
    if (!check) return;
    if (check.checked) state.selectedPaletteColors.add(check.dataset.mergeColor);
    else state.selectedPaletteColors.delete(check.dataset.mergeColor);
  });
  // Recolors everything using `map` (old hex → new hex), carrying per-color settings along.
  function remapColors(map) {
    for (const [previous, next] of map) {
      if (previous === next) continue;
      if (state.hiddenColors.delete(previous)) state.hiddenColors.add(next);
      if (state.gapFillSettings.has(previous)) {
        const settings = state.gapFillSettings.get(previous);
        if (!state.gapFillSettings.has(next)) state.gapFillSettings.set(next, settings);
        state.gapFillSettings.delete(previous);
      }
      if (state.edgeColor === previous) state.edgeColor = next;
      if (state.selectedPaletteColors.delete(previous)) state.selectedPaletteColors.add(next);
      if (state.color === previous) syncColorInputs(next);
    }
    for (const obj of state.objects) {
      if (obj.type === "image") obj.regions.forEach((region) => { if (map.has(region.fill)) region.fill = map.get(region.fill); });
      else if (map.has(obj.fill)) obj.fill = map.get(obj.fill);
    }
  }
  $("#snap-brother").addEventListener("click", () => {
    const colors = allColors();
    if (!colors.length) { message("There are no colors to match yet.", "info"); return; }
    snapshot();
    const map = new Map(colors.map((color) => [color, EF.nearestBrother(color).hex]));
    remapColors(map);
    const after = new Set(map.values()).size;
    changed();
    message(`Matched ${colors.length} thread color${colors.length === 1 ? "" : "s"} to the nearest Brother threads (${after} after matching).`, "ok");
  });
  $("#color-fill").addEventListener("change", () => {
    if (!state.edgeColor) return;
    snapshot();
    selectedGapFillSettings().fill = $("#color-fill").value;
    invalidateStitches();
    const label = FILL_STYLES.find(([v]) => v === resolveFill($("#color-fill").value))?.[1];
    if ($("#color-fill").value === "auto") message("Auto fill: each part of this color gets satin or tatami, with its own angle and underlay.", "info");
    else if ($("#color-fill").value === "applique") message("Appliqué: the machine sews a placement line, stops for your fabric, tacks it down, stops so you can trim, then sews a satin edge.", "info");
    else message(`${label} fill set for this color.`, "ok");
  });
  $("#color-angle").addEventListener("change", () => {
    if (!state.edgeColor) return;
    const value = $("#color-angle").value.trim(), angle = Number(value);
    snapshot();
    selectedGapFillSettings().angle = value === "" || !Number.isFinite(angle) ? null : Math.max(0, Math.min(179, angle));
    invalidateStitches();
  });
  $("#combine-colors").addEventListener("click", combineColors);
  $("#remove-colors").addEventListener("click", removeSelectedColors);


  // Files
  $("#project-save").addEventListener("click", exportProject);
  $("#project-file").addEventListener("change", async (event) => {
    try { await openProject(event.target.files[0]); message("Project opened.", "ok"); }
    catch (error) { console.error(error); message(error.message || "Could not open the project.", "error"); }
    finally { event.target.value = ""; }
  });

  // Undo / redo
  function undo() {
    const previous = state.history.pop(); if (!previous) return;
    state.future.push(serializeState());
    restoreSnapshot(previous); state.selectedId = null; state.selectedRegion = null; invalidateStitches();
    message("Last vector edit undone.", "ok");
  }
  function redo() {
    const next = state.future.pop(); if (!next) return;
    state.history.push(serializeState());
    restoreSnapshot(next); state.selectedId = null; state.selectedRegion = null; invalidateStitches();
    message("Last vector edit redone.", "ok");
  }
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);

  // Keyboard
  const SHORTCUTS = { v: "select", f: "fill", i: "pick", x: "remove", b: "draw", l: "line", e: "erase", r: "rect", o: "ellipse" };
  window.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    const typing = active && (/TEXTAREA|SELECT/.test(active.tagName) || (active.tagName === "INPUT" && !["checkbox", "range", "color", "button"].includes(active.type)));
    if (document.querySelector("#viewer[open]")) return;
    if (event.code === "Space" && stage.contains(event.target)) { state.spaceDown = true; event.preventDefault(); }
    const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (mod && key === "s") { event.preventDefault(); exportProject(); return; }
    if (typing) return;
    if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); undo(); return; }
    if (mod && (key === "y" || (key === "z" && event.shiftKey))) { event.preventDefault(); redo(); return; }
    if (mod && key === "d") { event.preventDefault(); duplicateSelected(); return; }
    if (mod || event.altKey) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelected(); return; }
    if (event.key === "Escape") { pop.hidden = true; state.selectedId = null; state.selectedRegion = null; setTool("select"); return; }
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (nudge && selectedObject()) {
      event.preventDefault();
      const obj = selectedObject(), step = event.shiftKey ? .1 : .02;
      if (!event.repeat) snapshot();
      obj.x += nudge[0] * step; obj.y += nudge[1] * step;
      invalidateStitches();
      return;
    }
    if (SHORTCUTS[key]) { setTool(SHORTCUTS[key]); return; }
    if (key === "t") { addText(); event.preventDefault(); return; }
    if (key === "0") { fitView(); return; }
    if (key === "+" || key === "=") { zoomCanvas(state.zoom * 1.25); return; }
    if (key === "-") { zoomCanvas(state.zoom / 1.25); }
  });
  window.addEventListener("keyup", (event) => { if (event.code === "Space") state.spaceDown = false; });

  // Per-color edge settings
  function updateEdgeSettingsPreview() {
    state.stale = true;
    state.stitches = [];
    $("#export-state").textContent = "Planned when you preview or export";
    $("#stitch-count").textContent = "—";
    objectRoot.replaceChildren();
    for (const obj of state.objects) renderObject(obj);
    selectionRoot.replaceChildren();
    drawColorHighlight();
    drawSelection(selectedObject());
    drawEdgePreview();
    if ($("#stitch-preview-toggle").checked) debounceStitches();
  }
  let editingEdgeSettings = false;
  $("#gap-fill").addEventListener("input", (event) => {
    if (!editingEdgeSettings) { snapshot(); editingEdgeSettings = true; }
    $("#gap-fill-value").textContent = `${Number(event.target.value).toFixed(1)} mm`;
    selectedGapFillSettings().strokeMm = Number(event.target.value);
    updateEdgeSettingsPreview();
  });
  $("#gap-fill").addEventListener("change", () => { editingEdgeSettings = false; });
  $("#inside-stroke").addEventListener("input", (event) => {
    if (!editingEdgeSettings) { snapshot(); editingEdgeSettings = true; }
    $("#inside-stroke-value").textContent = `${Number(event.target.value).toFixed(1)} mm`;
    selectedGapFillSettings().insideMm = Number(event.target.value);
    updateEdgeSettingsPreview();
  });
  $("#inside-stroke").addEventListener("change", () => { editingEdgeSettings = false; });
  // Remove the color shown in the "Editing" banner from stitching, everywhere it is used.
  $("#color-settings").addEventListener("click", (event) => {
    if (!event.target.closest("#remove-edge-color")) return;
    const color = state.edgeColor;
    if (!color) return;
    snapshot();
    let count = 0;
    for (const obj of state.objects) {
      if (obj.type === "image") {
        obj.regions.forEach((region) => { if (region.fill === color) { region.fill = "none"; if (region.brushWidth) region.filled = false; count++; } });
        refreshImageCrop(obj);
      } else if (obj.fill === color) { obj.fill = "none"; count++; }
    }
    state.selectedRegion = null;
    changed();
    message(`Removed ${color.toUpperCase()} (${count} region${count === 1 ? "" : "s"}) from stitching. Undo brings it back.`, "ok");
  });
  $("#color-smooth").addEventListener("input", (event) => {
    if (!editingEdgeSettings) { snapshot(); editingEdgeSettings = true; }
    $("#color-smooth-value").textContent = `${Number(event.target.value).toFixed(2)} mm`;
    selectedGapFillSettings().smoothMm = Number(event.target.value);
    updateEdgeSettingsPreview();
  });
  $("#color-smooth").addEventListener("change", () => { editingEdgeSettings = false; });

  // Stitch settings
  for (const id of ["#spacing", "#angle", "#stitch-length", "#underlay", "#pull-comp", "#pattern-size", "#outline-color", "#outline-color2", "#outline-width", "#outline-gap", "#outline-target"]) {
    $(id).addEventListener("change", () => { linePreviewCache.clear(); invalidateStitches(); });
  }
  $("#outline-mode").addEventListener("change", () => {
    $("#outline-fields").hidden = $("#outline-mode").value === "off";
    invalidateStitches();
  });
  $("#stitch-preview-toggle").addEventListener("change", () => {
    if ($("#stitch-preview-toggle").checked && state.stale) debounceStitches();
    else render();
  });
  $("#export-pes").addEventListener("click", exportPes);
  // Marching-ants outline of the picked color; the choice is remembered on this device.
  try { if (localStorage.getItem("colorAnts") === "off") $("#color-ants-toggle").checked = false; } catch {}
  $("#color-ants-toggle").addEventListener("change", () => {
    try { localStorage.setItem("colorAnts", $("#color-ants-toggle").checked ? "on" : "off"); } catch {}
    if ($("#color-ants-toggle").checked) state.antsDismissed = false;
    render();
  });

  // Temporary canvas color, only for seeing the design while editing. Never stitched or saved.
  function applyCanvasColor(color) {
    $("#hoop-fabric").setAttribute("fill", color || "#fbf9f4");
    for (const id of ["#hoop-bg", "#hoop-major"]) $(id).setAttribute("opacity", color ? ".25" : "1");
  }
  $("#canvas-bg").addEventListener("change", () => {
    const value = $("#canvas-bg").value;
    if (value === "custom") { $("#canvas-bg-custom").click(); applyCanvasColor($("#canvas-bg-custom").value); return; }
    applyCanvasColor(value);
  });
  $("#canvas-bg-custom").addEventListener("input", (event) => { $("#canvas-bg").value = "custom"; applyCanvasColor(event.target.value); });

  // Scales the whole design by (sx, sy) about its center and keeps it inside the hoop. Stitches are then
  // re-planned at the new size, so density stays correct (unlike stretching an existing stitch file).
  function scaleDesign(sx, sy) {
    if (!state.objects.length) throw new Error("There is nothing to resize.");
    if (!(sx > 0 && sy > 0)) throw new Error("Enter a width and height greater than zero.");
    const ext = state.objects.map(rotatedBounds);
    const x0 = Math.min(...ext.map((b) => b.x - b.width / 2)), x1 = Math.max(...ext.map((b) => b.x + b.width / 2));
    const y0 = Math.min(...ext.map((b) => b.y - b.height / 2)), y1 = Math.max(...ext.map((b) => b.y + b.height / 2));
    const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const nw = w * sx, nh = h * sy;
    if (nw > state.hoopW + 1e-6 || nh > state.hoopH + 1e-6) {
      const k = Math.min(state.hoopW / w, state.hoopH / h);
      throw new Error(`That size does not fit the ${state.hoopW} × ${state.hoopH} in hoop. The largest that fits is about ${(w * k).toFixed(2)} × ${(h * k).toFixed(2)} in (artwork size).`);
    }
    snapshot();
    const ncx = Math.max(nw / 2, Math.min(state.hoopW - nw / 2, cx)), ncy = Math.max(nh / 2, Math.min(state.hoopH - nh / 2, cy));
    for (const obj of state.objects) {
      obj.x = ncx + (obj.x - cx) * sx; obj.y = ncy + (obj.y - cy) * sy;
      obj.width *= sx; obj.height *= sy;
    }
    changed();
  }
  // Used by previewer.js.
  window.stitchStudioBridge = {
    resizeDesign(sx, sy) { scaleDesign(sx, sy); },
    hoop() { return { w: state.hoopW, h: state.hoopH }; },
    async getDesign() {
      while (state.busy) await new Promise((resolve) => setTimeout(resolve, 50));
      state.stale = true;
      await makeStitches();
      return {
        colors: state.stitchColors, segments: state.stitches, joins: planJoins(), hoopW: state.hoopW, hoopH: state.hoopH,
        stats: state.planStats,
        threadName: (hex) => { const name = colorSettings(hex).name, brother = machineThread(hex).name; return name ? `${name} (${brother})` : brother; }
      };
    },
    async readPes(bytes, name = "") {
      return EF.toSegments(EF.readEmbroidery(bytes, name));
    },
    // For automated checks: the exact machine commands an export would write.
    buildCommands() { return buildCommands(); },
    makeStitches() { return makeStitches(); },
    state
  };

  fillFontSelect("Archivo Black");
  syncColorInputs(state.color);
  setTool("select");
  fitView();
  fontsReady.then(() => render());
  if (!window.ImageTracer) message("The picture tracer did not load (vendor/imagetracer.js is missing).", "error");
  else message("Ready. Upload artwork to trace it into editable vector regions.");
})();
