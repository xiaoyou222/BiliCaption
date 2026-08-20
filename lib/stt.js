(function (global) {
  const P = () => global.BiliCaptionProviders;

  function parseRetryAfterMs(value) {
    if (value == null || value === "") return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 7 * 24 * 3600) * 1000;
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  function guessExt(mime) {
    const t = String(mime || "").toLowerCase();
    if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
    if (t.includes("wav")) return "wav";
    if (t.includes("webm")) return "webm";
    if (t.includes("ogg")) return "ogg";
    return "m4a";
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

  function throwHttpError(res, json, provider) {
    const err = new Error(json?.error?.message || json?.message || `${provider} 错误 ${res.status}`);
    err.status = res.status;
    err.retryAfter = parseRetryAfterMs(res.headers?.get?.("retry-after"));
    throw err;
  }

  async function transcribeOpenAI(blob, cfg, extra = {}) {
    const url = `${cfg.base}/audio/transcriptions`;
    await ensureOrigin(url);
    const form = new FormData();
    const filename = extra.filename || `audio.${guessExt(blob.type)}`;
    form.append("file", blob, filename);
    form.append("model", cfg.model);
    const openAiTextOnly = cfg.provider === "OpenAI"
      && /^gpt-4o(?:-mini)?-transcribe(?:-|$)/i.test(cfg.model || "");
    form.append("response_format", extra.responseFormat || (openAiTextOnly ? "json" : "verbose_json"));
    form.append("temperature", "0");
    if (extra.language) form.append("language", extra.language);
    if (cfg.provider === "Groq" && !openAiTextOnly) {
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }
    const res = await fetch(url, {
      method: "POST",
      signal: extra.signal,
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form
    });
    const { json, text } = await readJson(res);
    if (!res.ok) throwHttpError(res, json, cfg.provider);
    if (json?.segments || json?.text) {
      return { ...json, duration: Number(json.duration) || Number(extra.duration) || 0 };
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
    const res = await fetch(url, {
      method: "POST",
      signal: extra.signal,
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form
    });
    const { json, text } = await readJson(res);
    if (!res.ok) throwHttpError(res, json, cfg.provider || "Fish Audio");
    const segs = mapFishSegments(json);
    const duration = Number(json?.duration) || Number(extra.duration) || 0;
    const full = String(json?.text || "").trim() || segs.map((s) => s.text).join("");
    if (segs.length) return { text: full, segments: segs, duration };
    return asVerbose(full || text, duration);
  }

  // ElevenLabs 双通道：不填 Key 走官网演示通道（allow_unauthenticated，按 IP 限次，
  // 且强制 diarize=true）；填了 Key 走官方正式通道（xi-api-key，额度按账号算）。
  // 响应只有词级 words（实测无 utterances），转成通用 words 形状交给收句管线
  function friendlyElevenlabsError(detail, status, hasKey) {
    const message = detail?.message || (typeof detail === "string" ? detail : null);
    if (/landing page|signing up/i.test(String(message || ""))) {
      return "ElevenLabs 免费演示次数已用完（按 IP 限次）。稍后再试，或改用其他转写服务商";
    }
    if (hasKey && (status === 401 || status === 403)) {
      return `API Key 无效或无权限（${message || status}）`;
    }
    return message || `ElevenLabs 错误 ${status}`;
  }

  async function transcribeElevenlabs(blob, cfg, extra = {}) {
    const key = String(cfg.key || "").trim();
    const url = key
      ? `${cfg.base}/speech-to-text`
      : `${cfg.base}/speech-to-text?allow_unauthenticated=1`;
    await ensureOrigin(url);
    const form = new FormData();
    const filename = extra.filename || `audio.${guessExt(blob.type)}`;
    form.append("file", blob, filename);
    form.append("model_id", cfg.model || "scribe_v2");
    form.append("diarize", "true");
    // 不关的话 [Music]、[Applause] 之类事件标记会混进字幕
    form.append("tag_audio_events", "false");
    const res = await fetch(url, {
      method: "POST",
      signal: extra.signal,
      ...(key ? { headers: { "xi-api-key": key } } : {}),
      body: form
    });
    const { json, text } = await readJson(res);
    if (!res.ok) {
      const err = new Error(friendlyElevenlabsError(json?.detail, res.status, Boolean(key)) || String(text || "").slice(0, 160));
      err.status = res.status;
      err.retryAfter = parseRetryAfterMs(res.headers?.get?.("retry-after"));
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
    if (cfg?.kind === "elevenlabs") return P().MODEL_HINTS.ElevenLabs || [];
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
      // 轻量探测：不带音频会得到 400/422「缺少 file」的校验错误——
      // 说明通道可达；填了 Key 时顺带真实校验 Key（401 = Key 无效），且不消耗转写额度
      const key = String(cfg.key || "").trim();
      await ensureOrigin(cfg.base);
      const res = await fetch(
        key ? `${cfg.base}/speech-to-text` : `${cfg.base}/speech-to-text?allow_unauthenticated=1`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(key ? { "xi-api-key": key } : {})
          },
          body: `model_id=${encodeURIComponent(cfg.model || "scribe_v2")}&diarize=true`
        }
      );
      if (res.ok || res.status === 400 || res.status === 422) {
        return { ok: true, label: key ? "官方通道 Key 可用" : "免 Key 演示通道可用" };
      }
      const { json } = await readJson(res);
      throw new Error(friendlyElevenlabsError(json?.detail, res.status, Boolean(key)));
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
    guessExt
  };
})(globalThis);
