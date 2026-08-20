(function (global) {
  function joinUrl(base, path) {
    const root = String(base || "").replace(/\/+$/, "");
    const rel = String(path || "").replace(/^\/+/, "");
    return `${root}/${rel}`;
  }

  function authHeader(user, pass) {
    return `Basic ${btoa(`${user}:${pass}`)}`;
  }

  // http 会把 Basic 认证和同步的 API Key 全部明文过网，必须拦下
  function assertHttpsUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("服务器地址无效，请填写完整 URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("WebDAV 地址必须使用 https，否则网盘密码和 API Key 会明文传输");
    }
    return parsed;
  }

  async function ensureOrigin(url) {
    try {
      await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
    } catch {
      // ignore
    }
  }

  function safeFileId(value) {
    return String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
  }

  async function davFetch(cfg, path, options = {}) {
    const url = joinUrl(cfg.url, path);
    assertHttpsUrl(url);
    await ensureOrigin(url);
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader(cfg.user, cfg.pass),
        ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json;charset=UTF-8" } : {}),
        ...(options.headers || {})
      }
    });
    return res;
  }

  async function mkcol(cfg, path) {
    const res = await davFetch(cfg, path, { method: "MKCOL" });
    if (res.status === 201 || res.status === 405 || res.status === 409 || res.status === 301) return;
    if (!res.ok && res.status !== 200) {
      throw new Error(`无法创建目录 ${path}（HTTP ${res.status}）`);
    }
  }

  async function putJson(cfg, path, data) {
    const res = await davFetch(cfg, path, {
      method: "PUT",
      body: JSON.stringify(data, null, 2)
    });
    if (!res.ok) throw new Error(`上传失败 ${path}（HTTP ${res.status}）`);
  }

  async function getJson(cfg, path) {
    const res = await davFetch(cfg, path, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`下载失败 ${path}（HTTP ${res.status}）`);
    return res.json();
  }

  async function test(cfg) {
    if (!cfg.url) throw new Error("请填写服务器地址");
    if (!cfg.user || !cfg.pass) throw new Error("请填写用户名和密码");
    await mkcol(cfg, "");
    const res = await davFetch(cfg, "", { method: "PROPFIND", headers: { Depth: "0" } });
    if (!res.ok && res.status !== 207) throw new Error(`连接失败 HTTP ${res.status}`);
    return { ok: true };
  }

  function markFile(bvid, cid) {
    return `marks/${safeFileId(bvid) || "video"}-P${Number(cid) || 0}.json`;
  }

  async function pushMarks(cfg, entry, marks) {
    await mkcol(cfg, "marks");
    await putJson(cfg, markFile(entry.bvid, entry.cid), {
      ...entry,
      marks
    });
  }

  async function pullMarks(cfg, bvid, cid) {
    return getJson(cfg, markFile(bvid, cid));
  }

  async function pushConfig(cfg, data) {
    await putJson(cfg, "config.json", data);
  }

  async function pullConfig(cfg) {
    return getJson(cfg, "config.json");
  }

  async function syncNow(cfg, storage) {
    await test(cfg);
    await mkcol(cfg, "");
    const Markers = global.BiliCaptionMarkers;
    if (storage.syncMarks !== false && Markers) {
      const index = await Markers.loadIndex();
      for (const entry of index) {
        const marks = await Markers.load(entry.bvid, entry.cid);
        await pushMarks(cfg, entry, marks);
      }
    }
    if (storage.syncConfig || storage.syncKeys) {
      const cfgOut = {
        sttProvider: storage.sttProvider,
        sttModel: storage.sttModel,
        sttChannels: storage.sttChannels,
        backupProvider: storage.backupProvider,
        sumProvider: storage.sumProvider,
        apiBase: storage.apiBase,
        apiModel: storage.apiModel,
        selKey: storage.selKey,
        summaryPad: storage.summaryPad,
        translateConcurrency: storage.translateConcurrency,
        updatedAt: Date.now()
      };
      if (storage.syncKeys) {
        cfgOut.sttCreds = storage.sttCreds;
        cfgOut.sttChannels = storage.sttChannels;
        cfgOut.apiKey = storage.apiKey;
        cfgOut.backupKey = storage.backupKey;
      }
      await pushConfig(cfg, cfgOut);
    }
    return { ok: true, at: Date.now() };
  }

  global.BiliCaptionDav = {
    test,
    syncNow,
    pushMarks,
    pullMarks,
    pushConfig,
    pullConfig,
    markFile
  };
})(globalThis);
