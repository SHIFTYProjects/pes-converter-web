"use strict";

(() => {
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const stage = $("#stage");
  const stageWrap = $(".stage-wrap");
  const objectRoot = $("#objects");
  const selectionRoot = $("#selection-layer");
  const statusEl = $("#status");
  const hoopSizes = { "4x4": [4, 4], "7x5": [7, 5], "12x5": [12, 5] };
  const state = {
    objects: [], selectedId: null, selectedRegion: null, tool: "select", color: "#315ce8",
    hoopW: 7, hoopH: 5, zoom: 1, viewX: 0, viewY: 0, drawing: null, erasing: null, drag: null, pan: null, spaceDown: false, history: [],
    stitches: [], stitchColors: [], selectedPaletteColors: new Set(), hiddenColors: new Set(),
    gapFillSettings: new Map(), edgeColor: null,
    stale: true, busy: false, pyodidePromise: null
  };
  let idCounter = 1;
  try {
    localStorage.removeItem("stitch-studio-project");
  } catch (error) {
    console.error("Could not clear a legacy autosaved project from browser storage.", error);
  }

  function message(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = kind;
  }
  function renderDragFrame(obj) {
    const group = objectRoot.querySelector(`[data-object-id="${obj.id}"]`);
    if (group) group.setAttribute("transform", transformFor(obj));
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
    const offsetX = (next.x + next.width / 2 - oldX - oldWidth / 2) * scaleX;
    const offsetY = (next.y + next.height / 2 - oldY - oldHeight / 2) * scaleY;
    obj.x += offsetX * Math.cos(radians) - offsetY * Math.sin(radians);
    obj.y += offsetX * Math.sin(radians) + offsetY * Math.cos(radians);
    obj.width = next.width * scaleX; obj.height = next.height * scaleY;
    obj.baseW = next.width; obj.baseH = next.height;
    obj.cropX = next.x; obj.cropY = next.y;
    return true;
  }
  function viewBox() {
    const width = state.hoopW / state.zoom, height = state.hoopH / state.zoom;
    stage.setAttribute("viewBox", `${state.viewX} ${state.viewY} ${width} ${height}`);
    for (const id of ["hoop-bg", "hoop-outline"]) {
      const el = $("#" + id);
      el.setAttribute("x", "0"); el.setAttribute("y", "0");
      el.setAttribute("width", state.hoopW); el.setAttribute("height", state.hoopH);
    }
    $("#canvas-size").textContent = `${state.hoopW} × ${state.hoopH} in hoop`;
    updateHoopSummary();
    const zoomPercent = Math.round(state.zoom * 100);
    $("#zoom-label").textContent = `${zoomPercent}%`;
    $("#zoom").value = String(Math.max(25, Math.min(400, zoomPercent)));
    fitStageToHoop();
    updateToolCursor();
  }
  function fitStageToHoop() {
    const availableWidth = stageWrap.clientWidth;
    const availableHeight = stageWrap.clientHeight;
    if (!availableWidth || !availableHeight) return;
    const hoopRatio = state.hoopW / state.hoopH;
    const stageRatio = availableWidth / availableHeight;
    const width = stageRatio > hoopRatio ? availableHeight * hoopRatio : availableWidth;
    const height = stageRatio > hoopRatio ? availableHeight : availableWidth / hoopRatio;
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
  }
  new ResizeObserver(() => { fitStageToHoop(); updateToolCursor(); }).observe(stageWrap);
  function updateHoopSummary() {
    const orientation = state.hoopW === state.hoopH ? "square" : state.hoopW > state.hoopH ? "landscape" : "portrait";
    $("#hoop-summary").textContent = `Active hoop: ${state.hoopW} × ${state.hoopH} in (${orientation})`;
  }
  function zoomCanvas(zoom, anchor) {
    const nextZoom = Math.max(.25, Math.min(4, zoom));
    const oldWidth = state.hoopW / state.zoom, oldHeight = state.hoopH / state.zoom;
    const nextWidth = state.hoopW / nextZoom, nextHeight = state.hoopH / nextZoom;
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
    const sx = b.width / (obj.baseW || b.width);
    const sy = b.height / (obj.baseH || b.height);
    return `translate(${b.x} ${b.y}) rotate(${obj.rotation || 0}) scale(${sx} ${sy}) translate(${-((obj.baseW || b.width) / 2)} ${-((obj.baseH || b.height) / 2)})`;
  }
  function hasEdgeAdjustment(color) {
    const settings = state.gapFillSettings.get(color);
    return Boolean(settings && (settings.strokeMm > 0 || settings.smoothMm > 0));
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
  function regionPath(obj, region, index) {
    const brushWidth = Number(region.brushWidth) || 0;
    const attrs = {
      d: region.d, fill: brushWidth && !region.filled ? "none" : region.fill,
      "data-region-index": index, class: "region", "pointer-events": "all"
    };
    if (brushWidth) {
      attrs.stroke = region.fill; attrs["stroke-width"] = brushWidth;
      attrs["stroke-linecap"] = "round"; attrs["stroke-linejoin"] = "round";
    }
    const path = node("path", attrs);
    if (hasEdgeAdjustment(region.fill)) {
      path.setAttribute("fill-opacity", "0");
      if (brushWidth) path.setAttribute("stroke-opacity", "0");
    }
    path.style.cursor = state.tool === "fill" || state.tool === "remove" ? "crosshair" : "inherit";
    return path;
  }
  function appendObjectMask(parent, obj, prefix, gen = 0) {
    const erasures = Array.isArray(obj.erasures) ? obj.erasures.slice(gen) : [];
    if (!erasures.length) return null;
    const id = `${prefix}-${obj.id}-erasures-${gen}`;
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
    const mask = appendObjectMask(maskParent, obj, prefix, Number(region.gen) || 0);
    if (!mask) return content;
    const host = node("g", { mask });
    content.appendChild(host);
    return host;
  }
  function renderObject(obj) {
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
        if (!state.hiddenColors.has(region.fill)) regionHost(content, group, obj, "canvas", region).appendChild(regionPath(obj, region, index));
      });
      group.appendChild(content);
    } else if (obj.type === "text") {
      if (state.hiddenColors.has(obj.fill)) return;
      const content = node("g", { mask: appendObjectMask(group, obj, "canvas") });
      const text = node("text", {
        x: obj.baseW / 2, y: obj.baseH * .73, "text-anchor": "middle",
        "font-family": obj.font || "Arial", "font-size": obj.sizeIn || .4,
        fill: obj.fill,
        "fill-opacity": hasEdgeAdjustment(obj.fill) ? "0" : "1",
        "data-object-part": "text"
      });
      text.textContent = obj.text;
      content.appendChild(text);
      group.appendChild(content);
    } else if (obj.type === "shape" || obj.type === "draw") {
      if (state.hiddenColors.has(obj.fill)) return;
      const content = node("g", { mask: appendObjectMask(group, obj, "canvas") });
      const adjusted = hasEdgeAdjustment(obj.fill);
      const brushWidth = obj.type === "draw" ? Number(obj.brushWidth) || 0 : 0;
      const path = node("path", {
        d: obj.d, fill: brushWidth && !obj.filled ? "none" : obj.fill, "fill-opacity": adjusted ? "0" : "1",
        "pointer-events": brushWidth && (obj.closed || state.tool === "fill") ? "all" : "visiblePainted",
        stroke: brushWidth ? obj.fill : obj.stroke || "none",
        "stroke-width": brushWidth || obj.strokeWidth || .02,
        "stroke-linecap": brushWidth ? "round" : "butt",
        "stroke-linejoin": brushWidth ? "round" : "miter",
        "stroke-opacity": adjusted && brushWidth ? "0" : "1",
        "data-object-part": "shape"
      });
      content.appendChild(path);
      group.appendChild(content);
    }
    objectRoot.appendChild(group);
  }
  function drawEdgePreview() {
    const root = $("#edge-preview");
    root.replaceChildren();
    stage.querySelectorAll("[data-edge-filter]").forEach((filter) => filter.remove());
    const colors = allColors().filter((color) => !state.hiddenColors.has(color) && hasEdgeAdjustment(color));
    let filterIndex = 0;
    let previewIndex = 0;
    for (const obj of state.objects) {
      for (const color of colors) {
        const previewId = previewIndex++;
        const settings = state.gapFillSettings.get(color);
        const scaleX = obj.width / (obj.baseW || obj.width);
        const scaleY = obj.height / (obj.baseH || obj.height);
        const strokeWidth = settings.strokeMm / 25.4 / scaleX;
        const smoothX = settings.smoothMm / 25.4 / scaleX;
        const smoothY = settings.smoothMm / 25.4 / scaleY;
        const group = node("g", { transform: transformFor(obj), "pointer-events": "none" });
        if (settings.smoothMm > 0) {
          const filterId = `edge-preview-filter-${filterIndex++}`;
          const filter = node("filter", {
            id: filterId, x: "-10000", y: "-10000", width: "20000", height: "20000",
            filterUnits: "userSpaceOnUse", "data-edge-filter": "true"
          });
          filter.appendChild(node("feGaussianBlur", { stdDeviation: `${smoothX} ${smoothY}` }));
          const transfer = node("feComponentTransfer");
          transfer.appendChild(node("feFuncA", { type: "discrete", tableValues: "0 1" }));
          filter.appendChild(transfer);
          stage.querySelector("defs").appendChild(filter);
          group.setAttribute("filter", `url(#${filterId})`);
        }
        const appendPreviewPath = (d, parent = group, brushWidth = 0, filled = false) => {
          parent.appendChild(node("path", {
            d, fill: brushWidth && !filled ? "none" : color, "fill-opacity": "1", stroke: color,
            "stroke-width": brushWidth + strokeWidth, "stroke-linejoin": "round", "stroke-linecap": "round"
          }));
        };
        if (obj.type === "image") {
          const content = node("g", {
            transform: `translate(${-Number(obj.cropX || 0)} ${-Number(obj.cropY || 0)})`
          });
          for (const region of obj.regions) {
            if (region.fill === color) appendPreviewPath(region.d, regionHost(content, group, obj, `edge-preview-${previewId}`, region), Number(region.brushWidth) || 0, region.filled);
          }
          group.appendChild(content);
        } else if (obj.type === "text" && obj.fill === color) {
          const content = node("g", { mask: appendObjectMask(group, obj, `edge-preview-${previewId}`) });
          const text = node("text", {
            x: obj.baseW / 2, y: obj.baseH * .73, "text-anchor": "middle",
            "font-family": obj.font || "Arial", "font-size": obj.sizeIn, fill: color,
            stroke: color, "stroke-width": strokeWidth
          });
          text.textContent = obj.text;
          content.appendChild(text);
          group.appendChild(content);
        } else if ((obj.type === "shape" || obj.type === "draw") && obj.fill === color) {
          const content = node("g", { mask: appendObjectMask(group, obj, `edge-preview-${previewId}`) });
          appendPreviewPath(obj.d, content, obj.type === "draw" ? Number(obj.brushWidth) || 0 : 0, obj.filled);
          group.appendChild(content);
        }
        if (group.childNodes.length) root.appendChild(group);
      }
    }
  }
  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll("[data-tool]").forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateToolCursor();
    render();
  }
  function updateToolCursor() {
    if (state.tool === "draw" || state.tool === "erase") {
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
  function drawStitches() {
    if (!$("#stitch-preview-toggle").checked || !state.stitches.length) return;
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
    const disabled = !obj;
    ["#obj-x", "#obj-y", "#obj-w", "#obj-h", "#obj-rotation", "#obj-fill", "#bring-front", "#delete-selection"].forEach((s) => { $(s).disabled = disabled; });
    $("#text-entry").value = obj && obj.type === "text" ? obj.text : "";
    $("#retrace-image").disabled = !obj || obj.type !== "image" || !obj.sourceDataUrl;
    if (obj) {
      $("#obj-x").value = obj.x.toFixed(2); $("#obj-y").value = obj.y.toFixed(2);
      $("#obj-w").value = obj.width.toFixed(2); $("#obj-h").value = obj.height.toFixed(2);
      const selectedFill = state.selectedRegion && state.selectedRegion.id === obj.id
        ? obj.regions[state.selectedRegion.index]?.fill
        : obj.fill;
      $("#obj-fill").value = selectedFill && selectedFill !== "none" ? safeColor(selectedFill) : safeColor(state.color);
      $("#obj-rotation").value = String(Math.round(obj.rotation || 0));
      $("#font").value = obj.font || "Arial";
      if (obj.type === "text") $("#text-size").value = obj.sizeIn.toFixed(2);
      if (obj.type === "image" && Number.isFinite(obj.traceDetail)) {
        $("#trace-detail").value = obj.traceDetail;
        $("#trace-detail-value").textContent = `${obj.traceDetail}%`;
      }
      if (obj.type === "image" && Number.isFinite(obj.traceColors)) $("#trace-colors").value = String(obj.traceColors);
    }
  }
  function renderLayers() {
    const root = $("#layers"); root.replaceChildren();
    $("#delete-layer").disabled = !state.selectedId;
    for (const [visualIndex, obj] of [...state.objects].reverse().entries()) {
      const row = document.createElement("div");
      row.className = "layer-row" + (obj.id === state.selectedId ? " selected" : "");
      row.dataset.layerId = obj.id;
      const select = document.createElement("button");
      select.className = "layer"; select.type = "button"; select.dataset.selectId = obj.id;
      select.setAttribute("aria-label", `Select layer ${obj.name || obj.type}`);
      const swatch = document.createElement("i");
      swatch.style.background = obj.fill || (obj.regions && obj.regions[0]?.fill) || "transparent";
      const label = document.createElement("span");
      label.textContent = obj.name || (obj.type === "image" ? "Traced artwork" : obj.type === "text" ? obj.text : obj.type === "draw" ? "Freeform path" : "Shape");
      select.append(swatch, label);
      const actions = document.createElement("span"); actions.className = "layer-reorder";
      for (const [direction, symbol, title, disabled] of [
        ["up", "▲", "Move layer forward", visualIndex === 0],
        ["down", "▼", "Move layer backward", visualIndex === state.objects.length - 1]
      ]) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "layer-arrow"; button.dataset.layerAction = direction;
        button.dataset.layerId = obj.id; button.disabled = disabled;
        button.setAttribute("aria-label", `${title}: ${label.textContent}`);
        button.title = title; button.textContent = symbol;
        actions.appendChild(button);
      }
      row.append(select, actions); root.appendChild(row);
    }
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
    const scope = selected?.type === "image" ? "Selected image" : "Current design";
    $("#trace-summary").textContent = `${scope}: ${colors.size} thread color${colors.size === 1 ? "" : "s"} · ${regions} filled region${regions === 1 ? "" : "s"}`;
  }
  function renderPalette() {
    const root = $("#palette"); root.replaceChildren();
    for (const color of allColors()) {
      const row = document.createElement("div"); row.className = "swatch";
      const check = document.createElement("input"); check.type = "checkbox"; check.dataset.mergeColor = color;
      check.checked = state.selectedPaletteColors.has(color);
      const input = document.createElement("input"); input.type = "color"; input.value = color; input.dataset.paletteColor = color; input.setAttribute("aria-label", "Recolor " + color);
      const text = document.createElement("span"); text.textContent = color.toUpperCase();
      const visibility = document.createElement("button");
      const visible = !state.hiddenColors.has(color);
      visibility.type = "button"; visibility.className = "color-visibility";
      visibility.dataset.toggleColor = color;
      visibility.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${color.toUpperCase()} on canvas`);
      visibility.setAttribute("aria-pressed", String(visible));
      visibility.title = `${visible ? "Hide" : "Show"} this color on canvas`;
      visibility.innerHTML = visible
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a15 15 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
      row.append(check, input, text, visibility); root.appendChild(row);
    }
    renderEdgeColorChoices();
  }
  function renderEdgeColorChoices() {
    const root = $("#edge-colors");
    const colors = allColors();
    if (!colors.includes(state.edgeColor)) state.edgeColor = colors[0] || null;
    root.replaceChildren();
    for (const color of colors) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "edge-color";
      button.style.backgroundColor = color;
      button.dataset.edgeColor = color;
      button.setAttribute("aria-label", `Select color ${color.toUpperCase()} for edge adjustment`);
      button.setAttribute("aria-pressed", String(color === state.edgeColor));
      button.title = color.toUpperCase();
      root.appendChild(button);
    }
    const settings = selectedGapFillSettings();
    $("#gap-fill").value = String(settings.strokeMm);
    $("#gap-fill-value").textContent = `${settings.strokeMm.toFixed(1)} mm`;
    $("#color-smooth").value = String(settings.smoothMm);
    $("#color-smooth-value").textContent = `${settings.smoothMm.toFixed(1)} mm`;
    $("#gap-fill").disabled = !colors.length;
    $("#color-smooth").disabled = !colors.length;
  }
  function selectedGapFillSettings() {
    const color = state.edgeColor;
    if (!color) return { strokeMm: 0, smoothMm: 0 };
    if (!state.gapFillSettings.has(color)) state.gapFillSettings.set(color, { strokeMm: 0, smoothMm: 0 });
    return state.gapFillSettings.get(color);
  }
  function render() {
    objectRoot.replaceChildren(); selectionRoot.replaceChildren();
    for (const obj of state.objects) renderObject(obj);
    drawStitches();
    drawSelection(selectedObject());
    updateProperties(); renderLayers(); renderPalette();
    drawEdgePreview();
    updateTraceSummary();
    $("#stitch-count").textContent = state.stitches.length ? state.stitches.reduce((n, segment) => n + segment.points.length - 1, 0).toLocaleString() : "—";
    if (state.objects.length) {
      const extents = state.objects.map(rotatedBounds);
      const minX = Math.min(...extents.map((b) => b.x - b.width / 2));
      const maxX = Math.max(...extents.map((b) => b.x + b.width / 2));
      const minY = Math.min(...extents.map((b) => b.y - b.height / 2));
      const maxY = Math.max(...extents.map((b) => b.y + b.height / 2));
      $("#design-size").textContent = `${(maxX - minX).toFixed(2)} × ${(maxY - minY).toFixed(2)} in`;
      const fits = minX >= 0 && minY >= 0 && maxX <= state.hoopW && maxY <= state.hoopH;
      $("#canvas-size").textContent = `${state.hoopW} × ${state.hoopH} in hoop${fits ? "" : " · design extends outside hoop"}`;
    } else {
      $("#design-size").textContent = "—";
      $("#canvas-size").textContent = `${state.hoopW} × ${state.hoopH} in hoop`;
    }
  }
  function snapshot() {
    state.history.push(JSON.stringify({
      objects: state.objects,
      gapFillSettings: Object.fromEntries(state.gapFillSettings),
      edgeColor: state.edgeColor
    }));
    if (state.history.length > 35) state.history.shift();
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
    $("#export-state").textContent = "Artwork changed; regenerate stitches before exporting.";
    render();
    if ($("#stitch-preview-toggle").checked) debounceStitches();
  }
  let stitchTimer = 0;
  function debounceStitches() {
    clearTimeout(stitchTimer);
    stitchTimer = setTimeout(() => makeStitches().catch((error) => message(error.message, "error")), 250);
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
    const x = (dx * Math.cos(radians) + dy * Math.sin(radians)) / obj.width * obj.baseW + obj.baseW / 2;
    const y = (-dx * Math.sin(radians) + dy * Math.cos(radians)) / obj.height * obj.baseH + obj.baseH / 2;
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
    obj.erasures.push({ d: strokePath(erasing.points), width: erasing.width });
    changed();
    message(`Erased part of the selected ${obj.type === "image" ? "image" : "layer"}.`, "ok");
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
      if (state.tool === "select") { startPan(event); return; }
      state.selectedId = null; state.selectedRegion = null; render(); return;
    }
    const obj = state.objects.find((item) => item.id === group.dataset.objectId);
    if (!obj) return;
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
      if (state.drawing.type === "draw") {
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
      if (drawing.type === "draw") {
        const points = drawing.points.filter((p, index, list) => !index || Math.hypot(p.x - list[index - 1].x, p.y - list[index - 1].y) >= .01);
        if (points.length && Math.hypot(end.x - points[points.length - 1].x, end.y - points[points.length - 1].y) > .003) points.push(end);
        const brushWidthMm = Number($("#brush-size").value);
        const imageObj = state.objects.find((obj) => obj.id === drawing.imageId && obj.type === "image");
        if (imageObj?.type === "image") {
          const radians = (imageObj.rotation || 0) * Math.PI / 180;
          const localPoint = (point) => {
            const dx = point.x - imageObj.x, dy = point.y - imageObj.y;
            return {
              x: Number(imageObj.cropX || 0) + imageObj.baseW / 2
                + (dx * Math.cos(radians) + dy * Math.sin(radians)) / imageObj.width * imageObj.baseW,
              y: Number(imageObj.cropY || 0) + imageObj.baseH / 2
                + (-dx * Math.sin(radians) + dy * Math.cos(radians)) / imageObj.height * imageObj.baseH
            };
          };
          const d = strokePath(points, (point) => {
            const local = localPoint(point);
            return local;
          });
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
          const radians = (imageObj.rotation || 0) * Math.PI / 180;
          const cx = x0 + width / 2, cy = y0 + height / 2;
          const outline = drawing.type === "rect"
            ? [[x0, y0], [x0 + width, y0], [x0 + width, y0 + height], [x0, y0 + height]]
            : Array.from({ length: 64 }, (_, i) => {
              const t = i / 64 * Math.PI * 2;
              return [cx + Math.cos(t) * width / 2, cy + Math.sin(t) * height / 2];
            });
          const d = outline.map(([px, py], i) => {
            const dx = px - imageObj.x, dy = py - imageObj.y;
            const lx = Number(imageObj.cropX || 0) + imageObj.baseW / 2
              + (dx * Math.cos(radians) + dy * Math.sin(radians)) / imageObj.width * imageObj.baseW;
            const ly = Number(imageObj.cropY || 0) + imageObj.baseH / 2
              + (-dx * Math.sin(radians) + dy * Math.cos(radians)) / imageObj.height * imageObj.baseH;
            return `${i ? "L" : "M"}${lx.toFixed(4)} ${ly.toFixed(4)}`;
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
    if (d.type === "draw") {
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

  async function traceImage(file) {
    if (!window.ImageTracer) throw new Error("The vector tracing library could not load. Check your internet connection and reload the page.");
    if (!file || file.size > 15 * 1024 * 1024) throw new Error("Choose an image smaller than 15 MB.");
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
        sourceDataUrl: traced.sourceDataUrl, traceColors: traced.traceColors, traceDetail,
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
    return centers.map((c) => ({ r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: 255 }));
  }
  function snapToPalette(imageData, palette) {
    const { width, height, data } = imageData;
    const index = new Uint8Array(width * height);
    for (let p = 0; p < index.length; p++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < palette.length; c++) {
        const d = (data[p * 4] - palette[c].r) ** 2 + (data[p * 4 + 1] - palette[c].g) ** 2 + (data[p * 4 + 2] - palette[c].b) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      index[p] = best;
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
    for (let p = 0; p < smoothed.length; p++) {
      const color = palette[smoothed[p]];
      data[p * 4] = color.r; data[p * 4 + 1] = color.g; data[p * 4 + 2] = color.b; data[p * 4 + 3] = 255;
    }
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
      if (!sourceDataUrl.startsWith("data:image/webp,")) sourceDataUrl = canvas.toDataURL("image/jpeg", .92);
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
    const monochrome = inspected > 0 && chromatic < Math.max(24, inspected * .0005);
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
    let palette = null, traceData = imageData, traceScale = 1;
    if (!monochrome) {
      traceScale = Math.max(image.naturalWidth, image.naturalHeight) * scale <= 900 ? 2 : 1;
      if (traceScale > 1) {
        const big = document.createElement("canvas");
        big.width = width * traceScale; big.height = height * traceScale;
        const bigContext = big.getContext("2d", { willReadFrequently: true });
        bigContext.imageSmoothingQuality = "high";
        bigContext.fillStyle = "#ffffff"; bigContext.fillRect(0, 0, big.width, big.height);
        bigContext.drawImage(canvas, 0, 0, big.width, big.height);
        traceData = bigContext.getImageData(0, 0, big.width, big.height);
      }
      palette = buildImagePalette(traceData, effectiveColors);
      snapToPalette(traceData, palette);
    }
    const svgText = ImageTracer.imagedataToSVG(traceData, {
      numberofcolors: effectiveColors, colorsampling: 0, colorquantcycles: palette ? 1 : 8, layering: 0,
      ...(palette ? { pal: palette } : {}),
      scale: 1 / traceScale,
      ltres: 1.7 - .8 * quality, qtres: 1.7 - .8 * quality,
      pathomit: Math.max(2, Math.round((palette ? 20 - 16 * quality : 65 - 50 * quality) * traceScale)),
      rightangleenhance: true, viewbox: true
    });
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("The image tracer returned invalid SVG.");
    const regions = [...parsed.querySelectorAll("path[d]")].map((path) => ({
      d: path.getAttribute("d"), fill: safeColor(path.getAttribute("fill") || "#000000")
    })).filter((region) => region.d && region.d.length < 200000);
    if (!regions.length) throw new Error("No editable regions were found. Try a clearer, higher-contrast image.");
    return { width, height, regions, sourceDataUrl, traceColors: effectiveColors, monochrome };
  }
  async function retraceSelectedImage() {
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
        element.src = obj.sourceDataUrl;
      });
      const traceColors = Number($("#trace-colors").value);
      const traceDetail = Number($("#trace-detail").value);
      const traced = traceImageElement(image, traceColors, traceDetail);
      const regions = $("#ignore-white").checked
        ? traced.regions.filter((region) => !isNearWhite(region.fill))
        : traced.regions;
      if (!regions.length) throw new Error("Ignoring near-white removed every region. Turn the option off and retrace.");
      snapshot();
      const previousBaseW = obj.baseW, previousBaseH = obj.baseH;
      obj.regions = regions;
      obj.naturalW = traced.width; obj.naturalH = traced.height;
      obj.baseW = previousBaseW; obj.baseH = previousBaseH;
      obj.sourceDataUrl = traced.sourceDataUrl;
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
  function addText() {
    const text = $("#text-entry").value.trim() || "Text";
    snapshot();
    const requestedSize = Math.max(.05, Math.min(2, Number($("#text-size").value) || .4));
    const textBoxWidth = Math.max(.35, text.length * requestedSize * .62);
    const fitScale = Math.min(1, (state.hoopW - .24) / textBoxWidth,
      (state.hoopH - .24) / (requestedSize * 1.3));
    const sizeIn = Math.max(.05, requestedSize * fitScale);
    const width = Math.max(.35, text.length * sizeIn * .62), height = sizeIn * 1.3;
    const obj = {
      id: uid(), type: "text", name: text, text, font: $("#font").value, sizeIn,
      x: state.hoopW / 2, y: state.hoopH / 2, width, height, baseW: width, baseH: height, fill: state.color
    };
    state.objects.push(obj); state.selectedId = obj.id;
    $("#text-size").value = sizeIn.toFixed(2);
    changed();
    $("#text-entry").focus(); $("#text-entry").select();
    message(`Added “${text}” as editable text.`, "ok");
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
  function setHoop(width, height) {
    if (!(Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1 && width <= 12 && height <= 12)) {
      message("Canvas dimensions must each be between 1 and 12 inches.", "error");
      $("#custom-width").value = state.hoopW; $("#custom-height").value = state.hoopH;
      return;
    }
    snapshot();
    state.hoopW = width; state.hoopH = height;
    $("#custom-width").value = width; $("#custom-height").value = height;
    state.viewX = 0; state.viewY = 0;
    viewBox(); invalidateStitches();
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
  function exportProject() {
    const blob = new Blob([JSON.stringify({
      version: 1, hoopW: state.hoopW, hoopH: state.hoopH, objects: state.objects,
      edgeAdjustments: Object.fromEntries(state.gapFillSettings), edgeColor: state.edgeColor
    }, null, 2)], { type: "application/json" });
    download(blob, "stitch-studio-project.json");
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
    viewBox(); changed();
  }

  function colorSceneSvg(color, angle, ppu) {
    const w = Math.ceil(state.hoopW * 25.4 * ppu), h = Math.ceil(state.hoopH * 25.4 * ppu);
    const root = node("svg", { xmlns: NS, width: w, height: h, viewBox: `0 0 ${state.hoopW} ${state.hoopH}` });
    const gRoot = node("g");
    for (const obj of state.objects) {
      const group = node("g", { transform: transformFor(obj) });
      const mask = obj.type === "image" ? null : appendObjectMask(group, obj, "stitch");
      const content = node("g", { mask });
      const colorPath = (d, fill, parent = content, brushWidth = 0, filled = false) => {
        if (fill !== color) return;
        parent.appendChild(node("path", {
          d, fill: brushWidth && !filled ? "none" : fill,
          stroke: brushWidth ? fill : "none",
          "stroke-width": brushWidth,
          "stroke-linecap": "round", "stroke-linejoin": "round"
        }));
      };
      if (obj.type === "image") {
        const imageContent = node("g", {
          transform: `translate(${-Number(obj.cropX || 0)} ${-Number(obj.cropY || 0)})`
        });
        for (const region of obj.regions) {
          if (region.fill === color) colorPath(region.d, region.fill, regionHost(imageContent, group, obj, "stitch", region), Number(region.brushWidth) || 0, region.filled);
        }
        group.appendChild(imageContent);
      } else if (obj.type === "text") {
        if (obj.fill === color) {
          const text = node("text", {
            x: obj.baseW / 2, y: obj.baseH * .73, "text-anchor": "middle", "font-family": obj.font || "Arial",
            "font-size": obj.sizeIn, fill: color
          });
          text.textContent = obj.text; content.appendChild(text);
          group.appendChild(content);
        }
      } else {
        colorPath(obj.d, obj.fill, content, obj.type === "draw" ? Number(obj.brushWidth) || 0 : 0, obj.filled);
        group.appendChild(content);
      }
      if (group.childNodes.length) gRoot.appendChild(group);
    }
    root.appendChild(gRoot);
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
        const leaving = position - radius - 1;
        const entering = position + radius;
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
  async function scanColor(color, angle, rowSpacing, ppu, gapFillMm = 0, smoothMm = 0) {
    const scene = colorSceneSvg(color, angle, ppu);
    const image = await loadSvgImage(scene.svg);
    const side = Math.ceil(Math.hypot(scene.width, scene.height));
    const canvas = document.createElement("canvas"); canvas.width = side; canvas.height = side;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.translate(side / 2, side / 2); context.rotate(angle * Math.PI / 180);
    context.drawImage(image, -scene.width / 2, -scene.height / 2, scene.width, scene.height);
    smoothColorMask(canvas, smoothMm * ppu);
    expandColorMask(canvas, gapFillMm * ppu / 2);
    const pixels = context.getImageData(0, 0, side, side).data;
    const segments = [], step = rowSpacing * ppu;
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    const spacingMmPerPixel = 1 / ppu;
    for (let rowIndex = 0, y = 0; y < side; rowIndex++, y += step) {
      const row = Math.min(side - 1, Math.round(y));
      const runs = []; let start = -1;
      for (let x = 0; x <= side; x++) {
        const ink = x < side && pixels[(row * side + x) * 4 + 3] > 80;
        if (ink && start < 0) start = x;
        if ((!ink || x === side) && start >= 0) {
          if (x - start >= 2) runs.push([start, x - 1]);
          start = -1;
        }
      }
      if (rowIndex % 2) runs.reverse();
      for (const [x1, x2] of runs) {
        const mapPoint = (px) => {
          const xr = (px - side / 2) * spacingMmPerPixel, yr = (y - side / 2) * spacingMmPerPixel;
          const dx = xr * c + yr * s, dy = -xr * s + yr * c;
          return { x: state.hoopW / 2 + dx / 25.4, y: state.hoopH / 2 + dy / 25.4 };
        };
        let a = mapPoint(x1), b = mapPoint(x2);
        if (rowIndex % 2) [a, b] = [b, a];
        const length = Math.hypot(b.x - a.x, b.y - a.y) * 25.4;
        if (length < .35) continue;
        const stepMm = 3, phase = ((rowIndex * 3) % 7) / 7 * stepMm;
        const cuts = [0];
        for (let d = phase; d < length - .6; d += stepMm) if (d > .6) cuts.push(d);
        cuts.push(length);
        const points = cuts.map((d) => {
          const t = d / length;
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        });
        if (points.length > 1) segments.push({ color, points });
      }
    }
    return segments;
  }
  // Greedy nearest-neighbour ordering so rows run as a continuous serpentine and each
  // separate area is sewn in one pass instead of trimming and jumping after every row.
  function orderSegments(segments) {
    const rest = segments.slice(), ordered = [], window = 400;
    let end = null;
    while (rest.length) {
      let best = 0, bestDist = Infinity, bestFlip = false;
      const limit = end ? Math.min(rest.length, window) : 1;
      for (let i = 0; i < limit; i++) {
        const pts = rest[i].points;
        const head = end ? Math.hypot(pts[0].x - end.x, pts[0].y - end.y) : 0;
        const tail = end ? Math.hypot(pts.at(-1).x - end.x, pts.at(-1).y - end.y) : Infinity;
        if (head < bestDist) { best = i; bestDist = head; bestFlip = false; }
        if (tail < bestDist) { best = i; bestDist = tail; bestFlip = true; }
      }
      const [segment] = rest.splice(best, 1);
      if (bestFlip) segment.points = segment.points.slice().reverse();
      ordered.push(segment);
      end = segment.points.at(-1);
    }
    return ordered;
  }
  async function outlineSegments(colors, colorIndex, ppu) {
    const mode = $("#outline-mode").value;
    const satin = mode === "satin";
    const widthMm = Math.max(1, Math.min(6, Number($("#outline-width").value) || 2.5));
    const offsetPx = Math.round((satin ? widthMm / 2 : .4) * ppu);
    const pad = offsetPx + 4;
    const probe = colorSceneSvg(colors[0], 0, ppu);
    const w = probe.width + pad * 2, h = probe.height + pad * 2;
    const layer = document.createElement("canvas"); layer.width = w; layer.height = h;
    const layerContext = layer.getContext("2d", { willReadFrequently: true });
    for (const color of colors) {
      const scene = colorSceneSvg(color, 0, ppu);
      layerContext.drawImage(await loadSvgImage(scene.svg), pad, pad, scene.width, scene.height);
    }
    const alpha = layerContext.getImageData(0, 0, w, h).data;
    // Flood-fill the outside from the border so interior holes are not outlined.
    const outside = new Uint8Array(w * h), stack = [];
    const seed = (x, y) => { const i = y * w + x; if (!outside[i] && alpha[i * 4 + 3] <= 80) { outside[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      if (x > 0) seed(x - 1, y);
      if (x < w - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < h - 1) seed(x, y + 1);
    }
    const solid = layerContext.createImageData(w, h);
    for (let i = 0; i < outside.length; i++) if (!outside[i]) solid.data[i * 4 + 3] = 255;
    const silhouette = document.createElement("canvas"); silhouette.width = w; silhouette.height = h;
    silhouette.getContext("2d").putImageData(solid, 0, 0);
    const grown = document.createElement("canvas"); grown.width = w; grown.height = h;
    const grownContext = grown.getContext("2d", { willReadFrequently: true });
    grownContext.drawImage(silhouette, 0, 0);
    for (let k = 0; k < 32 && offsetPx > 0; k++) {
      const a = k / 32 * Math.PI * 2;
      grownContext.drawImage(silhouette, Math.round(Math.cos(a) * offsetPx), Math.round(Math.sin(a) * offsetPx));
    }
    const grownAlpha = grownContext.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = grownAlpha[i * 4 + 3] > 127 ? 1 : 0;

    const pxPerInX = probe.width / state.hoopW, pxPerInY = probe.height / state.hoopH;
    const toInches = (p) => ({ x: (p.x - pad) / pxPerInX, y: (p.y - pad) / pxPerInY });
    const segments = [];
    for (const contour of traceOuterContours(mask, w, h)) {
      const smooth = smoothClosedPath(contour, 9);
      const stepPx = (satin ? .4 : 2.5) * ppu;
      const path = resampleClosedPath(smooth, stepPx);
      if (path.length < 4) continue;
      let points;
      if (satin) {
        const half = widthMm / 2 * ppu, reach = 4;
        points = [];
        path.forEach((p, i) => {
          const before = path[(i - reach + path.length) % path.length], after = path[(i + reach) % path.length];
          const tx = after.x - before.x, ty = after.y - before.y, length = Math.hypot(tx, ty) || 1;
          const side = i % 2 ? 1 : -1;
          points.push(toInches({ x: p.x + side * half * -ty / length, y: p.y + side * half * tx / length }));
        });
      } else {
        points = [...path, path[0]].map(toInches);
      }
      segments.push({ color: colorIndex, points });
    }
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
    const colors = allColors();
    if (!colors.length) throw new Error("No filled regions are available to stitch.");
    const spacing = Number($("#spacing").value), angle = Number($("#angle").value);
    if (!Number.isFinite(spacing) || spacing < .2 || spacing > 1.2) throw new Error("Row spacing must be between 0.2 and 1.2 mm.");
    if (!Number.isFinite(angle) || angle < 0 || angle > 179) throw new Error("Fill angle must be between 0 and 179 degrees.");
    if (state.busy) return;
    state.busy = true; $("#export-pes").disabled = true;
    try {
      const segments = [], ppu = 8;
      for (const color of colors) {
        const colorIndex = colors.indexOf(color);
        const settings = state.gapFillSettings.get(color) || { strokeMm: 0, smoothMm: 0 };
        if (!Number.isFinite(Number(settings.strokeMm)) || settings.strokeMm < 0 || settings.strokeMm > 2
          || !Number.isFinite(Number(settings.smoothMm)) || settings.smoothMm < 0 || settings.smoothMm > 5) {
          throw new Error(`Invalid stroke or smoothing settings for ${color}.`);
        }
        if ($("#underlay").value === "grid") {
          segments.push(...orderSegments(await scanColor(color, angle + 90, Math.max(.65, spacing * 2), ppu, settings.strokeMm, settings.smoothMm)).map((segment) => ({ ...segment, color: colorIndex })));
        }
        segments.push(...orderSegments(await scanColor(color, angle, spacing, ppu, settings.strokeMm, settings.smoothMm)).map((segment) => ({ ...segment, color: colorIndex })));
        if (segments.reduce((total, seg) => total + seg.points.length, 0) > 100000) throw new Error("This design exceeds 100,000 planned stitches. Increase row spacing or simplify the artwork.");
      }
      if ($("#outline-mode").value !== "off") {
        const artColors = colors.slice();
        const outlineColor = safeColor($("#outline-color").value);
        let outlineIndex = colors.indexOf(outlineColor);
        if (outlineIndex < 0) { colors.push(outlineColor); outlineIndex = colors.length - 1; }
        segments.push(...await outlineSegments(artColors, outlineIndex, ppu));
      }
      if (!segments.length) throw new Error("No stitches were generated. Increase trace detail or add larger filled regions.");
      const usedColorIndices = [...new Set(segments.map((segment) => segment.color))].sort((a, b) => a - b);
      const remappedColors = new Map(usedColorIndices.map((colorIndex, index) => [colorIndex, index]));
      segments.forEach((segment) => { segment.color = remappedColors.get(segment.color); });
      state.stitchColors = usedColorIndices.map((colorIndex) => colors[colorIndex]);
      state.stitches = segments; state.stale = false;
      $("#export-state").textContent = "Stitch plan is ready. Export creates a Brother PES v1 file with a complete PES/PEC structure.";
      render(); message(`Stitch preview generated: ${segments.reduce((n, seg) => n + seg.points.length - 1, 0).toLocaleString()} estimated stitches.`, "ok");
      return segments;
    } finally {
      state.busy = false; $("#export-pes").disabled = false;
    }
  }
  async function loadPyodideWriter() {
    if (!state.pyodidePromise) {
      state.pyodidePromise = (async () => {
        message("Loading Python/WASM and PyEmbroidery from the internet. This may take a minute…");
        if (!window.loadPyodide) {
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js";
            script.onload = resolve; script.onerror = () => reject(new Error("Could not load the Pyodide runtime. Check the network, then reload."));
            document.head.appendChild(script);
          });
        }
        const pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/" });
        await pyodide.loadPackage("micropip");
        await pyodide.runPythonAsync("import micropip\nawait micropip.install('pyembroidery')");
        return pyodide;
      })();
    }
    return state.pyodidePromise;
  }
  async function exportPes() {
    try {
      if (state.stale || !state.stitches.length) await makeStitches();
      const pyodide = await loadPyodideWriter();
      const threadColors = state.stitchColors;
      const events = [];
      const orientation = $("#output-orientation").value;
      const flipX = orientation === "mirror-x" || orientation === "rotate-180" ? -1 : 1;
      const flipY = orientation === "mirror-y" || orientation === "rotate-180" ? -1 : 1;
      const toPesPoint = (point) => ({
        x: (point.x - state.hoopW / 2) * 254 * flipX,
        y: (point.y - state.hoopH / 2) * 254 * flipY
      });
      const joinLimit = 3 / 25.4;
      state.stitches.forEach((segment, index) => {
        const colorIndex = segment.color;
        const first = toPesPoint(segment.points[0]);
        const previous = state.stitches[index - 1];
        const lastPoint = previous && previous.color === colorIndex ? previous.points.at(-1) : null;
        const gap = lastPoint ? Math.hypot(segment.points[0].x - lastPoint.x, segment.points[0].y - lastPoint.y) : Infinity;
        if (gap <= joinLimit) {
          // Short connections are sewn so the machine does not cut the thread between every row.
          events.push({ cmd: "stitch", color: colorIndex, x: first.x, y: first.y });
        } else {
          if (lastPoint) events.push({ cmd: "trim", color: colorIndex, x: toPesPoint(lastPoint).x, y: toPesPoint(lastPoint).y });
          events.push({ cmd: "jump", color: colorIndex, x: first.x, y: first.y });
        }
        for (const point of segment.points.slice(1)) {
          const pesPoint = toPesPoint(point);
          const prev = events.at(-1);
          if (prev && Math.round(prev.x) === Math.round(pesPoint.x) && Math.round(prev.y) === Math.round(pesPoint.y)) continue;
          events.push({ cmd: "stitch", color: colorIndex, x: pesPoint.x, y: pesPoint.y });
        }
        const next = state.stitches[index + 1];
        if (next && next.color !== colorIndex) {
          const pesPoint = toPesPoint(segment.points.at(-1));
          events.push({ cmd: "color", color: next.color, x: pesPoint.x, y: pesPoint.y });
        }
      });
      const hoopLimitX = state.hoopW * 127 + 1;
      const hoopLimitY = state.hoopH * 127 + 1;
      if (events.some((event) => !Number.isFinite(event.x) || !Number.isFinite(event.y)
        || Math.abs(event.x) > hoopLimitX || Math.abs(event.y) > hoopLimitY)) {
        throw new Error("Generated stitch coordinates exceed the selected hoop. Regenerate the stitch plan and check the design bounds.");
      }
      pyodide.globals.set("stitch_json", JSON.stringify({ colors: threadColors, events }));
      const encoded = await pyodide.runPythonAsync(`
import base64, io, json
from pyembroidery import EmbPattern, EmbThread
from pyembroidery import STITCH, JUMP, TRIM, COLOR_CHANGE, END
payload = json.loads(stitch_json)
pattern = EmbPattern()
pattern.extras["name"] = "Stitch Studio"
for hexcolor in payload["colors"]:
    thread = EmbThread()
    thread.set_color(int(hexcolor[1:3], 16), int(hexcolor[3:5], 16), int(hexcolor[5:7], 16))
    pattern.add_thread(thread)
for item in payload["events"]:
    command = {"stitch": STITCH, "jump": JUMP, "trim": TRIM, "color": COLOR_CHANGE}.get(item["cmd"])
    if command is not None:
        pattern.add_stitch_absolute(command, item["x"], item["y"])
pattern.add_command(END)
output = io.BytesIO()
# encode=False writes exactly the commands planned above: no automatic tie-in/tie-off stitches
# or extra trim-jumps, matching the structure of PES files known to sew correctly.
EmbPattern.write_pes(pattern, output, {"version": 1.0, "encode": False})
data = output.getvalue()
checked = EmbPattern.read_pes(io.BytesIO(data))
if len(checked.stitches) < 2 or len(checked.threadlist) != len(payload["colors"]):
    raise ValueError("PES validation did not find the expected stitches and thread colors.")
# Safety checks on the file as a machine will read it.
cmds = [s for s in checked.stitches]
if cmds[0][2] != JUMP:
    raise ValueError("Safety check failed: the file does not begin with a jump to the start point.")
if cmds[-1][2] != END:
    raise ValueError("Safety check failed: the file does not end with an END command.")
still = 0
for i in range(1, len(cmds)):
    if cmds[i][2] != STITCH:
        still = 0
        continue
    step = ((cmds[i][0] - cmds[i - 1][0]) ** 2 + (cmds[i][1] - cmds[i - 1][1]) ** 2) ** 0.5
    if step > 121:
        raise ValueError("Safety check failed: stitch %d is %.1f mm long (limit 12.1 mm)." % (i, step / 10))
    still = still + 1 if step == 0 else 0
    if still > 3:
        raise ValueError("Safety check failed: repeated stitches in the same spot at command %d would break thread." % i)
if sum(1 for s in cmds if s[2] == STITCH) < 20:
    raise ValueError("Safety check failed: the file contains almost no stitches.")
json.dumps({
    "data": base64.b64encode(data).decode("ascii"),
    "bytes": len(data),
    "stitches": len(checked.stitches),
    "threads": len(checked.threadlist)
})
      `);
      const result = JSON.parse(encoded);
      const binary = atob(result.data), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (new TextDecoder().decode(bytes.slice(0, 8)) !== "#PES0001") throw new Error("The PES writer returned an invalid file signature.");
      if (bytes.length < 600) throw new Error("The PES writer returned an incomplete file.");
      const fileName = ($("#file-name").value.replace(/\.pes$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().replace(/[. ]+$/, "")) || "Embroidery File";
      download(new Blob([bytes], { type: "application/octet-stream" }), `${fileName}.pes`);
      message(`PES v1 generated and reopened for validation (${result.bytes.toLocaleString()} bytes, ${result.stitches.toLocaleString()} commands, ${result.threads} threads). Verify in Brother software and test on scrap fabric before sewing.`, "ok");
    } catch (error) {
      console.error(error);
      const details = String(error.message || error).split("\n").filter(Boolean).slice(-1)[0];
      message(details || "Could not create a PES file.", "error");
    }
  }

  document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  function syncColorInputs(color) {
    state.color = color;
    for (const id of ["#active-color", "#obj-fill", "#merge-color"]) $(id).value = color;
  }
  $("#active-color").addEventListener("input", (event) => syncColorInputs(event.target.value));
  $("#merge-color").addEventListener("input", (event) => syncColorInputs(event.target.value));
  $("#obj-fill").addEventListener("input", (event) => syncColorInputs(event.target.value));
  $("#ignore-white").addEventListener("change", (event) => {
    if (!event.target.checked) return;
    const obj = selectedObject();
    if (obj?.type !== "image") return;
    const whites = obj.regions.filter((region) => isNearWhite(region.fill));
    if (!whites.length) return;
    snapshot();
    obj.regions.forEach((region) => { if (isNearWhite(region.fill)) region.fill = "none"; });
    refreshImageCrop(obj);
    changed(); message(`Ignored ${whites.length} near-white traced region(s).`, "ok");
  });
  $("#obj-fill").addEventListener("change", (event) => {
    const obj = selectedObject(); if (!obj) return;
    syncColorInputs(event.target.value);
    applySelectedColor();
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
  $("#trace-detail").addEventListener("input", (event) => {
    $("#trace-detail-value").textContent = `${event.target.value}%`;
    if (selectedObject()?.type === "image") message("Trace cleanup changed. Retrace the selected image to apply it.", "info");
  });
  $("#zoom").addEventListener("input", (event) => zoomCanvas(Number(event.target.value) / 100));
  $("#fit-view").addEventListener("click", () => {
    state.zoom = 1; state.viewX = 0; state.viewY = 0; viewBox();
  });
  $("#artwork-file").addEventListener("change", async (event) => {
    try { await traceImage(event.target.files[0]); }
    catch (error) { console.error(error); message(error.message, "error"); }
    finally { event.target.value = ""; }
  });
  $("#retrace-image").addEventListener("click", retraceSelectedImage);
  $("#add-text").addEventListener("click", addText);
  $("#delete-selection").addEventListener("click", deleteSelected);
  $("#delete-layer").addEventListener("click", deleteSelected);
  $("#clear-canvas").addEventListener("click", clearCanvas);
  $("#bring-front").addEventListener("click", () => {
    const obj = selectedObject(); if (!obj) return;
    snapshot(); state.objects = state.objects.filter((item) => item.id !== obj.id); state.objects.push(obj); changed();
  });
  for (const [selector, key, min, max] of [["#obj-x", "x", -12, 24], ["#obj-y", "y", -12, 24], ["#obj-w", "width", .05, 12], ["#obj-h", "height", .05, 12]]) {
    $(selector).addEventListener("change", () => setNumber(selector, key, min, max));
  }
  $("#obj-rotation").addEventListener("change", () => {
    const obj = selectedObject(), angle = Number($("#obj-rotation").value);
    if (!obj || !Number.isFinite(angle) || angle < -180 || angle > 180) return;
    snapshot(); obj.rotation = angle; changed();
  });
  $("#text-entry").addEventListener("input", () => {
    const obj = selectedObject(); if (!obj || obj.type !== "text") return;
    obj.text = $("#text-entry").value; obj.name = obj.text; obj.baseW = Math.max(.35, obj.text.length * obj.sizeIn * .62);
    obj.width = obj.baseW; obj.height = obj.baseH; changed();
  });
  $("#text-entry").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && selectedObject()?.type !== "text") { event.preventDefault(); addText(); }
  });
  $("#text-size").addEventListener("change", () => {
    const obj = selectedObject(), size = Number($("#text-size").value);
    if (!obj || obj.type !== "text" || !Number.isFinite(size) || size < .05 || size > 2) return;
    obj.sizeIn = size;
    obj.baseW = Math.max(.35, obj.text.length * size * .62);
    obj.baseH = size * 1.3;
    obj.width = obj.baseW; obj.height = obj.baseH;
    changed();
  });
  $("#palette").addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-color]");
    if (!button) return;
    const color = button.dataset.toggleColor;
    if (state.hiddenColors.has(color)) state.hiddenColors.delete(color);
    else state.hiddenColors.add(color);
    render();
  });
  $("#font").addEventListener("change", () => { const obj = selectedObject(); if (obj && obj.type === "text") { obj.font = $("#font").value; changed(); } });
  $("#layers").addEventListener("click", (event) => {
    const reorder = event.target.closest("[data-layer-action]");
    if (reorder) {
      event.stopPropagation();
      moveLayer(reorder.dataset.layerId, reorder.dataset.layerAction === "up" ? 1 : -1);
      return;
    }
    const button = event.target.closest("[data-select-id]"); if (!button) return;
    state.selectedId = button.dataset.selectId; state.selectedRegion = null; render();
  });
  $("#palette").addEventListener("change", (event) => {
    const input = event.target.closest("[data-palette-color]"); if (!input) return;
    const previous = input.dataset.paletteColor, next = input.value;
    if (previous === next) return;
    snapshot();
    if (state.hiddenColors.delete(previous)) state.hiddenColors.add(next);
    if (state.gapFillSettings.has(previous)) {
      const settings = state.gapFillSettings.get(previous);
      if (!state.gapFillSettings.has(next)) state.gapFillSettings.set(next, settings);
      state.gapFillSettings.delete(previous);
    }
    if (state.edgeColor === previous) state.edgeColor = next;
    for (const obj of state.objects) {
      if (obj.type === "image") obj.regions.forEach((region) => { if (region.fill === previous) region.fill = next; });
      else if (obj.fill === previous) obj.fill = next;
    }
    if (state.selectedPaletteColors.delete(previous)) state.selectedPaletteColors.add(next);
    if (state.color === previous) {
      syncColorInputs(next);
    }
    if ($("#merge-color").value === previous) $("#merge-color").value = next;
    changed();
  });
  $("#palette").addEventListener("change", (event) => {
    const check = event.target.closest("[data-merge-color]");
    if (!check) return;
    if (check.checked) state.selectedPaletteColors.add(check.dataset.mergeColor);
    else state.selectedPaletteColors.delete(check.dataset.mergeColor);
  });
  $("#combine-colors").addEventListener("click", combineColors);
  $("#remove-colors").addEventListener("click", removeSelectedColors);
  $("#project-save").addEventListener("click", exportProject);
  $("#project-file").addEventListener("change", async (event) => {
    try { await openProject(event.target.files[0]); message("Project opened.", "ok"); }
    catch (error) { message(error.message || "Could not open the project.", "error"); }
    finally { event.target.value = ""; }
  });
  $("#undo").addEventListener("click", () => {
    const previous = state.history.pop(); if (!previous) return;
    restoreSnapshot(previous); state.selectedId = null; state.selectedRegion = null; render(); invalidateStitches();
    message("Last vector edit undone.", "ok");
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && stage.contains(event.target)) {
      state.spaceDown = true; event.preventDefault();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); $("#undo").click(); }
    if ((event.key === "Delete" || event.key === "Backspace") && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) deleteSelected();
  });
  window.addEventListener("keyup", (event) => { if (event.code === "Space") state.spaceDown = false; });
  $("#spacing").addEventListener("change", invalidateStitches);
  $("#edge-colors").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edge-color]");
    if (!button) return;
    editingEdgeSettings = false;
    state.edgeColor = button.dataset.edgeColor;
    render();
  });
  function updateEdgeSettingsPreview() {
    state.stale = true;
    state.stitches = [];
    $("#export-state").textContent = "Color edge settings changed; regenerate stitches before exporting.";
    $("#stitch-count").textContent = "—";
    objectRoot.replaceChildren();
    for (const obj of state.objects) renderObject(obj);
    selectionRoot.replaceChildren();
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
  $("#color-smooth").addEventListener("input", (event) => {
    if (!editingEdgeSettings) { snapshot(); editingEdgeSettings = true; }
    $("#color-smooth-value").textContent = `${Number(event.target.value).toFixed(1)} mm`;
    selectedGapFillSettings().smoothMm = Number(event.target.value);
    updateEdgeSettingsPreview();
  });
  $("#color-smooth").addEventListener("change", () => { editingEdgeSettings = false; });
  $("#angle").addEventListener("change", invalidateStitches);
  $("#underlay").addEventListener("change", invalidateStitches);
  $("#outline-mode").addEventListener("change", () => {
    $("#outline-width-row").hidden = $("#outline-mode").value !== "satin";
    invalidateStitches();
  });
  $("#outline-color").addEventListener("change", invalidateStitches);
  $("#outline-width").addEventListener("change", invalidateStitches);
  $("#stitch-preview-toggle").addEventListener("change", () => {
    if ($("#stitch-preview-toggle").checked && state.stale) debounceStitches();
    else render();
  });
  $("#export-pes").addEventListener("click", exportPes);

  viewBox(); render();
  if (!window.ImageTracer) message("Vector tracer is loading. Connect to the internet and reload if tracing is unavailable.");
})();
