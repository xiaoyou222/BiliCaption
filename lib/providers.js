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
    // ElevenLabs：不填 Key 走官网演示通道（allow_unauthenticated，按 IP 限次）；
    // 填了 Key 自动切官方正式通道。演示通道属非公开承诺接口，不进备用服务商
    ElevenLabs: {
      url: "https://api.elevenlabs.io/v1",
      model: "scribe_v2",
      kind: "elevenlabs",
      keyless: true,
      fields: [["key", "API Key（选填）", "不填走免 Key 演示通道"]],
      compatibilityWarning: "不填 Key 直接用官网演示通道（按 IP 限次，几次就会用完，适合先体验）；填写 API Key 后自动走官方正式通道，额度按你的账号算"
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

  const SUM_MODELS = {
    OpenAI: "gpt-4o-mini",
    Gemini: "gemini-2.5-flash",
    DeepSeek: "deepseek-chat",
    自定义: ""
  };

  const SUM_KEY_HINT = {
    OpenAI: "sk-...",
    Gemini: "AI Studio API Key",
    DeepSeek: "sk-...",
    自定义: "sk-..."
  };

  const MODEL_HINTS = {
    Groq: ["whisper-large-v3-turbo", "whisper-large-v3", "distil-whisper-large-v3-en"],
    OpenAI: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    "ElevenLabs": ["scribe_v2", "scribe_v1"],
    Gemini: ["gemini-2.5-flash", "gemini-3-flash-preview"],
    DeepSeek: ["deepseek-chat", "deepseek-reasoner"]
  };

  const XY_ALIASES = new Set(["xy-fast", "xy-smart", "xy-backup"]);

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

  function normalizeBase(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function hasSttCreds(provider, creds = {}) {
    const meta = schema(provider);
    // 免 Key 服务商（ElevenLabs 演示通道）无需任何凭证
    if (meta.keyless) return true;
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
    const storedModel = String(storage.sttModel || "").trim();
    return {
      provider,
      kind: meta.kind,
      base: resolveSttBase(provider, box, meta),
      model: remapped ? meta.model : (storedModel || meta.model),
      creds: box,
      key: credentialKey(provider, box)
    };
  }

  // 通道 = 服务商的一个实例（同服务商可多条 = 多账号）。key 选填（ElevenLabs 免 Key）
  function normalizeChannel(ch) {
    if (!ch || !isSttProvider(ch.provider)) return null;
    const meta = schema(ch.provider);
    const key = String(ch.key || "").trim();
    const url = String(ch.url || "").trim();
    return {
      provider: ch.provider,
      kind: meta.kind,
      base: resolveSttBase(ch.provider, { url }, meta),
      model: String(ch.model || "").trim() || meta.model,
      creds: url ? { key, url } : { key },
      key
    };
  }

  function channelUsable(cfg) {
    if (!cfg) return false;
    return schema(cfg.provider).keyless || Boolean(cfg.key);
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

  function sttLimits() {
    return { maxSeconds: 8 * 60, maxBytes: 20 * 1024 * 1024, hardDuration: false };
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
    if (XY_ALIASES.has(String(next.translateModel || "").trim())) {
      next.translateModel = "";
    }
    if (XY_ALIASES.has(String(next.apiModel || "").trim()) && provider !== "自定义") {
      next.apiModel = "";
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
    SUM_KEY_HINT,
    MODEL_HINTS,
    schema,
    originOf,
    normalizeBase,
    hasSttCreds,
    credentialKey,
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
