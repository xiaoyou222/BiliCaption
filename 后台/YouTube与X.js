// 后台 · YouTube 与 X：记下播放器发出的字幕 / 清单请求，注入页面读取视频信息与字幕轨，
// 拉取 X 的 HLS 字幕和音频。webRequest、标签页关闭的监听在 background.js 注册。

// 页面脚本只读取当前标签页；视频身份来自真实标签页 URL。
const youtubeCueUrls = new Map();
// 记下播放器自己发出的字幕请求（带 pot），读这条轨时优先沿用。过滤器见 background.js。
function onYoutubeCueCompleted(details) {
  if (details.tabId < 0) return;
  const url = new URL(details.url);
  if (!url.searchParams.get("v") || !url.searchParams.get("lang")) return;
  const key = `ytCue:${details.tabId}:${url.searchParams.get("v")}:${url.searchParams.get("lang")}:${url.searchParams.get("kind") || ""}:${url.searchParams.get("tlang") || ""}`;
  youtubeCueUrls.set(key, details.url);
  if (youtubeCueUrls.size > 100) youtubeCueUrls.delete(youtubeCueUrls.keys().next().value);
  chrome.storage.session?.set({ [key]: details.url }).catch(() => {});
}

const xManifestUrls = new Map();
// 只监听 HLS 清单（.m3u8），视频 / 音频分片不再每片唤醒一次 service worker。
const X_MANIFEST_FILTER = {
  urls: [
    "https://video.twimg.com/amplify_video/*.m3u8*",
    "https://video.twimg.com/ext_tw_video/*.m3u8*"
  ]
};
function onXManifestCompleted(details) {
  const match = String(details.url || "").match(/^https:\/\/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\/pl\/[^/]+\.m3u8(?:\?|$)/);
  if (details.tabId < 0 || !match) return;
  const key = `xManifest:${details.tabId}:${match[1]}`;
  const known = xManifestUrls.has(key);
  xManifestUrls.set(key, details.url);
  if (xManifestUrls.size > 100) xManifestUrls.delete(xManifestUrls.keys().next().value);
  chrome.storage.session?.set({ [key]: details.url }).catch(() => {});
  if (!known) notifyXManifestWaiter(details.tabId, match[1]).catch(() => {});
}

// 读字幕时还没捕获到清单的帖子记在这里；用户一播放、清单一到，就让该标签页自动重读一次字幕。
// 存 session：用户可能过了好一会儿才点播放，service worker 早已回收过。
const xManifestWaiters = new Set();
function xWaitKey(tabId, mediaId) {
  return `xWait:${tabId}:${mediaId}`;
}
async function markXManifestWaiter(tabId, mediaId, bvid) {
  if (!Number.isInteger(tabId) || tabId <= 0 || !/^\d+$/.test(mediaId || "")) return;
  const key = xWaitKey(tabId, mediaId);
  xManifestWaiters.add(key);
  await chrome.storage.session?.set({ [key]: { bvid: bvid || "", at: Date.now() } })?.catch?.(() => {});
}
async function notifyXManifestWaiter(tabId, mediaId) {
  const key = xWaitKey(tabId, mediaId);
  let waiting = xManifestWaiters.has(key);
  let bvid = "";
  if (chrome.storage.session) {
    const stored = (await chrome.storage.session.get(key).catch(() => ({})))?.[key];
    if (stored) {
      waiting = true;
      bvid = stored.bvid || "";
    }
  }
  if (!waiting) return;
  xManifestWaiters.delete(key);
  await chrome.storage.session?.remove(key)?.catch?.(() => {});
  chrome.tabs.sendMessage(tabId, { type: "X_MANIFEST_READY", mediaId, bvid }).catch(() => {});
}

// 只列键名再删，别把 session 里的所有值都读出来；getKeys 需 Chrome 130+。
async function sessionKeys() {
  const area = chrome.storage.session;
  if (!area) return [];
  if (typeof area.getKeys === "function") return area.getKeys();
  return Object.keys((await area.get(null)) || {});
}

