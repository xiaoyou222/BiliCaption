(() => {
  window.__BILI_CAPTION_GEN__ = (window.__BILI_CAPTION_GEN__ || 0) + 1;
  const SCRIPT_GEN = window.__BILI_CAPTION_GEN__;
  const isCurrentScript = () => window.__BILI_CAPTION_GEN__ === SCRIPT_GEN;

  let targetRate = 1;
  let applyingRate = false;
  let lastHref = location.href;
  let lastStateKey = "";
  let loadToken = 0;
  let myTabId = 0;
  let cachedState = emptyState("loading");
  let hookedVideo = null;
  let hookedCleanups = [];
  let hudTimer = 0;
  let overlayCues = [];
  let lastOverlayText = "";
  let overlayOn = true;
  let overlayRo = null;
  const DOCK_SNAP = 26;
  const DOCK_MIN_W = 260;
  const DOCK_MIN_H = 200;
  const DOCK_TAB_W = 18;

  let dockOpen = false;
  let dockGeom = { page: null, full: null };
  let dockAlpha = 0.82;
  let preferSidebar = true;
  let dockHover = false;
  let selKey = "Shift";
  let selKeyHeld = false;

  function requestChromePanelHidden() {
    postRuntime({ type: "CLOSE_SIDE_PANEL" });
  }

  function requestChromePanelRestore() {
    if (!runtimeAlive()) return;
    try {
      chrome.runtime.sendMessage({ type: "RESTORE_SIDE_PANEL" }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // ignore
    }
  }

  function persistDockPrefs() {
    if (!myTabId) return;
    chrome.storage.local.set({
      [`dockOpen:${myTabId}`]: dockOpen,
      [`preferSidebar:${myTabId}`]: preferSidebar
    }).catch(() => {});
  }

  function returnToSidebar() {
    preferSidebar = true;
    dockOpen = false;
    persistDockPrefs();
    const el = document.getElementById("bilicaption-dock");
    if (el) el.remove();
    requestChromePanelRestore();
  }

  function emptyState(page, extra = {}) {
    return {
      page,
      bvid: "",
      aid: 0,
      cid: 0,
      title: "",
      part: "",
      rate: targetRate,
      tracks: [],
      activeLan: "",
      cues: [],
      currentTime: 0,
      duration: 0,
      source: "",
      canGenerate: false,
      error: "",
      ...extra
    };
  }

  function cueTextKey(cue) {
    return String(Math.round((Number(cue?.from) || 0) * 10));
  }

  function preserveCueText(incoming, existing) {
    const textByStart = new Map(
      (Array.isArray(existing) ? existing : []).map((cue) => [
        cueTextKey(cue),
        String(cue.content || "")
      ])
    );
    return (Array.isArray(incoming) ? incoming : []).map((cue) => {
      const content = textByStart.get(cueTextKey(cue));
      return content == null ? { ...cue } : { ...cue, content };
    });
  }

  function readPageIdentity() {
    try {
      const init = window.__INITIAL_STATE__ || {};
      const ep = init.epInfo || {};
      const video = init.videoData || {};
      const p = Math.max(1, Number(new URLSearchParams(location.search).get("p") || init.p || 1));
      const page = video.pages?.[p - 1];
      return {
        epId: String(ep.id || ep.ep_id || init.epId || ""),
        seasonId: String(init.mediaInfo?.season_id || init.ssId || ""),
        cid: Number(ep.cid || page?.cid || video.cid || 0),
        aid: Number(ep.aid || video.aid || 0),
        bvid: ep.bvid || video.bvid || ""
      };
    } catch {
      return { epId: "", seasonId: "", cid: 0, aid: 0, bvid: "" };
    }
  }

  function parsePage() {
    const path = location.pathname;
    const search = new URLSearchParams(location.search);
    const hint = readPageIdentity();
    const bvFromPath = path.match(/\/video\/(BV[\w]+)/)?.[1];
    const bvFromQuery = search.get("bvid");
    const bvid = bvFromPath || bvFromQuery || hint.bvid;
    if (bvid && /\/video\/|\/list\//.test(path)) {
      return {
        kind: "video",
        bvid,
        p: Math.max(1, Number(search.get("p") || 1)),
        cid: hint.cid || 0,
        aid: hint.aid || 0
      };
    }
    const epId = path.match(/\/bangumi\/play\/ep(\d+)/)?.[1] || hint.epId;
    const seasonId = path.match(/\/bangumi\/play\/ss(\d+)/)?.[1] || hint.seasonId;
    if (/\/bangumi\/play\//.test(path) && (epId || seasonId)) {
      return {
        kind: "bangumi",
        epId: epId || "",
        seasonId: seasonId || "",
        cid: hint.cid || 0,
        aid: hint.aid || 0,
        bvid: hint.bvid || ""
      };
    }
    return { kind: "other" };
  }

  function pageKey(page = parsePage()) {
    if (page.kind === "video") return `video:${page.bvid}:${page.p || 1}`;
    if (page.kind === "bangumi") {
      if (page.epId) return `ep:${page.epId}`;
      if (page.seasonId) return `ss:${page.seasonId}:${page.cid || ""}`;
    }
    return `other:${location.pathname}${location.search}`;
  }

  function pageIdentity(extra = {}) {
    const page = parsePage();
    return {
      tabId: myTabId,
      pageKey: pageKey(page),
      bvid: cachedState.bvid || page.bvid || extra.bvid || "",
      cid: Number(cachedState.cid || page.cid || extra.cid) || 0,
      ...extra
    };
  }

  function runtimeAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function postRuntime(message) {
    if (!runtimeAlive()) return Promise.resolve();
    try {
      const sent = chrome.runtime.sendMessage({ ...pageIdentity(), ...message });
      return sent && typeof sent.then === "function" ? sent.catch(() => {}) : Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  async function ensureTabId() {
    if (myTabId) return myTabId;
    try {
      const res = await chrome.runtime.sendMessage({ type: "WHOAMI" });
      myTabId = Number(res?.tabId) || 0;
    } catch {
      myTabId = 0;
    }
    return myTabId;
  }

  function askBackground(message) {
    return new Promise((resolve, reject) => {
      if (!runtimeAlive()) {
        reject(new Error("扩展已更新，请刷新这个标签页"));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(/context invalidated/i.test(err.message || "")
              ? "扩展已更新，请刷新这个标签页"
              : err.message));
            return;
          }
        // 业务提示走 notice；只有 fatal/没有有效数据时才当失败
        if (response?.fatal) {
          reject(new Error(response.error || response.fatal || "请求失败"));
          return;
        }
        if (response?.error && !response?.aid && response?.page !== "video") {
          reject(new Error(response.error));
          return;
        }
          resolve(response);
        });
      } catch {
        reject(new Error("扩展已更新，请刷新这个标签页"));
      }
    });
  }

  function getVideo() {
    const videos = [...document.querySelectorAll("video")].filter((el) => el.offsetWidth > 80);
    if (!videos.length) return document.querySelector("video");
    return videos.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
  }

  function ensureHud() {
    let hud = document.getElementById("bilicaption-rate-hud");
    if (hud) return hud;
    hud = document.createElement("div");
    hud.id = "bilicaption-rate-hud";
    hud.style.cssText = [
      "position:absolute",
      "top:12px",
      "right:12px",
      "z-index:2147483646",
      "padding:4px 11px",
      "border-radius:999px",
      "background:rgba(20,30,45,.38)",
      "backdrop-filter:blur(3px)",
      "color:rgba(255,255,255,.85)",
      "font:500 12px/1 JetBrains Mono,SF Mono,ui-monospace,monospace",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity .16s",
      "letter-spacing:.02em"
    ].join(";");
    const host =
      getPlayerHost();
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(hud);
    return hud;
  }

  function flashHud(rate) {
    const hud = ensureHud();
    hud.textContent = `${Number(rate).toFixed(rate % 1 ? 2 : 1).replace(/\.00$/, "")}×`;
    hud.style.opacity = "1";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hud.style.opacity = targetRate === 1 ? "0" : "0.85";
    }, 900);
  }

  function getPlayerHost() {
    return (
      document.querySelector(".bpx-player-video-area") ||
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bilibili-player-video-wrap") ||
      document.body
    );
  }

  function getDockHost() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      getPlayerHost()
    );
  }

  function ensureDockStyle() {
    if (document.getElementById("bilicaption-dock-style")) return;
    const style = document.createElement("style");
    style.id = "bilicaption-dock-style";
    style.textContent = `
      #bilicaption-dock {
        --bc-dock-alpha: .82;
        position: fixed;
        z-index: 2147483646;
        pointer-events: auto;
        font-family: "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      }
      #bilicaption-dock.bc-inside { position: absolute; }
      #bilicaption-dock .bc-dock-tab {
        appearance: none;
        position: absolute;
        inset: 0;
        margin: 0;
        padding: 0;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 12px 0 0 12px;
        background: rgba(18, 20, 23, .78);
        color: #e8eaed;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font: 600 15px/1 inherit;
      }
      #bilicaption-dock .bc-dock-tab:hover { background: rgba(18, 20, 23, .94); }
      #bilicaption-dock.bc-edge-left .bc-dock-tab {
        border-radius: 0 12px 12px 0;
        border-left: none;
      }
      #bilicaption-dock.bc-edge-right .bc-dock-tab { border-right: none; }
      #bilicaption-dock.open .bc-dock-tab { display: none; }
      #bilicaption-dock.collapsed .bc-dock-win { display: none; }
      #bilicaption-dock .bc-dock-win {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.1);
        background: #121417;
        box-shadow: 0 14px 34px rgba(0,0,0,.35);
        opacity: var(--bc-dock-alpha);
      }
      #bilicaption-dock .bc-dock-head {
        flex: 0 0 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 8px 0 12px;
        background: #16181c;
        color: #c4c8ce;
        font: 500 12px/1 inherit;
        cursor: move;
        user-select: none;
      }
      #bilicaption-dock .bc-dock-title {
        flex: none;
        color: #eceef1;
        letter-spacing: .04em;
      }
      #bilicaption-dock .bc-dock-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      #bilicaption-dock .bc-dock-alpha-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1 1 110px;
        max-width: 168px;
      }
      #bilicaption-dock .bc-dock-alpha-value {
        flex: none;
        min-width: 2.4em;
        color: #9aa3ad;
        font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        text-align: right;
        letter-spacing: .02em;
      }
      #bilicaption-dock .bc-dock-alpha {
        -webkit-appearance: none;
        appearance: none;
        flex: 1 1 auto;
        width: 96px;
        height: 12px;
        margin: 0;
        background: transparent;
        cursor: pointer;
      }
      #bilicaption-dock .bc-dock-alpha:focus { outline: none; }
      #bilicaption-dock .bc-dock-alpha::-webkit-slider-runnable-track {
        height: 2px;
        border-radius: 99px;
        background: #3a4048;
      }
      #bilicaption-dock .bc-dock-alpha::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 10px;
        height: 10px;
        margin-top: -4px;
        border-radius: 50%;
        border: 0;
        background: #c5ccd4;
      }
      #bilicaption-dock .bc-dock-alpha::-moz-range-track {
        height: 2px;
        border-radius: 99px;
        background: #3a4048;
      }
      #bilicaption-dock .bc-dock-alpha::-moz-range-thumb {
        width: 10px;
        height: 10px;
        border: 0;
        border-radius: 50%;
        background: #c5ccd4;
      }
      #bilicaption-dock .bc-dock-btns {
        display: flex;
        align-items: center;
        gap: 4px;
        padding-left: 8px;
        border-left: 1px solid rgba(255,255,255,.08);
      }
      #bilicaption-dock .bc-dock-sidebar,
      #bilicaption-dock .bc-dock-collapse {
        appearance: none;
        border: 0;
        height: 20px;
        border-radius: 6px;
        background: transparent;
        color: #b8bec6;
        cursor: pointer;
        font: 500 11px/1 inherit;
        padding: 0 7px;
      }
      #bilicaption-dock .bc-dock-collapse {
        width: 20px;
        padding: 0;
        font-weight: 600;
        font-size: 14px;
      }
      #bilicaption-dock .bc-dock-sidebar:hover,
      #bilicaption-dock .bc-dock-collapse:hover {
        background: rgba(255,255,255,.08);
        color: #eceef1;
      }
      #bilicaption-dock .bc-dock-frame {
        flex: 1;
        min-height: 0;
        background: transparent;
      }
      #bilicaption-dock iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }
      #bilicaption-dock.bc-dragging .bc-dock-frame { pointer-events: none; }
      #bilicaption-dock .bc-dock-resize { position: absolute; z-index: 2; }
      #bilicaption-dock.collapsed .bc-dock-resize { display: none; }
      #bilicaption-dock .bc-dock-resize-w { left: 0; top: 14px; bottom: 14px; width: 7px; cursor: ew-resize; }
      #bilicaption-dock .bc-dock-resize-e { right: 0; top: 14px; bottom: 14px; width: 7px; cursor: ew-resize; }
      #bilicaption-dock .bc-dock-resize-s { left: 14px; right: 14px; bottom: 0; height: 7px; cursor: ns-resize; }
      #bilicaption-dock .bc-dock-resize-sw { left: 0; bottom: 0; width: 16px; height: 16px; cursor: nesw-resize; }
      #bilicaption-dock .bc-dock-resize-se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    `;
    document.documentElement.appendChild(style);
  }

  function dockMode() {
    return isImmersivePlayer() ? "full" : "page";
  }

  /** 浮窗可用区域；全屏时上下留出信息条和进度条 */
  function dockArea(el) {
    if (dockMode() === "page") {
      return {
        w: window.innerWidth,
        h: window.innerHeight,
        top: 8,
        bottom: 8,
        left: 8,
        right: 8
      };
    }
    const host = el?.parentElement;
    return {
      w: host?.clientWidth || window.innerWidth,
      h: host?.clientHeight || window.innerHeight,
      top: 44,
      bottom: 84,
      left: 0,
      right: 0
    };
  }

  function defaultDockGeom(area) {
    const usableW = area.w - area.left - area.right;
    const usableH = area.h - area.top - area.bottom;
    const width = Math.max(DOCK_MIN_W, Math.min(360, Math.round(usableW * 0.9)));
    const height = Math.max(DOCK_MIN_H, Math.min(560, usableH));
    return {
      left: area.w - area.right - width,
      top: area.top,
      width,
      height
    };
  }

  function clampDockGeom(geom, area) {
    const usableW = area.w - area.left - area.right;
    const usableH = area.h - area.top - area.bottom;
    const width = Math.round(Math.max(Math.min(DOCK_MIN_W, usableW), Math.min(geom.width, usableW)));
    const height = Math.round(Math.max(Math.min(DOCK_MIN_H, usableH), Math.min(geom.height, usableH)));
    const left = Math.round(Math.min(Math.max(geom.left, area.left), area.w - area.right - width));
    const top = Math.round(Math.min(Math.max(geom.top, area.top), area.h - area.bottom - height));
    return { left, top, width, height };
  }

  /** 靠近边缘时吸上去，稍微拖开就脱离 */
  function snapDockGeom(geom, area) {
    const next = { ...geom };
    const rightEdge = area.w - area.right;
    const bottomEdge = area.h - area.bottom;
    if (Math.abs(next.left - area.left) <= DOCK_SNAP) next.left = area.left;
    else if (Math.abs(next.left + next.width - rightEdge) <= DOCK_SNAP) {
      next.left = rightEdge - next.width;
    }
    if (Math.abs(next.top - area.top) <= DOCK_SNAP) next.top = area.top;
    else if (Math.abs(next.top + next.height - bottomEdge) <= DOCK_SNAP) {
      next.top = bottomEdge - next.height;
    }
    return next;
  }

  function currentDockGeom(el) {
    const area = dockArea(el);
    const saved = dockGeom[dockMode()];
    return clampDockGeom(saved || defaultDockGeom(area), area);
  }

  function saveDockGeom(geom) {
    dockGeom[dockMode()] = geom;
    const key = dockMode() === "full" ? "dockGeomFull" : "dockGeomPage";
    chrome.storage.local.set({ [key]: geom }).catch(() => {});
  }

  function applyDockGeom(el = document.getElementById("bilicaption-dock")) {
    if (!el) return;
    const area = dockArea(el);
    const geom = currentDockGeom(el);
    if (dockOpen) {
      el.classList.remove("bc-edge-left", "bc-edge-right");
      el.style.left = `${geom.left}px`;
      el.style.top = `${geom.top}px`;
      el.style.width = `${geom.width}px`;
      el.style.height = `${geom.height}px`;
      return;
    }
    const onLeft = geom.left + geom.width / 2 < area.w / 2;
    el.classList.toggle("bc-edge-left", onLeft);
    el.classList.toggle("bc-edge-right", !onLeft);
    const tabH = 64;
    const top = Math.min(
      Math.max(geom.top + geom.height / 2 - tabH / 2, area.top),
      area.h - area.bottom - tabH
    );
    el.style.left = onLeft ? `${area.left}px` : `${area.w - area.right - DOCK_TAB_W}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${DOCK_TAB_W}px`;
    el.style.height = `${tabH}px`;
  }

  function startDockDrag(event, edges) {
    const el = document.getElementById("bilicaption-dock");
    if (!el || !dockOpen || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const area = dockArea(el);
    const start = currentDockGeom(el);
    const startX = event.clientX;
    const startY = event.clientY;
    const moving = !edges.length;
    const grip = event.currentTarget;
    // 指针划到 iframe 上时事件会被它吃掉，捕获后才收得到 move
    grip.setPointerCapture?.(event.pointerId);
    el.classList.add("bc-dragging");

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let next = { ...start };
      if (moving) {
        next.left = start.left + dx;
        next.top = start.top + dy;
      } else {
        if (edges.includes("w")) {
          next.left = start.left + dx;
          next.width = start.width - dx;
        }
        if (edges.includes("e")) next.width = start.width + dx;
        if (edges.includes("s")) next.height = start.height + dy;
      }
      next = snapDockGeom(clampDockGeom(next, area), area);
      dockGeom[dockMode()] = clampDockGeom(next, area);
      applyDockGeom(el);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      grip.releasePointerCapture?.(event.pointerId);
      el.classList.remove("bc-dragging");
      saveDockGeom(currentDockGeom(el));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function applyDockAlpha(el = document.getElementById("bilicaption-dock")) {
    if (!el) return;
    const alpha = Math.min(1, Math.max(0.3, Number(dockAlpha) || 0.82));
    dockAlpha = alpha;
    el.style.setProperty("--bc-dock-alpha", String(alpha));
    const slider = el.querySelector(".bc-dock-alpha");
    const label = el.querySelector(".bc-dock-alpha-value");
    const pct = Math.round(alpha * 100);
    if (slider) slider.value = String(pct);
    if (label) label.textContent = `${pct}%`;
  }

  function setDockAlpha(value) {
    dockAlpha = Math.min(1, Math.max(0.3, Number(value) || 0.82));
    applyDockAlpha();
    chrome.storage.local.set({ dockAlpha }).catch(() => {});
  }

  function renderDock() {
    const el = document.getElementById("bilicaption-dock");
    if (!el) return;
    const hide = preferSidebar && !dockOpen;
    el.style.display = hide ? "none" : "";
    el.classList.toggle("open", dockOpen);
    el.classList.toggle("collapsed", !dockOpen);
    el.classList.toggle("bc-inside", dockMode() === "full");
    applyDockAlpha(el);
    applyDockGeom(el);
    const tab = el.querySelector(".bc-dock-tab");
    if (tab) {
      tab.textContent = el.classList.contains("bc-edge-left") ? "›" : "‹";
      tab.title = "展开字幕";
    }
  }

  function grabPageFocus() {
    try {
      window.focus();
    } catch {
      // ignore
    }
    const video = getVideo();
    const target = video || document.body;
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    try {
      target.focus({ preventScroll: true });
    } catch {
      try {
        target.focus();
      } catch {
        // ignore
      }
    }
  }

  function setDockOpen(on) {
    dockOpen = Boolean(on);
    if (on) preferSidebar = false;
    persistDockPrefs();
    if (on) {
      placeDock();
      grabPageFocus();
      requestChromePanelHidden();
      [40, 120, 280].forEach((ms) => setTimeout(grabPageFocus, ms));
    } else {
      renderDock();
    }
  }

  function isImmersivePlayer() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    const host =
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bilibili-player-video-wrap");
    if (!host) return false;
    const cls = `${host.className} ${document.documentElement.className} ${document.body?.className || ""}`;
    if (/web-?full|full-?web|mode-webscreen|mode-fullscreen|player-fullscreen|bpx-state-full/i.test(cls)) {
      return true;
    }
    const screen = host.getAttribute("data-screen") || "";
    return Boolean(screen && /web|full/i.test(screen) && !/^(normal|wide)$/i.test(screen));
  }

  function ensureDock() {
    ensureDockStyle();
    let el = document.getElementById("bilicaption-dock");
    if (el) return el;
    el = document.createElement("div");
    el.id = "bilicaption-dock";
    el.addEventListener("pointerenter", () => {
      dockHover = true;
      grabPageFocus();
      postSelKeyState();
    });
    el.addEventListener("pointerleave", () => {
      dockHover = false;
    });

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "bc-dock-tab";
    tab.title = "展开字幕";
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      setDockOpen(true);
    });

    const win = document.createElement("div");
    win.className = "bc-dock-win";
    const head = document.createElement("div");
    head.className = "bc-dock-head";
    const title = document.createElement("span");
    title.className = "bc-dock-title";
    title.textContent = "字幕";
    const actions = document.createElement("div");
    actions.className = "bc-dock-actions";
    const alphaWrap = document.createElement("div");
    alphaWrap.className = "bc-dock-alpha-wrap";
    alphaWrap.title = "背景透明度";
    const alphaValue = document.createElement("span");
    alphaValue.className = "bc-dock-alpha-value";
    alphaValue.textContent = `${Math.round(dockAlpha * 100)}%`;
    const alpha = document.createElement("input");
    alpha.type = "range";
    alpha.className = "bc-dock-alpha";
    alpha.min = "30";
    alpha.max = "100";
    alpha.step = "1";
    alpha.value = String(Math.round(dockAlpha * 100));
    alpha.setAttribute("aria-label", "背景透明度");
    alpha.addEventListener("pointerdown", (event) => event.stopPropagation());
    alpha.addEventListener("click", (event) => event.stopPropagation());
    alpha.addEventListener("input", () => setDockAlpha(Number(alpha.value) / 100));
    alphaWrap.append(alpha, alphaValue);
    const btns = document.createElement("div");
    btns.className = "bc-dock-btns";
    const toSidebar = document.createElement("button");
    toSidebar.type = "button";
    toSidebar.className = "bc-dock-sidebar";
    toSidebar.textContent = "侧栏";
    toSidebar.title = "回到浏览器侧栏";
    toSidebar.addEventListener("pointerdown", (event) => event.stopPropagation());
    toSidebar.addEventListener("click", (event) => {
      event.stopPropagation();
      returnToSidebar();
    });
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "bc-dock-collapse";
    collapse.textContent = "›";
    collapse.title = "收起为贴边按钮";
    collapse.addEventListener("pointerdown", (event) => event.stopPropagation());
    collapse.addEventListener("click", (event) => {
      event.stopPropagation();
      setDockOpen(false);
    });
    btns.append(toSidebar, collapse);
    actions.append(alphaWrap, btns);
    head.append(title, actions);
    head.addEventListener("pointerdown", (event) => startDockDrag(event, []));

    const frame = document.createElement("div");
    frame.className = "bc-dock-frame";
    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("sidepanel.html");
    iframe.setAttribute("title", "BiliCaption");
    iframe.addEventListener("pointerenter", () => {
      grabPageFocus();
      postSelKeyState();
      try {
        iframe.focus({ preventScroll: true });
        iframe.contentWindow?.focus();
      } catch {
        // 自定义划选键由页面记住按住状态，再发给浮窗
      }
    });
    iframe.addEventListener("load", () => {
      postSelKeyState();
      iframe.contentWindow?.postMessage({ type: "BC_TAB", tabId: myTabId }, "*");
    });
    frame.appendChild(iframe);
    win.append(head, frame);

    el.append(tab, win);
    for (const [name, edges] of [
      ["w", ["w"]],
      ["e", ["e"]],
      ["s", ["s"]],
      ["sw", ["s", "w"]],
      ["se", ["s", "e"]]
    ]) {
      const grip = document.createElement("div");
      grip.className = `bc-dock-resize bc-dock-resize-${name}`;
      grip.addEventListener("pointerdown", (event) => startDockDrag(event, edges));
      el.appendChild(grip);
    }

    renderDock();
    return el;
  }

  function placeDock() {
    if (preferSidebar && !dockOpen) {
      document.getElementById("bilicaption-dock")?.remove();
      return;
    }
    const immersive = isImmersivePlayer();
    const el = ensureDock();
    if (!el) return;
    // 全屏时必须挂在全屏元素里才可见，普通模式挂 body 才能浮在整页上
    const host = immersive ? getDockHost() : document.body;
    if (!host) return;
    if (immersive && getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    if (el.parentElement !== host) host.appendChild(el);
    renderDock();
  }

  function overlayBox() {
    const video = getVideo();
    const host = getPlayerHost();
    const el = video && video.clientHeight > 40 ? video : host;
    const box = el?.getBoundingClientRect?.();
    return {
      width: box?.width || 640,
      height: box?.height || 360
    };
  }

  function overlayMetrics() {
    const { width, height } = overlayBox();
    const scale = Math.min(width / 640, height / 360);
    const font = Math.round(Math.min(44, Math.max(13, 15 * scale)));
    return {
      font,
      padY: Math.round(font * 0.34),
      padX: Math.round(font * 0.8),
      radius: Math.max(5, Math.round(font * 0.4)),
      bottom: Math.round(Math.min(110, Math.max(32, height * 0.09))),
      note: Math.max(9, Math.round(font * 0.62)),
      gap: Math.max(4, Math.round(font * 0.32))
    };
  }

  function applyOverlayScale(el = document.getElementById("bilicaption-overlay")) {
    if (!el) return;
    const m = overlayMetrics();
    el.style.bottom = `${m.bottom}px`;
    el.style.gap = `${m.gap}px`;
    const textEl = el.querySelector(".bc-overlay-text");
    if (textEl) {
      textEl.style.fontSize = `${m.font}px`;
      textEl.style.lineHeight = "1.55";
      textEl.style.padding = `${m.padY}px ${m.padX}px`;
      textEl.style.borderRadius = `${m.radius}px`;
    }
    const noteEl = el.querySelector(".bc-overlay-note");
    if (noteEl) noteEl.style.fontSize = `${m.note}px`;
  }

  function watchOverlaySize() {
    const host = getPlayerHost();
    const video = getVideo();
    overlayRo?.disconnect();
    overlayRo = new ResizeObserver(() => applyOverlayScale());
    if (host) overlayRo.observe(host);
    if (video && video !== host) overlayRo.observe(video);
  }

  function ensureOverlay() {
    let el = document.getElementById("bilicaption-overlay");
    if (el && !el.querySelector(".bc-overlay-text")) {
      el.remove();
      el = null;
    }
    if (el) {
      applyOverlayScale(el);
      return el;
    }
    el = document.createElement("div");
    el.id = "bilicaption-overlay";
    el.setAttribute("aria-live", "polite");
    el.style.cssText = [
      "position:absolute",
      "left:6%",
      "right:6%",
      "bottom:52px",
      "z-index:2147483645",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "gap:5px",
      "text-align:center",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity .12s"
    ].join(";");
    const text = document.createElement("span");
    text.className = "bc-overlay-text";
    text.style.cssText = [
      "display:inline-block",
      "padding:5px 12px",
      "border-radius:6px",
      "background:rgba(8,10,13,.62)",
      "color:#ffffff",
      "font:500 15px/1.55 PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif",
      "text-shadow:0 1px 3px rgba(0,0,0,.5)",
      "white-space:pre-wrap",
      "word-break:break-word"
    ].join(";");
    const note = document.createElement("span");
    note.className = "bc-overlay-note";
    note.style.cssText = [
      "font:9.5px/1 JetBrains Mono,SF Mono,ui-monospace,monospace",
      "color:rgba(255,255,255,.5)",
      "letter-spacing:.08em"
    ].join(";");
    el.append(text, note);
    placeOverlay(el);
    return el;
  }

  function getOverlayHost() {
    const full = document.fullscreenElement || document.webkitFullscreenElement;
    if (full) {
      if (full.tagName === "VIDEO") return full.parentElement || getPlayerHost();
      return (
        full.querySelector(".bpx-player-video-area") ||
        full.querySelector(".bpx-player-container") ||
        full
      );
    }
    return getPlayerHost();
  }

  function placeOverlay(el = document.getElementById("bilicaption-overlay")) {
    if (!el) return;
    const host = getOverlayHost();
    if (!host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    if (el.parentElement !== host) host.appendChild(el);
    applyOverlayScale(el);
    watchOverlaySize();
  }

  function hideOverlay() {
    if (!isCurrentScript()) return;
    const el = document.getElementById("bilicaption-overlay");
    if (!el) return;
    const textEl = el.querySelector(".bc-overlay-text");
    if (textEl) textEl.textContent = "";
    el.style.opacity = "0";
    lastOverlayText = "";
  }

  function setOverlayVisible(on) {
    if (!isCurrentScript()) return;
    overlayOn = on !== false;
    lastOverlayText = "";
    if (!overlayOn) hideOverlay();
    else updateOverlay(getVideo()?.currentTime || 0);
  }

  function overlayCueAt(time) {
    const list = overlayCues;
    if (!list.length) return null;
    let lo = 0;
    let hi = list.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Number(list[mid].from) <= time) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return null;
    const cue = list[idx];
    if (time < Number(cue.to) + 0.45) return cue;
    return null;
  }

  function setOverlayCues(cues) {
    if (!isCurrentScript()) return;
    overlayCues = (Array.isArray(cues) ? cues : [])
      .filter((cue) => cue && Number(cue.to) > Number(cue.from))
      .sort((a, b) => Number(a.from) - Number(b.from) || Number(a.to) - Number(b.to));
    lastOverlayText = "";
    updateOverlay(getVideo()?.currentTime || 0);
  }

  function updateOverlay(currentTime) {
    if (!isCurrentScript()) return;
    if (!overlayOn || !overlayCues.length) {
      hideOverlay();
      return;
    }
    const t = Number(currentTime) || 0;
    let cue = overlayCueAt(t);
    if (!cue) {
      const el = ensureOverlay();
      if (lastOverlayText) {
        const textEl = el.querySelector(".bc-overlay-text");
        if (textEl) textEl.textContent = "";
        el.style.opacity = "0";
        lastOverlayText = "";
      }
      return;
    }
    const text = String(cue.content || "").trim();
    if (text === lastOverlayText) return;
    lastOverlayText = text;
    const el = ensureOverlay();
    const textEl = el.querySelector(".bc-overlay-text");
    const noteEl = el.querySelector(".bc-overlay-note");
    if (textEl) textEl.textContent = text;
    if (noteEl) {
      const generated = cachedState.source === "groq" || cachedState.activeLan === "groq-asr";
      noteEl.textContent = generated ? "BiliCaption · 生成字幕" : "";
    }
    el.style.opacity = text ? "1" : "0";
  }

  function clampRate(rate) {
    return Math.min(10, Math.max(0.1, Math.round((Number(rate) || 1) * 10) / 10));
  }

  function applyRate(rate, { notify = true } = {}) {
    const next = clampRate(rate);
    targetRate = next;
    const video = getVideo();
    if (video) {
      applyingRate = true;
      try {
        video.preservesPitch = true;
        video.playbackRate = next;
      } finally {
        queueMicrotask(() => {
          applyingRate = false;
        });
      }
    }
    flashHud(next);
    if (notify) {
      postRuntime({
        type: "RATE",
        rate: next,
        currentTime: video?.currentTime || 0,
        duration: video?.duration || 0
      });
    }
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return Boolean(el.closest?.("[contenteditable='true'], input, textarea, select"));
  }

  function hotkeyAction(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
    if (event.isComposing || event.key === "Process") return null;
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return null;

    const code = event.code;
    if (code === "KeyZ" || event.key?.toLowerCase() === "z") return "reset";
    if (code === "KeyX" || event.key?.toLowerCase() === "x") return "down";
    if (code === "KeyC" || event.key?.toLowerCase() === "c") return "up";
    return null;
  }

  function matchesSelKey(event) {
    const key = event?.key;
    if (!key) return false;
    return key.toLowerCase() === String(selKey || "Shift").toLowerCase();
  }

  function modifierHeldFromEvent(event) {
    const key = String(selKey || "Shift").toLowerCase();
    if (key === "shift") return Boolean(event.shiftKey);
    if (key === "control" || key === "ctrl") return Boolean(event.ctrlKey);
    if (key === "alt" || key === "option") return Boolean(event.altKey);
    if (key === "meta" || key === "command") return Boolean(event.metaKey);
    return null;
  }

  function dockFrame() {
    return document.querySelector("#bilicaption-dock iframe");
  }

  function postSelKeyState(held = selKeyHeld) {
    const payload = { type: "SEL_KEY_STATE", held: Boolean(held) };
    postRuntime(payload);
    if (dockOpen) dockFrame()?.contentWindow?.postMessage(payload, "*");
  }

  function setSelKeyHeld(held) {
    const next = Boolean(held);
    if (selKeyHeld === next) return;
    selKeyHeld = next;
    postSelKeyState(next);
  }

  function forwardPanelKey(event) {
    if (event.isComposing || event.key === "Process") return;
    const typing = isTypingTarget(event.target) || isTypingTarget(document.activeElement);
    const modifierHeld = modifierHeldFromEvent(event);
    if (modifierHeld !== null) {
      setSelKeyHeld(modifierHeld);
    } else if (matchesSelKey(event) && (event.type === "keyup" || !typing)) {
      setSelKeyHeld(event.type === "keydown");
    }
    if (typing) return;

    const payload = {
      type: "PANEL_KEY",
      phase: event.type,
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey
    };

    const toFrame = () => {
      if (!dockOpen) return;
      dockFrame()?.contentWindow?.postMessage({ type: "BC_DOCK_KEY", ...payload }, "*");
    };

    if (matchesSelKey(event)) {
      if (dockOpen && dockHover) toFrame();
      return;
    }

    if (!dockOpen || !dockHover) return;
    postRuntime(payload);
    toFrame();
  }

  function onHotkey(event) {
    if (dockOpen && dockHover) return;
    const action = hotkeyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === "reset") applyRate(1);
    else if (action === "down") applyRate(targetRate - 0.1);
    else if (action === "up") applyRate(targetRate + 0.1);
  }

  function unhookVideo() {
    for (const dispose of hookedCleanups) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    hookedCleanups = [];
    hookedVideo = null;
  }

  function hookVideo(video) {
    if (!video) {
      unhookVideo();
      return;
    }
    if (hookedVideo === video) return;
    unhookVideo();
    hookedVideo = video;
    video.preservesPitch = true;
    watchOverlaySize();
    const onRate = () => {
      if (!isCurrentScript()) return;
      if (applyingRate) return;
      const actual = clampRate(video.playbackRate);
      if (Math.abs(actual - targetRate) <= 0.02) return;
      targetRate = actual;
      flashHud(actual);
      postRuntime({
        type: "RATE",
        rate: actual,
        currentTime: video.currentTime || 0,
        duration: video.duration || 0
      });
    };
    const onMeta = () => applyRate(targetRate, { notify: false });
    let lastSent = 0;
    const sendTime = () => {
      if (!isCurrentScript()) return;
      if (hookedVideo !== video || getVideo() !== video) return;
      const now = Date.now();
      if (now - lastSent < 120) return;
      lastSent = now;
      const currentTime = video.currentTime || 0;
      updateOverlay(currentTime);
      postRuntime({
        type: "TIME",
        currentTime,
        duration: video.duration || 0,
        rate: targetRate
      });
    };
    const onSeeked = () => {
      if (!isCurrentScript()) return;
      if (hookedVideo !== video) return;
      updateOverlay(video.currentTime || 0);
      sendTime();
    };
    video.addEventListener("ratechange", onRate);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("timeupdate", sendTime);
    video.addEventListener("seeked", onSeeked);
    hookedCleanups.push(() => {
      video.removeEventListener("ratechange", onRate);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("timeupdate", sendTime);
      video.removeEventListener("seeked", onSeeked);
    });
    applyRate(targetRate, { notify: false });
    updateOverlay(video.currentTime || 0);
  }

  function seekTo(time) {
    const video = getVideo();
    if (!video) return;
    video.currentTime = Math.max(0, Number(time) || 0);
  }

  async function loadState() {
    const token = ++loadToken;
    const page = parsePage();
    const key = pageKey(page);
    if (page.kind === "other") {
      cachedState = emptyState("other");
      lastStateKey = key;
      setOverlayCues([]);
      return cachedState;
    }

    try {
      const data = await askBackground({ type: "LOAD_SUBTITLES", page });
      if (token !== loadToken || pageKey() !== key) return cachedState;
      const video = getVideo();
      hookVideo(video);

      cachedState = {
        page: data.page || "video",
        bvid: data.bvid || page.bvid || "",
        aid: Number(data.aid) || 0,
        cid: Number(data.cid || page.cid) || 0,
        title: data.title || "",
        part: data.part || "",
        rate: targetRate,
        tracks: data.tracks || [],
        activeLan: data.activeLan || "",
        cues: data.cues || [],
        login: data.login || null,
        source: data.source || "",
        canGenerate: data.canGenerate !== false,
        partial: Boolean(data.partial),
        asrDone: Number(data.asrDone) || 0,
        asrTotal: Number(data.asrTotal) || 0,
        currentTime: video?.currentTime || 0,
        duration: video?.duration || 0,
        error: data.error || (data.partial ? "" : data.notice) || ""
      };
      setOverlayCues(cachedState.cues);
      lastStateKey = key;
      return cachedState;
    } catch (error) {
      if (token !== loadToken || pageKey() !== key) return cachedState;
      const pageInfo = parsePage();
      cachedState = emptyState("video", {
        bvid: pageInfo.bvid || "",
        aid: Number(pageInfo.aid) || 0,
        cid: Number(pageInfo.cid) || 0,
        error: error.message || String(error),
        canGenerate: true
      });
      lastStateKey = key;
      return cachedState;
    }
  }

  async function switchTrack(lan) {
    const track = cachedState.tracks.find((item) => item.lan === lan);
    if (!track) return cachedState;
    const data = await askBackground({ type: "FETCH_CUES", url: track.url });
    cachedState.cues = data.cues || [];
    cachedState.activeLan = track.lan;
    cachedState.source = "bilibili";
    cachedState.error = data.error || "";
    setOverlayCues(cachedState.cues);
    return cachedState;
  }

  function snapshot() {
    const video = parsePage().kind === "other" ? null : getVideo();
    hookVideo(video);
    return {
      ...cachedState,
      rate: targetRate,
      overlayOn,
      currentTime: video?.currentTime || cachedState.currentTime || 0,
      duration: video?.duration || cachedState.duration || 0
    };
  }

  async function refreshIfNeeded(force = false) {
    const key = pageKey();
    if (!force && key === lastStateKey && cachedState.page && cachedState.page !== "loading") {
      return snapshot();
    }
    lastHref = location.href;
    return loadState();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isCurrentScript()) return;
    if (message?.type === "PING") {
      sendResponse({ ok: true, tabId: myTabId });
      return true;
    }
    const reply = (promise) => {
      Promise.resolve(promise)
        .then(sendResponse)
        .catch((error) => {
          sendResponse(emptyState("video", { error: error.message || String(error) }));
        });
      return true;
    };

  if (message?.type === "GET_META") {
      const page = parsePage();
      return reply(
        Promise.resolve({
          page,
          tabId: myTabId,
          bvid: cachedState.bvid || page.bvid || "",
          aid: Number(cachedState.aid || page.aid) || 0,
          cid: Number(cachedState.cid || page.cid) || 0,
          p: Number(page.p) || 1,
          epId: page.epId || "",
          seasonId: page.seasonId || "",
          title: cachedState.title || "",
          href: location.href
        })
      );
    }
    if (message?.type === "GET_STATE") return reply(refreshIfNeeded(false).then(snapshot));
    if (message?.type === "REFRESH") return reply(loadState());
    if (message?.type === "SET_RATE") {
      applyRate(message.rate);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "PAUSE") {
      const video = getVideo();
      if (video && !video.paused) video.pause();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SEEK") {
      seekTo(message.time);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "TOGGLE_DOCK") {
      setDockOpen(!dockOpen);
      placeDock();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "OPEN_FLOAT") {
      setDockOpen(true);
      placeDock();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "RETURN_SIDEBAR") {
      returnToSidebar();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SET_OVERLAY") {
      setOverlayVisible(message.on !== false);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SWITCH_TRACK") return reply(switchTrack(message.lan));
    if (message?.type === "APPLY_ASR_CUES") {
      const sameVideo =
        (!message.bvid || !cachedState.bvid || message.bvid === cachedState.bvid) &&
        (!message.cid || !cachedState.cid || Number(message.cid) === Number(cachedState.cid));
      if (!sameVideo) return reply(Promise.resolve(snapshot()));
      const keepTranslation =
        cachedState.source === "translated" || cachedState.activeLan === "translated";
      if (message.aid) cachedState.aid = Number(message.aid) || cachedState.aid;
      if (message.cid) cachedState.cid = Number(message.cid) || cachedState.cid;
      if (message.bvid) cachedState.bvid = message.bvid;
      if (message.title) cachedState.title = message.title;
      cachedState.cues = keepTranslation
        ? preserveCueText(message.cues || [], cachedState.cues)
        : (message.cues || []);
      cachedState.activeLan = keepTranslation ? "translated" : (message.activeLan || "groq-asr");
      cachedState.source = keepTranslation ? "translated" : (message.source || "groq");
      cachedState.canGenerate = true;
      cachedState.partial = Boolean(message.partial);
      cachedState.error = "";
      setOverlayCues(cachedState.cues);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SYNC_CUES") {
      cachedState.cues = message.cues || cachedState.cues;
      if (message.activeLan) cachedState.activeLan = message.activeLan;
      if (message.source) cachedState.source = message.source;
      setOverlayCues(cachedState.cues);
      if (cachedState.bvid && cachedState.cid && cachedState.cues.length) {
        askBackground({
          type: "SAVE_CUES_CACHE",
          bvid: cachedState.bvid,
          cid: cachedState.cid,
          cues: cachedState.cues,
          activeLan: cachedState.activeLan,
          source: cachedState.source
        }).catch(() => {});
      }
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "GENERATE_ASR") {
      return reply(
        askBackground({
          type: "GENERATE_ASR",
          aid: cachedState.aid || message.aid,
          cid: cachedState.cid || message.cid,
          bvid: cachedState.bvid || message.bvid
        }).then(async (data) => {
          const keepTranslation =
            cachedState.source === "translated" || cachedState.activeLan === "translated";
          cachedState.cues = keepTranslation
            ? preserveCueText(data.cues || [], cachedState.cues)
            : (data.cues || []);
          cachedState.activeLan = keepTranslation ? "translated" : (data.activeLan || "groq-asr");
          cachedState.source = keepTranslation ? "translated" : (data.source || "groq");
          cachedState.canGenerate = true;
          cachedState.partial = false;
          cachedState.error = "";
          setOverlayCues(cachedState.cues);
          return snapshot();
        })
      );
    }
    return false;
  });

  const notifyNav = () => {
    refreshIfNeeded(true).then((state) => {
      postRuntime({ type: "STATE", payload: state });
    });
  };

  const wrap = (method) => {
    const raw = history[method];
    history[method] = function () {
      const result = raw.apply(this, arguments);
      queueMicrotask(() => {
        if (location.href !== lastHref) notifyNav();
      });
      return result;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", notifyNav);
  // capture 阶段抢在 B 站播放器之前；只绑 window，避免 C/X 处理两遍
  window.addEventListener("keydown", onHotkey, true);
  window.addEventListener("keydown", forwardPanelKey, true);
  window.addEventListener("keyup", forwardPanelKey, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setSelKeyHeld(false);
  });
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "BC_SEL_KEY") return;
    if (event.source !== dockFrame()?.contentWindow) return;
    setSelKeyHeld(Boolean(event.data.held));
  });
  const onPlayerResize = () => {
    placeOverlay();
    applyOverlayScale();
    placeDock();
  };
  document.addEventListener("fullscreenchange", onPlayerResize);
  document.addEventListener("webkitfullscreenchange", onPlayerResize);
  window.addEventListener("resize", onPlayerResize);

  setInterval(() => {
    if (!isCurrentScript()) return;
    if (location.href !== lastHref) notifyNav();
    if (parsePage().kind !== "other") hookVideo(getVideo());
    if (overlayCues.length) {
      const el = document.getElementById("bilicaption-overlay");
      if (!el) updateOverlay(getVideo()?.currentTime || 0);
      else placeOverlay(el);
    }
    if (dockOpen || !preferSidebar) placeDock();
  }, 1000);

  chrome.storage.sync.get({ overlayOn: true, selKey: "Shift" }, (data) => {
    overlayOn = data.overlayOn !== false;
    selKey = data.selKey || "Shift";
    if (!overlayOn) hideOverlay();
  });
  ensureTabId().then(() => {
    const keys = {
      dockGeomPage: null,
      dockGeomFull: null,
      dockAlpha: 0.82
    };
    if (myTabId) {
      keys[`dockOpen:${myTabId}`] = false;
      keys[`preferSidebar:${myTabId}`] = true;
    }
    chrome.storage.local.get(keys, (data) => {
      dockGeom.page = data.dockGeomPage || null;
      dockGeom.full = data.dockGeomFull || null;
      dockAlpha = Math.min(1, Math.max(0.3, Number(data.dockAlpha) || 0.82));
      preferSidebar = myTabId ? data[`preferSidebar:${myTabId}`] !== false : true;
      dockOpen = myTabId ? data[`dockOpen:${myTabId}`] === true && !preferSidebar : false;
      if (dockOpen || !preferSidebar) placeDock();
      dockFrame()?.contentWindow?.postMessage({ type: "BC_TAB", tabId: myTabId }, "*");
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && myTabId && changes[`dockOpen:${myTabId}`]) {
      dockOpen = changes[`dockOpen:${myTabId}`].newValue === true;
      if (dockOpen || !preferSidebar) placeDock();
      else document.getElementById("bilicaption-dock")?.remove();
    }
    if (area === "local" && myTabId && changes[`preferSidebar:${myTabId}`]) {
      preferSidebar = changes[`preferSidebar:${myTabId}`].newValue !== false;
      if (preferSidebar && !dockOpen) document.getElementById("bilicaption-dock")?.remove();
    }
    if (area === "local" && changes.dockAlpha) {
      dockAlpha = Math.min(1, Math.max(0.3, Number(changes.dockAlpha.newValue) || 0.82));
      applyDockAlpha();
    }
    if (area === "local" && (changes.dockGeomPage || changes.dockGeomFull)) {
      if (changes.dockGeomPage) dockGeom.page = changes.dockGeomPage.newValue || null;
      if (changes.dockGeomFull) dockGeom.full = changes.dockGeomFull.newValue || null;
      applyDockGeom();
    }
    if (area === "sync" && changes.overlayOn) {
      setOverlayVisible(changes.overlayOn.newValue !== false);
    }
    if (area === "sync" && changes.selKey) {
      selKey = changes.selKey.newValue || "Shift";
    }
  });

  const dockWatch = new MutationObserver(() => placeDock());
  dockWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  if (document.body) dockWatch.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });

  refreshIfNeeded(true);
})();
