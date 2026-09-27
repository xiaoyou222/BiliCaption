// 后台 · 字幕获取：侧栏 / 浮窗打开视频时要的整份字幕状态（LOAD_SUBTITLES）。
// B 站走接口，YouTube / X 走页面注入；命中本地缓存时不再请求字幕。

function xTitleNeedsRewrite(title) {
  const chars = Array.from(String(title || "").trim());
  if (!chars.length) return true;
  if (chars.length <= 40) return false;
  return !(chars.length === 41 && chars.at(-1) === "…");
}

function applyXHeadline(data) {
  if (!data) return data;
  const title = String(data.title || "").trim();
  const full = String(data.titleFull || "").trim();
  if (title && !xTitleNeedsRewrite(title)) {
    const tip = full ? BiliCaptionPlatforms.xHeadline({ text: full }).titleFull : title;
    return { ...data, title, titleFull: tip || title };
  }
  const shaped = title
    ? BiliCaptionPlatforms.xHeadline({ text: full || title })
    : BiliCaptionPlatforms.xHeadline({ author: data.up || "" });
  return {
    ...data,
    title: shaped.title || "",
    titleFull: shaped.titleFull || shaped.title || ""
  };
}

// 限流退避：内存里留一份，同时写 chrome.storage.session。service worker 被回收重启后
// 仍记得这支视频刚被限流，自动轮询不会一醒来就又去打 timedtext。
const subtitleFetchBackoff = new Map();
const SUBTITLE_BACKOFF_MS = 60_000;

function subtitleBackoffKey(page) {
  return `subBackoff:${page?.kind || ""}:${page?.bvid || ""}`;
}

async function noteSubtitleRateLimit(page, error, meta = {}) {
  const key = subtitleBackoffKey(page);
  const rec = {
    until: Date.now() + SUBTITLE_BACKOFF_MS,
    error: error || "YouTube 字幕接口限流，请稍后再试",
    title: meta.title || "",
    up: meta.up || "",
    pic: meta.pic || "",
    duration: meta.duration || 0,
    tracks: Array.isArray(meta.tracks) ? meta.tracks : []
  };
  subtitleFetchBackoff.set(key, rec);
  await chrome.storage.session?.set({ [key]: rec })?.catch?.(() => {});
}

async function subtitleBackoff(page, force) {
  const key = subtitleBackoffKey(page);
  const drop = async () => {
    subtitleFetchBackoff.delete(key);
    await chrome.storage.session?.remove(key)?.catch?.(() => {});
    return null;
  };
  if (force) return drop();
  let rec = subtitleFetchBackoff.get(key);
  if (!rec && chrome.storage.session) {
    rec = (await chrome.storage.session.get(key).catch(() => ({})))?.[key] || null;
    if (rec) subtitleFetchBackoff.set(key, rec);
  }
  if (!rec) return null;
  if (Date.now() >= (Number(rec.until) || 0)) return drop();
  return rec;
}

function pendingPlatformState(page, notice) {
  return {
    page: "video",
    platform: page.kind,
    bvid: page.bvid,
    cid: 1,
    aid: 0,
    title: "",
    up: "",
    pic: "",
    durationMeta: 0,
    tracks: [],
    cues: [],
    activeLan: "",
    source: page.kind,
    canGenerate: page.kind === "x",
    partial: false,
    login: { platform: page.kind },
    subtitleStatus: "pending",
    error: "",
    notice: notice || "正在读取视频信息…"
  };
}

// YouTube「自动翻译中文」轨只在 readPage 里生成一次：那里能看到 translationLanguages，
// 只有 YouTube 声明支持中文且原轨可翻译时才加，后台不再自己拼一条可能不存在的 zh-Hans。

const PLATFORM_TRACK_TRY_LIMIT = 3;

/**
 * 侧栏「继续生成」显示的已完成 / 总段数：有转写存档用存档，没有就按字幕末尾和视频时长粗估
 * （每段约 8 分钟）。B 站和 X 共用这一份算法。
 */