// 标签页关闭：丢掉这个标签页捕获到的字幕 / 清单地址和等待标记（内存和 session 里各一份）
function forgetTabCaptures(tabId) {
  for (const key of youtubeCueUrls.keys()) if (key.startsWith(`ytCue:${tabId}:`)) youtubeCueUrls.delete(key);
  for (const key of xManifestUrls.keys()) if (key.startsWith(`xManifest:${tabId}:`)) xManifestUrls.delete(key);
  for (const key of xManifestWaiters) if (key.startsWith(`xWait:${tabId}:`)) xManifestWaiters.delete(key);
  const prefixes = [`xManifest:${tabId}:`, `ytCue:${tabId}:`, `xWait:${tabId}:`];
  sessionKeys()
    .then((keys) => {
      const gone = keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
      return gone.length ? chrome.storage.session.remove(gone) : null;
    })
    .catch(() => {});
}

async function fetchXText(url) {
  if (!BiliCaptionPlatforms.cueUrl(url) || new URL(url).hostname !== "video.twimg.com") throw new Error("字幕地址不在允许的域名内");
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!res.ok) throw new Error(`字幕请求失败（${res.status}）`);
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error("字幕文件过大");
  return text;
}

function xManifestTracks(text, url) {
  return text.split(/\r?\n/).filter((line) => line.startsWith("#EXT-X-MEDIA:")).flatMap((line) => {
    const attrs = Object.fromEntries([...line.matchAll(/([A-Z-]+)=(?:"([^"]*)"|([^,]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    if (attrs.TYPE !== "SUBTITLES" || !attrs.URI) return [];
    const trackUrl = new URL(attrs.URI, url).href;
    if (!BiliCaptionPlatforms.cueUrl(trackUrl)) return [];
    return [{ lan: attrs.LANGUAGE || "und", lanDoc: attrs.NAME || attrs.LANGUAGE || "字幕", url: trackUrl, hls: true }];
  });
}

function xMediaUrl(raw) {
  try {
    const u = new URL(raw);
    return BiliCaptionPlatforms.cueUrl(raw) && u.hostname === "video.twimg.com";
  } catch {
    return false;
  }
}

function xPlaylistAttrs(line) {
  return Object.fromEntries([...String(line).replace(/^#EXT-X-[A-Z-]+:/, "").matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
}

function xManifestAudioTracks(text, url) {
  return String(text || "").split(/\r?\n/).filter((line) => line.startsWith("#EXT-X-MEDIA:")).flatMap((line) => {
    const attrs = xPlaylistAttrs(line);
    if (attrs.TYPE !== "AUDIO" || !attrs.URI) return [];
    const trackUrl = new URL(attrs.URI, url).href;
    if (!xMediaUrl(trackUrl)) return [];
    return [{
      groupId: attrs["GROUP-ID"] || "",
      name: attrs.NAME || attrs.LANGUAGE || "audio",
      language: attrs.LANGUAGE || "",
      defaulted: /^(YES|TRUE)$/i.test(attrs.DEFAULT || ""),
      bitrate: Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH) || 0,
      url: trackUrl
    }];
  });
}

/** X 的音轨码率写在地址（/mp4a/32000/）或分组名（audio-32000）里 */
function xAudioBitrate(track) {
  const direct = Number(track?.bitrate) || 0;
  if (direct > 0) return direct;
  const fromUrl = String(track?.url || "").match(/\/mp4a\/(\d{4,7})\//)?.[1];
  const fromGroup = String(track?.groupId || "").match(/(\d{4,7})/)?.[1];
  return Number(fromUrl || fromGroup) || 0;
}

/** 选最低码率的音轨：转写不需要高音质，体积小下载快、分片少 */
function pickXAudioTrack(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) {
    throw new Error("该视频没有独立音轨，暂不支持无字幕转写");
  }
  const known = tracks
    .filter((item) => xAudioBitrate(item) > 0)
    .sort((a, b) => xAudioBitrate(a) - xAudioBitrate(b));
  return known[0] || tracks.find((item) => item.defaulted) || tracks[0];
}

function parseXAudioPlaylist(text, url) {
  const raw = String(text || "");
  if (!raw.includes("#EXT-X-ENDLIST")) throw new Error("暂不支持直播或 Twitter Spaces 音频转写");
  let mapUrl = "";
  let pendingDur = 0;
  let duration = 0;
  const segmentUrls = [];
  for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = xPlaylistAttrs(line);
      if (attrs.BYTERANGE) throw new Error("音频清单使用按字节范围的初始化片段，暂不支持该封装");
      if (!attrs.URI) continue;
      mapUrl = new URL(attrs.URI, url).href;
      if (!xMediaUrl(mapUrl)) throw new Error("音频地址不在允许的域名内");
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDur = Number(line.slice(8).split(",")[0]) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    const segUrl = new URL(line, url).href;
    if (!xMediaUrl(segUrl)) throw new Error("音频地址不在允许的域名内");
    if (/\.ts(?:\?|$)/i.test(segUrl)) throw new Error("该视频音视频封装在一起（MPEG-TS），暂不支持无字幕转写");
    segmentUrls.push(segUrl);
    duration += pendingDur;
    pendingDur = 0;
  }
  if (!mapUrl) throw new Error("音频清单缺少初始化片段（EXT-X-MAP），暂不支持该封装");
  if (!segmentUrls.length) throw new Error("音频清单没有分片");
  if (segmentUrls.length > 8000) throw new Error("音频分片数量异常");
  return { mapUrl, segmentUrls, duration };
}

function xExpiredError(status, label) {
  const error = status === 403 || status === 404 || status === 410
    ? new Error(`X ${label}已过期（${status}），请回到该帖播放一次视频后再生成`)
    : new Error(`X ${label}请求失败（${status}）`);
  error.status = status;
  return error;
}

async function fetchXUrl(url, label = "音频") {
  if (!xMediaUrl(url)) throw new Error(`${label}地址不在允许的域名内`);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!res.ok) throw xExpiredError(res.status, label);
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error(`${label}文件过大`);
  return text;
}

async function fetchXBytes(url, signal, label = "音频分片") {
  if (!xMediaUrl(url)) throw new Error(`${label}地址不在允许的域名内`);
  // 带上任务的取消信号，同时单片最多等 30 秒，卡住的分片交给上层重试
  const timed = abortAfter(signal, 30 * 1000);
  try {
    const res = await fetch(url, { signal: timed.signal, redirect: "error" });
    if (!res.ok) throw xExpiredError(res.status, label);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw downloadTooLarge(buf.byteLength);
    return buf;
  } catch (error) {
    if (error?.name === "AbortError" && !signal?.aborted) {
      throw new Error(`X ${label}下载超时`);
    }
    throw error;
  } finally {
    timed.cleanup();
  }
}

async function lookupXManifest(tabId, mediaId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return "";
  if (/^\d+$/.test(mediaId || "")) {
    const key = `xManifest:${tabId}:${mediaId}`;
    const stored = await chrome.storage.session?.get(key);
    return xManifestUrls.get(key) || stored?.[key] || "";
  }
  const prefix = `xManifest:${tabId}:`;
  const live = [...xManifestUrls.entries()].filter(([key]) => key.startsWith(prefix));
  return live.length === 1 ? live[0][1] : "";
}

async function fetchXPlayurl(meta) {
  const tabId = Number(meta.tabId) || 0;
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("找不到视频标签页，请在 X 视频页打开侧栏后再生成");
  }
  const parsed = BiliCaptionPlatforms.parse(BiliCaptionPlatforms.videoUrl(meta.bvid));
  if (parsed?.kind !== "x") throw new Error("视频编号无效");
  const data = await readPlatformPage({ ...parsed, bvid: meta.bvid, mediaIndex: parsed.mediaIndex }, tabId);
  const mediaId = /^\d+$/.test(data.mediaId || "") ? data.mediaId : "";
  const masterUrl = await lookupXManifest(tabId, mediaId);
  if (!masterUrl) {
    throw new Error("尚未捕获 X 音频地址，请先在该帖播放视频后再点生成");
  }
  const master = await fetchXUrl(masterUrl, "音频清单");
  const audio = pickXAudioTrack(xManifestAudioTracks(master, masterUrl));
  const duration = Number(data.duration) || Number(meta.duration) || 0;
  return {
    timelength: duration > 0 ? duration * 1000 : 0,
    xAudio: {
      kind: "x-hls",
      tabId,
      mediaId: mediaId || "",
      masterUrl,
      audioUrl: audio.url,
      duration
    }
  };
}

async function loadXAudioParts(stream) {
  const tabId = Number(stream.tabId) || 0;
  const masterUrl = (await lookupXManifest(tabId, stream.mediaId)) || stream.masterUrl || "";
  if (!masterUrl) throw new Error("尚未捕获 X 音频地址，请先在该帖播放视频后再点生成");
  const master = await fetchXUrl(masterUrl, "音频清单");
  const audio = pickXAudioTrack(xManifestAudioTracks(master, masterUrl));
  const parsed = parseXAudioPlaylist(await fetchXUrl(audio.url, "音频清单"), audio.url);
  return [parsed.mapUrl, ...parsed.segmentUrls];
}

/**
 * X 的 HLS 音频逐片下载，对上层表现为一条连续字节流。单片失败退避重试；
 * 地址失效（403/404/410）时重新读取清单，分片数不变就从同一片接着下。
 */
async function openXAudioDownload(stream, signal, options = {}) {
  let parts = await loadXAudioParts(stream);
  let pos = 0;
  let received = 0;
  let refreshes = 0;
  const reader = {
    async read() {
      for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(signal);
        if (pos >= parts.length) return { done: true, value: undefined };
        try {
          const buf = await fetchXBytes(parts[pos], signal);
          pos += 1;
          received += buf.byteLength;
          if (received > MAX_DOWNLOAD_BYTES) throw downloadTooLarge(received);
          return { done: false, value: new Uint8Array(buf) };
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted || error?.fatal) throw error;
          if ([403, 404, 410].includes(Number(error?.status)) && refreshes < ASR_URL_REFRESHES) {
            refreshes += 1;
            appLog("warn", "x", `X 音频地址失效，重新读取清单（第 ${refreshes} 次）`);
            const next = await loadXAudioParts(stream);
            if (next.length !== parts.length) {
              throw new Error("X 音频清单已变化，无法接着下载。已保存进度，可点「生成字幕」继续");
            }
            parts = next;
            continue;
          }
          if (attempt >= 3) throw error;
          options.onReconnect?.(attempt + 1, received, 0);
          await sleep(1000 * 2 ** attempt, signal);
        }
      }
    },
    async cancel() {
      pos = parts.length;
    },
    releaseLock() {}
  };
  return { reader, total: 0, mime: "audio/mp4" };
}

