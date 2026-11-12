# Shifty Stitch

Turn pictures and text into machine embroidery files in your browser. Built for the Brother PE900; exports Brother **PES** and Tajima **DST**.

**Web app:** https://shiftyprojects.github.io/pes-converter-web/

> Beta. Always test-sew on scrap fabric first. Not responsible for damage if your machine is not compatible.

## What it does

- **Picture tracing**: import a PNG/JPG/WebP (or drop it on the hoop) and it becomes editable color regions.
- **Text**: 104 built-in fonts (script & monogram, handwritten, block, varsity, serif, sans, themed) that stitch the same on every computer, with curved (arched) text and letter spacing.
- **Color edges**: per color, an outside stroke (fills outward over neighbouring colors to close gaps), an inside stroke (fills inward over the areas the color surrounds, such as the middle of a ring), and smoothing. Double-click a color to give it your own name; your Brother machine still shows its standard thread names, because PES files only store a Brother thread number.
- **Auto fill**: measures every part of each color and picks satin (narrow parts, stitched across) or tatami (wide parts, rows along their length), with matching underlay, like auto-digitizing in professional software.
- **Machine thread** per color: choose which Brother thread your machine asks for (pick one you own) without changing the design colors.
- **Advanced tab**: a filled border around the design (follow the design, circle, oval, rounded rectangle or rectangle, in satin or fill, with edge-run underlay), fabric presets for real garments (towel, denim, cotton hoodie, T-shirt, polo, fleece, cap, felt, leather…) with a stabilizer tip for each, basting box, knockdown base for towels/fleece, trim and short-stitch limits.
- **Smooth outlines**: satin, filled band, satin with an edge line, or double satin rings, built from the exact distance around the design so the border is one continuous, even column with clean corners. Outlines and borders show on the canvas as their real stitches.
- **Layers sew in order**: traced colors stack by size (background at the bottom, details on top) and sew in that order; strokes grow only under colors above them, never over them.
- **Eraser**: click a color in the Layers & colors list to erase only that color.
- **Fill styles per thread color**: tatami, satin, wave, chevron, diamond, brick, light crosshatch, contour (echo), cross-stitch, outline only, and appliqué (placement line → stop → tack-down → stop → satin edge).
- **Decorative stitches**: draw a stitched line, or turn any shape into one: running, triple (bean), satin, zigzag, blanket, scallop, wave, cross, hearts, stars, diamonds. The same styles work as an outline around the whole design or around every color.
- **Brother thread colors**: pick from the 63 standard Brother threads, see the nearest thread name for every color, or match a whole design to Brother threads in one click.
- **Generate Stitch File**: opens the stitch previewer, where you set the file name, format (PES/DST) and final product size (the design is resized and its stitches re-planned, so density stays right), then choose where to save.
- **Efficient sewing**: connecting stitches travel hidden under areas that later colors cover, and each color starts near where the needle already is, so there are far fewer jumps and thread trims.
- **Canvas color**: a temporary background color (gray, black, navy…) to help you see and clean up artwork. It is only for the screen and is never stitched.
- **Sew-out preview**: watch the design stitch, with an estimated time. It also opens existing `.pes` and `.dst` files.
- **Machine-safe output**: tie-in/tie-off stitches, long stitches split, and every file is read back and checked before saving (same rules as `check_pes.py`).

## Works offline

Everything the app needs ships in this folder, and nothing is downloaded from the internet.

- **On the website:** after one visit the browser keeps a copy, so the page opens even with no connection. In Chrome or Edge you can also choose *Install app* from the address bar.
- **From the folder:** download the repository and double-click `index.html`.

The PES/DST writers are plain JavaScript (`formats.js`). PES output is byte-for-byte identical to pyembroidery 1.5.1, which earlier versions loaded through Python/WebAssembly.

`vendor/pyodide/` and `vendor/pyembroidery-*.whl` are no longer used, so you can delete them (about 14 MB).

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout and styles |
| `editor.js` | Canvas, tracing, stitch planning |
| `stitches.js` | Decorative line stitches, contour fill geometry |
| `formats.js` | PES/PEC/DST writers and readers, Brother thread chart |
| `previewer.js` | Sew-out preview window |
| `sw.js` | Offline cache. **Change `VERSION` when you publish an update.** |
| `vendor/` | Image tracer and bundled fonts (SIL OFL) |
| `check_pes.py` | Optional desktop safety check: `python check_pes.py design.pes` |

## Shortcuts

`V` select · `F` recolor · `I` pick color · `X` remove region · `B` brush · `L` stitch line · `E` eraser · `R` rectangle · `O` ellipse · `T` text · `0` fit hoop · arrows nudge (Shift = more) · `Ctrl+Z / Ctrl+Y` undo/redo · `Ctrl+D` duplicate · `Ctrl+S` save project · `Del` delete