function asrProgressCounts(asrJob, lastCueTo, duration) {
  return {
    asrDone: Math.max(
      Number(asrJob?.done) || 0,
      (asrJob?.parts || []).filter(Boolean).length,
      lastCueTo > 80 ? Math.max(1, Math.round(lastCueTo / (8 * 60))) : 0
    ),
    asrTotal: Number(asrJob?.total) || (Number(duration) > 0 ? Math.ceil(Number(duration) / (8 * 60)) : 0)
  };
}

async function platformAsrProgress(page, cached, cues, duration) {
  const canGenerate = page.kind === "x";
  if (!canGenerate) return { canGenerate: false, partial: false, asrDone: 0, asrTotal: 0 };
  const asrJob = await loadAsrJob(page.bvid, 1);
  return {
    canGenerate,
    partial: Boolean(cached?.partial),
    ...asrProgressCounts(asrJob, maxCueField(cues), duration)
  };
}

/**
 * 状态里带上字幕的来源类别（official / asr），页面转回来保存、侧栏发起翻译时用它给新条目定来源：
 * 命中缓存按缓存条目；刚拉到官方字幕是 official；没有字幕为空。
 */
function subtitleStateOrigin(cached, fromCache, cues) {
  if (!cues?.length) return "";
  return fromCache ? BiliCaptionCueTools.subtitleCacheOrigin(cached) : "official";
}

function platformSubtitleState(page, { data, cached, tracks, cues, active, error, asr, fromCache = false }) {
  const canGenerate = asr?.canGenerate === true;
  return {
    page: "video",
    platform: page.kind,
    bvid: page.bvid,
    cid: 1,
    aid: 0,
    title: data.title || cached?.title || "",
    titleFull: data.titleFull || cached?.titleFull || "",
    up: data.up || cached?.up || "",
    pic: data.pic || cached?.pic || "",
    durationMeta: data.duration || cached?.durationMeta || 0,
    tracks: tracks || [],
    cues,
    activeLan: active,
    source: cached?.source || page.kind,
    origin: subtitleStateOrigin(cached, fromCache, cues),
    canGenerate,
    partial: Boolean(asr?.partial),
    asrDone: Number(asr?.asrDone) || 0,
    asrTotal: Number(asr?.asrTotal) || 0,
    login: { platform: page.kind },
    subtitleStatus: error ? "fetch_failed" : cues.length ? "" : "none",
    error,
    notice: cues.length ? "" : (canGenerate
      ? (error || "未发现可读取的字幕，可在设置好转写通道后生成")
      : "未发现可读取的字幕，请先开启播放器字幕后刷新；该平台暂不支持无字幕转写")
  };
}