async function readXTracks(data, tabId, page = {}) {
  if (!/^\d+$/.test(data.mediaId || "")) return data;
  const key = `xManifest:${tabId}:${data.mediaId}`;
  const stored = await chrome.storage.session?.get(key);
  const url = xManifestUrls.get(key) || stored?.[key];
  if (!url) {
    data.subtitleError = "尚未捕获该帖视频信息，请先播放视频后再刷新字幕或生成";
    // 播放后清单一到就通知页面自动重读一次，不用用户手动刷新
    await markXManifestWaiter(tabId, data.mediaId, page.bvid || "");
    return data;
  }
  const tracks = xManifestTracks(await fetchXText(url), url);
  // HLS 全量字幕优先于 textTracks 内仅有的已播放片段。
  if (tracks.length) data.tracks = tracks;
  return data;
}

// 小并发拉取，结果按原顺序返回。
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

const X_CUE_SEGMENT_CONCURRENCY = 4;

async function fetchXTrackCues(track) {
  const text = await fetchXText(track.url);
  if (!track.hls) return BiliCaptionPlatforms.parseCues(text);
  if (!text.includes("#EXT-X-ENDLIST")) throw new Error("暂不支持直播字幕");
  const segments = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  if (!segments.length || segments.length > 120) throw new Error("字幕分片数量异常");
  // 先校验全部分片地址再发请求，跨域分片直接整体拒绝
  const urls = segments.map((segment) => new URL(segment, track.url).href);
  for (const url of urls) {
    if (!BiliCaptionPlatforms.cueUrl(url) || new URL(url).hostname !== "video.twimg.com") {
      throw new Error("字幕地址不在允许的域名内");
    }
  }
  const raws = await mapLimit(urls, X_CUE_SEGMENT_CONCURRENCY, (url) => fetchXText(url));
  const cues = [], seen = new Set();
  for (const raw of raws) {
    for (const cue of BiliCaptionPlatforms.parseCues(raw)) {
      const key = `${cue.from}:${cue.to}:${cue.content}`;
      if (!seen.has(key)) { seen.add(key); cues.push(cue); }
    }
  }
  return cues.sort((a, b) => a.from - b.from).map((cue, i) => ({ ...cue, sid: i + 1 }));
}

