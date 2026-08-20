(function (global) {
  function requestFields() {
    return {};
  }

  function markError(error, { status = 0, invalidResponse = false } = {}) {
    const next = error instanceof Error ? error : new Error(String(error || "模型请求失败"));
    if (status) next.status = Number(status) || 0;
    if (invalidResponse) next.invalidResponse = true;
    return next;
  }

  function shouldFallback(error) {
    if (!error || error.name === "AbortError" || error.canceled) return false;
    if (error.invalidResponse) return true;
    const status = Number(error.status) || 0;
    if ([402, 408, 425, 429].includes(status) || status >= 500) return true;
    const raw = String(error.message || error);
    return error instanceof TypeError
      || /timeout|timed out|network|failed to fetch|connection|限流|额度|响应为空|结构校验失败/i.test(raw);
  }

  function fallbackFor() {
    return "";
  }

  global.BiliCaptionModelRoute = {
    isPrimaryAlias: () => false,
    isBusinessAlias: () => false,
    requestFields,
    markError,
    shouldFallback,
    fallbackFor
  };
})(globalThis);
