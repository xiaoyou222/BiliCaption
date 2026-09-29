// 后台 · B 站接口：登录状态、视频 / 番剧信息、字幕轨列表与字幕文件。

async function fetchJson(url, options = {}) {
  const { headers, ...rest } = options;
  const res = await fetch(url, {
    ...rest,
    credentials: rest.credentials || "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(headers || {})
    }
  });
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${redactUrl(url)}`);
  return res.json();
}

// 错误信息会进日志：去掉查询参数（WBI 签名、字幕地址里的 auth_key 等），只留来源和路径。
function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || "").split(/[?#]/)[0].slice(0, 200);
  }
}

function normalizeSubtitleUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

// B 站登录状态短时缓存：已登录的结果 10 分钟内复用，字幕走本地缓存时不再固定打一次 nav。
// 未登录和出错不缓存，用户刚登录完马上就能看到变化。存 session，service worker 重启也还在。
const BILI_LOGIN_KEY = "biliLoginCache";
const BILI_LOGIN_TTL_MS = 10 * 60 * 1000;
let biliLoginCache = null;

async function rememberBiliLogin(login) {
  if (!login?.isLogin || login.error) {
    biliLoginCache = null;
    await chrome.storage.session?.remove?.(BILI_LOGIN_KEY)?.catch?.(() => {});
    return;
  }
  biliLoginCache = { at: Date.now(), login };
  await chrome.storage.session?.set?.({ [BILI_LOGIN_KEY]: biliLoginCache })?.catch?.(() => {});
}

async function loadBiliLogin() {
  let hit = biliLoginCache;
  if (!hit) {
    try {
      hit = (await chrome.storage.session?.get?.(BILI_LOGIN_KEY))?.[BILI_LOGIN_KEY] || null;
    } catch {
      hit = null;
    }
  }
  if (hit?.login?.isLogin && Date.now() - (Number(hit.at) || 0) < BILI_LOGIN_TTL_MS) {
    biliLoginCache = hit;
    return hit.login;
  }
  return fetchLoginStatus();
}

async function fetchLoginStatus() {
  try {
    const json = await fetchJson("https://api.bilibili.com/x/web-interface/nav");
    const data = json.data || {};
    const isLogin = Boolean(data.isLogin);
    // nav 同时带了 WBI 密钥，顺手喂给签名模块，省掉 fetchPlayer 里再打一次 nav。
    self.BiliCaptionWbi?.primeKeys?.(data.wbi_img);
    const login = {
      isLogin,
      mid: data.mid || 0,
      uname: data.uname || "",
      face: data.face || "",
      level: data.level_info?.current_level ?? null,
      vipDueDate: data.vipDueDate || 0,
      vipStatus: data.vipStatus || 0,
      vipType: data.vipType || 0,
      error: ""
    };
    await rememberBiliLogin(login);
    return login;
  } catch (error) {
    await rememberBiliLogin(null);
    return {
      isLogin: false,
      mid: 0,
      uname: "",
      face: "",
      level: null,
      vipDueDate: 0,
      vipStatus: 0,
      vipType: 0,
      error: error.message || String(error)
    };
  }
}

async function fetchView(bvid) {
  const json = await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  );
  if (json.code !== 0) throw new Error(json.message || "获取视频信息失败");
  return json.data;
}

// 视频的互动数据：只留判断「值不值得看」要用的几项，随字幕状态带给侧栏，不为此单独请求。
function pickViewStat(stat) {
  if (!stat || typeof stat !== "object") return null;
  const out = {};
  for (const key of ["view", "like", "coin", "favorite", "reply", "share", "danmaku"]) {
    const n = Number(stat[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out.view > 0 ? out : null;
}

// ---- 热评：生成大纲时取一次，只作「值不值得看」的修正参考 ----
// 不登录也能取；最多 2 页（每页 20 条）、留 40 条，每条截到 150 字，按赞数排序。
// 失败或超过 5 秒就当没有评论，不影响大纲生成。
const HOT_COMMENT_PAGES = 2;
const HOT_COMMENT_MAX = 40;
const HOT_COMMENT_CHARS = 150;
const HOT_COMMENT_TIMEOUT_MS = 5000;

function clipCommentText(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > HOT_COMMENT_CHARS ? `${chars.slice(0, HOT_COMMENT_CHARS).join("")}…` : flat;
}

/** 接口返回的 replies → [{ message, like }]：去重、去空、按赞数降序、截断 */
function normalizeHotComments(replies) {
  const seen = new Set();
  const out = [];
  for (const reply of replies || []) {
    const id = reply?.rpid ?? reply?.rpid_str;
    if (id != null) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
    }
    const message = clipCommentText(reply?.content?.message);
    if (!message) continue;
    out.push({ message, like: Math.max(0, Number(reply?.like) || 0) });
  }
  return out.sort((a, b) => b.like - a.like).slice(0, HOT_COMMENT_MAX);
}

async function fetchHotComments(aid, { timeoutMs = HOT_COMMENT_TIMEOUT_MS } = {}) {
  const oid = Number(aid) || 0;
  if (!oid) return { comments: [] };
  const replies = [];
  const ac = new AbortController();
  let timer = 0;
  const work = (async () => {
    let next = "";
    for (let page = 0; page < HOT_COMMENT_PAGES; page += 1) {
      const params = { oid, type: 1, mode: 3, plat: 1, web_location: 1315875 };
      if (page > 0) params.next = next;
      const query = await BiliCaptionWbi.signQuery(params);
      if (ac.signal.aborted) return;
      const json = await fetchJson(`https://api.bilibili.com/x/v2/reply/wbi/main?${query}`, { signal: ac.signal });
      if (json?.code !== 0) throw new Error(json?.message || `评论接口返回 ${json?.code}`);
      replies.push(...(json.data?.replies || []));
      const cursor = json.data?.cursor || {};
      next = cursor.next;
      if (cursor.is_end || next == null || next === "" || replies.length >= HOT_COMMENT_MAX) return;
    }
  })();
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve("timeout");
    }, Math.max(0, Number(timeoutMs) || 0));
  });
  try {
    await Promise.race([work, timeout]);
  } catch (error) {
    console.warn("[BiliCaption] hot comments failed", error?.message || error);
  } finally {
    clearTimeout(timer);
    ac.abort();
    work.catch(() => {});
  }
  // 第二页失败或超时时，第一页拿到的照样用
  return { comments: normalizeHotComments(replies) };
}