async function readPlatformPage(page, tabId, trackUrl = "") {
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("找不到视频标签页");
  const tab = await chrome.tabs.get(tabId);
  const actual = BiliCaptionPlatforms.parse(tab.url);
  if (!actual || actual.kind !== page.kind || actual.videoId !== page.videoId) throw new Error("视频页面已切换");
  if (page.kind === "x" && (!/^[1-4]$/.test(String(page.mediaIndex)) || page.bvid !== `x_${actual.videoId}_${page.mediaIndex}`)) throw new Error("视频编号无效");
  if (page.kind === "youtube" && page.bvid !== actual.bvid) throw new Error("视频编号无效");
  let loadedUrl = "";
  if (page.kind === "youtube" && trackUrl) {
    if (!BiliCaptionPlatforms.cueUrl(trackUrl)) throw new Error("字幕地址不在允许的域名内");
    const url = new URL(trackUrl);
    const key = `ytCue:${tabId}:${page.videoId}:${url.searchParams.get("lang")}:${url.searchParams.get("kind") || ""}:${url.searchParams.get("tlang") || ""}`;
    const originalKey = key.slice(0, key.lastIndexOf(":")) + ":";
    const stored = await chrome.storage.session?.get([key, originalKey]);
    loadedUrl = youtubeCueUrls.get(key) || stored?.[key] || youtubeCueUrls.get(originalKey) || stored?.[originalKey] || "";
  }
  const waitMs = 2500;
  let timer = 0;
  let results;
  try {
    results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: BiliCaptionPlatforms.readPage,
        args: [page, trackUrl, loadedUrl, waitMs]
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("视频信息尚未就绪，请稍后刷新字幕")),
          trackUrl ? 14000 : waitMs + 2500
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const injected = results?.[0];
  if (injected?.error) throw new Error(injected.error.message || String(injected.error));
  const data = injected?.result;
  if (!data) throw new Error("视频信息尚未就绪，请稍后刷新字幕");
  if (data.pending) throw new Error(data.notice || "视频信息尚未就绪，请稍后刷新字幕");
  if (data.error && data.raw == null && !data.tracks) throw new Error(data.error);
  if (page.kind === "x") {
    shapeXPageTitle(data);
    try { return await readXTracks(data, tabId, page); }
    catch (error) { return { ...data, subtitleError: error.message || String(error) }; }
  }
  return data;
}

