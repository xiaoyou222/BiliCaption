(function (global) {
  const LABELS = {
    working: "Working….",
    searching: "Searching….",
    solving: "Solving….",
    listening: "Listening….",
    connecting: "Connecting….",
    weaving: "Weaving….",
    composing: "Composing….",
    breathing: "Thinking….",
    shaping: "Shaping…."
  };

  function mountThinkingOrb(host, options = {}) {
    const engine = global.ThinkingOrbsEngine;
    if (!host || !engine) return () => {};

    const state = LABELS[options.state] ? options.state : "composing";
    const size = 20;
    const speed = Number(options.speed) || 1;
    const label = options.label || LABELS[state] || "Thinking….";

    host.innerHTML = "";
    host.hidden = false;

    const pill = document.createElement("div");
    pill.className = "think-pill";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "think-pill-label";
    text.dataset.text = label;
    text.textContent = label;
    pill.append(canvas, text);
    host.append(pill);

    const dpr = Math.min(2, global.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return () => {};

    let preset = null;
    try {
      preset = engine.resolvePreset(state, size);
    } catch {
      preset = null;
    }
    const draw = preset?.mode ? engine.MODE_DRAWS[preset.mode] : null;
    if (!draw) return () => {};
    const effSpeed = (preset.speed || 1) * speed;

    const frame = () => {
      try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        draw(ctx, size, (performance.now() / 1000) * effSpeed, true, preset.opts);
      } catch {
        stop();
      }
    };

    let raf = 0;
    let running = false;
    const loop = () => {
      frame();
      if (running) raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    frame();
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && document.visibilityState !== "hidden") start();
      else stop();
    });
    io.observe(canvas);
    const onVis = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      host.innerHTML = "";
    };
  }

  global.mountThinkingOrb = mountThinkingOrb;
})(typeof window !== "undefined" ? window : globalThis);
