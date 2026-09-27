(() => {
  // 平台模块、共用工具和页面样式必须先注入（见 BiliCaptionPlatforms.CONTENT_SCRIPT_FILES）。单独注入本文件时
  // 不接管页面，免得半截脚本抢走所有权又在后面报错；侧栏发现收不到回应会整份清单一起补注入。
  if (!globalThis.BiliCaptionPlatforms || !globalThis.BiliCaptionCueTools || !globalThis.BiliCaptionContentStyles) return;
  const { preserveTranslatedCues, formatClock, isTypingTarget, matchesKey } = globalThis.BiliCaptionCueTools;
  // 扩展重载后旧 isolated world 还活着，但 chrome.runtime 已死。
  // window 上的代计数跨不了 world，所有权必须写在 DOM 上，否则旧脚本
  // 会按秒拆掉新脚本刚挂上的浮窗，看起来就是不停闪。
  const OWNER_ATTR = "data-bilicaption-owner";
  const ownerToken = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  document.documentElement.setAttribute(OWNER_ATTR, ownerToken);
  const isCurrentScript = () => document.documentElement.getAttribute(OWNER_ATTR) === ownerToken;
  // 上一版扩展的 iframe 地址已经失效；同一次注入里旧事件处理器也会叠。
  // 只在接手前拆一次，之后不再由失去所有权的脚本去 remove。
  document.getElementById("bilicaption-dock")?.remove();
  document.getElementById("bilicaption-progress-marks")?.remove();

  let targetRate = 1;
  let applyingRate = false;
  let lastHref = location.href;
  let lastStateKey = "";
  let loadToken = 0;
  let pendingReload = 0;
  let loadingPageKey = "";
  let inflightLoad = null;
  let pendingSince = 0;
  let pendingGiveUpMs = 12000;
  let myTabId = 0;
  let cachedState = emptyState("loading");
  let hookedVideo = null;
  let hookedCleanups = [];
  let hudTimer = 0;
  let overlayCues = [];
  let progressMarks = [];
  let lastOverlayText = "";
  let overlayOn = true;
  let captionLang = "zh";
  let overlayRo = null;
  let progressMarksSig = "";
  const DOCK_SNAP = 26;
  const DOCK_MIN_W = 260;
  const DOCK_MIN_H = 200;
  const DOCK_TAB_W = 20;

  let dockOpen = false;
  let dockGeom = { page: null, full: null };
  let dockAlpha = 0.82;
  let preferSidebar = true;

  function clampDockAlpha(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.82;
    return Math.min(1, Math.max(0, n));
  }
  let dockHover = false;
  let selKey = "Shift";
  let selKeyHeld = false;
  let cueLoop = null;
  let cueLoopSeekAt = 0;
  let cueLoopTimer = 0;
  let xManifestRetryKey = "";

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
    chrome.storage.sync.set({ dockOpen, preferSidebar }).catch(() => {});
  }

  function applyDockUiPrefs(data = {}) {
    preferSidebar = data.preferSidebar !== false;
    dockOpen = data.dockOpen === true && !preferSidebar;
    if (dockOpen || !preferSidebar) {
      placeDock();
      requestChromePanelHidden();
    } else {
      document.getElementById("bilicaption-dock")?.remove();
    }
  }

  function returnToSidebar() {
    preferSidebar = true;
    dockOpen = false;
    persistDockPrefs();
    // 先写全局偏好再 restore，让其它标签先读到侧栏；open() 仍在这次点击的用户手势里
    requestChromePanelRestore();
    document.getElementById("bilicaption-dock")?.remove();
  }

  function allowsAsr(kind) {
    return kind !== "youtube";
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
      subtitleStatus: "",
      ...extra
    };
  }

  // X 当前视频要扫全页帖子和链接才认得出来。结果按地址缓存一小会儿，
  // 有视频开始播放（可能换了一个）或地址变了才重扫；视频节点被拆掉也重扫。
  let xPick = null;
  function pickXVideo(external) {
    const now = Date.now();
    const hit = xPick
      && xPick.href === location.href
      && now - xPick.at < (xPick.result.video ? 1500 : 400)
      && (!xPick.result.video || xPick.result.video.isConnected);
    if (hit) return xPick.result;
    const result = BiliCaptionPlatforms.xSelection(document, external);
    xPick = { href: location.href, at: now, result };
    return result;
  }
  // 媒体事件不冒泡，但捕获阶段在 document 上收得到
  document.addEventListener("play", () => {
    xPick = null;
  }, true);

  // 番剧 ss 链接不带集数；页面变量 __INITIAL_STATE__ 在内容脚本的隔离环境里读不到（新版番剧页也没有），
  // 所以这里只按地址解析，当前集由后台注入页面 MAIN world 读播放器（readBangumiPage）。
  function parsePage() {
    const external = globalThis.BiliCaptionPlatforms?.parse(location.href);
    if (external) {
      if (external.kind === "x") {
        const selected = pickXVideo(external);
        external.mediaIndex = selected.mediaIndex;
        external.bvid = `x_${external.videoId}_${selected.mediaIndex}`;
        if (selected.video && selected.video.dataset.bilicaptionVideoKey !== external.bvid) {
          for (const video of document.querySelectorAll('video[data-bilicaption-video-key]')) {
            if (video !== selected.video) delete video.dataset.bilicaptionVideoKey;
          }
          selected.video.dataset.bilicaptionVideoKey = external.bvid;
        }
      }
      return external;
    }
    const path = location.pathname;
    const search = new URLSearchParams(location.search);
    const bvFromPath = path.match(/\/video\/(BV[\w]+)/)?.[1];
    const bvFromQuery = search.get("bvid");
    const bvid = bvFromPath || bvFromQuery;
    if (bvid && /\/video\/|\/list\//.test(path)) {
      return {
        kind: "video",
        bvid,
        p: Math.max(1, Number(search.get("p") || 1)),
        cid: 0,
        aid: 0
      };
    }
    const epId = path.match(/\/bangumi\/play\/ep(\d+)/)?.[1] || "";
    const seasonId = path.match(/\/bangumi\/play\/ss(\d+)/)?.[1] || "";
    if (/\/bangumi\/play\//.test(path) && (epId || seasonId)) {
      return {
        kind: "bangumi",
        epId,
        seasonId,
        cid: 0,
        aid: 0,
        bvid: ""
      };
    }
    return { kind: "other" };
  }

  function pageKey(page = parsePage()) {
    if (["youtube", "x"].includes(page.kind)) return page.bvid;
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
    const external = globalThis.BiliCaptionPlatforms?.parse(location.href);
    if (external?.kind === "x") return pickXVideo(external).video;
    if (external?.platform === "youtube") return document.querySelector("#movie_player video");
    if (external) return null;
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
    const external = globalThis.BiliCaptionPlatforms?.platform(location.href);
    if (external === "youtube") return document.querySelector("#movie_player") || document.body;
    if (external === "x") return getVideo()?.closest('[data-testid="videoPlayer"]') || getVideo()?.parentElement || document.body;
    return (
      document.querySelector(".bpx-player-video-area") ||
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bilibili-player-video-wrap") ||
      document.body
    );
  }

  function isXMediaOverlay() {
    if (BiliCaptionPlatforms.platform(location.href) !== "x") return false;
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const video = getVideo();
    return Boolean((video && dialog.contains(video)) || dialog.querySelector("video"));
  }

  function getXDockHost() {
    if (BiliCaptionPlatforms.platform(location.href) !== "x") return null;
    const dialog = document.querySelector('[role="dialog"]');
    const video = getVideo();
    if (dialog && ((video && dialog.contains(video)) || dialog.querySelector("video"))) return dialog;
    return null;
  }

  function getDockHost() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      getXDockHost() ||
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      getPlayerHost()
    );
  }

  function ensureDockStyle() {
    let style = document.getElementById("bilicaption-dock-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "bilicaption-dock-style";
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.dataset.bcOwner === ownerToken) return;
    style.dataset.bcOwner = ownerToken;
    style.textContent = BiliCaptionContentStyles.dock;
  }

  function dockMode() {
    return isImmersivePlayer() ? "full" : "page";
  }

  /** 浮窗可用区域。叠在播放器上时跟视频画布对齐，不额外留控件带。 */
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
      top: 0,
      bottom: 0,
      left: 0,
      right: 0
    };
  }

  function defaultDockGeom(area, el) {
    const usableW = area.w - area.left - area.right;
    const usableH = area.h - area.top - area.bottom;
    const width = Math.max(DOCK_MIN_W, Math.min(360, Math.round(usableW * 0.9)));
    const height = Math.max(DOCK_MIN_H, Math.min(560, usableH));
    const fallback = {
      left: area.w - area.right - width,
      top: area.top,
      width,
      height
    };
    if (BiliCaptionPlatforms.platform(location.href) !== "x") return fallback;
    const video = getVideo();
    const videoBox = video?.getBoundingClientRect?.();
    if (!videoBox || videoBox.width < 40 || videoBox.height < 40) return fallback;
    const host = el?.parentElement;
    const hostBox = dockMode() === "full" && host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const videoRight = videoBox.right - hostBox.left;
    const videoLeft = videoBox.left - hostBox.left;
    const videoTop = videoBox.top - hostBox.top;
    let left = videoRight + 8;
    if (left + width > area.w - area.right) left = videoLeft - width - 8;
    if (left < area.left) left = fallback.left;
    let top = Math.max(area.top, videoTop);
    if (top + height > area.h - area.bottom) top = Math.max(area.top, area.h - area.bottom - height);
    return { left: Math.round(left), top: Math.round(top), width, height };
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
    return clampDockGeom(saved || defaultDockGeom(area, el), area);
  }

  function saveDockGeom(geom) {
    dockGeom[dockMode()] = geom;
    const key = dockMode() === "full" ? "dockGeomFull" : "dockGeomPage";
    chrome.storage.sync.set({ [key]: geom }).catch(() => {});
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
    const tabH = 120;
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
        if (edges.includes("n")) {
          next.top = start.top + dy;
          next.height = start.height - dy;
        }
      }
      next = snapDockGeom(clampDockGeom(next, area), area);
      dockGeom[dockMode()] = clampDockGeom(next, area);
      applyDockGeom(el);
      // 贴边时高亮对应边缘（设计稿 snapHint，左右优先）
      const hint = el.querySelector(".bc-dock-snap");
      if (hint) {
        let side = "";
        if (next.left <= area.left + 1) side = "left";
        else if (next.left + next.width >= area.w - area.right - 1) side = "right";
        else if (next.top <= area.top + 1) side = "top";
        else if (next.top + next.height >= area.h - area.bottom - 1) side = "bottom";
        hint.className = `bc-dock-snap${side ? ` is-${side}` : ""}`;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      grip.releasePointerCapture?.(event.pointerId);
      el.classList.remove("bc-dragging");
      const hint = el.querySelector(".bc-dock-snap");
      if (hint) hint.className = "bc-dock-snap";
      saveDockGeom(currentDockGeom(el));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function applyDockAlpha(el = document.getElementById("bilicaption-dock")) {
    if (!el) return;
    const alpha = clampDockAlpha(dockAlpha);
    dockAlpha = alpha;
    el.style.setProperty("--bc-dock-alpha", String(alpha));
    const slider = el.querySelector(".bc-dock-alpha");
    const label = el.querySelector(".bc-dock-alpha-value");
    const pct = Math.round(alpha * 100);
    if (slider) slider.value = String(pct);
    if (label) label.textContent = `${pct}%`;
  }

  // 拖滑块每一格都会触发 input；立刻改外观，写 sync 等松手停一会儿再写一次，
  // 否则容易撞上 storage.sync 的每分钟写入上限，也会每格触发一次存储变更广播。
  let dockAlphaSaveTimer = 0;
  function setDockAlpha(value) {
    dockAlpha = clampDockAlpha(value);
    applyDockAlpha();
    clearTimeout(dockAlphaSaveTimer);
    dockAlphaSaveTimer = setTimeout(() => {
      dockAlphaSaveTimer = 0;
      chrome.storage.sync.set({ dockAlpha }).catch(() => {});
    }, 400);
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
    if (isXMediaOverlay()) return true;
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

  function ensureDockGlass(win) {
    if (!win || win.querySelector(".bc-dock-glass")) return;
    const glass = document.createElement("div");
    glass.className = "bc-dock-glass";
    glass.setAttribute("aria-hidden", "true");
    win.insertBefore(glass, win.firstChild);
  }

  function ensureDock() {
    ensureDockStyle();
    let el = document.getElementById("bilicaption-dock");
    if (el) {
      ensureDockGlass(el.querySelector(".bc-dock-win"));
      return el;
    }
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
    ensureDockGlass(win);
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
    alpha.min = "0";
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
    // manifest 对 sidepanel.html 开了 use_dynamic_url：getURL 返回每次会话随机的地址（Chrome 130+），
    // 网页猜不到固定地址去嵌入。查询参数在 getURL 之后再拼，避开旧版 getURL 带参数时丢随机 ID 的问题。
    iframe.src = `${chrome.runtime.getURL("sidepanel.html")}?embed=1`;
    iframe.setAttribute("title", BiliCaptionPlatforms.chromeTitle(BiliCaptionPlatforms.platform(location.href)));
    iframe.setAttribute("allowtransparency", "true");
    iframe.style.background = "transparent";
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
    });
    frame.appendChild(iframe);
    win.append(head, frame);

    el.append(tab, win);
    const snapHint = document.createElement("div");
    snapHint.className = "bc-dock-snap";
    el.appendChild(snapHint);
    for (const [name, edges] of [
      ["w", ["w"]],
      ["e", ["e"]],
      ["s", ["s"]],
      ["n", ["n"]],
      ["sw", ["s", "w"]],
      ["se", ["s", "e"]],
      ["nw", ["n", "w"]],
      ["ne", ["n", "e"]]
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
    // 扩展已失效：建浮窗要用 chrome.runtime.getURL，会抛错
    if (!runtimeAlive()) return;
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
    if (immersive && host !== document.body && getComputedStyle(host).position === "static") {
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
      bottom: Math.round(Math.min(110, Math.max(32, height * 0.09)))
    };
  }

  function applyOverlayScale(el = document.getElementById("bilicaption-overlay")) {
    if (!el) return;
    const m = overlayMetrics();
    el.style.bottom = `${m.bottom}px`;
    const textEl = el.querySelector(".bc-overlay-text");
    if (textEl) {
      textEl.style.fontSize = `${m.font}px`;
      textEl.style.lineHeight = "1.55";
      textEl.style.padding = `${m.padY}px ${m.padX}px`;
      textEl.style.borderRadius = `${m.radius}px`;
    }
    el.querySelector(".bc-overlay-note")?.remove();
  }

  let overlayHostWatch = null;

  function watchOverlayHost(host = getOverlayHost()) {
    if (!host) return;
    if (overlayHostWatch?.__host === host) return;
    overlayHostWatch?.disconnect();
    overlayHostWatch = new MutationObserver(() => {
      if (!overlayOn || !overlayCues.length) return;
      const overlay = document.getElementById("bilicaption-overlay");
      if (!overlay || !overlay.isConnected || overlay.parentElement !== host) {
        lastOverlayText = "";
        updateOverlay(getVideo()?.currentTime || 0);
      }
    });
    overlayHostWatch.__host = host;
    overlayHostWatch.observe(host, { childList: true });
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
    ensureDockStyle();
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
      'font:500 15px/1.55 "Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
      "text-shadow:0 1px 3px rgba(0,0,0,.5)",
      "white-space:pre-wrap",
      "word-break:break-word"
    ].join(";");
    el.append(text);
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
    return (
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      getPlayerHost()
    );
  }

  function placeOverlay(el = document.getElementById("bilicaption-overlay")) {
    if (!el) return;
    const host = getOverlayHost();
    if (!host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    if (el.parentElement !== host) host.appendChild(el);
    applyOverlayScale(el);
    watchOverlaySize();
    watchOverlayHost(host);
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
    for (let i = idx; i >= 0; i -= 1) {
      const cover = list[i];
      const from = Number(cover.from);
      const to = Number(cover.to);
      if (time >= from && time < to) return cover;
      if (to < time - 3) break;
    }
    const cue = list[idx];
    const next = list[idx + 1];
    const from = Number(cue.from);
    const to = Number(cue.to);
    const nextFrom = next ? Number(next.from) : Infinity;
    const minHold = Math.max(to + 0.35, from + 1.25);
    if (time >= nextFrom) return next;
    if (time < Math.min(minHold, nextFrom)) return cue;
    if (next && nextFrom - to < 2.2 && time < nextFrom) return cue;
    return null;
  }

  function setOverlayCues(cues) {
    if (!isCurrentScript()) return;
    overlayCues = (Array.isArray(cues) ? cues : [])
      .filter((cue) => cue && String(cue.content || "").trim())
      .map((cue) => {
        const from = Number(cue.from) || 0;
        const to = Number(cue.to) || 0;
        return {
          ...cue,
          from,
          to: Math.max(to, from + 1.2)
        };
      })
      .sort((a, b) => Number(a.from) - Number(b.from) || Number(a.to) - Number(b.to));
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
    const original = String(cue.original || "").trim();
    const text = captionLang === "en" && original
      ? original
      : String(cue.content || "").trim();
    const mounted = document.getElementById("bilicaption-overlay");
    if (text === lastOverlayText && mounted?.isConnected) return;
    lastOverlayText = text;
    const el = ensureOverlay();
    if (!el.isConnected) placeOverlay(el);
    const textEl = el.querySelector(".bc-overlay-text");
    if (textEl) textEl.textContent = text;
    el.style.opacity = text ? "1" : "0";
  }

  function clampRate(rate) {
    return Math.min(10, Math.max(0.1, Math.round((Number(rate) || 1) * 10) / 10));
  }

  function applyRate(rate, { notify = true } = {}) {
    if (!isCurrentScript()) return;
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
    postRuntime({ type: "SEL_KEY_STATE", held: Boolean(held) });
  }

  function setSelKeyHeld(held) {
    if (!isCurrentScript()) return;
    const next = Boolean(held);
    if (selKeyHeld === next) return;
    selKeyHeld = next;
    postSelKeyState(next);
  }

  function forwardPanelKey(event) {
    if (!isCurrentScript()) return;
    if (event.isComposing || event.key === "Process") return;
    const typing = isTypingTarget(event.target) || isTypingTarget(document.activeElement);
    const modifierHeld = modifierHeldFromEvent(event);
    if (modifierHeld !== null) {
      setSelKeyHeld(modifierHeld);
    } else if (matchesKey(event, selKey) && (event.type === "keyup" || !typing)) {
      setSelKeyHeld(event.type === "keydown");
    }
    if (typing) return;

    if (!dockOpen || !dockHover) return;
    postRuntime({
      type: "PANEL_KEY",
      phase: event.type,
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey
    });
  }

  function onHotkey(event) {
    if (!isCurrentScript()) return;
    if (dockOpen && dockHover) return;
    if (!getVideo()) return;
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

  // 播放进度走长连接：侧栏 / 浮窗用 chrome.tabs.connect(tabId, { name: "bc-time" }) 连进来，
  // 有连接才推送 { type: "TIME", currentTime, duration, rate }；侧栏没开时一条都不发。
  const TIME_PORT_NAME = "bc-time";
  const timePorts = new Set();

  function pushPlayback(video = hookedVideo, port = null) {
    if (!timePorts.size || !isCurrentScript()) return;
    const message = {
      type: "TIME",
      currentTime: video?.currentTime || 0,
      duration: video?.duration || 0,
      rate: targetRate
    };
    for (const target of port ? [port] : [...timePorts]) {
      try {
        target.postMessage(message);
      } catch {
        timePorts.delete(target);
      }
    }
  }

  function closeTimePorts() {
    for (const port of timePorts) {
      try {
        port.disconnect();
      } catch {
        // ignore
      }
    }
    timePorts.clear();
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port?.name !== TIME_PORT_NAME) return;
    // 同一 isolated world 里新旧两份脚本会收到同一个 port；只由当前 owner 接手，旧脚本别动它
    if (!isCurrentScript()) return;
    timePorts.add(port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      timePorts.delete(port);
    });
    // 连上先给一次当前进度，侧栏不用等下一次 timeupdate；还没找到视频就等 timeupdate
    const video = hookedVideo || getVideo();
    if (video) pushPlayback(video, port);
  });

  let initialXSeekKey = "";
  function applyXLinkTime(video) {
    const page = parsePage();
    if (page.kind !== "x" || initialXSeekKey === page.bvid || !video || !Number.isFinite(video.duration)) return;
    const raw = new URLSearchParams(location.search).get("t");
    const time = Number(raw);
    if (raw && Number.isFinite(time) && time >= 0) video.currentTime = Math.min(time, video.duration);
    initialXSeekKey = page.bvid;
  }
  function hookVideo(video) {
    if (!video) {
      unhookVideo();
      return;
    }
    applyXLinkTime(video);
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
    const onMeta = () => {
      if (!isCurrentScript()) return;
      applyRate(targetRate, { notify: false });
      applyXLinkTime(video);
      renderProgressMarks();
    };
    let lastSent = 0;
    const sendTime = ({ force = false } = {}) => {
      if (!isCurrentScript()) return;
      if (hookedVideo !== video || getVideo() !== video) return;
      const now = Date.now();
      if (!force && now - lastSent < 120) return;
      lastSent = now;
      const currentTime = video.currentTime || 0;
      // 页面内字幕照常跟随；进度只推给已连上的侧栏 / 浮窗，不再广播唤醒后台。
      updateOverlay(currentTime);
      pushPlayback(video);
    };
    const onSeeked = () => {
      if (!isCurrentScript()) return;
      if (hookedVideo !== video) return;
      // seek 后即使撞上普通 timeupdate 的节流窗口，也必须把最终时间同步给侧栏。
      sendTime({ force: true });
    };
    const onTimeUpdate = () => {
      tickCueLoop(video);
      sendTime();
    };
    video.addEventListener("ratechange", onRate);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    hookedCleanups.push(() => {
      video.removeEventListener("ratechange", onRate);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
    });
    applyRate(targetRate, { notify: false });
    updateOverlay(video.currentTime || 0);
    renderProgressMarks();
  }

  function seekTo(time) {
    const video = getVideo();
    if (!video) return;
    cueLoopSeekAt = Date.now();
    video.currentTime = Math.max(0, Number(time) || 0);
  }

  function clearCueLoop(notifyPanel) {
    const had = Boolean(cueLoop);
    cueLoop = null;
    if (cueLoopTimer) {
      clearInterval(cueLoopTimer);
      cueLoopTimer = 0;
    }
    if (had && notifyPanel) postRuntime({ type: "LOOP_ENDED" });
  }

  function startCueLoopWatch() {
    if (cueLoopTimer) return;
    cueLoopTimer = setInterval(() => {
      if (!isCurrentScript() || !cueLoop) {
        clearCueLoop();
        return;
      }
      const video = getVideo();
      if (video) tickCueLoop(video);
    }, 50);
  }

  function tickCueLoop(video) {
    if (!cueLoop || !video) return;
    if (video.seeking) return;
    if (Date.now() - cueLoopSeekAt < 220) return;
    const t = Number(video.currentTime) || 0;
    const from = cueLoop.from;
    const to = cueLoop.to;
    if (t >= to && t - to < 1.2) {
      cueLoopSeekAt = Date.now();
      video.currentTime = Math.max(0, from);
      if (video.paused) video.play()?.catch(() => {});
      return;
    }
    if (t < from - 0.2 || t > to + 0.35) clearCueLoop(true);
  }

  function applyCueLoop(message) {
    const from = Number(message?.from);
    const to = Number(message?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      clearCueLoop();
      return;
    }
    cueLoop = { from, to };
    startCueLoopWatch();
    const video = getVideo();
    if (!video) return;
    if (message.seek) {
      cueLoopSeekAt = Date.now();
      video.currentTime = Math.max(0, from);
    }
    if (message.play && video.paused) video.play()?.catch(() => {});
    tickCueLoop(video);
  }

  function getProgressHost() {
    if (BiliCaptionPlatforms.platform(location.href) === "youtube") return document.querySelector("#movie_player .ytp-progress-bar");
    if (BiliCaptionPlatforms.platform(location.href) === "x") return getVideo()?.closest('[data-testid="videoPlayer"]')?.querySelector('[role="slider"][aria-label*="Seek"], [role="slider"][aria-label*="进度"], [data-testid="progressBar"]') || null;
    return (
      document.querySelector(".bpx-player-progress") ||
      document.querySelector(".bpx-player-progress-wrap") ||
      document.querySelector(".squirtle-progress-wrap") ||
      document.querySelector(".bilibili-player-video-progress")
    );
  }

  function ensureProgressMarkStyle() {
    let style = document.getElementById("bilicaption-progress-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "bilicaption-progress-style";
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.dataset.bcOwner === ownerToken) return;
    style.dataset.bcOwner = ownerToken;
    style.textContent = BiliCaptionContentStyles.progressMarks;
  }

  function ensureProgressMarks() {
    ensureProgressMarkStyle();
    const host = getProgressHost();
    if (!host) return null;
    let el = document.getElementById("bilicaption-progress-marks");
    if (el && el.parentElement !== host) {
      el.remove();
      el = null;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "bilicaption-progress-marks";
      host.appendChild(el);
    }
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    return el;
  }

  function setProgressMarks(list) {
    progressMarks = Array.isArray(list) ? list : [];
    progressMarksSig = "";
    renderProgressMarks();
  }

  function jumpProgressMark(time) {
    if (cueLoop && (time < cueLoop.from - 0.15 || time > cueLoop.to + 0.15)) {
      clearCueLoop(true);
    }
    seekTo(time);
  }

  function renderProgressMarks() {
    const duration = Number(getVideo()?.duration) || 0;
    const el = ensureProgressMarks();
    if (!el) return;
    if (!(duration > 0) || !progressMarks.length) {
      progressMarksSig = "";
      el.replaceChildren();
      return;
    }
    const sig = `${duration.toFixed(2)}:${progressMarks.map((m) => `${Number(m.time) || 0}:${String(m.text || "")}`).join("|")}`;
    if (sig === progressMarksSig && el.querySelector(".bc-progress-mark")) return;
    progressMarksSig = sig;
    const tip = document.createElement("div");
    tip.className = "bc-progress-tip";
    tip.hidden = true;
    const dots = progressMarks.map((mark) => {
      const time = Number(mark.time) || 0;
      const pct = Math.min(100, Math.max(0, (time / duration) * 100));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bc-progress-mark";
      btn.style.left = `${pct}%`;
      const label = String(mark.text || "").trim() || formatClock(time);
      btn.setAttribute("aria-label", label);
      const jump = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        jumpProgressMark(time);
      };
      btn.addEventListener("pointerdown", jump, true);
      btn.addEventListener("click", jump, true);
      btn.addEventListener("pointerenter", () => {
        tip.hidden = false;
        tip.textContent = label;
        tip.style.left = `${pct}%`;
      });
      btn.addEventListener("pointerleave", () => {
        tip.hidden = true;
      });
      return btn;
    });
    el.replaceChildren(...dots, tip);
  }

  async function pullProgressMarks() {
    const bvid = cachedState.bvid || parsePage().bvid || "";
    const cid = Number(cachedState.cid || parsePage().cid) || 0;
    if (!bvid && !cid) {
      setProgressMarks([]);
      return;
    }
    try {
      const data = await askBackground({ type: "GET_MARKERS", bvid, cid });
      setProgressMarks(data?.markers || []);
    } catch {
      // 侧栏稍后会 SYNC_MARKERS
    }
  }

  function schedulePendingReload() {
    if (pendingReload) return;
    pendingReload = setTimeout(() => {
      pendingReload = 0;
      if (!isCurrentScript() || !runtimeAlive()) return;
      if (!["youtube", "x"].includes(parsePage().kind)) return;
      if (cachedState.subtitleStatus !== "pending" && cachedState.page !== "loading") return;
      loadState().then((state) => {
        postRuntime({ type: "STATE", payload: state });
      });
    }, 1000);
  }

  async function loadState() {
    const force = arguments[0] === true;
    const page = parsePage();
    const key = pageKey(page);
    if (inflightLoad && inflightLoad.key === key && (!force || inflightLoad.force)) {
      return inflightLoad.promise;
    }

    const token = ++loadToken;
    const run = (async () => {
      if (key !== lastStateKey || cachedState.subtitleStatus === "fetch_failed") pendingSince = 0;
      if (key !== lastStateKey) {
        if (pendingReload) {
          clearTimeout(pendingReload);
          pendingReload = 0;
        }
        clearCueLoop();
        if (["youtube", "x"].includes(page.kind)) {
          setOverlayCues([]);
          setProgressMarks([]);
          cachedState = emptyState("loading", { bvid: page.bvid, cid: 1, platform: page.kind, canGenerate: allowsAsr(page.kind) });
        }
      }
      if (page.kind === "other") {
        clearCueLoop();
        cachedState = emptyState("other", { platform: page.platform || "" });
        lastStateKey = key;
        pendingSince = 0;
        setOverlayCues([]);
        setProgressMarks([]);
        return cachedState;
      }

      const settlePending = () => {
        if (cachedState.subtitleStatus === "pending") {
          if (!pendingSince) pendingSince = Date.now();
          if (Date.now() - pendingSince >= (pendingGiveUpMs || 60000)) {
            const ad = /广告/.test(`${cachedState.notice || ""}${cachedState.error || ""}`);
            cachedState.subtitleStatus = "fetch_failed";
            cachedState.error = ad
              ? "广告结束后仍未读到正片，请确认视频已开始播放后重试"
              : "读取视频信息超时，请确认已开始播放正片后重试";
            cachedState.notice = "";
            return;
          }
          schedulePendingReload();
          return;
        }
        pendingSince = 0;
      };

      loadingPageKey = key;
      try {
        const data = await askBackground({ type: "LOAD_SUBTITLES", page, force });
        if (token !== loadToken || pageKey() !== key) return cachedState;
        const video = getVideo();
        hookVideo(video);

        cachedState = {
          page: data.page || "video",
          platform: data.platform || "bilibili",
          notice: data.notice || "",
          bvid: data.bvid || page.bvid || "",
          aid: Number(data.aid) || 0,
          cid: Number(data.cid || page.cid) || 0,
        title: data.title || "",
        titleFull: data.titleFull || "",
        part: data.part || "",
          pic: data.pic || "",
          up: data.up || "",
          rate: targetRate,
          tracks: data.tracks || [],
          activeLan: data.activeLan || "",
          cues: data.cues || [],
          login: data.login || null,
          source: data.source || "",
          // 来源类别（official / asr）：转回后台保存时带上，本地条目已被清掉时据此重建
          origin: data.origin || "",
          canGenerate: data.canGenerate !== false,
          partial: Boolean(data.partial),
          asrDone: Number(data.asrDone) || 0,
          asrTotal: Number(data.asrTotal) || 0,
          currentTime: video?.currentTime || 0,
          duration: video?.duration || 0,
          subtitleStatus: data.subtitleStatus || "",
          error: data.error || (data.partial || data.subtitleStatus ? "" : data.notice) || ""
        };
        setOverlayCues(cachedState.cues);
        lastStateKey = key;
        pullProgressMarks();
        settlePending();
        return cachedState;
      } catch (error) {
        if (token !== loadToken || pageKey() !== key) return cachedState;
        const pageInfo = parsePage();
        const pending = ["youtube", "x"].includes(pageInfo.kind) && BiliCaptionPlatforms.isPending(error);
        cachedState = emptyState("video", {
          bvid: pageInfo.bvid || "",
          aid: Number(pageInfo.aid) || 0,
          cid: Number(pageInfo.cid) || 0,
          error: pending ? "" : (error.message || String(error)),
          notice: pending ? (error.message || String(error)) : "",
          platform: pageInfo.platform || pageInfo.kind || "bilibili",
          login: ["youtube", "x"].includes(pageInfo.kind) ? { platform: pageInfo.kind } : undefined,
          subtitleStatus: pending ? "pending" : "",
          canGenerate: allowsAsr(pageInfo.kind)
        });
        lastStateKey = key;
        pullProgressMarks();
        settlePending();
        return cachedState;
      } finally {
        if (token === loadToken) loadingPageKey = "";
      }
    })();

    inflightLoad = { key, promise: run, force };
    run.finally(() => {
      if (inflightLoad?.promise === run) inflightLoad = null;
    });
    return run;
  }

  async function switchTrack(lan) {
    const track = cachedState.tracks.find((item) => item.lan === lan);
    if (!track) return cachedState;
    const key = pageKey();
    const data = await askBackground({ type: "FETCH_CUES", url: track.url, lan: track.lan, page: parsePage() });
    if (pageKey() !== key) return cachedState;
    if (data.error) { cachedState.error = data.error; return cachedState; }
    cachedState.cues = data.cues || [];
    cachedState.activeLan = track.lan;
    cachedState.source = cachedState.platform || "bilibili";
    cachedState.origin = "official";
    cachedState.error = "";
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
    if (message?.type === "PING") {
      try {
        sendResponse({ ok: true, tabId: myTabId });
      } catch {
        // 失效 world 里 sendResponse 可能抛，别挡住新脚本的应答
      }
      return;
    }
    if (!isCurrentScript()) return;
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
    if (message?.type === "REFRESH") return reply(loadState(Boolean(message.force)));
    if (message?.type === "SET_RATE") {
      applyRate(message.rate);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "PAUSE") {
      const video = getVideo();
      if (video && !video.paused) video.pause();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "LOOP_SEL") {
      applyCueLoop(message);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SEEK") {
      seekTo(message.time);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "OPEN_FLOAT") {
      setDockOpen(true);
      placeDock();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "CLOSE_FLOAT") {
      preferSidebar = true;
      dockOpen = false;
      persistDockPrefs();
      document.getElementById("bilicaption-dock")?.remove();
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SET_OVERLAY") {
      setOverlayVisible(message.on !== false);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SYNC_MARKERS") {
      const hasIdentity = Boolean(message.bvid || message.cid);
      const sameVideo =
        (!message.bvid || (cachedState.bvid && message.bvid === cachedState.bvid)) &&
        (!message.cid || (cachedState.cid && Number(message.cid) === Number(cachedState.cid)));
      if (!hasIdentity || !sameVideo) return reply(Promise.resolve(snapshot()));
      setProgressMarks(message.markers || []);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SET_CAPTION_LANG") {
      captionLang = message.lang === "en" ? "en" : "zh";
      lastOverlayText = "";
      updateOverlay(getVideo()?.currentTime || 0);
      return reply(Promise.resolve(snapshot()));
    }
    if (message?.type === "SWITCH_TRACK") return reply(switchTrack(message.lan));
    if (message?.type === "APPLY_ASR_CUES") {
      const page = parsePage();
      const expectedBvid = cachedState.bvid || page.bvid || "";
      const expectedCid = Number(cachedState.cid || page.cid) || 0;
      const hasIdentity = Boolean(message.bvid || message.cid);
      const sameVideo =
        (!message.bvid || (expectedBvid && message.bvid === expectedBvid)) &&
        (!message.cid || (expectedCid && Number(message.cid) === expectedCid));
      if (!hasIdentity || !sameVideo) return reply(Promise.resolve(snapshot()));
      const keepTranslation =
        cachedState.source === "translated" || cachedState.activeLan === "translated";
      if (message.aid) cachedState.aid = Number(message.aid) || cachedState.aid;
      if (message.cid) cachedState.cid = Number(message.cid) || cachedState.cid;
      if (message.bvid) cachedState.bvid = message.bvid;
      if (message.title) cachedState.title = message.title;
      cachedState.cues = keepTranslation
        ? preserveTranslatedCues(message.cues || [], cachedState.cues)
        : (message.cues || []);
      cachedState.activeLan = keepTranslation ? "translated" : (message.activeLan || "groq-asr");
      cachedState.source = keepTranslation ? "translated" : (message.source || "groq");
      cachedState.origin = "asr";
      cachedState.canGenerate = allowsAsr(parsePage().kind);
      cachedState.partial = Boolean(message.partial);
      cachedState.error = "";
      setOverlayCues(cachedState.cues);
      const snap = snapshot();
      postRuntime({ type: "STATE", payload: snap });
      return reply(Promise.resolve(snap));
    }
    if (message?.type === "SYNC_CUES") {
      const hasIdentity = Boolean(message.bvid || message.cid);
      const sameVideo =
        (!message.bvid || (cachedState.bvid && message.bvid === cachedState.bvid)) &&
        (!message.cid || (cachedState.cid && Number(message.cid) === Number(cachedState.cid)));
      // 翻译可能在后台继续。标签页已经跳到别的视频时，旧任务不得覆盖并缓存到新视频。
      if (!hasIdentity || !sameVideo) return reply(Promise.resolve(snapshot()));
      // 后台翻译运行中只发本批变化的行：[[行索引, 译文, 英文原文], …]。
      // 行数对不上（页面刚刷新、后台刚切句）时回 needFull，让后台补发整份。
      if (Array.isArray(message.patch)) {
        const list = cachedState.cues || [];
        if (list.length !== Number(message.cueCount)) return reply(Promise.resolve({ needFull: true }));
        const next = list.slice();
        for (const [index, content, original] of message.patch) {
          const cue = next[index];
          if (!cue || typeof content !== "string") continue;
          next[index] = original && !String(cue.original || "").trim()
            ? { ...cue, content, original }
            : { ...cue, content };
        }
        cachedState.cues = next;
        if (message.activeLan) cachedState.activeLan = message.activeLan;
        if (message.source) cachedState.source = message.source;
        setOverlayCues(cachedState.cues);
        return reply(Promise.resolve({ ok: true }));
      }
      cachedState.cues = message.cues || cachedState.cues;
      if (message.activeLan) cachedState.activeLan = message.activeLan;
      if (message.source) cachedState.source = message.source;
      setOverlayCues(cachedState.cues);
      // persisted：后台翻译已自己写缓存，不再回传整份字幕重写一遍；侧栏改字等来源仍由这里保存。
      // edited：只有侧栏 / 浮窗里用户手动改字、批量替换发来的才带 true，原样转给后台记 editedAt。
      if (!message.persisted && cachedState.bvid && cachedState.cid && cachedState.cues.length) {
        askBackground({
          type: "SAVE_CUES_CACHE",
          bvid: cachedState.bvid,
          cid: cachedState.cid,
          cues: cachedState.cues,
          activeLan: cachedState.activeLan,
          source: cachedState.source,
          origin: cachedState.origin || "",
          edited: message.edited === true
        }).catch(() => {});
      }
      const snap = snapshot();
      postRuntime({ type: "STATE", payload: snap });
      return reply(Promise.resolve(snap));
    }
    if (message?.type === "X_MANIFEST_READY") {
      // 后台刚捕获到本帖视频的 HLS 清单：之前因「尚未捕获」没拿到字幕的，自动重读一次
      const page = parsePage();
      const same = page.kind === "x" && (!message.bvid || message.bvid === page.bvid);
      if (same && !cachedState.cues?.length && cachedState.bvid === page.bvid && xManifestRetryKey !== page.bvid) {
        xManifestRetryKey = page.bvid;
        const key = pageKey(page);
        // 正在进行的同视频读取发起于清单到达之前，直接合并会拿到旧结果、之后也不再重读：
        // 等它结束，仍没有字幕就再读一次
        const running = inflightLoad?.key === key ? inflightLoad.promise : null;
        Promise.resolve(running)
          .catch(() => {})
          .then(() => {
            if (pageKey() !== key) return null;
            return cachedState.cues?.length ? cachedState : loadState();
          })
          .then((state) => {
            if (state) postRuntime({ type: "STATE", payload: state });
          });
      }
      return reply(Promise.resolve({ ok: true }));
    }
    return false;
  });

  const notifyNav = () => {
    if (!isCurrentScript()) return;
    lastHref = location.href;
    refreshIfNeeded(true).then((state) => {
      postRuntime({ type: "STATE", payload: state });
    });
  };
  // 注：content script 的 isolated world 拦不到页面自己的 pushState/replaceState，
  // SPA 切页靠下面 popstate 和 1 秒轮询 location.href 兜底
  window.addEventListener("popstate", notifyNav);
  // capture 阶段抢在 B 站播放器之前；只绑 window，避免 C/X 处理两遍
  window.addEventListener("keydown", onHotkey, true);
  window.addEventListener("keydown", forwardPanelKey, true);
  window.addEventListener("keyup", forwardPanelKey, true);
  document.addEventListener("visibilitychange", () => {
    if (!isCurrentScript()) return;
    if (document.hidden) setSelKeyHeld(false);
  });
  window.addEventListener("message", (event) => {
    if (!isCurrentScript()) return;
    if (event.data?.type !== "BC_SEL_KEY") return;
    if (event.source !== dockFrame()?.contentWindow) return;
    if (event.origin !== `chrome-extension://${chrome.runtime.id}`) return;
    setSelKeyHeld(Boolean(event.data.held));
  });
  const onPlayerResize = () => {
    if (!isCurrentScript()) return;
    placeOverlay();
    applyOverlayScale();
    placeDock();
  };
  document.addEventListener("fullscreenchange", onPlayerResize);
  document.addEventListener("webkitfullscreenchange", onPlayerResize);
  window.addEventListener("resize", onPlayerResize);

  const dockWatch = new MutationObserver(() => {
    // 扩展重载后旧脚本已失效：浮窗节点被移除时别再重建（getURL 会抛 Extension context invalidated）
    if (!isCurrentScript() || !runtimeAlive()) {
      dockWatch.disconnect();
      return;
    }
    if (dockOpen || !preferSidebar) placeDock();
  });
  dockWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  if (document.body) dockWatch.observe(document.body, { attributes: true, attributeFilter: ["class", "style"], childList: true });

  const dockTick = setInterval(() => {
    if (!isCurrentScript()) {
      clearInterval(dockTick);
      dockWatch.disconnect();
      // 让出所有权后断开进度连接，侧栏会重连到接手的新脚本
      closeTimePorts();
      return;
    }
    // 扩展重载后旧 content script 已死。只有自己仍是 owner 时才拆 DOM；
    // 新脚本接手前写过 data-bilicaption-owner，旧脚本到这里会直接停。
    if (!runtimeAlive()) {
      document.getElementById("bilicaption-dock")?.remove();
      document.getElementById("bilicaption-overlay")?.remove();
      document.getElementById("bilicaption-rate-hud")?.remove();
      document.getElementById("bilicaption-progress-marks")?.remove();
      return;
    }
    const key = pageKey();
    if (key !== loadingPageKey && (location.href !== lastHref || (key !== lastStateKey && parsePage().kind !== "other"))) {
      notifyNav();
    }
    if (parsePage().kind !== "other") hookVideo(getVideo());
    if (progressMarks.length) renderProgressMarks();
    if (overlayCues.length) {
      const el = document.getElementById("bilicaption-overlay");
      if (!el) updateOverlay(getVideo()?.currentTime || 0);
      else placeOverlay(el);
    }
    if (dockOpen || !preferSidebar) placeDock();
  }, 1000);

  chrome.storage.sync.get({ overlayOn: true, selKey: "Shift", captionLang: "zh" }, (data) => {
    if (!isCurrentScript()) return;
    overlayOn = data.overlayOn !== false;
    selKey = data.selKey || "Shift";
    captionLang = data.captionLang === "en" ? "en" : "zh";
    if (!overlayOn) hideOverlay();
    else {
      lastOverlayText = "";
      updateOverlay(getVideo()?.currentTime || 0);
    }
  });
  chrome.storage.sync.get({
    dockGeomPage: null,
    dockGeomFull: null,
    dockAlpha: 0.82,
    dockOpen: false,
    preferSidebar: true
  }, (data) => {
    if (!isCurrentScript()) return;
    dockGeom.page = data.dockGeomPage || null;
    dockGeom.full = data.dockGeomFull || null;
    dockAlpha = clampDockAlpha(data.dockAlpha);
    applyDockUiPrefs(data);
  });
  ensureTabId().catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!isCurrentScript()) return;
    if (area === "sync" && (changes.dockOpen || changes.preferSidebar)) {
      applyDockUiPrefs({
        dockOpen: changes.dockOpen ? changes.dockOpen.newValue : dockOpen,
        preferSidebar: changes.preferSidebar ? changes.preferSidebar.newValue : preferSidebar
      });
    }
    if (area === "sync" && changes.dockAlpha) {
      dockAlpha = clampDockAlpha(changes.dockAlpha.newValue);
      applyDockAlpha();
    }
    if (area === "sync" && (changes.dockGeomPage || changes.dockGeomFull)) {
      if (changes.dockGeomPage) dockGeom.page = changes.dockGeomPage.newValue || null;
      if (changes.dockGeomFull) dockGeom.full = changes.dockGeomFull.newValue || null;
      applyDockGeom();
    }
    if (area === "sync" && changes.overlayOn) {
      setOverlayVisible(changes.overlayOn.newValue !== false);
    }
    if (area === "sync" && changes.captionLang) {
      captionLang = changes.captionLang.newValue === "en" ? "en" : "zh";
      lastOverlayText = "";
      updateOverlay(getVideo()?.currentTime || 0);
    }
    if (area === "sync" && changes.selKey) {
      selKey = changes.selKey.newValue || "Shift";
    }
  });

  refreshIfNeeded(true);
})();
