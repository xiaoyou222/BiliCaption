// 后台 · 音频下载：取播放地址、选音轨，打开可断点续传的音频字节流（B 站 CDN；X 走 HLS 分片）。

// 整条音轨的下载上限，超过就不转写
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
// 下载断开的重连次数、地址过期后重新获取播放地址的次数
const ASR_RECONNECTS = 5;
const ASR_URL_REFRESHES = 2;
// 连接迟迟不回响应头、或连上后长时间一个字节都不给（连接不断但卡住），超过这么久就断开重连。
// X 的 HLS 分片是单片 30 秒上限；B 站这里是整条流，按两次数据之间的空闲时间算。
const ASR_STALL_MS = 45 * 1000;

async function fetchPlayurl(meta) {
  if (/^x_\d+_[1-4]$/.test(meta.bvid || "")) return fetchXPlayurl(meta);
  const params = {
    bvid: meta.bvid || undefined,
    avid: meta.aid,
    cid: meta.cid,
    qn: 0,
    fnval: 16,
    fourk: 1
  };
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  try {
    const query = await BiliCaptionWbi.signQuery(clean);
    const json = await fetchJson(`https://api.bilibili.com/x/player/wbi/playurl?${query}`);
    if (json.code === 0 && json.data) return json.data;
  } catch (error) {
    console.warn("[BiliCaption] wbi playurl failed", error);
    appLog("warn", "bili", `WBI playurl 失败，改走普通接口：${error.message || error}`);
  }
  const qs = new URLSearchParams({
    avid: String(meta.aid),
    cid: String(meta.cid),
    qn: "0",
    fnval: "16",
    fourk: "1"
  });
  if (meta.bvid) qs.set("bvid", meta.bvid);
  const json = await fetchJson(`https://api.bilibili.com/x/player/playurl?${qs}`);
  if (json.code !== 0 || !json.data) {
    const msg = json.message || "获取音频地址失败，请确认已登录且能正常播放";
    appLog("error", "bili", msg, { status: json.code });
    throw new Error(msg);
  }
  return json.data;
}

function pickAudioStream(playurl, { sameAs } = {}) {
  if (playurl?.xAudio?.kind === "x-hls") return playurl.xAudio;
  const audios = playurl?.dash?.audio;
  if (!Array.isArray(audios) || !audios.length) {
    throw new Error("没有找到可下载的音频流（可能是大会员/地区限制）");
  }
  if (sameAs && sameAs.id != null) {
    // 刷新地址后续传必须是同一条音轨，字节偏移才对得上
    const same = audios.find((item) => item.id === sameAs.id);
    if (same) return same;
    throw new Error("刷新播放地址后音轨变了，无法接着下载。已保存进度，可点「生成字幕」继续");
  }
  const sorted = [...audios].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  // 优先较低码率：体积小、分片少
  return sorted[0];
}

function audioUrls(stream) {
  const urls = [];
  const push = (value) => {
    if (typeof value === "string" && value && !urls.includes(value)) urls.push(value);
  };
  push(stream.baseUrl || stream.base_url || stream.url);
  const backups = stream.backupUrl || stream.backup_url || [];
  if (Array.isArray(backups)) backups.forEach(push);
  else push(backups);
  return urls;
}

/** B 站音频地址带 deadline（秒级时间戳），过期后 CDN 返回 403 */
function audioUrlExpired(url, slackMs = 30 * 1000) {
  try {
    const deadline = Number(new URL(url).searchParams.get("deadline")) || 0;
    return deadline > 0 && deadline * 1000 < Date.now() + slackMs;
  } catch {
    return false;
  }
}

async function fetchAudio(url, signal, offset = 0) {
  const headers = { Referer: "https://www.bilibili.com/" };
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  // 请求用自己的控制器：跟随任务取消，另外响应头超时未到也断开。
  // 响应头到了只清计时器、不解除跟随，之后取消任务仍能中断正在读的响应体。
  const ctrl = new AbortController();
  const follow = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener?.("abort", follow, { once: true });
  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    ctrl.abort();
  }, ASR_STALL_MS);
  try {
    return await fetch(url, { credentials: "include", signal: ctrl.signal, headers });
  } catch (error) {
    signal?.removeEventListener?.("abort", follow);
    if (stalled && !signal?.aborted) throw new Error(`音频地址 ${Math.round(ASR_STALL_MS / 1000)} 秒没有响应`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 读一段数据，超过 ASR_STALL_MS 没有新数据就返回 null（由调用方断开重连） */
function readWithStallTimeout(body) {
  let timer = 0;
  const stall = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ASR_STALL_MS);
  });
  // race 会给两边都挂上处理，卡住的那次 read 之后再报错也不会变成未处理的拒绝
  return Promise.race([body.read(), stall]).finally(() => clearTimeout(timer));
}

