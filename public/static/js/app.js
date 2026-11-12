// Page logic: state, controls, talking to /convert, drawing, copy & downloads.
import { XTERM, buildPalette } from "./palette.js";
import { render, FONT_FAMILY } from "./renderer.js";

const $ = (id) => document.getElementById(id);
const MAX_ORIGINAL = 25 * 1024 * 1024;   // largest photo we'll even try to open in the browser
const MAX_UPLOAD = 4 * 1024 * 1024;      // Vercel rejects bodies over ~4.5 MB; the server caps at 4 MB
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const BACKGROUNDS = { midnight: "#0b0d12", black: "#000000", white: "#ffffff", transparent: null };
const DEMO_RAMP = "'`^\",:;Il!i<>~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"; // sparse -> dense

// ----------------------------------------------------------------- state ----
const state = {
  file: null,                 // what we upload (possibly a shrunken copy), kept in memory
  name: "image",               // the person's original filename, for labels and downloads
  art: null, cols: 0, rows: 0,
  rgb: null,                  // original colours straight from the server
  boosted: null,              // rgb after the colour-boost slider
  width: Number($("width").value),
  charset: "detailed",
  invert: false,
  contrast: true,
  colorMode: "original",      // "original" | "single"
  paletteIndex: 214,          // an orange from the xterm-256 palette
  boost: 40,
  bg: "midnight",
};

const canvas = $("art-canvas"), stage = $("stage"), statusEl = $("status");
const copyBtn = $("copy-btn"), txtBtn = $("txt-btn"), pngBtn = $("png-btn");
let controller = null, debounceTimer = null, demoActive = true, rafId = 0, redrawQueued = false;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// --------------------------------------------------------- colour helpers ----
/** Raise saturation and brightness together; `amount` is 0-100. Returns a new array. */
function boostColors(rgb, amount) {
  const sat = 1 + amount / 50, gain = 1 + amount / 100;
  const out = new Uint8ClampedArray(rgb.length);   // clamps to 0-255 automatically
  for (let i = 0; i < rgb.length; i += 3) {
    const lum = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
    out[i] = (lum + (rgb[i] - lum) * sat) * gain;
    out[i + 1] = (lum + (rgb[i + 1] - lum) * sat) * gain;
    out[i + 2] = (lum + (rgb[i + 2] - lum) * sat) * gain;
  }
  return out;
}

function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

// ------------------------------------------------------------------ draw ----
/** Options shared by the on-screen canvas and the PNG export. */
function drawOptions(rgb) {
  const single = state.colorMode === "single";
  return { rgb: single ? null : rgb, solid: XTERM[state.paletteIndex], bg: BACKGROUNDS[state.bg] };
}

/** Pick a font size so the art exactly fills the stage width. */
function fitFontPx(cols) {
  const dpr = window.devicePixelRatio || 1;
  const pad = 20 * dpr;
  const available = stage.clientWidth * dpr - pad * 2;
  return Math.max(3, Math.min(22 * dpr, available / (cols * 0.6)));
}

function paint(art, cols, rows, rgb) {
  const dpr = window.devicePixelRatio || 1;
  render(canvas, art, { cols, rows, fontPx: fitFontPx(cols), pad: 20 * dpr, ...drawOptions(rgb) });
  canvas.style.width = canvas.width / dpr + "px";   // canvas pixels are device pixels; CSS size is not
}

function redraw() {
  if (state.art) paint(state.art, state.cols, state.rows, state.boosted);
  else if (!demoActive) return;
  else drawDemo(performance.now());
}

function queueRedraw() {            // coalesce bursts (resize, slider drags) into one frame
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; redraw(); });
}

// ------------------------------------------------- the demo before upload ----
// A moving plasma, rendered with the same renderer. It reacts to the colour and
// background controls, so people can try the palette before uploading anything.
function drawDemo(now) {
  const cols = 120, rows = 38, t = now / 1000;
  const rgb = new Uint8ClampedArray(cols * rows * 3);
  let art = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = (Math.sin(x * 0.11 + t) + Math.sin(y * 0.3 - t * 0.8) +
                 Math.sin((x + y * 2) * 0.06 + t * 0.5) +
                 Math.sin(Math.hypot(x - cols / 2, (y - rows / 2) * 2.2) * 0.14 - t * 1.2) + 4) / 8;
      art += DEMO_RAMP[Math.min(DEMO_RAMP.length - 1, Math.floor(v * DEMO_RAMP.length))];
      const [r, g, b] = hsvToRgb((v * 0.7 + t * 0.04) % 1, 0.8, 0.35 + 0.65 * v);
      const i = (y * cols + x) * 3;
      rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
    }
    if (y < rows - 1) art += "\n";
  }
  paint(art, cols, rows, boostColors(rgb, state.boost));
}

