(function (global) {
  // Vanilla port of border-beam@1.3.0 pulse-inner + ocean + strength 0.7
  const ID = "bc";
  const BLOBS = [
    { color: "100, 80, 220", pos: "33% -7.4%", size: [70, 40], region: 1, quad: "tl" },
    { color: "60, 120, 255", pos: "12% -5%", size: [60, 35], region: 2, quad: "tl" },
    { color: "80, 100, 200", pos: "2.1% 68.3%", size: [40, 70], region: 3, quad: "bl" },
    { color: "50, 140, 220", pos: "2.1% 68.3%", size: [20, 35], region: 1, quad: "bl" },
    { color: "120, 80, 255", pos: "74.4% 100%", size: [180, 32], region: 2, quad: "br" },
    { color: "70, 130, 255", pos: "55% 100%", size: [85, 26], region: 3, quad: "br" },
    { color: "140, 100, 240", pos: "93.9% 0%", size: [74, 32], region: 1, quad: "tr" },
    { color: "90, 110, 230", pos: "100% 27.1%", size: [26, 42], region: 2, quad: "tr" },
    { color: "130, 70, 255", pos: "100% 27.1%", size: [52, 48], region: 3, quad: "tr" }
  ];
  const INNER_SIZE = [
    [65, 35], [55, 30], [35, 65], [15, 30], [173, 28], [80, 22], [69, 28], [22, 38], [47, 44]
  ];
  const BLOOM = [
    { i: 0, w: 84, h: 48 },
    { i: 1, w: 72, h: 42 },
    { i: 2, w: 48, h: 84 },
    { i: 4, w: 216, h: 38 },
    { i: 5, w: 102, h: 31 },
    { i: 6, w: 89, h: 38 },
    { i: 8, w: 62, h: 58 }
  ];

  function blob(color, w, h, region, quad, x, y) {
    return `radial-gradient(ellipse calc(${w}px * var(--bw${region}-${ID}) * var(--pulse-glow-sx, 1) * var(--pulse-glow-boost, 1)) calc(${h}px * var(--bh${region}-${ID}) * var(--bgh-${ID}) * var(--pulse-glow-sy, 1) * var(--pulse-glow-boost, 1)) at calc(${x} + var(--bx${region}-${ID})) calc(${y} + var(--by${region}-${ID})), rgba(${color}, var(--bop-${quad}-${ID})), transparent)`;
  }

  function strokeBg() {
    return BLOBS.map((b) => blob(b.color, b.size[0], b.size[1], b.region, b.quad, ...b.pos.split(" "))).join(",\n    ");
  }

  function innerBg() {
    const blobs = BLOBS.map((b, i) => blob(b.color, INNER_SIZE[i][0], INNER_SIZE[i][1], b.region, b.quad, ...b.pos.split(" ")));
    const corners = [
      ["0%", "0%", "tl"],
      ["100%", "0%", "tr"],
      ["0%", "100%", "bl"],
      ["100%", "100%", "br"]
    ].map(([x, y, q]) => `radial-gradient(ellipse 60px 60px at ${x} ${y}, rgba(255, 255, 255, calc(0.18 * var(--bop-${q}-${ID}))), transparent 70%)`);
    return [...blobs, ...corners].join(",\n    ");
  }

  function bloomBg() {
    return BLOOM.map((b) => {
      const src = BLOBS[b.i];
      const [x, y] = src.pos.split(" ");
      return `radial-gradient(ellipse calc(${b.w}px * var(--pulse-glow-sx, 1) * var(--pulse-glow-boost, 1)) calc(${b.h}px * var(--pulse-glow-sy, 1) * var(--pulse-glow-boost, 1)) at ${x} ${y}, rgba(${src.color}, 0.76), transparent)`;
    }).join(",\n    ");
  }

  function propsCss() {
    const nums = ["bw1", "bh1", "bw2", "bh2", "bw3", "bh3", "bgh", "bop-tl", "bop-tr", "bop-bl", "bop-br"];
    const lens = ["bx1", "by1", "bx2", "by2", "bx3", "by3"];
    return [
      ...nums.map((n) => `@property --${n}-${ID} { syntax: "<number>"; initial-value: 1; inherits: true; }`),
      ...lens.map((n) => `@property --${n}-${ID} { syntax: "<length>"; initial-value: 0px; inherits: true; }`),
      `@property --beam-opacity-${ID} { syntax: "<number>"; initial-value: 1; inherits: true; }`,
      `@property --beam-hue-${ID} { syntax: "<angle>"; initial-value: 0deg; inherits: true; }`
    ].join("\n");
  }

  const EDGE = `
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;`;

  function cssText() {
    const glow = `hue-rotate(calc(var(--beam-hue-base, 0deg) + var(--beam-hue-${ID}))) brightness(0.75) saturate(1.2)`;
    return `${propsCss()}
.bc-beam {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  isolation: isolate;
  pointer-events: none;
  z-index: 2;
  --beam-strength: 0.7;
  --beam-inset: 14px;
}
.bc-beam[data-active]::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: ${strokeBg()};
  ${EDGE}
  pointer-events: none;
  z-index: 2;
  opacity: calc(var(--beam-opacity-${ID}) * 1.54 * var(--beam-strength, 1));
  filter: ${glow};
}
.bc-beam[data-active]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: ${innerBg()};
  -webkit-mask-image:
    linear-gradient(#fff, transparent var(--beam-inset), transparent calc(100% - var(--beam-inset)), #fff),
    linear-gradient(to right, #fff, transparent var(--beam-inset), transparent calc(100% - var(--beam-inset)), #fff);
  -webkit-mask-composite: source-over;
  mask-image:
    linear-gradient(#fff, transparent var(--beam-inset), transparent calc(100% - var(--beam-inset)), #fff),
    linear-gradient(to right, #fff, transparent var(--beam-inset), transparent calc(100% - var(--beam-inset)), #fff);
  mask-composite: add;
  pointer-events: none;
  z-index: 1;
  opacity: calc(var(--beam-opacity-${ID}) * 0.44 * var(--beam-strength, 1));
  filter: ${glow};
}
.bc-beam [data-beam-bloom] {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: ${bloomBg()};
  padding: 1px;
  ${EDGE}
  pointer-events: none;
  z-index: 3;
  opacity: calc(var(--beam-opacity-${ID}) * 0.66 * var(--beam-strength, 1));
  filter: blur(8px) ${glow};
}
@media (prefers-reduced-motion: reduce) {
  .bc-beam[data-active]::before,
  .bc-beam[data-active]::after,
  .bc-beam [data-beam-bloom] { filter: brightness(0.75) saturate(1.2) !important; }
}`;
  }

  function inject() {
    if (document.getElementById("bc-border-beam-style")) return;
    const style = document.createElement("style");
    style.id = "bc-border-beam-style";
    style.textContent = cssText();
    (document.head || document.documentElement).appendChild(style);
  }

  const TAU = Math.PI * 2;
  const ease = (t) => (1 - Math.cos(TAU * t)) / 2;
  const live = new Set();
  let raf = 0;
  let last = 0;

  const OSC = [
    { prop: `--bw1-${ID}`, a: 0.72, b: 1.308, period: 2.34, delay: 0, unit: "" },
    { prop: `--bh1-${ID}`, a: 1.252, b: 0.762, period: 3.276, delay: 0, unit: "" },
    { prop: `--bx1-${ID}`, a: -33, b: 29.7, period: 3.04, delay: 0, unit: "px" },
    { prop: `--by1-${ID}`, a: 18.15, b: -23.1, period: 3.04, delay: 0, unit: "px" },
    { prop: `--bw2-${ID}`, a: 1.28, b: 0.762, period: 2.86, delay: 0, unit: "" },
    { prop: `--bh2-${ID}`, a: 0.776, b: 1.294, period: 2.106, delay: 0, unit: "" },
    { prop: `--bx2-${ID}`, a: 26.4, b: -29.7, period: 3.572, delay: 0, unit: "px" },
    { prop: `--by2-${ID}`, a: -33, b: 21.45, period: 3.572, delay: 0, unit: "px" },
    { prop: `--bw3-${ID}`, a: 0.832, b: 1.322, period: 2.548, delay: 0, unit: "" },
    { prop: `--bh3-${ID}`, a: 1.21, b: 0.72, period: 3.64, delay: 0, unit: "" },
    { prop: `--bx3-${ID}`, a: -19.8, b: 33, period: 2.755, delay: 0, unit: "px" },
    { prop: `--by3-${ID}`, a: -28.05, b: 14.85, period: 2.755, delay: 0, unit: "px" },
    { prop: `--bgh-${ID}`, a: 0.66, b: 1.34, period: 2.4, delay: 0, unit: "" },
    { prop: `--bop-tl-${ID}`, a: 0.52, b: 1, period: 1.9, delay: 0, unit: "" },
    { prop: `--bop-tr-${ID}`, a: 0.52, b: 1, period: 2.508, delay: 0.532, unit: "" },
    { prop: `--bop-bl-${ID}`, a: 0.52, b: 1, period: 1.596, delay: 1.045, unit: "" },
    { prop: `--bop-br-${ID}`, a: 0.52, b: 1, period: 3.002, delay: 1.577, unit: "" }
  ];
  const HUE_PERIOD = 16;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < 31) return;
    last = now;
    const t = now / 1000;
    live.forEach((el) => {
      if (!el.isConnected) {
        live.delete(el);
        return;
      }
      if (global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      for (const o of OSC) {
        const v = o.a + (o.b - o.a) * ease((t - o.delay) / o.period);
        el.style.setProperty(o.prop, o.unit === "px" ? `${v.toFixed(2)}px` : v.toFixed(4));
      }
      el.style.setProperty(`--beam-hue-${ID}`, `${((t / HUE_PERIOD) % 1 * 360).toFixed(2)}deg`);
    });
  }

  function startLoop() {
    if (!raf) {
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  function stopLoop() {
    if (live.size || !raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  const attached = new WeakMap();

  function attach(el, { strength = 0.7 } = {}) {
    if (!el) return;
    detach(el);
    inject();
    const host = document.createElement("span");
    host.className = "bc-beam";
    host.setAttribute("data-beam", ID);
    host.setAttribute("data-active", "");
    host.setAttribute("aria-hidden", "true");
    host.style.setProperty("--beam-strength", String(strength));
    host.style.borderRadius = getComputedStyle(el).borderRadius;
    const fit = () => {
      const box = el.getBoundingClientRect();
      const edge = Math.max(8, Math.min(28, Math.round(Math.min(box.width, box.height) * 0.22)));
      host.style.setProperty("--beam-inset", `${edge}px`);
    };
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    host._bcFit = ro;
    const bloom = document.createElement("span");
    bloom.setAttribute("data-beam-bloom", "");
    host.appendChild(bloom);
    el.prepend(host);
    live.add(host);
    startLoop();
    attached.set(el, host);
  }

  function detach(el) {
    if (!el) return;
    const host = attached.get(el) || el.querySelector(":scope > .bc-beam");
    if (!host) return;
    live.delete(host);
    host._bcFit?.disconnect();
    host.remove();
    attached.delete(el);
    stopLoop();
  }

  global.BiliCaptionBorderBeam = { attach, detach };
})(typeof window !== "undefined" ? window : globalThis);