function collectBangumiEpisodes(result) {
  const list = [];
  const push = (item) => {
    if (item && (item.cid || item.aid || item.bvid)) list.push(item);
  };
  (result?.episodes || []).forEach(push);
  for (const section of result?.section || []) {
    (section.episodes || []).forEach(push);
  }
  return list;
}

function pickBangumiEpisode(result, hint = {}) {
  const all = collectBangumiEpisodes(result);
  if (!all.length) return null;
  const epId = hint.epId || hint.ep_id;
  if (epId) {
    return all.find((item) => String(item.ep_id || item.id) === String(epId)) || null;
  }
  if (hint.cid) {
    return all.find((item) => Number(item.cid) === Number(hint.cid)) || null;
  }
  const last = result?.user_status?.progress?.last_ep_id;
  if (last) {
    return all.find((item) => String(item.ep_id || item.id) === String(last)) || null;
  }
  return null;
}

async function fetchBangumi(input) {
  const epId = typeof input === "object" ? input.epId : input;
  const seasonId = typeof input === "object" ? input.seasonId : "";
  const cid = typeof input === "object" ? input.cid : 0;
  if (!epId && !seasonId) throw new Error("找不到该分集");
  const url = epId
    ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(epId)}`
    : `https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`;
  const json = await fetchJson(url);
  const result = json.result || json.data;
  if (!result) throw new Error(json.message || "获取番剧信息失败");
  const ep = pickBangumiEpisode(result, { epId, cid });
  if (!ep) throw new Error("找不到该分集，请从具体一集进入");
  return {
    title: result.title || "",
    part: ep.long_title || ep.title || "",
    aid: ep.aid,
    cid: ep.cid,
    bvid: ep.bvid || "",
    // pgc 接口的 duration 是毫秒，其余地方都按秒
    duration: Number(ep.duration) > 0 ? Number(ep.duration) / 1000 : 0,
    epId: String(ep.ep_id || ep.id || epId || ""),
    pic: ep.cover || result.cover || "",
    up: result.subtitle || result.title || ""
  };
}

async function fetchPlayer(aid, cid) {
  try {
    const query = await BiliCaptionWbi.signQuery({ aid, cid });
    const json = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?${query}`);
    if (json.code === 0 && json.data) return json.data;
  } catch (error) {
    console.warn("[BiliCaption] wbi player failed", error);
  }
  const json = await fetchJson(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`);
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || "获取播放器信息失败，请先登录 B 站");
  }
  return json.data;
}

async function fetchDmView(aid, cid) {
  // fetch 不能自设 Referer（禁用请求头），改 Referer 的 DNR 规则也不覆盖 api.bilibili.com，所以不带。
  const json = await fetchJson(
    `https://api.bilibili.com/x/v2/dm/view?type=1&oid=${Number(cid) || 0}&pid=${Number(aid) || 0}`,
    { headers: { Accept: "application/json" } }
  );
  if (json.code != null && json.code !== 0) {
    throw new Error(json.message || "获取字幕列表失败");
  }
  return json.data || json.result || json;
}

