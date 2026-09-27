(function (global) {
  // 统一的大模型调用层：后台翻译和侧栏总结 / 大纲 / 润色都走这里。
  // 负责 URL 安全检查、鉴权头、流式与非流式请求、首字 / 空闲超时、错误信息、
  // 去掉 <think> 思考内容，以及按服务商与模型决定思考参数、是否发 temperature、输出上限字段名
  //（见 lib/模型路由.js）；服务端明确拒绝 temperature / max_tokens 时改掉重试一次。
  const DEFAULT_SYSTEM = "你是简洁的中文助手。只输出结果，不要客套。";
  const DEFAULT_MODEL = "gpt-4o-mini";
  // 流式：从发出请求到收到第一段数据的上限。思考模型写长大纲前可能先想一阵。
  const FIRST_BYTE_MS = 90 * 1000;
  // 流式：收到数据后，两段数据之间最长可以空多久；有新数据就续期，长输出不会被中途掐断。
  const IDLE_MS = 45 * 1000;
  // 非流式：整次请求的总时限。
  const TIMEOUT_MS = 90 * 1000;

  function route() {
    return global.BiliCaptionModelRoute || null;
  }

  function defaultModel(model) {
    return String(model || "").trim() || DEFAULT_MODEL;
  }

  /** 去掉推理模型混进正文的 <think>…</think>；只写了开头的半截思考也一起去掉。 */
  function stripThinking(text) {
    return String(text || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*$/gi, "")
      .trim();
  }

  function markError(error, { status = 0, invalidResponse = false, truncated = false, fatal = false } = {}) {
    const next = error instanceof Error ? error : new Error(String(error || "模型请求失败"));
    if (status) next.status = Number(status) || 0;
    if (invalidResponse) next.invalidResponse = true;
    if (truncated) next.truncated = true;
    if (fatal) next.fatal = true;
    return next;
  }

  /** 配置类错误（没填地址、地址不安全、没 Key）：重试没有意义，整项任务直接停。 */
  function configError(message) {
    return markError(new Error(message), { fatal: true });
  }

  function abortError() {
    const error = new Error("已取消");
    error.name = "AbortError";
    return error;
  }

  function isLocalHost(host) {
    const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  }

  function assertSafeUrl(url) {
    const shared = global.BiliCaptionProviders?.assertSafeApiUrl;
    try {
      if (typeof shared === "function") return shared(url);
      const parsed = new URL(String(url || "").trim());
      if (parsed.protocol === "https:") return parsed;
      if (parsed.protocol === "http:" && isLocalHost(parsed.hostname)) return parsed;
      throw new Error("接口地址必须使用 https（本机可用 http://127.0.0.1）");
    } catch (error) {
      throw configError(error?.message === "Invalid URL" ? "接口地址无效" : (error?.message || "接口地址无效"));
    }
  }

  function unwrapJson(json) {
    return Array.isArray(json) ? json[0] : json;
  }

  const STATUS_HINTS = {
    400: "请求参数不被接受（400）",
    401: "API Key 无效或已过期（401）",
    403: "没有权限调用该模型（403）",
    404: "接口地址或模型名不存在（404）",
    429: "请求太频繁或额度不足（429）"
  };

  function errorMessage(json, status) {
    const body = unwrapJson(json);
    const raw = body?.error?.message
      || body?.message
      || (typeof body?.error === "string" ? body.error : "");
    if (raw) return String(raw);
    return STATUS_HINTS[Number(status)] || `接口错误 ${status}`;
  }

  function header(res, name) {
    try {
      return res?.headers?.get?.(name) || "";
    } catch {
      return "";
    }
  }

  /** 服务端要求的等待时间（毫秒）：Retry-After 头，或 Gemini 错误体里的 retryDelay。 */
  function retryAfterMs(res, json) {
    const ms = Number(header(res, "retry-after-ms"));
    if (Number.isFinite(ms) && ms > 0) return ms;
    const value = header(res, "retry-after");
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const at = Date.parse(value);
      if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    }
    const details = unwrapJson(json)?.error?.details;
    if (Array.isArray(details)) {
      for (const item of details) {
        const hit = String(item?.retryDelay || "").match(/^(\d+(?:\.\d+)?)s$/);
        if (hit) return Number(hit[1]) * 1000;
      }
    }
    return 0;
  }

  // 400 里夹着 Key 无效、模型不存在、参数不支持这类配置问题时，每一批都会一样失败。
  const FATAL_400 = /api[ _-]?key|unauthori[sz]ed|permission|model[^.]{0,40}(?:not found|does not exist|not exist|不存在)|unsupported (?:parameter|value)|unknown (?:parameter|field)|unrecognized/i;

  function httpError(res, json) {
    const status = Number(res?.status) || 0;
    const message = errorMessage(json, status);
    const error = markError(new Error(message), { status });
    error.retryAfter = retryAfterMs(res, json);
    if ([401, 403, 404].includes(status) || (status === 400 && FATAL_400.test(message))) error.fatal = true;
    return error;
  }

  function isRetryable(error) {
    if (!error || error.name === "AbortError" || error.canceled || error.fatal) return false;
    if (error.invalidResponse || error.truncated || error.streamError) return true;
    const status = Number(error.status) || 0;
    if (status) return [408, 409, 425, 429].includes(status) || status >= 500;
    const raw = String(error.message || error);
    return error.name === "TypeError"
      || /timeout|timed out|network|failed to fetch|connection|超时|中断|响应为空|结构校验失败/i.test(raw);
  }

  function isFatal(error) {
    return Boolean(error?.fatal);
  }

  /** 按服务商与模型决定发哪些参数（见 lib/模型路由.js）；没加载路由时按通用 OpenAI 兼容格式发 */
  function requestPlan({ provider = "", model = "", task = "" }) {
    const r = route();
    if (typeof r?.requestPlan === "function") return r.requestPlan({ provider, model, task });
    return { fields: r?.requestFields?.({ provider, model, task }) || {}, temperature: true, tokenField: "max_tokens" };
  }

  /**
   * 拼请求体。dropTemperature / tokenField 是服务端拒绝过某个参数后的改法，优先于按服务商的默认。
   */
  function buildBody({ model, provider = "", task = "", temperature = 0.3, maxTokens = 0, stream = false, messages, dropTemperature = false, tokenField = "" }) {
    const plan = requestPlan({ provider, model, task });
    const body = { model };
    if (temperature != null && plan.temperature !== false && !dropTemperature) body.temperature = temperature;
    if (maxTokens) body[tokenField || plan.tokenField || "max_tokens"] = maxTokens;
    if (stream) body.stream = true;
    Object.assign(body, plan.fields || {});
    body.messages = messages;
    return body;
  }

  // 自定义网关后面可能是推理模型，按服务商判断不出来。服务端明确说某个通用参数不受支持时，
  // 改掉它自动重试一次，并按「接口地址 + 模型」记住，之后的请求第一次就按改过的发：
  // - temperature 不受支持（OpenAI 推理模型：Unsupported parameter / Only the default (1) value is supported）→ 不发；
  // - max_tokens 不受支持（提示改用 max_completion_tokens）→ 换成 max_completion_tokens。
  const TEMPERATURE_REJECTED = /temperature[\s\S]{0,120}(?:not supported|unsupported|does not support|only the default|not allowed|unknown|unrecogni)|(?:unsupported|unknown|unrecognized)[\s\S]{0,40}temperature/i;
  const MAX_TOKENS_REJECTED = /max_tokens[\s\S]{0,120}(?:not supported|unsupported|max_completion_tokens)|(?:unsupported|unknown|unrecognized)[\s\S]{0,40}max_tokens/i;
  const learnedFixes = new Map();

  function paramFix(error, body) {
    const status = Number(error?.status) || 0;
    if (status !== 400 && status !== 422) return "";
    const message = String(error?.message || "");
    if ("temperature" in body && TEMPERATURE_REJECTED.test(message)) return "temperature";
    if ("max_tokens" in body && MAX_TOKENS_REJECTED.test(message)) return "max_tokens";
    return "";
  }

  function createWatchdog(outer, ms, reason) {
    const ctrl = new AbortController();
    let timer = 0;
    let fired = "";
    const arm = (wait, why) => {
      clearTimeout(timer);
      if (wait > 0) {
        timer = setTimeout(() => {
          fired = why;
          ctrl.abort();
        }, wait);
      }
    };
    const onAbort = () => ctrl.abort();
    if (outer?.aborted) ctrl.abort();
    else outer?.addEventListener?.("abort", onAbort, { once: true });
    arm(ms, reason);
    return {
      signal: ctrl.signal,
      fired: () => fired,
      touch(wait) {
        if (!fired && !ctrl.signal.aborted) arm(wait, "idle");
      },
      done() {
        clearTimeout(timer);
        outer?.removeEventListener?.("abort", onAbort);
      }
    };
  }

  function timeoutText(reason) {
    if (reason === "first") return "模型迟迟没有开始输出（首字超时），请稍后重试";
    if (reason === "idle") return "模型输出中途停住了（空闲超时），请稍后重试";
    return "请求超时，请稍后重试";
  }

  function streamError(payload) {
    const body = unwrapJson(payload);
    const code = Number(body?.error?.code ?? body?.error?.status) || 0;
    const error = markError(new Error(`模型输出中断：${errorMessage(body, code || "")}`), { status: code });
    error.streamError = true;
    return error;
  }

  /**
   * 读 OpenAI 兼容的 SSE 流。返回正文、finish_reason 和模型名。
   * - 流中途的 error 事件（`event: error` 或 data 里带 error）直接抛错；
   * - 服务端没理 stream:true、直接回整段 JSON 时，也能读出正文；
   * - onActivity 每收到一段字节就调用一次（含 reasoning_content 和心跳注释），用来续期空闲超时。
   */
  async function readStream(res, { onDelta, onActivity } = {}) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    let sse = false;
    let full = "";
    let emitted = "";
    let finishReason = "";
    let model = "";
    let eventName = "";
    const emit = () => {
      if (!onDelta) return;
      const shown = stripThinking(full);
      if (!shown || shown === emitted) return;
      emitted = shown;
      onDelta(shown);
    };
    const consume = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        eventName = "";
        return;
      }
      if (trimmed.startsWith("event:")) {
        eventName = trimmed.slice(6).trim();
        sse = true;
        return;
      }
      if (!trimmed.startsWith("data:")) return;
      sse = true;
      raw = "";
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {
        if (eventName === "error") throw streamError({ error: { message: data } });
        return;
      }
      if (eventName === "error" || unwrapJson(json)?.error) throw streamError(json);
      if (json?.model) model = json.model;
      const choice = json?.choices?.[0];
      const piece = choice?.delta?.content ?? choice?.message?.content ?? "";
      if (piece) {
        full += piece;
        emit();
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      const text = decoder.decode(value, { stream: true });
      if (!sse) raw += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(consume);
    }
    const tail = decoder.decode();
    if (!sse) raw += tail;
    buffer += tail;
    if (buffer.trim()) buffer.split(/\r?\n/).forEach(consume);
    if (!sse && raw.trim()) {
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      if (unwrapJson(json)?.error) throw streamError(json);
      const choice = json?.choices?.[0];
      full = choice?.message?.content || "";
      finishReason = choice?.finish_reason || "";
      model = json?.model || "";
      emit();
    }
    return { text: full, finishReason, model };
  }

  /**
   * 发一次 chat/completions。
   * task：translate / summary / outline / polish，只用来决定思考参数。
   * stream：流式请求（onDelta 可选）；用「首字超时 + 空闲超时」，不设总时限。
   * 返回 { text, model, finishReason, truncated }，text 已去掉 <think>。
   */
  async function chat(options = {}) {
    const {
      base,
      key,
      model,
      provider = "",
      task = "",
      prompt = "",
      system,
      messages,
      temperature = 0.3,
      maxTokens = 0,
      signal,
      stream = false,
      onDelta,
      validate,
      allowEmpty = false,
      firstByteMs = FIRST_BYTE_MS,
      idleMs = IDLE_MS,
      timeoutMs = TIMEOUT_MS
    } = options;
    const url = String(base || "").trim().replace(/\/+$/, "");
    if (!url) throw configError("请先在设置里填写接口地址");
    assertSafeUrl(url);
    if (!String(key || "").trim()) throw configError("请先在设置里配置总结服务和 API Key");
    if (signal?.aborted) throw abortError();
    const name = defaultModel(model);
    const fixKey = `${url}|${name}`;
    const fixes = { ...(learnedFixes.get(fixKey) || {}) };
    const doFetch = options.fetch || global.fetch;
    for (let attempt = 0; ; attempt += 1) {
      const body = buildBody({
        model: name,
        provider,
        task,
        temperature,
        maxTokens,
        stream,
        dropTemperature: Boolean(fixes.dropTemperature),
        tokenField: fixes.tokenField || "",
        messages: messages || [
          { role: "system", content: system || DEFAULT_SYSTEM },
          { role: "user", content: prompt }
        ]
      });
      const watchdog = createWatchdog(signal, stream ? firstByteMs : timeoutMs, stream ? "first" : "total");
      try {
        const res = await doFetch(`${url}/chat/completions`, {
          method: "POST",
          signal: watchdog.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(key).trim()}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          let json = null;
          try {
            json = await res.json();
          } catch {
            json = null;
          }
          const error = httpError(res, json);
          const fix = attempt < 2 ? paramFix(error, body) : "";
          if (fix) {
            if (fix === "temperature") fixes.dropTemperature = true;
            else fixes.tokenField = "max_completion_tokens";
            learnedFixes.set(fixKey, { ...fixes });
            continue;
          }
          throw error;
        }
        let text = "";
        let finishReason = "";
        let responseModel = name;
        if (stream && typeof res.body?.getReader === "function") {
          const out = await readStream(res, {
            onDelta,
            onActivity: () => watchdog.touch(idleMs)
          });
          text = out.text;
          finishReason = out.finishReason;
          responseModel = out.model || name;
        } else {
          let json;
          try {
            json = await res.json();
          } catch {
            throw markError(new Error("模型响应不是有效 JSON"), { invalidResponse: true });
          }
          if (unwrapJson(json)?.error) throw httpError(res, json);
          const choice = json?.choices?.[0];
          text = choice?.message?.content || "";
          finishReason = choice?.finish_reason || "";
          responseModel = json?.model || name;
          if (onDelta && stripThinking(text)) onDelta(stripThinking(text));
        }
        const clean = stripThinking(text);
        const truncated = finishReason === "length";
        if (!clean && !allowEmpty) {
          throw markError(
            new Error(truncated ? "模型输出被截断（达到长度上限），没有拿到正文" : "模型响应为空"),
            { invalidResponse: true, truncated }
          );
        }
        if (validate && !validate(clean)) {
          throw markError(
            new Error(truncated ? "模型输出被截断（达到长度上限），结果不完整" : "模型响应结构校验失败"),
            { invalidResponse: true, truncated }
          );
        }
        return { text: clean, model: responseModel, finishReason, truncated };
      } catch (error) {
        const fired = watchdog.fired();
        if (fired) throw markError(new Error(timeoutText(fired)), { status: 408 });
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        watchdog.done();
      }
    }
  }

  global.BiliCaptionModelCall = {
    DEFAULT_SYSTEM,
    DEFAULT_MODEL,
    FIRST_BYTE_MS,
    IDLE_MS,
    TIMEOUT_MS,
    defaultModel,
    stripThinking,
    markError,
    errorMessage,
    retryAfterMs,
    isRetryable,
    isFatal,
    buildBody,
    readStream,
    chat
  };
})(globalThis);
