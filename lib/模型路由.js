(function (global) {
  // 各服务商「关闭 / 降低思考」的参数按官方文档逐家核对，不能互相套用（2026-09 查证）：
  // - Gemini（OpenAI 兼容接口）：字段是 reasoning_effort。2.5 Flash 可设 "none" 关闭思考；
  //   2.5 Pro 与 Gemini 3 系列关不掉，只能降到 "low"（3.7/3.8 Flash 不支持 minimal，统一用 low）；
  //   Flash-Lite 默认不思考或只做最少思考，不加参数。
  //   https://ai.google.dev/gemini-api/docs/openai
  //   https://ai.google.dev/gemini-api/docs/thinking
  // - DeepSeek：V4 起同一个模型名默认开启思考，关闭用 thinking: { type: "disabled" }。
  //   https://api-docs.deepseek.com/guides/thinking_mode
  // - OpenAI：见下方 OPENAI_* 的说明；默认 gpt-4o-mini 不是推理模型，不发 reasoning_effort。
  // - 自定义：可能是用户自己的网关（模型名可能是网关别名），一律不发厂商专用参数。
  // 只有速度敏感、不需要复杂推理的任务（翻译）才降思考；总结、大纲、润色保持服务商默认。
  const FAST_TASKS = new Set(["translate"]);

  // OpenAI 推理模型（2026-09 按官方文档查证）：
  // - 模型页标了 Reasoning token support 的是推理模型：o 系列、gpt-5 及之后各代（含 mini / nano / pro）；
  //   gpt-4o、gpt-4.1 系列不是（gpt-4.1 页写明是 non-reasoning）；*-chat-latest 没标，按普通模型处理。
  //   https://developers.openai.com/api/docs/models
  // - temperature：GPT-5.2 指南写明 temperature / top_p / logprobs 只在 reasoning_effort 为 none 时支持，
  //   其它强度以及 gpt-5 / gpt-5-mini / gpt-5-nano 带上会报错；GPT-6 指南要求强度不是 none 时去掉这些参数。
  //   所以推理模型一律不发 temperature。
  //   https://developers.openai.com/api/docs/guides/latest-model
  // - max_tokens：Chat Completions 参考标为已弃用、与 o 系列不兼容，改用 max_completion_tokens（含推理 token）。
  //   https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
  // - 翻译取各模型页写明支持的最低强度（快照名去掉日期后比对）。没列在这里的（gpt-5-pro 只支持 high、
  //   o 系列模型页没列可选值、以后的新型号）不发强度，保持默认，免得发了不支持的值被 400。
  const OPENAI_LOWEST_EFFORT = {
    "gpt-5": "minimal",
    "gpt-5-mini": "minimal",
    "gpt-5-nano": "minimal",
    "gpt-5.1": "none",
    "gpt-5.2": "none",
    "gpt-5.2-pro": "medium",
    "gpt-5.4": "none",
    "gpt-5.4-mini": "none",
    "gpt-5.5": "none",
    "gpt-5.5-pro": "medium",
    "gpt-5.6": "none",
    "gpt-5.6-sol": "none",
    "gpt-5.6-terra": "none",
    "gpt-5.6-luna": "none",
    // GPT-6 Astra 不支持 none（发了返回 400），最低 low
    "gpt-6-astra": "low",
    "gpt-6-sol": "none",
    "gpt-6-luna": "none"
  };

  function modelName(model) {
    return String(model || "").trim().toLowerCase().replace(/^models\//, "");
  }

  function geminiFields(model) {
    const name = modelName(model);
    if (/lite/.test(name)) return {};
    if (/^gemini-2\.5-flash/.test(name)) return { reasoning_effort: "none" };
    if (/^gemini-2\.5-pro/.test(name)) return { reasoning_effort: "low" };
    if (/^gemini-3(?:\.\d+)?-(?:flash|pro)/.test(name)) return { reasoning_effort: "low" };
    return {};
  }

  function deepseekFields(model) {
    const name = modelName(model);
    // deepseek-chat / deepseek-reasoner 已于 2026-07-24 下线，不再给它们配参数。
    if (/^deepseek-(?:flash|v4)/.test(name)) return { thinking: { type: "disabled" } };
    return {};
  }

  /** OpenAI 模型名去掉快照日期（gpt-5-mini-2025-08-07 → gpt-5-mini） */
  function openaiBase(model) {
    return modelName(model).replace(/-\d{4}-\d{2}-\d{2}$/, "");
  }

  function openaiReasoning(model) {
    const name = openaiBase(model);
    if (/chat/.test(name)) return false;
    if (/^o\d/.test(name)) return true;
    const major = Number(name.match(/^gpt-(\d+)/)?.[1]) || 0;
    return major >= 5;
  }

  function openaiFields(model) {
    const effort = OPENAI_LOWEST_EFFORT[openaiBase(model)];
    return effort ? { reasoning_effort: effort } : {};
  }

  function requestFields({ provider = "", model = "", task = "" } = {}) {
    if (!FAST_TASKS.has(task)) return {};
    if (provider === "Gemini") return geminiFields(model);
    if (provider === "DeepSeek") return deepseekFields(model);
    if (provider === "OpenAI" && openaiReasoning(model)) return openaiFields(model);
    return {};
  }

  /**
   * 一次请求该怎么拼：fields 是要并进请求体的思考参数；temperature 为 false 时不发 temperature；
   * tokenField 是输出上限用的字段名。自定义服务商按通用 OpenAI 兼容格式发，不做厂商判断。
   */
  function requestPlan({ provider = "", model = "", task = "" } = {}) {
    const plan = { fields: requestFields({ provider, model, task }), temperature: true, tokenField: "max_tokens" };
    if (provider === "OpenAI") {
      plan.tokenField = "max_completion_tokens";
      if (openaiReasoning(model)) plan.temperature = false;
    }
    // Gemini 3 系列官方强烈建议 temperature 保持默认值 1.0，3.x 起建议从请求里删掉采样参数
    // https://ai.google.dev/gemini-api/docs/gemini-3
    // https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
    if (provider === "Gemini" && /^gemini-3/.test(modelName(model))) plan.temperature = false;
    return plan;
  }

  global.BiliCaptionModelRoute = {
    requestFields,
    requestPlan
  };
})(globalThis);