function mapSubtitleTracks(source) {
  const raw = source?.subtitle?.subtitles || source?.subtitles || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      lan: item.lan || "",
      lanDoc: item.lan_doc || item.lan || "字幕",
      url: item.subtitle_url || "",
      aiType: item.ai_type,
      aiStatus: item.ai_status
    }))
    .filter((item) => item.url);
}

function isAllowedCueHost(url) {
  try {
    const parsed = new URL(normalizeSubtitleUrl(url));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "bilibili.com"
      || host.endsWith(".bilibili.com")
      || host === "hdslb.com"
      || host.endsWith(".hdslb.com")
      || host === "bilivideo.com"
      || host.endsWith(".bilivideo.com")
      || host.endsWith(".akamaized.net")
    );
  } catch {
    return false;
  }
}

async function fetchCues(url) {
  if (!isAllowedCueHost(url)) throw new Error("字幕地址不在允许的域名内");
  const json = await fetchJson(normalizeSubtitleUrl(url));
  const body = Array.isArray(json?.body) ? json.body : [];
  return refineCues(body
    .map((item, index) => ({
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content: String(item.content || "").replace(/\s+/g, " ").trim(),
      sid: item.sid || index + 1
    }))
    .filter((item) => item.content));
}

function pickDefaultTrack(tracks) {
  const zhAi = tracks.find((t) => t.lan === "ai-zh" || /中文.*自动/.test(t.lanDoc));
  if (zhAi) return zhAi;
  const zh = tracks.find((t) => /zh/.test(t.lan) && !/en/.test(t.lan));
  if (zh) return zh;
  return tracks[0] || null;
}

// B 站 AI 字幕偶尔会给成别的视频的：最后一句比视频还长出 10% 以上就不可信。
// 另留 3 秒余量，免得几秒长的短视频因为字幕多挂了一两秒被误判。
function cuesExceedDuration(cues, duration) {
  const total = Number(duration) || 0;
  if (!(total > 0) || !cues?.length) return false;
  const lastTo = maxCueField(cues);
  return lastTo > total * 1.1 && lastTo - total > 3;
}

// 首选轨下载失败或与视频时长对不上时，依次换其它轨，不整个报错。
async function pickBiliTrackCues(tracks, duration) {
  const preferred = pickDefaultTrack(tracks);
  const order = [preferred, ...tracks.filter((t) => t !== preferred)].filter((t) => t?.url);
  const tried = new Set();
  let error = "";
  let mismatch = false;
  for (const track of order) {
    if (tried.has(track.url)) continue;
    tried.add(track.url);
    try {
      const cues = await fetchCues(track.url);
      if (!cues.length) continue;
      if (cuesExceedDuration(cues, duration)) {
        mismatch = true;
        appLog("warn", "sub", `字幕轨 ${track.lan || "?"} 的时长超出视频 10% 以上，已跳过`, { cues: cues.length });
        continue;
      }
      return { cues, track, error: "", mismatch: false };
    } catch (e) {
      error = e.message || String(e);
      appLog("warn", "sub", `字幕轨 ${track.lan || "?"} 下载失败：${error}`);
    }
  }
  return { cues: [], track: null, error, mismatch };
}

// ss 链接的当前集：executeScript 到页面 MAIN world 读播放器，读不到就返回 null。
async function readBangumiEpisode(page, tabId) {
  if (!page?.seasonId || !Number.isInteger(tabId) || tabId <= 0) return null;
  // 内容脚本在 document_idle 就来要字幕，番剧播放器可能还没初始化完，多等一会儿
  const waitMs = 6000;
  let timer = 0;
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: BiliCaptionPlatforms.readBangumiPage,
        args: [String(page.seasonId), waitMs]
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs + 2000);
      })
    ]);
    const data = results?.[0]?.result;
    if (!data || data.pending || data.error) return null;
    if (!data.epId && !data.cid) return null;
    return { epId: String(data.epId || ""), cid: Number(data.cid) || 0 };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