async function loadPlatformSubtitles(page, tabId, options = {}) {
  const force = Boolean(options.force);
  let cached = await loadCachedAsr(page.bvid, 1);
  // 本机没有转写 / 改字而 WebDAV 上有备份时取回来用（至多一个 GET，见 后台/字幕备份.js）
  cached = (await restoreSubtitleBackup(page.bvid, 1, cached, { force }).catch(() => null)) || cached;
  if (shouldUseSubtitleCache(cached, force)) {
    let meta = {
      title: cached.title || "",
      titleFull: cached.titleFull || "",
      up: cached.up || "",
      pic: cached.pic || "",
      duration: cached.durationMeta || 0
    };
    const titleMissing = page.kind === "x" && xTitleNeedsRewrite(meta.title);
    if (titleMissing) {
      try {
        const fresh = applyXHeadline(await readPlatformPage(page, tabId));
        if (fresh?.title) {
          meta = {
            title: fresh.title,
            titleFull: fresh.titleFull || fresh.title,
            up: fresh.up || meta.up,
            pic: fresh.pic || meta.pic,
            duration: fresh.duration || meta.duration
          };
          await saveCachedAsr(page.bvid, 1, {
            ...cached,
            origin: BiliCaptionCueTools.subtitleCacheOrigin(cached),
            title: meta.title,
            titleFull: meta.titleFull,
            up: meta.up,
            pic: meta.pic,
            durationMeta: meta.duration || cached.durationMeta || 0
          });
        }
      } catch {
        meta = applyXHeadline(meta);
      }
    }
    const tracks = Array.isArray(cached.tracks) ? cached.tracks : [];
    const asr = await platformAsrProgress(page, cached, cached.cues, cached.durationMeta);
    return platformSubtitleState(page, {
      data: meta,
      cached,
      tracks,
      cues: cached.cues,
      active: cached.activeLan || "",
      error: "",
      asr,
      fromCache: true
    });
  }

  const blocked = await subtitleBackoff(page, force);
  if (blocked) {
    const asr = await platformAsrProgress(page, cached, [], cached?.durationMeta || blocked.duration);
    return platformSubtitleState(page, {
      data: {
        title: cached?.title || blocked.title || "",
        up: cached?.up || blocked.up || "",
        pic: cached?.pic || blocked.pic || "",
        duration: cached?.durationMeta || blocked.duration || 0
      },
      cached,
      tracks: Array.isArray(cached?.tracks) && cached.tracks.length ? cached.tracks : blocked.tracks,
      cues: [],
      active: "",
      error: blocked.error,
      asr
    });
  }

  let data;
  try {
    data = await readPlatformPage(page, tabId);
    if (page.kind === "x") data = applyXHeadline(data);
  } catch (error) {
    if (BiliCaptionPlatforms.isPending(error)) return pendingPlatformState(page, error.message || String(error));
    throw error;
  }
  const tracks = (data.tracks || []).filter((t) => t.embedded || BiliCaptionPlatforms.cueUrl(t.url));
  const preferred = pickDefaultTrack(tracks);
  let cues = [];
  let error = data.subtitleError || "";
  let active = preferred?.lan || "";
  if (!cues.length) {
    const order = [preferred, ...tracks.filter((t) => t !== preferred)].filter(Boolean);
    const tried = new Set();
    for (const track of order) {
      if (!track.url || tried.has(track.url)) continue;
      // YouTube 每条轨失败可能要等十几秒（多格式 + 等播放器），最多试 3 条就停。
      if (tried.size >= PLATFORM_TRACK_TRY_LIMIT) break;
      tried.add(track.url);
      try {
        cues = await fetchPlatformTrack({ page, url: track.url, lan: track.lan }, tabId);
        if (cues.length) { active = track.lan; error = ""; break; }
      } catch (e) {
        if (BiliCaptionPlatforms.isPending(e)) {
          return { ...pendingPlatformState(page, e.message || String(e)), title: data.title || "", up: data.up || "", pic: data.pic || "", durationMeta: data.duration || 0, tracks };
        }
        error = e.message || String(e);
        if (BiliCaptionPlatforms.isRateLimited(e)) {
          error = /限流/.test(error) ? error : "YouTube 字幕接口限流，请稍后再试";
          await noteSubtitleRateLimit(page, error, {
            title: data.title || "",
            up: data.up || "",
            pic: data.pic || "",
            duration: data.duration || 0,
            tracks
          });
          break;
        }
        if (!/未返回字幕内容|未返回有效内容|已失效/.test(error)) break;
      }
    }
  }
  if (cues.length) {
    await persistOfficialSubtitleCache(page.bvid, 1, {
      cues,
      activeLan: active,
      source: page.kind,
      title: data.title || "",
      titleFull: data.titleFull || "",
      up: data.up || "",
      pic: data.pic || "",
      durationMeta: data.duration || 0,
      tracks
    }, cached);
  }
  const asr = await platformAsrProgress(page, cached, cues, data.duration);
  return platformSubtitleState(page, {
    data,
    cached: cues.length ? { ...cached, source: cached?.source || page.kind } : cached,
    tracks,
    cues,
    active,
    error,
    asr
  });
}

/**
 * 切换官方字幕轨（FETCH_CUES）：拉这条轨并写进本视频的字幕缓存。
 * 缓存被用户改过字时：切回改的那条轨直接用缓存里改过的版本；切到别的轨只显示、不落盘，
 * 免得改过的字被官方原文盖掉。
 */
