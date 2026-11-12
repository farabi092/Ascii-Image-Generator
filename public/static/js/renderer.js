// Draws ASCII art onto a <canvas>, one coloured character per cell.
// Canvas is used (instead of <pre>) because every character can have its own
// colour, and the exact same drawing code produces the PNG download.

export const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
const GLYPH_W = 0.6;       // a monospace glyph is ~0.6 x its font size wide
const CELL_ASPECT = 0.55;  // must match CHAR_ASPECT in app.py so the picture isn't stretched

/**
 * @param canvas   target canvas (its size is set here)
 * @param art      the text, rows separated by "\n"
 * @param opts     cols, rows, fontPx
 *                 rgb   Uint8ClampedArray of R,G,B per character (original-colour mode) or null
 *                 solid CSS colour used for every character when rgb is null
 *                 bg    CSS colour, or null for a transparent background
 *                 pad   padding in pixels around the art
 */
export function render(canvas, art, { cols, rows, fontPx, rgb = null, solid = "#ffffff", bg = null, pad = 0 }) {
  const cellW = fontPx * GLYPH_W;
  const cellH = cellW / CELL_ASPECT;
  canvas.width = Math.ceil(cols * cellW + pad * 2);    // setting size also clears the canvas
  canvas.height = Math.ceil(rows * cellH + pad * 2);

  const ctx = canvas.getContext("2d");
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.font = `${fontPx}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";      // centre each glyph in its cell so rows stay aligned
  ctx.textBaseline = "middle";
  if (!rgb) ctx.fillStyle = solid;

  const lines = art.split("\n");
  let lastKey = -1;
  for (let r = 0; r < rows; r++) {
    const line = lines[r] || "";
    const y = pad + (r + 0.5) * cellH;
    for (let c = 0; c < cols; c++) {
      const glyph = line[c];
      if (glyph === undefined || glyph === " ") continue;   // spaces draw nothing
      if (rgb) {
        const i = (r * cols + c) * 3;
        const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
        if (key !== lastKey) {                               // only change style when colour changes
          ctx.fillStyle = `rgb(${rgb[i]},${rgb[i + 1]},${rgb[i + 2]})`;
          lastKey = key;
        }
      }
      ctx.fillText(glyph, pad + (c + 0.5) * cellW, y);
    }
  }
}
