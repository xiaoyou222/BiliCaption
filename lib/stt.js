(function (global) {
  const P = () => global.BiliCaptionProviders;

  /** Retry-After 头：秒数或 HTTP 日期，统一换算成毫秒 */
  function parseRetryAfterMs(value) {
    if (value == null || value === "") return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 7 * 24 * 3600) * 1000;
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  /** Groq 的时长写法：2m59.56s / 7.66s / 120ms / 1h2m，换算成毫秒 */
  function parseDurationMs(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    let total = 0;
    let matched = false;
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
      matched = true;
      const n = Number(m[1]);
      if (m[2] === "ms") total += n;
      else if (m[2] === "s") total += n * 1000;
      else if (m[2] === "m") total += n * 60 * 1000;
      else total += n * 3600 * 1000;
    }
    if (!matched) {
      const seconds = Number(text);
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    }
    return Number.isFinite(total) ? total : 0;
  }

  function guessExt(mime) {
    const t = String(mime || "").toLowerCase();
    if (t.includes("aac")) return "aac";
    if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
    if (t.includes("wav")) return "wav";
    if (t.includes("webm")) return "webm";
    if (t.includes("ogg")) return "ogg";
    if (t.includes("flac")) return "flac";
    return "m4a";
  }

  /**
   * Groq 官方文档：响应头只有 x-ratelimit-*-requests（每日请求数 RPD）和 *-tokens（每分钟 token），
   * 没有「每小时音频秒数（ASH）」对应的头；ASH 只能从 429 文案里读。
   */
  function readRateLimit(headers) {
    const get = (name) => headers?.get?.(name);
    const remaining = get("x-ratelimit-remaining-requests");
    if (remaining == null || remaining === "") return null;
    return {
      remainingRequests: Number(remaining),
      limitRequests: Number(get("x-ratelimit-limit-requests")) || 0,
      resetRequestsMs: parseDurationMs(get("x-ratelimit-reset-requests"))
    };
  }

  function silentWav(durationMs = 1000, sampleRate = 16000) {
    const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000));
    const dataSize = samples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const ascii = (offset, value) => {
      for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, dataSize, true);
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function ensureOrigin(url) {
    P().assertSafeApiUrl(url);
    const origin = P().originOf(url);
    if (!origin || !chrome?.permissions?.request) return;
    try {
      await chrome.permissions.request({ origins: [origin] });
    } catch {
      // 用户拒绝时后续 fetch 会自己报错
    }
  }

  async function readJson(res) {
    const text = await res.text();
    try {
      return { json: JSON.parse(text), text };
    } catch {
      return { json: null, text };
    }
  }

  function asVerbose(text, duration = 0, segments) {
    const cues = Array.isArray(segments) ? segments : [];
    return {
      text: String(text || "").trim(),
      duration,
      segments: cues.length
        ? cues
        : (text ? [{ start: 0, end: duration || 0, text: String(text).trim() }] : [])
    };
  }

  function mapFishSegments(payload) {
    const segments = Array.isArray(payload?.segments) ? payload.segments : [];
    return segments.map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || "").trim()
    })).filter((s) => s.text);
  }

  /**
   * 统一的 HTTP 错误：status、retryAfter（毫秒）、code/type（如 OpenAI 的 insufficient_quota）
   * 都挂在 error 上，由后台按类别决定停用通道、冷却还是重试。
   */
  function throwHttpError(res, json, provider, text = "") {
    const detail = json?.error || json?.detail || null;
    const message = (typeof detail === "string" ? detail : detail?.message)
      || json?.message
      || (json ? "" : String(text || "").replace(/\s+/g, " ").trim().slice(0, 200))
      || `${provider} 错误 ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.retryAfter = parseRetryAfterMs(res.headers?.get?.("retry-after"));
    const code = detail?.code || detail?.status || json?.code;
    const type = detail?.type || json?.type;
    if (code) err.code = String(code);
    if (type) err.type = String(type);
    throw err;
  }

  async function postForm(url, init, provider) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const err = new Error(`连不上 ${provider}（${error?.message || "Failed to fetch"}）`);
      err.network = true;
      err.retryable = true;
      throw err;
    }
  }

  async function transcribeOpenAI(blob, cfg, extra = {}) {
    const url = `${cfg.base}/audio/transcriptions`;
    await ensureOrigin(url);
    const form = new FormData();
    const filename = extra.filename || `audio.${guessExt(blob.type)}`;
    form.append("file", blob, filename);
    form.append("model", cfg.model);
    // verbose_json 和时间戳按白名单发（2026-09 查证官方文档）：
    // - OpenAI：timestamp_granularities 只有 whisper-1 支持；gpt-4o(-mini)-transcribe 只支持 json，
    //   gpt-4o-transcribe-diarize 只支持 json / text / diarized_json；新的 gpt-transcribe 返回 JSON，
    //   迁移指南明确说不要假设 verbose_json 仍可用。
    //   https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
    //   https://developers.openai.com/api/docs/guides/speech-to-text
    //   https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe
    // - Groq：whisper-large-v3 / turbo 支持 verbose_json 和 segment / word 时间戳。
    //   https://console.groq.com/docs/speech-to-text
    // 所以只有 Groq 或模型名含 whisper 才发 verbose_json + 时间戳，其余一律 json（只拿纯文本）。
    const verbose = cfg.provider === "Groq" || /whisper/i.test(cfg.model || "");
    form.append("response_format", extra.responseFormat || (verbose ? "verbose_json" : "json"));
    form.append("temperature", "0");
    if (extra.language) form.append("language", extra.language);
    // 词级时间戳用于分片重叠区按中点裁剪
    if (verbose) {
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }
    const res = await postForm(url, {
      method: "POST",
      signal: extra.signal,
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form
    }, cfg.provider || "转写服务");
    const { json, text } = await readJson(res);
    if (!res.ok) throwHttpError(res, json, cfg.provider, text);
    const rateLimit = cfg.provider === "Groq" ? readRateLimit(res.headers) : null;
    if (json?.segments || json?.text) {
      return {
        ...json,
        duration: Number(json.duration) || Number(extra.duration) || 0,
        ...(rateLimit ? { rateLimit } : {})
      };
    }
    return asVerbose(text, Number(extra.duration) || 0);
  }

  async function transcribeFish(blob, cfg, extra = {}) {
    const url = `${cfg.base}/v1/asr`;
    await ensureOrigin(url);
    const form = new FormData();
    const filename = extra.filename || `audio.${guessExt(blob.type)}`;
    form.append("audio", blob, filename);
    form.append("ignore_timestamps", "false");
    if (extra.language) form.append("language", extra.language);
    const res = await postForm(url, {
      method: "POST",
      signal: extra.signal,
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form
    }, cfg.provider || "Fish Audio");
    const { json, text } = await readJson(res);
    if (!res.ok) throwHttpError(res, json, cfg.provider || "Fish Audio", text);
    const segs = mapFishSegments(json);
    const duration = Number(json?.duration) || Number(extra.duration) || 0;
    const full = String(json?.text || "").trim() || segs.map((s) => s.text).join("");
    if (segs.length) return { text: full, segments: segs, duration };
    return asVerbose(full || text, duration);
  }

  // ElevenLabs 只走官方 xi-api-key。allow_unauthenticated 是网页演示私货，
  // 现在会直接要求注册，扩展里从未稳定可用。
  function friendlyElevenlabsError(detail, status) {
    const message = detail?.message || (typeof detail === "string" ? detail : null);
    if (status === 401 || status === 403) {
      return `API Key 无效或无权限（${message || status}）`;
    }
    return message || `ElevenLabs 错误 ${status}`;
  }

  async function transcribeElevenlabs(blob, cfg, extra = {}) {
    const key = String(cfg.key || "").trim();
    if (!key) throw new Error("请填写 ElevenLabs API Key");
    const url = `${cfg.base}/speech-to-text`;
    await ensureOrigin(url);
    const form = new FormData();
    const filename = extra.filename || `audio.${guessExt(blob.type)}`;
    form.append("file", blob, filename);
    form.append("model_id", cfg.model || "scribe_v2");
    form.append("diarize", "true");
    // 不关的话 [Music]、[Applause] 之类事件标记会混进字幕
    form.append("tag_audio_events", "false");
    const res = await postForm(url, {
      method: "POST",
      signal: extra.signal,
      headers: { "xi-api-key": key },
      body: form
    }, "ElevenLabs");
    const { json, text } = await readJson(res);
    if (!res.ok) {
      const err = new Error(friendlyElevenlabsError(json?.detail, res.status) || String(text || "").slice(0, 160));
      err.status = res.status;
      err.retryAfter = parseRetryAfterMs(res.headers?.get?.("retry-after"));
      // quota_exceeded 等状态码放进 code，后台据此判定额度用完而不是限流
      if (json?.detail?.status) err.code = String(json.detail.status);
      throw err;
    }
    const words = (Array.isArray(json?.words) ? json.words : [])
      .map((w) => ({
        word: String(w.text || "").trim(),
        start: Number(w.start) || 0,
        end: Number(w.end) || 0
      }))
      .filter((w) => w.word);
    return {
      text: String(json?.text || "").trim(),
      words,
      duration: Number(json?.audio_duration_secs) || Number(extra.duration) || 0,
      language: json?.language_code || ""
    };
  }

  async function transcribe(blob, cfg, extra = {}) {
    if (!cfg?.provider) throw new Error("未选择转写服务商");
    if (cfg.kind === "openai") return transcribeOpenAI(blob, cfg, extra);
    if (cfg.kind === "fish") return transcribeFish(blob, cfg, extra);
    if (cfg.kind === "elevenlabs") return transcribeElevenlabs(blob, cfg, extra);
    throw new Error(`未接通的转写服务：${cfg.provider}`);
  }

  async function listModels(kind, cfg) {
    if (cfg?.kind === "fish") return [];
    if (cfg?.kind === "elevenlabs") return P().STT_MODEL_HINTS.ElevenLabs || [];
    if (!cfg?.base || !cfg.key) throw new Error("先填写 API Key");
    const url = `${cfg.base}/models`;
    await ensureOrigin(url);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.key}` } });
    const { json } = await readJson(res);
    if (!res.ok) throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    const ids = (json?.data || []).map((m) => m.id).filter(Boolean);
    if (kind === "stt") {
      const matched = ids.filter((id) => /whisper|transcribe|sense|asr|paraformer|nova|speech/i.test(id));
      return matched.length ? matched : ids;
    }
    return ids;
  }

  async function testConnection(cfg) {
    if (cfg.kind === "fish") {
      if (!cfg.key) throw new Error("请先填写 API Key");
      await transcribeFish(silentWav(), cfg);
      return { ok: true, label: "已连通" };
    }
    if (cfg.kind === "elevenlabs") {
      const key = String(cfg.key || "").trim();
      if (!key) throw new Error("请填写 ElevenLabs API Key。官网演示免登录已经不可用");
      await ensureOrigin(cfg.base);
      const res = await fetch(`${cfg.base}/speech-to-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "xi-api-key": key
        },
        body: `model_id=${encodeURIComponent(cfg.model || "scribe_v2")}&diarize=true`
      });
      if (res.ok || res.status === 400 || res.status === 422) {
        return { ok: true, label: "已连通" };
      }
      const { json } = await readJson(res);
      throw new Error(friendlyElevenlabsError(json?.detail, res.status));
    }
    if (cfg.kind === "openai") {
      if (!cfg.key) throw new Error("请先填写 API Key");
      const ids = await listModels("stt", cfg);
      return { ok: true, label: ids.length ? `已读到 ${ids.length} 个模型` : "已连通" };
    }
    throw new Error("未知服务商");
  }

  global.BiliCaptionStt = {
    transcribe,
    listModels,
    testConnection,
    ensureOrigin,
    guessExt,
    parseRetryAfterMs,
    parseDurationMs
  };
})(globalThis);