// 页面里只回原始正文 / 作者 / 页面标题（注入函数没有闭包，用不了 xHeadline），在这里截成短标题。
function shapeXPageTitle(data) {
  if (!data || data.title != null) return data;
  if (data.xText == null && data.xAuthor == null && data.pageTitle == null) return data;
  const headline = BiliCaptionPlatforms.xHeadline({
    text: data.xText || "",
    author: data.xAuthor || "",
    pageTitle: data.pageTitle || ""
  });
  data.title = headline.title;
  data.titleFull = headline.titleFull;
  if (!data.up && data.xAuthor) data.up = data.xAuthor;
  delete data.xText;
  delete data.xAuthor;
  delete data.pageTitle;
  return data;
}

async function fetchPlatformTrack(message, tabId) {
  const page = message.page;
  if (page?.kind === "youtube") {
    const data = await readPlatformPage(page, tabId, message.url);
    const cues = BiliCaptionPlatforms.parseCues(data.raw);
    if (!cues.length) throw new Error("字幕轨未返回有效内容，请开启播放器字幕后重试");
    return cues;
  }
  if (page?.kind === "x") {
    const data = await readPlatformPage(page, tabId);
    const track = data.tracks?.find((t) => t.lan === message.lan && t.url === (message.url || ""));
    if (!track) throw new Error("字幕轨已失效，请刷新后重试");
    if (!BiliCaptionPlatforms.cueUrl(track.url)) throw new Error("字幕尚未加载，请刷新视频页面后重试");
    const cues = await fetchXTrackCues(track);
    if (!cues.length) throw new Error("字幕尚未加载，请开启播放器字幕后刷新");
    return cues;
  }
  return fetchCues(message.url);
}
