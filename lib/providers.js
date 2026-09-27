(function (global) {
  const STT_PROVIDERS = ["Fish Audio", "Groq", "OpenAI", "ElevenLabs"];
  const SUM_PROVIDERS = ["OpenAI", "Gemini", "DeepSeek", "自定义"];
  const FETCHABLE = {
    Groq: 1, OpenAI: 1, Gemini: 1,
    DeepSeek: 1, 自定义: 1
  };

  const STT_SCHEMA = {
    "Fish Audio": { url: "https://api.fish.audio", model: "", kind: "fish", fields: [["key", "API Key", "sk-..."]] },
    Groq: { url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", kind: "openai", fields: [["key", "API Key", "gsk_..."]] },
    OpenAI: {
      url: "https://api.openai.com/v1",
      model: "whisper-1",
      kind: "openai",
      editableUrl: true,
      fields: [["key", "API Key", "sk-..."]]
    },
    ElevenLabs: {
      url: "https://api.elevenlabs.io/v1",
      model: "scribe_v2",
      kind: "elevenlabs",
      fields: [["key", "API Key", "xi-..."]]
    }
  };

  const SUM_URLS = {
    OpenAI: "https://api.openai.com/v1",
    Gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    DeepSeek: "https://api.deepseek.com/v1",
    自定义: ""
  };

  const LEGACY_SUM_URLS = {
    "智谱 GLM": "https://open.bigmodel.cn/api/paas/v4",
    Kimi: "https://api.moonshot.cn/v1",
    通义千问: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    OpenRouter: "https://openrouter.ai/api/v1"
  };

  // 对话默认模型（总结 / 大纲 / 润色，翻译模型留空时也用它），2026-09 按官方模型页核对：
  // - OpenAI gpt-6-luna：官方「最高效、面向专注的大批量任务」的一档，$0.1 / $0.5 每百万 token，比 gpt-4o-mini 便宜；
  //   是推理模型，参数规则见 lib/模型路由.js。https://developers.openai.com/api/docs/models/gpt-6-luna
  // - Gemini gemini-3.8-flash：最新正式版 Flash。2.5 系列已限制为只给用过的老用户，新项目官方推荐 3.8 Flash / 3.5 Flash-Lite。
  //   https://ai.google.dev/gemini-api/docs/models  https://ai.google.dev/gemini-api/docs/deprecations
  // - DeepSeek deepseek-flash（现为 V4.1-Flash）；deepseek-chat / deepseek-reasoner 已于 2026-07-24 下线。
  //   https://api-docs.deepseek.com/quick_start/pricing  https://api-docs.deepseek.com/updates/
  const SUM_MODELS = {
    OpenAI: "gpt-6-luna",
    Gemini: "gemini-3.8-flash",
    DeepSeek: "deepseek-flash",
    自定义: ""
  };

  // 翻译「速度优先」档：服务商有官方明确更快更便宜的一档时才填，设置页切到该服务商时预填进翻译模型。
  // 只影响新选的服务商；已保存的翻译模型（包括留空 = 跟随总结模型）不动。
  // - Gemini 3.5 Flash-Lite：官方定位低延迟、低成本的大批量任务，$0.30 / $2.50，默认只做最少思考。
  //   https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
  // - OpenAI 默认已是最便宜的 gpt-6-luna，DeepSeek 只有 flash / pro 两档且默认已是 flash：跟随总结模型即可。
  const SUM_TRANSLATE_MODELS = {
    Gemini: "gemini-3.5-flash-lite"
  };

  const SUM_KEY_HINT = {
    OpenAI: "sk-...",
    Gemini: "AI Studio API Key",
    DeepSeek: "sk-...",
    自定义: "sk-..."
  };

  // 对话模型候选（设置页拉不到模型列表时的兜底），按总结服务商取：前一个速度优先，后一个质量优先。
  const MODEL_HINTS = {
    OpenAI: ["gpt-6-luna", "gpt-6-sol"],
    Gemini: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
    DeepSeek: ["deepseek-flash", "deepseek-v4-pro"]
  };

  // 转写模型候选。字幕要对时间轴，只列能返回分段 / 词级时间戳的模型（2026-09 核对）：
  // - Groq：只剩 whisper-large-v3-turbo / whisper-large-v3；distil-whisper-large-v3-en 已于 2025-08-23 下线。
  //   https://console.groq.com/docs/speech-to-text  https://console.groq.com/docs/deprecations
  // - OpenAI：只有 whisper-1 支持 timestamp_granularities；官方推荐的 gpt-transcribe 只返回 json、没有时间戳，
  //   gpt-4o(-mini)-transcribe 同样没有，所以不列。whisper-1 已公告 2027-02-26 下线。
  //   https://developers.openai.com/api/docs/guides/speech-to-text  https://developers.openai.com/api/docs/deprecations
  // - ElevenLabs：scribe_v2 带词级时间戳；scribe_v1 已于 2026-07-09 移除；scribe_v2_realtime 走实时接口，不适用。
  //   https://elevenlabs.io/docs/models  https://elevenlabs.io/docs/changelog/2026/6/8
  const STT_MODEL_HINTS = {
    Groq: ["whisper-large-v3-turbo", "whisper-large-v3"],
    OpenAI: ["whisper-1"],
    ElevenLabs: ["scribe_v2"]
  };

  const XY_ALIASES = new Set(["xy-fast", "xy-smart", "xy-backup"]);

  // 已下线（请求必然失败）的旧模型名：读设置时自动换成当前默认。仍能用、只是不再推荐的
  // （gpt-4o-mini、gemini-2.5-flash、gemini-3-flash-preview、whisper-1 等）不在这里，用户已保存的值保持不动。
  // Gemini 名单取自官方弃用页里停用日期已过的对话模型。https://ai.google.dev/gemini-api/docs/deprecations
  const RETIRED_SUM_MODELS = {
    DeepSeek: new Set(["deepseek-chat", "deepseek-reasoner"]),
    Gemini: new Set([
      "gemini-3-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-pro-preview-03-25",
      "gemini-2.5-pro-preview-05-06",
      "gemini-2.5-pro-preview-06-05",
      "gemini-2.5-flash-preview-05-20",
      "gemini-2.5-flash-preview-09-2025",
      "gemini-2.5-flash-preview-09-25",
      "gemini-2.5-flash-lite-preview-09-2025",
      "gemini-2.0-flash",
      "gemini-2.0-flash-001",
      "gemini-2.0-flash-lite",
      "gemini-2.0-flash-lite-001",
      "gemini-2.0-flash-lite-preview",
      "gemini-2.0-flash-lite-preview-02-05"
    ])
  };
  const RETIRED_STT_MODELS = {
    Groq: new Set(["distil-whisper-large-v3-en"]),
    ElevenLabs: new Set(["scribe_v1"])
  };

  function retiredName(model) {
    return String(model || "").trim().toLowerCase().replace(/^models\//, "");
  }

  function isRetiredSumModel(provider, model) {
    return Boolean(RETIRED_SUM_MODELS[provider]?.has(retiredName(model)));
  }

  /** 翻译模型的默认值：有速度档用速度档，否则同总结模型 */
  function translateDefault(provider) {
    return SUM_TRANSLATE_MODELS[provider] || SUM_MODELS[provider] || "";
  }

  /** 转写通道里保存的模型名：已下线的换成该服务商当前默认，其余原样（空 = 用默认） */
  function migrateSttModel(provider, model) {
    const name = String(model || "").trim();
    if (!RETIRED_STT_MODELS[provider]?.has(name.toLowerCase())) return name;
    return STT_SCHEMA[provider]?.model || "";
  }

  function isSttProvider(provider) {
    return STT_PROVIDERS.includes(provider);
  }

  function schema(provider) {
    return STT_SCHEMA[provider] || STT_SCHEMA.Groq;
  }

  function originOf(url) {
    try {
      return `${new URL(url).origin}/*`;
    } catch {
      return "";
    }
  }

  function isLocalApiHost(host) {
    const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  }

  function assertSafeApiUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || "").trim());
    } catch {
      throw new Error("接口地址无效");
    }
    if (parsed.protocol === "https:") return parsed;
    if (parsed.protocol === "http:" && isLocalApiHost(parsed.hostname)) return parsed;
    throw new Error("接口地址必须使用 https（本机可用 http://127.0.0.1）");
  }

  function normalizeBase(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function hasSttCreds(provider, creds = {}) {
    const meta = schema(provider);
    const box = creds[provider] || {};
    const fields = meta.fields || [];
    if (!fields.length) return Boolean(String(box.key || "").trim());
    return fields.every(([k]) => String(box[k] || "").trim());
  }

  function credentialKey(provider, box = {}) {
    return String(box.key || "").trim();
  }

  function resolveSttBase(provider, box, meta) {
    if (provider === "OpenAI") return normalizeBase(box.url) || normalizeBase(meta.url);
    return normalizeBase(meta.url);
  }

  function resolveStt(storage = {}) {
    const remapped = !isSttProvider(storage.sttProvider);
    const provider = remapped ? "Groq" : storage.sttProvider;
    const creds = storage.sttCreds || {};
    const box = { ...(creds[provider] || {}) };
    if (!box.key && (storage.groqApiKey || storage.sttKey) && provider === "Groq") {
      box.key = storage.groqApiKey || storage.sttKey;
    }
    const meta = schema(provider);
    const storedModel = migrateSttModel(provider, storage.sttModel);
    return {
      provider,
      kind: meta.kind,
      base: resolveSttBase(provider, box, meta),
      model: remapped ? meta.model : (storedModel || meta.model),
      creds: box,
      key: credentialKey(provider, box)
    };
  }

  function channelNote(ch) {
    return String(ch?.note || "").trim();
  }

  /** 用户可见通道名：有备注时带上，避免两个 Groq 账号看起来像同一条 */
  function channelLabel(cfg, fallback = "转写") {
    const provider = String(cfg?.provider || "").trim() || fallback;
    const note = channelNote(cfg);
    return note ? `${provider} · ${note}` : provider;
  }

  // 通道 = 服务商的一个实例（同服务商可多条 = 多账号）
  function normalizeChannel(ch) {
    if (!ch || !isSttProvider(ch.provider)) return null;
    const meta = schema(ch.provider);
    const key = String(ch.key || "").trim();
    const url = String(ch.url || "").trim();
    return {
      provider: ch.provider,
      kind: meta.kind,
      base: resolveSttBase(ch.provider, { url }, meta),
      model: migrateSttModel(ch.provider, ch.model) || meta.model,
      creds: url ? { key, url } : { key },
      key,
      note: channelNote(ch),
      off: Boolean(ch.off)
    };
  }

  function channelUsable(cfg) {
    if (!cfg || cfg.off) return false;
    return Boolean(cfg.key);
  }

  /** 优先级链：sttChannels 顺序即优先级；旧配置迁移成 [主, 备用] */
  function resolveChannels(storage = {}) {
    const raw = Array.isArray(storage.sttChannels) ? storage.sttChannels : [];
    const list = raw.map(normalizeChannel).filter(Boolean);
    if (list.length) return list;
    const main = resolveStt(storage);
    const chain = [main];
    const backup = resolveBackup(storage);
    if (backup && backup.provider !== main.provider) chain.push(backup);
    return chain;
  }

  function resolveBackup(storage = {}) {
    const provider = storage.backupProvider;
    if (!isSttProvider(provider)) return null;
    const creds = storage.sttCreds || {};
    const box = { ...(creds[provider] || {}) };
    if (storage.backupKey && !box.key) box.key = storage.backupKey;
    if (!hasSttCreds(provider, { [provider]: box })) return null;
    const meta = schema(provider);
    return {
      provider,
      kind: meta.kind,
      base: resolveSttBase(provider, box, meta),
      model: meta.model,
      creds: box,
      key: credentialKey(provider, box)
    };
  }

  // 各服务商单次上传上限（2026-09 按官方文档核对）：
  // - Groq：免费档 25MB、开发者档 100MB（拿不到账号档位，按 25MB 算）；不足 10 秒按 10 秒计费；
  //   免费档 whisper 每小时 7200 音频秒（ASH）、每分钟 20 次请求。console.groq.com/docs/speech-to-text、/docs/rate-limits
  // - OpenAI：25MB。developers.openai.com/api/docs/guides/speech-to-text
  // - ElevenLabs：单文件最大 3GB、最长 10 小时，超过 8 分钟服务端自动并行切段。elevenlabs.io/docs/capabilities/speech-to-text
  // - Fish Audio：文档没写大小和时长上限，保持保守值。docs.fish.audio
  // maxSeconds / maxBytes 是切片目标，uploadBytes 是单个请求允许的硬上限，concurrency 是单条通道同时在途的请求数。
  const MB = 1024 * 1024;
  const STT_LIMITS = {
    Groq: { maxSeconds: 8 * 60, maxBytes: 20 * MB, uploadBytes: 24 * MB, concurrency: 2 },
    OpenAI: { maxSeconds: 8 * 60, maxBytes: 20 * MB, uploadBytes: 24 * MB, concurrency: 3 },
    ElevenLabs: { maxSeconds: 30 * 60, maxBytes: 150 * MB, uploadBytes: 200 * MB, concurrency: 2 },
    "Fish Audio": { maxSeconds: 8 * 60, maxBytes: 20 * MB, uploadBytes: 20 * MB, concurrency: 2 }
  };
  const DEFAULT_STT_LIMITS = { maxSeconds: 8 * 60, maxBytes: 20 * MB, uploadBytes: 20 * MB, concurrency: 2 };

  function sttLimits(cfg = {}) {
    const limits = STT_LIMITS[cfg?.provider] || DEFAULT_STT_LIMITS;
    return { ...limits, hardDuration: false };
  }

  function acceptsSttExtension() {
    return true;
  }

  function sttCompatibilityError(cfg = {}, extension = "m4a") {
    if (acceptsSttExtension(cfg, extension)) return "";
    return `${cfg.provider || "当前转写服务"}不支持 ${String(extension || "该").toUpperCase()} 音频`;
  }

  function migrateSum(storage = {}) {
    const next = { ...storage };
    const previous = String(next.sumProvider || "").trim();
    const url = normalizeBase(next.apiBase || next.sumUrl);
    let provider = previous;

    if (provider === "统一网关") {
      if (url) {
        provider = "自定义";
        next.apiBase = url;
      } else {
        provider = "OpenAI";
      }
    } else if (LEGACY_SUM_URLS[provider]) {
      next.apiBase = url || LEGACY_SUM_URLS[provider];
      provider = "自定义";
    } else if (!SUM_PROVIDERS.includes(provider)) {
      provider = "OpenAI";
    }

    next.sumProvider = provider;
    // 网关别名只在「自定义」（用户自己的网关）下有意义：主模型和翻译模型同一规则，
    // 自定义时都保留，换到具体服务商时都清掉。
    // 已下线的模型名：主模型换成该服务商默认，翻译模型换成默认翻译模型（有速度档用速度档）。
    for (const key of ["apiModel", "translateModel"]) {
      const value = String(next[key] || "").trim();
      if (XY_ALIASES.has(value) && provider !== "自定义") next[key] = "";
      else if (isRetiredSumModel(provider, value)) next[key] = key === "translateModel" ? translateDefault(provider) : SUM_MODELS[provider];
    }
    return next;
  }

  function resolveSum(storage = {}) {
    const migrated = migrateSum(storage);
    const provider = SUM_PROVIDERS.includes(migrated.sumProvider) ? migrated.sumProvider : "OpenAI";
    const base = provider === "自定义"
      ? normalizeBase(migrated.apiBase || migrated.sumUrl)
      : normalizeBase(SUM_URLS[provider]);
    const model = String(migrated.apiModel || migrated.sumModel || SUM_MODELS[provider] || "").trim();
    return {
      provider,
      base,
      // 只有「自定义」且没填模型会落到这里：沿用各家 OpenAI 兼容网关普遍认得的非推理模型名，
      // 不用 gpt-6-luna（推理模型，自定义通道会照常发 temperature）。
      model: model || SUM_MODELS[provider] || "gpt-4o-mini",
      key: String(migrated.apiKey || migrated.sumKey || "").trim()
    };
  }

  function knownOrigins() {
    const urls = [
      ...Object.values(STT_SCHEMA).map((s) => s.url),
      ...Object.values(SUM_URLS),
      ...Object.values(LEGACY_SUM_URLS)
    ];
    return [...new Set(urls.map(originOf).filter(Boolean))];
  }

  global.BiliCaptionProviders = {
    STT_PROVIDERS,
    SUM_PROVIDERS,
    FETCHABLE,
    STT_SCHEMA,
    SUM_URLS,
    LEGACY_SUM_URLS,
    SUM_MODELS,
    SUM_TRANSLATE_MODELS,
    SUM_KEY_HINT,
    MODEL_HINTS,
    STT_MODEL_HINTS,
    translateDefault,
    migrateSttModel,
    schema,
    originOf,
    assertSafeApiUrl,
    normalizeBase,
    hasSttCreds,
    credentialKey,
    channelNote,
    channelLabel,
    normalizeChannel,
    channelUsable,
    resolveChannels,
    resolveStt,
    resolveBackup,
    sttLimits,
    acceptsSttExtension,
    sttCompatibilityError,
    migrateSum,
    resolveSum,
    knownOrigins
  };
})(globalThis);