function startDemo() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { drawDemo(2000); return; }          // one still frame, no animation
  let last = 0;
  const loop = (now) => {
    if (!demoActive) return;
    if (now - last > 66) { last = now; drawDemo(now); }   // ~15 fps is plenty for text
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopDemo() { demoActive = false; cancelAnimationFrame(rafId); $("demo-note").hidden = true; }

// ------------------------------------------------------------- converting ----
/**
 * Phone photos are often 4-12 MB, but the server only accepts 4 MB. So big images are shrunk
 * in the browser first. 1600 px on the long side is far more than the max 300 columns need.
 */
async function prepareImage(file) {
  let bitmap;
  try {
    // "from-image" applies the EXIF rotation, so portrait phone photos stay upright
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (file.size <= MAX_UPLOAD) return file;       // can't decode here: let the server try
    throw new Error("This browser couldn’t open that image. Try a JPG or PNG.");
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (file.size <= 1.5 * 1024 * 1024 && longest <= 2400) { bitmap.close(); return file; }  // already small

  const keepAlpha = file.type !== "image/jpeg";     // PNG/WEBP may be transparent: keep that as PNG
  for (const side of [1600, 1200, 800, 500]) {      // try smaller sizes until it fits the limit
    const scale = Math.min(1, side / longest);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bitmap.width * scale));
    c.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    const blob = await new Promise((done) => c.toBlob(done, keepAlpha ? "image/png" : "image/jpeg", 0.9));
    if (blob && blob.size <= MAX_UPLOAD) {
      bitmap.close();
      return new File([blob], file.name, { type: blob.type });
    }
  }
  bitmap.close();
  throw new Error("That image is too large to upload, even after shrinking. Try a smaller one.");
}

async function handleFile(file) {
  if (!file) return;
  if (!ALLOWED.includes(file.type)) return setStatus("Choose a PNG, JPG or WEBP image.", true);
  if (file.size > MAX_ORIGINAL) return setStatus("That file is over 25 MB. Choose a smaller one.", true);
  setStatus("Preparing image…");
  try {
    state.file = await prepareImage(file);
  } catch (err) {
    return setStatus(err.message, true);
  }
  state.name = file.name;
  $("drop-title").textContent = file.name;
  $("drop-sub").textContent = "Tap or drop to replace";
  convert();
}

async function convert() {
  if (!state.file) return;
  if (controller) controller.abort();               // cancel an outdated request
  controller = new AbortController();

  const body = new FormData();
  body.append("file", state.file);
  body.append("width", state.width);
  body.append("charset", state.charset);
  body.append("invert", state.invert);
  body.append("contrast", state.contrast);
  stage.setAttribute("aria-busy", "true");
  setStatus("Converting…");

  try {
    const res = await fetch("/convert", { method: "POST", body, signal: controller.signal });
    const data = await res.json().catch(() => ({}));   // platform errors (e.g. Vercel's 413) aren't JSON
    if (res.status === 413) throw new Error("That image is too large to upload. Try a smaller one.");
    if (!res.ok) throw new Error(data.error || "Conversion failed. Please try again.");

    // base64 -> bytes: three bytes (R, G, B) per character
    state.rgb = Uint8Array.from(atob(data.colors), (c) => c.charCodeAt(0));
    state.boosted = boostColors(state.rgb, state.boost);
    state.art = data.ascii; state.cols = data.cols; state.rows = data.rows;

    stopDemo();
    canvas.setAttribute("aria-label", `ASCII art of ${state.name}, ${data.cols} by ${data.rows} characters`);
    [copyBtn, txtBtn, pngBtn].forEach((b) => (b.disabled = false));
    redraw();
    setStatus(`${data.cols} × ${data.rows} characters`);
  } catch (err) {
    if (err.name === "AbortError") return;
    // fetch() itself rejects with a TypeError when there is no connection
    setStatus(err instanceof TypeError ? "Couldn’t reach the server. Check your connection." : err.message, true);
  } finally {
    stage.removeAttribute("aria-busy");
  }
}

