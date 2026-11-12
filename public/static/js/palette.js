// The classic xterm 256-colour palette, plus a keyboard-friendly picker grid.

/** Build the 256 colours as "#rrggbb" strings. */
function buildXterm() {
  const hex = (n) => n.toString(16).padStart(2, "0");
  const rgb = (r, g, b) => `#${hex(r)}${hex(g)}${hex(b)}`;

  // 0-15: the 16 standard + bright terminal colours
  const colors = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  // 16-231: a 6x6x6 colour cube. Each channel is one of 0, 95, 135, 175, 215, 255.
  const level = (v) => (v === 0 ? 0 : 55 + 40 * v);
  for (let i = 0; i < 216; i++) {
    colors.push(rgb(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)));
  }
  // 232-255: 24 steps of grey, from near-black to near-white
  for (let i = 0; i < 24; i++) {
    const v = 8 + 10 * i;
    colors.push(rgb(v, v, v));
  }
  return colors;
}

export const XTERM = buildXterm();

/**
 * Fill `container` with 256 swatches. Behaves as a radio group:
 * arrow keys move the selection (left/right = ±1, up/down = ±16),
 * and only the selected swatch is in the tab order.
 * Returns { select(i) } so the page can change the selection programmatically.
 */
export function buildPalette(container, initial, onPick) {
  let selected = initial;
  const swatches = XTERM.map((color, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.background = color;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", `Color ${i}, ${color}`);
    b.title = `${i} · ${color}`;
    b.dataset.index = i;
    container.appendChild(b);
    return b;
  });

  function select(i, { focus = false, notify = true } = {}) {
    selected = Math.max(0, Math.min(255, i));
    swatches.forEach((s, idx) => {
      const on = idx === selected;
      s.setAttribute("aria-checked", on);
      s.tabIndex = on ? 0 : -1;
    });
    if (focus) swatches[selected].focus();
    if (notify) onPick(selected, XTERM[selected]);
  }

  container.addEventListener("click", (e) => {
    const b = e.target.closest(".swatch");
    if (b) select(Number(b.dataset.index));
  });
  container.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -16, ArrowDown: 16, Home: -999, End: 999 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    select(selected + step, { focus: true });
  });

  select(initial);
  return { select };
}