function contentRangeStart(res) {
  const m = String(res?.headers?.get?.("content-range") || "").match(/bytes\s+(\d+)-/i);
  return m ? Number(m[1]) : -1;
}

function downloadTooLarge(bytes) {
  const error = new Error(`音频约 ${mbOf(bytes)}MB，文件过大，请换更短视频`);
  error.fatal = true;
  return error;
}

function dropResponse(res) {
  try {
    res?.body?.cancel?.()?.catch?.(() => {});
  } catch {
    // ignore
  }
}

/** 依次试主地址和备用地址，返回第一个能用的响应；expired 表示地址过期、值得重新获取 */
async function connectAudioUrls(urls, signal, offset = 0) {
  let lastStatus = 0;
  let expired = false;
  for (const url of urls) {
    throwIfAborted(signal);
    const host = hostOf(url);
    if (audioUrlExpired(url)) {
      expired = true;
      continue;
    }
    let res;
    try {
      res = await fetchAudio(url, signal, offset);
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      appLog("warn", "bili", `音频连接失败 ${host || ""}：${error.message || error}`, { host });
      continue;
    }
    lastStatus = res.status;
    if (res.ok) return { res, lastStatus, expired, host };
    if ([403, 404, 410].includes(res.status)) expired = true;
    appLog("warn", "bili", `音频地址 HTTP ${res.status} ${host}`, { status: res.status, host });
    dropResponse(res);
  }
  return { res: null, lastStatus, expired };
}

function bufferReader(buffer) {
  let sent = false;
  return {
    async read() {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value: new Uint8Array(buffer) };
    },
    async cancel() {
      sent = true;
    }
  };
}

/**
 * 下载统计（options.stats）：开始、完成不再各记一条日志，由转写任务结束时的汇总带上。
 * 同一个对象可以跨两次下载（边下边切失败后整段重下）累计续传、刷新次数；bytes 是最近这次下载收到的字节。
 */
function audioDownloadStats(options = {}) {
  const stats = options.stats && typeof options.stats === "object" ? options.stats : {};
  stats.host = stats.host || "";
  stats.bytes = 0;
  stats.resumes = Number(stats.resumes) || 0;
  stats.refreshes = Number(stats.refreshes) || 0;
  return stats;
}

/**
 * 打开可自动续传的音频字节流，对上层表现为一条连续不断的流：
 * - 连接断开或 CDN 提前结束时，按已收字节用 Range 续传；服务器不认 Range 就从头下、丢掉已收部分；
 * - 地址过期（403/404/410 或 deadline 已过）时调用 options.refresh 重新获取播放地址再接着下；
 * - 重连有次数上限，两次断开之间下了足够多的数据会重新计数。
 */
