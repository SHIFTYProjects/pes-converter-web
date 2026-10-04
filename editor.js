"use strict";

(() => {
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const stage = $("#stage");
  const stageWrap = $(".stage-wrap");
  const objectRoot = $("#objects");
  const selectionRoot = $("#selection-layer");
  const statusEl = $("#status");
  const hoopSizes = { "4x4": [4, 4], "5x7": [7, 5], "6x10": [10, 6], "8x12": [12, 8] };
  const state = {
    objects: [], selectedId: null, selectedRegion: null, tool: "select", color: "#315ce8",
    hoopW: 7, hoopH: 5, zoom: 1, viewX: 0, viewY: 0, drawing: null, drag: null, pan: null, spaceDown: false, history: [],
    stitches: [], stitchColors: [], selectedPaletteColors: new Set(),
    stale: true, busy: false, pyodidePromise: null
  };
  let idCounter = 1;

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
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
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
  new ResizeObserver(fitStageToHoop).observe(stageWrap);
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
  function regionPath(obj, region, index) {
    const path = node("path", { d: region.d, fill: region.fill, "data-region-index": index, class: "region", "pointer-events": "all" });
    path.style.cursor = state.tool === "fill" || state.tool === "remove" ? "crosshair" : "inherit";
    return path;
  }
  function renderObject(obj) {
    const group = node("g", {
      "data-object-id": obj.id,
      transform: transformFor(obj),
      "pointer-events": "visiblePainted"
    });
    if (obj.type === "image") {
      const content = node("g", { transform: `scale(${obj.baseW / obj.naturalW} ${obj.baseH / obj.naturalH})` });
      obj.regions.forEach((region, index) => content.appendChild(regionPath(obj, region, index)));
      group.appendChild(content);
    } else if (obj.type === "text") {
      const text = node("text", {
        x: obj.baseW / 2, y: obj.baseH * .73, "text-anchor": "middle",
        "font-family": obj.font || "Arial", "font-size": obj.sizeIn || .4,
        fill: obj.fill, "data-object-part": "text"
      });
      text.textContent = obj.text;
      group.appendChild(text);
    } else if (obj.type === "shape" || obj.type === "draw") {
      const path = node("path", { d: obj.d, fill: obj.fill, stroke: obj.stroke || "none", "stroke-width": obj.strokeWidth || .02, "data-object-part": "shape" });
      group.appendChild(path);
    }
    objectRoot.appendChild(group);
  }
  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll("[data-tool]").forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    stage.style.cursor = tool === "select" ? "default" : tool === "pick" ? "copy" : "crosshair";
    render();
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
    for (const obj of [...state.objects].reverse()) {
      const button = document.createElement("button");
      button.className = "layer" + (obj.id === state.selectedId ? " selected" : "");
      button.type = "button"; button.dataset.selectId = obj.id; button.dataset.layerId = obj.id; button.draggable = true;
      button.setAttribute("aria-label", `Layer ${obj.name || obj.type}; drag to reorder`);
      const swatch = document.createElement("i");
      swatch.style.background = obj.fill || (obj.regions && obj.regions[0]?.fill) || "transparent";
      const label = document.createElement("span");
      label.textContent = obj.name || (obj.type === "image" ? "Traced artwork" : obj.type === "text" ? obj.text : obj.type === "draw" ? "Freeform path" : "Shape");
      button.append(swatch, label); root.appendChild(button);
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
  function renderPalette() {
    const root = $("#palette"); root.replaceChildren();
    for (const color of allColors()) {
      const row = document.createElement("label"); row.className = "swatch";
      const check = document.createElement("input"); check.type = "checkbox"; check.dataset.mergeColor = color;
      check.checked = state.selectedPaletteColors.has(color);
      const input = document.createElement("input"); input.type = "color"; input.value = color; input.dataset.paletteColor = color; input.setAttribute("aria-label", "Recolor " + color);
      const text = document.createElement("span"); text.textContent = color.toUpperCase();
      row.append(check, input, text); root.appendChild(row);
    }
  }
  function render() {
    objectRoot.replaceChildren(); selectionRoot.replaceChildren();
    for (const obj of state.objects) renderObject(obj);
    drawStitches();
    drawSelection(selectedObject());
    updateProperties(); renderLayers(); renderPalette();
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
    state.history.push(JSON.stringify(state.objects));
    if (state.history.length > 35) state.history.shift();
  }
  function persist() {
    try {
      localStorage.setItem("stitch-studio-project", JSON.stringify({ version: 1, hoopW: state.hoopW, hoopH: state.hoopH, objects: state.objects }));
    } catch (error) {
      message("Project is too large for browser autosave. Use Save project to download a copy.", "error");
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
    persist(); invalidateStitches();
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
      obj.regions[Number(regionIndex)].fill = remove ? "none" : state.color;
    } else {
      state.selectedRegion = null;
      if (obj.type === "image") obj.regions.forEach((region) => { region.fill = remove ? "none" : state.color; });
      else obj.fill = state.color;
    }
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
    state.color = safeColor(picked);
    $("#active-color").value = state.color;
    state.selectedId = obj.id;
    state.selectedRegion = { id: obj.id, index: Number(region.dataset.regionIndex) };
    render();
    message(`Picked ${state.color} from the image region.`, "ok");
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
    if (state.tool === "draw" || state.tool === "rect" || state.tool === "ellipse") {
      state.drawing = { start: p, points: [p], type: state.tool };
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
    if (state.drawing) {
      const drawing = state.drawing; state.drawing = null;
      const end = svgPoint(event), start = drawing.start;
      const x0 = Math.min(start.x, end.x), y0 = Math.min(start.y, end.y);
      const width = Math.max(.05, Math.abs(end.x - start.x)), height = Math.max(.05, Math.abs(end.y - start.y));
      snapshot();
      if (drawing.type === "draw" && drawing.points.length > 2) {
        const points = drawing.points.filter((p, index, list) => !index || Math.hypot(p.x - list[index - 1].x, p.y - list[index - 1].y) >= .01);
        const imageObj = selectedObject();
        if (imageObj?.type === "image") {
          const radians = (imageObj.rotation || 0) * Math.PI / 180;
          const localPoint = (point) => {
            const dx = point.x - imageObj.x, dy = point.y - imageObj.y;
            return {
              x: (dx * Math.cos(radians) + dy * Math.sin(radians)) / imageObj.width * imageObj.naturalW + imageObj.naturalW / 2,
              y: (-dx * Math.sin(radians) + dy * Math.cos(radians)) / imageObj.height * imageObj.naturalH + imageObj.naturalH / 2
            };
          };
          const d = points.map((point, index) => {
            const local = localPoint(point);
            return `${index ? "L" : "M"}${local.x.toFixed(3)} ${local.y.toFixed(3)}`;
          }).join(" ") + " Z";
          imageObj.regions.push({ d, fill: state.color });
          state.selectedRegion = { id: imageObj.id, index: imageObj.regions.length - 1 };
          message("Touch-up added to the selected traced image as a color region.", "ok");
        } else {
          const minX = Math.min(...points.map((p) => p.x)), minY = Math.min(...points.map((p) => p.y));
          const maxX = Math.max(...points.map((p) => p.x)), maxY = Math.max(...points.map((p) => p.y));
          const w = Math.max(.05, maxX - minX), h = Math.max(.05, maxY - minY);
          const d = points.map((p, i) => `${i ? "L" : "M"}${(p.x - minX).toFixed(4)} ${(p.y - minY).toFixed(4)}`).join(" ") + " Z";
          state.objects.push(makeVectorObject("draw", minX + w / 2, minY + h / 2, w, h, state.color, d, "Freeform path"));
        }
      } else if (drawing.type === "rect" || drawing.type === "ellipse") {
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
      render(); persist(); invalidateStitches();
    }
  });
  stage.addEventListener("pointercancel", () => {
    if (state.drag) {
      const previous = state.history.pop();
      if (previous) state.objects = JSON.parse(previous);
      persist();
    }
    state.drag = null; state.drawing = null; state.pan = null; render();
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
      const path = d.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
      selectionRoot.appendChild(node("path", { d: path, fill: "none", stroke: state.color, "stroke-width": .025, "pointer-events": "none" }));
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
      const hoopW = state.hoopW, hoopH = state.hoopH;
      const fit = Math.min((hoopW - .24) / traced.width, (hoopH - .24) / traced.height);
      snapshot();
      const obj = {
        id: uid(), type: "image", name: file.name || "Traced artwork",
        x: hoopW / 2, y: hoopH / 2, width: traced.width * fit, height: traced.height * fit,
        baseW: traced.width, baseH: traced.height, naturalW: traced.width, naturalH: traced.height,
        sourceDataUrl: traced.sourceDataUrl, traceColors, traceDetail,
        regions: $("#ignore-white").checked
          ? traced.regions.filter((region) => !isNearWhite(region.fill))
          : traced.regions
      };
      if (!obj.regions.length) throw new Error("Ignoring near-white removed all traced regions. Turn off that option and try again.");
      state.objects.push(obj); state.selectedId = obj.id; state.selectedRegion = null;
      changed();
      message(`Traced ${obj.regions.length} editable regions and fitted the image inside the hoop. Use Fill or Color Remover to edit regions.`, "ok");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function traceImageElement(image, colorCount, detail) {
    const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    let sourceDataUrl = canvas.toDataURL("image/png");
    if (sourceDataUrl.length > 1_200_000) {
      sourceDataUrl = canvas.toDataURL("image/webp", .95);
      if (!sourceDataUrl.startsWith("data:image/webp,")) sourceDataUrl = canvas.toDataURL("image/jpeg", .92);
    }
    const quality = Math.max(0, Math.min(1, (detail - 10) / 90));
    const svgText = ImageTracer.imagedataToSVG(context.getImageData(0, 0, width, height), {
      numberofcolors: colorCount, colorsampling: 2, colorquantcycles: 8, layering: 0,
      ltres: 1.4 - .6 * quality, qtres: 1.4 - .6 * quality,
      pathomit: Math.round(14 - 6 * quality), rightangleenhance: true, viewbox: true
    });
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("The image tracer returned invalid SVG.");
    const regions = [...parsed.querySelectorAll("path[d]")].map((path) => ({
      d: path.getAttribute("d"), fill: safeColor(path.getAttribute("fill") || "#000000")
    })).filter((region) => region.d && region.d.length < 200000);
    if (!regions.length) throw new Error("No editable regions were found. Try a clearer, higher-contrast image.");
    return { width, height, regions, sourceDataUrl };
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
      const width = obj.width, height = obj.height;
      obj.regions = regions;
      obj.baseW = traced.width; obj.baseH = traced.height;
      obj.naturalW = traced.width; obj.naturalH = traced.height;
      obj.sourceDataUrl = traced.sourceDataUrl;
      obj.traceColors = traceColors; obj.traceDetail = traceDetail;
      obj.width = width; obj.height = height;
      changed();
      message(`Retraced image into ${regions.length} regions using ${traceColors} colors at ${traceDetail}% detail.`, "ok");
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
    persist();
    invalidateStitches();
    message("Canvas cleared. The empty design will remain saved in this browser.", "ok");
  }
  function reorderLayer(sourceId, targetId, belowTarget) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const topDown = [...state.objects].reverse();
    const sourceIndex = topDown.findIndex((obj) => obj.id === sourceId);
    const targetIndex = topDown.findIndex((obj) => obj.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    snapshot();
    const [moved] = topDown.splice(sourceIndex, 1);
    let insertAt = topDown.findIndex((obj) => obj.id === targetId) + (belowTarget ? 1 : 0);
    insertAt = Math.max(0, Math.min(topDown.length, insertAt));
    topDown.splice(insertAt, 0, moved);
    state.objects = topDown.reverse();
    changed();
  }
  function setHoop(width, height) {
    if (!(width >= 1 && width <= 12 && height >= 1 && height <= 12)) {
      message("Hoop width and height must be between 1 and 12 inches.", "error"); return;
    }
    snapshot();
    state.hoopW = width; state.hoopH = height;
    $("#custom-width").value = width; $("#custom-height").value = height;
    state.viewX = 0; state.viewY = 0;
    viewBox(); persist(); invalidateStitches();
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
      if (obj.type === "image") obj.regions.forEach((region) => { if (selected.has(region.fill)) region.fill = "none"; });
      else if (selected.has(obj.fill)) obj.fill = "none";
    }
    state.selectedPaletteColors.clear(); changed();
    message(`Removed ${selected.size} selected fill color(s) from the stitch plan.`, "ok");
  }
  function exportProject() {
    const blob = new Blob([JSON.stringify({ version: 1, hoopW: state.hoopW, hoopH: state.hoopH, objects: state.objects }, null, 2)], { type: "application/json" });
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
    snapshot(); state.objects = data.objects; state.hoopW = Number(data.hoopW) || 7; state.hoopH = Number(data.hoopH) || 5;
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
      const colorPath = (d, fill) => {
        if (fill !== color) return;
        group.appendChild(node("path", { d, fill }));
      };
      if (obj.type === "image") {
        const content = node("g", { transform: `scale(${obj.baseW / obj.naturalW} ${obj.baseH / obj.naturalH})` });
        for (const region of obj.regions) if (region.fill === color) content.appendChild(node("path", { d: region.d, fill: region.fill }));
        group.appendChild(content);
      } else if (obj.type === "text") {
        if (obj.fill === color) {
          const text = node("text", { x: obj.baseW / 2, y: obj.baseH * .73, "text-anchor": "middle", "font-family": obj.font || "Arial", "font-size": obj.sizeIn, fill: color });
          text.textContent = obj.text; group.appendChild(text);
        }
      } else colorPath(obj.d, obj.fill);
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
  async function scanColor(color, angle, rowSpacing, ppu) {
    const scene = colorSceneSvg(color, angle, ppu);
    const image = await loadSvgImage(scene.svg);
    const side = Math.ceil(Math.hypot(scene.width, scene.height));
    const canvas = document.createElement("canvas"); canvas.width = side; canvas.height = side;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.translate(side / 2, side / 2); context.rotate(angle * Math.PI / 180);
    context.drawImage(image, -scene.width / 2, -scene.height / 2, scene.width, scene.height);
    const pixels = context.getImageData(0, 0, side, side).data;
    const segments = [], step = Math.max(1, Math.round(rowSpacing * ppu));
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    const spacingIn = 1 / ppu;
    for (let y = 0; y < side; y += step) {
      const runs = []; let start = -1;
      for (let x = 0; x <= side; x++) {
        const ink = x < side && pixels[(y * side + x) * 4 + 3] > 80;
        if (ink && start < 0) start = x;
        if ((!ink || x === side) && start >= 0) {
          if (x - start >= 2) runs.push([start, x - 1]);
          start = -1;
        }
      }
      if (y / step % 2) runs.reverse();
      for (const [x1, x2] of runs) {
        const mapPoint = (px) => {
          const xr = (px - side / 2) * spacingIn, yr = (y - side / 2) * spacingIn;
          const dx = xr * c + yr * s, dy = -xr * s + yr * c;
          return { x: state.hoopW / 2 + dx / 25.4, y: state.hoopH / 2 + dy / 25.4 };
        };
        let a = mapPoint(x1), b = mapPoint(x2);
        const length = Math.hypot(b.x - a.x, b.y - a.y) * 25.4;
        if (length < .35) continue;
        const pieces = Math.max(1, Math.ceil(length / 3));
        const points = [];
        for (let i = 0; i <= pieces; i++) {
          const t = i / pieces;
          points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
        if (points.length > 1) segments.push({ color, points });
      }
    }
    return segments;
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
      const segments = [], ppu = 2;
      for (const color of colors) {
        const colorIndex = colors.indexOf(color);
        if ($("#underlay").value === "grid") {
          segments.push(...(await scanColor(color, angle + 90, Math.max(.65, spacing * 2), ppu)).map((segment) => ({ ...segment, color: colorIndex })));
        }
        segments.push(...(await scanColor(color, angle, spacing, ppu)).map((segment) => ({ ...segment, color: colorIndex })));
        if (segments.reduce((total, seg) => total + seg.points.length, 0) > 100000) throw new Error("This design exceeds 100,000 planned stitches. Increase row spacing or simplify the artwork.");
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
      state.stitches.forEach((segment, index) => {
        const colorIndex = segment.color;
        const first = toPesPoint(segment.points[0]);
        events.push({ cmd: "jump", color: colorIndex, x: first.x, y: first.y });
        for (const point of segment.points.slice(1)) {
          const pesPoint = toPesPoint(point);
          events.push({ cmd: "stitch", color: colorIndex, x: pesPoint.x, y: pesPoint.y });
        }
        const next = state.stitches[index + 1];
        if (next && next.color !== colorIndex) {
          const pesPoint = toPesPoint(segment.points.at(-1));
          events.push({ cmd: "color", color: next.color, x: pesPoint.x, y: pesPoint.y });
        }
      });
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
EmbPattern.write_pes(pattern, output, {"version": 1.0})
data = output.getvalue()
checked = EmbPattern.read_pes(io.BytesIO(data))
if len(checked.stitches) < 2 or len(checked.threadlist) != len(payload["colors"]):
    raise ValueError("PES validation did not find the expected stitches and thread colors.")
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
      download(new Blob([bytes], { type: "application/octet-stream" }), "stitch-studio-design.pes");
      message(`PES v1 generated and reopened for validation (${result.bytes.toLocaleString()} bytes, ${result.stitches.toLocaleString()} commands, ${result.threads} threads). Verify in Brother software and test on scrap fabric before sewing.`, "ok");
    } catch (error) {
      console.error(error);
      const details = String(error.message || error).split("\n").filter(Boolean).slice(-1)[0];
      message(details || "Could not create a PES file.", "error");
    }
  }

  document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  $("#active-color").addEventListener("input", (event) => { state.color = event.target.value; });
  $("#active-color").addEventListener("change", () => { if (state.selectedId) applySelectedColor(); });
  $("#ignore-white").addEventListener("change", (event) => {
    if (!event.target.checked) return;
    const obj = selectedObject();
    if (obj?.type !== "image") return;
    const whites = obj.regions.filter((region) => isNearWhite(region.fill));
    if (!whites.length) return;
    snapshot();
    obj.regions.forEach((region) => { if (isNearWhite(region.fill)) region.fill = "none"; });
    changed(); message(`Ignored ${whites.length} near-white traced region(s).`, "ok");
  });
  $("#obj-fill").addEventListener("change", (event) => {
    const obj = selectedObject(); if (!obj) return;
    state.color = event.target.value; $("#active-color").value = state.color; applySelectedColor();
  });
  $("#hoop").addEventListener("change", () => {
    $("#custom-row").hidden = $("#hoop").value !== "custom";
    if ($("#hoop").value !== "custom") setHoop(...hoopSizes[$("#hoop").value]);
    else setHoop(Number($("#custom-width").value), Number($("#custom-height").value));
  });
  $("#custom-width").addEventListener("change", () => setHoop(Number($("#custom-width").value), Number($("#custom-height").value)));
  $("#custom-height").addEventListener("change", () => setHoop(Number($("#custom-width").value), Number($("#custom-height").value)));
  $("#trace-colors").addEventListener("change", () => {
    if (selectedObject()?.type === "image") message("Color count changed. Retrace the selected image to apply it.", "info");
  });
  $("#trace-detail").addEventListener("input", (event) => {
    $("#trace-detail-value").textContent = `${event.target.value}%`;
    if (selectedObject()?.type === "image") message("Trace detail changed. Retrace the selected image to apply it.", "info");
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
  $("#font").addEventListener("change", () => { const obj = selectedObject(); if (obj && obj.type === "text") { obj.font = $("#font").value; changed(); } });
  $("#layers").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-id]"); if (!button) return;
    state.selectedId = button.dataset.selectId; state.selectedRegion = null; render();
  });
  let draggingLayerId = null;
  $("#layers").addEventListener("dragstart", (event) => {
    const layer = event.target.closest("[data-layer-id]");
    if (!layer) return;
    draggingLayerId = layer.dataset.layerId;
    layer.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingLayerId);
  });
  $("#layers").addEventListener("dragover", (event) => {
    const target = event.target.closest("[data-layer-id]");
    if (!target || target.dataset.layerId === draggingLayerId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    $("#layers").querySelectorAll(".drop-target").forEach((item) => item.classList.remove("drop-target"));
    target.classList.add("drop-target");
  });
  $("#layers").addEventListener("drop", (event) => {
    const target = event.target.closest("[data-layer-id]");
    if (!target) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    reorderLayer(draggingLayerId || event.dataTransfer.getData("text/plain"), target.dataset.layerId, event.clientY > rect.top + rect.height / 2);
    draggingLayerId = null;
  });
  $("#layers").addEventListener("dragend", () => {
    draggingLayerId = null;
    $("#layers").querySelectorAll(".dragging,.drop-target").forEach((item) => item.classList.remove("dragging", "drop-target"));
  });
  $("#palette").addEventListener("change", (event) => {
    const input = event.target.closest("[data-palette-color]"); if (!input) return;
    const previous = input.dataset.paletteColor, next = input.value;
    if (previous === next) return;
    snapshot();
    for (const obj of state.objects) {
      if (obj.type === "image") obj.regions.forEach((region) => { if (region.fill === previous) region.fill = next; });
      else if (obj.fill === previous) obj.fill = next;
    }
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
    state.objects = JSON.parse(previous); state.selectedId = null; state.selectedRegion = null; render(); persist(); invalidateStitches();
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
  $("#angle").addEventListener("change", invalidateStitches);
  $("#underlay").addEventListener("change", invalidateStitches);
  $("#stitch-preview-toggle").addEventListener("change", () => {
    if ($("#stitch-preview-toggle").checked && state.stale) debounceStitches();
    else render();
  });
  $("#export-pes").addEventListener("click", exportPes);

  try {
    const saved = JSON.parse(localStorage.getItem("stitch-studio-project") || "null");
    if (saved?.version === 1 && Array.isArray(saved.objects)) {
      state.hoopW = Number(saved.hoopW) || 4; state.hoopH = Number(saved.hoopH) || 4; state.objects = saved.objects;
      for (const obj of state.objects) {
        const suffix = Number(/(\d+)$/.exec(obj.id)?.[1]);
        if (Number.isFinite(suffix)) idCounter = Math.max(idCounter, suffix + 1);
      }
      const option = Object.entries(hoopSizes).find(([, size]) => size[0] === state.hoopW && size[1] === state.hoopH);
      if (option) $("#hoop").value = option[0];
      else { $("#hoop").value = "custom"; $("#custom-row").hidden = false; $("#custom-width").value = state.hoopW; $("#custom-height").value = state.hoopH; }
    }
  } catch (error) {
    console.warn("Could not restore the autosaved project.", error);
  }
  viewBox(); render();
  if (!window.ImageTracer) message("Vector tracer is loading. Connect to the internet and reload if tracing is unavailable.");
})();