// --------------------------------------------------------------- controls ----
const dz = $("dropzone");
$("file-input").addEventListener("change", (e) => handleFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

/** Wire a group of toggle buttons (aria-pressed) to a callback. */
function segment(id, onChange) {
  const group = $(id);
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    onChange(btn.dataset.value);
  });
}

$("width").addEventListener("input", (e) => {
  state.width = Number(e.target.value);
  $("width-value").textContent = `${state.width} characters`;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(convert, 250);          // wait until the slider settles
});

segment("charset", (v) => { state.charset = v; convert(); });
$("contrast").addEventListener("change", (e) => { state.contrast = e.target.checked; convert(); });
$("invert").addEventListener("change", (e) => { state.invert = e.target.checked; convert(); });

// Colour mode: these changes are instant because colours are already in the browser.
segment("color-mode", (v) => {
  state.colorMode = v;
  $("boost-row").hidden = v !== "original";
  $("palette-row").hidden = v !== "single";
  queueRedraw();
});

$("boost").addEventListener("input", (e) => {
  state.boost = Number(e.target.value);
  $("boost-value").textContent = `${state.boost}%`;
  if (state.rgb) state.boosted = boostColors(state.rgb, state.boost);
  queueRedraw();
});

const palette = buildPalette($("palette"), state.paletteIndex, (i, hex) => {
  state.paletteIndex = i;
  $("palette-label").textContent = `Color ${i} · ${hex}`;
  $("palette-chip").style.background = hex;
  queueRedraw();
});

segment("background", (v) => {
  state.bg = v;
  stage.classList.toggle("checker", v === "transparent");
  // Light backgrounds need the reversed ramp so dark areas stay visible; pre-tick it for them.
  const wantsReverse = v === "white";
  if (wantsReverse !== state.invert) { $("invert").checked = wantsReverse; state.invert = wantsReverse; convert(); }
  queueRedraw();
});

new ResizeObserver(queueRedraw).observe(stage);

// ---------------------------------------------------------------- outputs ----
const baseName = () => (state.name.replace(/\.[^.]+$/, "") || "ascii-art");

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.art);
    setStatus("Copied. Colors aren’t included in plain text; use the PNG for those.");
  } catch {
    setStatus("Your browser blocked copying. Use Download .txt instead.", true);
  }
});

txtBtn.addEventListener("click", () => {
  download(new Blob([state.art], { type: "text/plain;charset=utf-8" }), `${baseName()}.txt`);
  setStatus("Downloaded the .txt file.");
});

/** Phones cap canvas size (iOS ~16.7 million pixels), so shrink big exports to fit. */
function exportFontPx() {
  const MAX_AREA = 14e6, MAX_SIDE_PX = 8000, base = 18;
  const w = state.cols * 0.6 * base + 48, h = (state.rows * 0.6 / 0.55) * base + 48;
  const k = Math.min(1, Math.sqrt(MAX_AREA / (w * h)), MAX_SIDE_PX / Math.max(w, h));
  return Math.max(5, base * k);
}

pngBtn.addEventListener("click", () => {
  const off = document.createElement("canvas");   // draw again, off-screen, at a fixed generous size
  render(off, state.art, { cols: state.cols, rows: state.rows, fontPx: exportFontPx(), pad: 24, ...drawOptions(state.boosted) });
  off.toBlob(async (blob) => {
    if (!blob) return setStatus("The image was too large for your browser. Lower the detail and retry.", true);
    const filename = `${baseName()}.png`;
    // On phones the share sheet offers "Save Image" (to Photos) and sharing to other apps
    const file = new File([blob], filename, { type: "image/png" });
    if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "ASCII art" });
        return setStatus("Choose “Save Image” to keep it in your photos.");
      } catch (err) {
        if (err.name === "AbortError") return;     // person closed the sheet: nothing to report
      }                                            // any other failure: fall back to a normal download
    }
    download(blob, filename);
    setStatus(`Downloaded a ${off.width} × ${off.height} px PNG.`);
  }, "image/png");
});

// ------------------------------------------------------------------ start ----
// Wait for the monospace font so the very first frame isn't drawn in a fallback face.
document.fonts.load(`16px ${FONT_FAMILY}`).catch(() => {}).finally(startDemo);