async function openAudioDownload(stream, signal, options = {}) {
  if (stream?.kind === "x-hls") return openXAudioDownload(stream, signal, options);
  const stats = audioDownloadStats(options);
  let current = stream;
  let refreshes = 0;
  let reconnects = 0;
  let reconnectAt = 0;
  let total = 0;
  let received = 0;
  let skip = 0;
  let body = null;
  let closed = false;

  const refresh = async () => {
    if (typeof options.refresh !== "function" || refreshes >= ASR_URL_REFRESHES) return false;
    refreshes += 1;
    stats.refreshes += 1;
    appLog("warn", "bili", `音频地址已过期，重新获取播放地址（第 ${refreshes} 次）`);
    current = await options.refresh(current);
    return true;
  };

  const connect = async () => {
    for (;;) {
      const urls = audioUrls(current);
      if (!urls.length) throw new Error("音频地址为空");
      const { res, lastStatus, expired, host } = await connectAudioUrls(urls, signal, received);
      if (!res) {
        if (expired && await refresh()) continue;
        const error = new Error(`音频下载失败 ${lastStatus || ""}`.trim());
        error.status = lastStatus;
        throw error;
      }
      stats.host = host || stats.host;
      if (received) {
        stats.resumes += 1;
        appLog("warn", "bili", `从 ${mbOf(received)}MB 处续传音频 ${host}`, { status: res.status, host, mb: mbOf(received) });
      }
      if (!received) {
        total = Number(res.headers.get("content-length") || 0);
        if (total > MAX_DOWNLOAD_BYTES) {
          dropResponse(res);
          throw downloadTooLarge(total);
        }
        skip = 0;
      } else if (res.status === 206) {
        const at = contentRangeStart(res);
        if (at < 0 || at > received) {
          dropResponse(res);
          const error = new Error("续传位置对不上，已保存进度，可点「生成字幕」继续");
          error.fatal = true;
          throw error;
        }
        skip = received - at;
      } else {
        // 服务器不认 Range，只能从头下，已收过的部分读到就丢
        skip = received;
      }
      body = res.body ? res.body.getReader() : bufferReader(await res.arrayBuffer());
      return;
    }
  };

  const reconnect = async () => {
    let lastError = null;
    while (!body) {
      // 距上次重连又下了不少数据，说明连接本身没问题，重新计数
      if (received - reconnectAt > 8 * 1024 * 1024) reconnects = 0;
      reconnects += 1;
      reconnectAt = received;
      if (reconnects > ASR_RECONNECTS) {
        const error = new Error(
          `音频下载中断（${mbOf(received)}MB${total ? `/${mbOf(total)}MB` : ""}）${lastError ? `：${lastError.message || lastError}` : ""}。已保存进度，可点「生成字幕」继续`
        );
        error.fatal = true;
        throw error;
      }
      options.onReconnect?.(reconnects, received, total);
      await sleep(Math.min(8000, 1000 * 2 ** (reconnects - 1)), signal);
      try {
        await connect();
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted || error?.fatal) throw error;
        lastError = error;
      }
    }
  };

  await connect();

  const reader = {
    async read() {
      for (;;) {
        throwIfAborted(signal);
        if (closed) return { done: true, value: undefined };
        if (!body) await reconnect();
        let piece;
        try {
          piece = await readWithStallTimeout(body);
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) throw error;
          appLog("warn", "bili", `音频流读取中断：${error.message || error}`, { mb: mbOf(received) });
          body = null;
          continue;
        }
        if (!piece) {
          // 连接没断但一直不给数据：取消这条连接，按已收字节 Range 续传
          throwIfAborted(signal);
          appLog("warn", "bili", `音频流 ${Math.round(ASR_STALL_MS / 1000)} 秒没有新数据，断开重连`, { mb: mbOf(received) });
          const stuck = body;
          body = null;
          try {
            stuck?.cancel?.()?.catch?.(() => {});
          } catch {
            // ignore
          }
          continue;
        }
        if (piece.done) {
          body = null;
          // CDN 可能干净地提前断流（done 但字节没收全），不续传就会少掉后半段字幕
          if (total > 0 && received < total) {
            appLog("warn", "bili", `音频流提前结束 ${mbOf(received)}/${mbOf(total)}MB，续传`);
            continue;
          }
          closed = true;
          return { done: true, value: undefined };
        }
        let value = piece.value;
        if (!value?.byteLength) continue;
        if (skip > 0) {
          if (value.byteLength <= skip) {
            skip -= value.byteLength;
            continue;
          }
          value = value.subarray(skip);
          skip = 0;
        }
        received += value.byteLength;
        stats.bytes = received;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw downloadTooLarge(received);
        }
        return { done: false, value };
      }
    },
    async cancel() {
      closed = true;
      const live = body;
      body = null;
      try {
        await live?.cancel();
      } catch {
        // ignore
      }
    },
    releaseLock() {}
  };
  return {
    reader,
    total,
    mime: stream.mimeType || stream.mime_type || "audio/mp4"
  };
}

/** 整段下载（边下边切失败时的兜底），同样走可续传的字节流 */
async function downloadAudio(stream, onProgress, signal, options = {}) {
  onProgress?.("正在下载音频…");
  const { reader, total, mime } = await openAudioDownload(stream, signal, options);
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onProgress?.(total
      ? `正在下载音频… ${Math.min(99, Math.round((received / total) * 100))}%`
      : `正在下载音频… ${mbOf(received)}MB`);
  }
  return new Blob(parts, { type: mime });
}