async function fetchTrackCues(message, tabId) {
  const page = message.page;
  const platform = page?.kind === "youtube" || page?.kind === "x";
  const source = platform ? page.kind : "bilibili";
  const bvid = page?.bvid || message.bvid || "";
  const cid = platform ? 1 : (Number(page?.cid || message.cid) || 0);
  if (bvid && message.lan) {
    const cached = await loadCachedAsr(bvid, cid).catch(() => null);
    if (isEditedSubtitleCache(cached) && cached.cues?.length
      && isOfficialSubtitleSource(cached.source) && cached.activeLan === message.lan) {
      return { cues: cached.cues };
    }
  }
  const cues = await fetchPlatformTrack(message, tabId);
  if (bvid && cues.length) {
    await persistOfficialSubtitleCache(bvid, cid, {
      cues,
      activeLan: message.lan || "",
      source
    }, undefined, { overwrite: true });
  }
  return { cues };
}

async function loadSubtitles(page, tabId, options = {}) {
  if (["youtube", "x"].includes(page?.kind)) return loadPlatformSubtitles(page, tabId, options);
  const force = Boolean(options.force);

  if (!page || !["video", "bangumi"].includes(page.kind)) {
    const login = await loadBiliLogin();
    return { page: "other", tracks: [], cues: [], activeLan: "", error: "", login, canGenerate: false };
  }

  // 登录状态和视频信息并行取；已登录的结果 10 分钟内复用，命中本地字幕缓存时不再固定打 nav。
  const loginTask = loadBiliLogin();
  let meta;
  if (page.kind === "video") {
    const view = await fetchView(page.bvid);
    const p = Math.max(1, Number(page.p) || 1);
    const part = view.pages?.[p - 1];
    if (!part && view.pages?.length > 1) {
      throw new Error(`找不到第 ${p} P`);
    }
    const cid = Number(page.cid) || part?.cid || (view.pages?.length === 1 ? view.cid : 0);
    if (!cid) throw new Error("无法解析当前分 P，请刷新后再试");
    meta = {
      title: view.title || "",
      part: part?.part && view.pages?.length > 1 ? part.part : "",
      aid: view.aid,
      cid,
      bvid: view.bvid || page.bvid,
      duration: part?.duration || view.duration || 0,
      pic: view.pic || "",
      up: view.owner?.name || ""
    };
  } else {
    let hint = page;
    if (!page.epId && page.seasonId) {
      // ss 链接：当前集只在页面播放器里，读不到时不拿第一集或上次进度去猜
      const live = await readBangumiEpisode(page, tabId);
      if (!live) throw new Error("还没读到当前播放的是哪一集，请开始播放后刷新字幕，或从具体一集进入");
      hint = { ...page, epId: live.epId || "", cid: live.cid || 0 };
    }
    meta = await fetchBangumi(hint);
  }

  let tracks = [];
  let cues = [];
  let activeLan = "";
  let source = "";
  let origin = "";
  let error = "";
  let notice = "";
  let subtitleStatus = "";
  let cached = await loadCachedAsr(meta.bvid, meta.cid);
  // 本机没有转写 / 改字而 WebDAV 上有备份时取回来用，受保护条目优先于官方字幕（至多一个 GET）
  cached = (await restoreSubtitleBackup(meta.bvid, meta.cid, cached, { force }).catch(() => null)) || cached;
  const asrJob = await loadAsrJob(meta.bvid, meta.cid);
  const lastCueTo = maxCueField(cached?.cues);
  // 新缓存会明确写 partial=false；长片尾静音不能仅凭最后一句离视频结尾远
  // 就判成断点任务。时长启发式只用于兼容没有 partial 字段的旧缓存。
  const looksIncomplete = cached?.partial == null
    && lastCueTo > 20
    && Number(meta.duration) > 0
    && lastCueTo < Number(meta.duration) - 90;
  const partial = Boolean(
    cached?.partial
    || (asrJob?.parts?.length && asrJob.pending !== false)
    || looksIncomplete
  );
  // 以前缓存下来的「别的视频的 AI 字幕」同样作废，重新取
  const badOfficialCache = cached?.source === "bilibili" && cuesExceedDuration(cached?.cues, meta.duration);
  let login;
  if (shouldUseSubtitleCache(cached, force) && !badOfficialCache) {
    // 有缓存先用缓存：字幕轨列表用缓存里存的那份，不再打 WBI nav、player、dm/view。
    tracks = Array.isArray(cached.tracks) ? cached.tracks : [];
    cues = cached.cues;
    source = cached.source || "groq";
    origin = BiliCaptionCueTools.subtitleCacheOrigin(cached);
    if (cached.activeLan) activeLan = cached.activeLan;
    else if (source === "translated") activeLan = "translated";
    else if (isOfficialSubtitleSource(source)) activeLan = "";
    else activeLan = "groq-asr";
    if (partial) notice = "字幕还没转写完，点「继续生成」会从断点接着传";
    login = await loginTask;
  } else {
    let playerError = null;
    let dmViewError = null;
    let needLogin = false;
    try {
      const player = await fetchPlayer(meta.aid, meta.cid);
      tracks = mapSubtitleTracks(player);
      needLogin = player?.need_login_subtitle === true;
    } catch (e) {
      playerError = e;
      console.warn("[BiliCaption] player failed", e);
    }
    if (!tracks.length && meta.aid && meta.cid) {
      try {
        const dmTracks = mapSubtitleTracks(await fetchDmView(meta.aid, meta.cid));
        if (dmTracks.length) tracks = dmTracks;
      } catch (e) {
        dmViewError = e;
        console.warn("[BiliCaption] dm/view failed", e);
      }
    }
    login = await loginTask;
    const picked = tracks.length ? await pickBiliTrackCues(tracks, meta.duration) : null;
    if (picked?.cues.length) {
      cues = picked.cues;
      activeLan = picked.track.lan || "";
      source = "bilibili";
      origin = "official";
      await persistOfficialSubtitleCache(meta.bvid, meta.cid, {
        cues,
        activeLan,
        source,
        title: meta.title || "",
        up: meta.up || "",
        pic: meta.pic || "",
        durationMeta: meta.duration || 0,
        tracks
      }, cached);
    } else if (tracks.length) {
      // 有字幕轨但一条都用不上：不报成「没有字幕」
      subtitleStatus = "fetch_failed";
      notice = picked?.mismatch
        ? "B 站返回的字幕与视频时长对不上，可能是别的视频的 AI 字幕，已忽略"
        : "字幕文件下载失败，请稍后重试";
    } else if (needLogin && !login.isLogin) {
      error = "未登录或登录态无效，B 站通常不返回字幕。请先在浏览器登录 bilibili.com。";
      subtitleStatus = "login";
    } else if (needLogin) {
      // 接口明说登录后才给字幕，nav 却显示已登录（多半 Cookie 没带上），与「本视频没有字幕」分开提示
      subtitleStatus = "login";
      notice = "B 站要求登录后才返回字幕，请在浏览器重新登录 bilibili.com 后重试";
    } else if (login.error) {
      error = `无法确认登录状态：${login.error}`;
      subtitleStatus = "network";
    } else if (!login.isLogin) {
      error = "未登录或登录态无效，B 站通常不返回字幕。请先在浏览器登录 bilibili.com。";
      subtitleStatus = "login";
    } else if (playerError || dmViewError) {
      subtitleStatus = "fetch_failed";
      notice = "没拿到字幕列表";
    } else {
      subtitleStatus = "none";
      notice = "该视频暂无 AI/CC 字幕。";
    }
  }

  return {
    page: "video",
    bvid: meta.bvid,
    aid: meta.aid,
    cid: meta.cid,
    title: meta.title,
    part: meta.part,
    durationMeta: meta.duration || 0,
    pic: meta.pic || "",
    up: meta.up || "",
    tracks,
    activeLan,
    cues,
    login,
    source,
    origin,
    subtitleStatus,
    canGenerate: true,
    partial,
    ...asrProgressCounts(asrJob, lastCueTo, meta.duration),
    notice,
    error
  };
}
