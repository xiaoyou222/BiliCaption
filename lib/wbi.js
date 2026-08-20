(function (global) {
  const MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
    13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
    44, 52
  ];

  let cached = null;
  let cachedAt = 0;

  function fileKey(url) {
    const name = String(url || "").split("/").pop() || "";
    return name.split(".")[0] || "";
  }

  function mixinKey(imgKey, subKey) {
    const raw = `${imgKey}${subKey}`;
    return MIXIN_TAB.map((i) => raw[i] || "").join("").slice(0, 32);
  }

  async function getKeys() {
    if (cached && Date.now() - cachedAt < 10 * 60 * 1000) return cached;
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
    const json = await res.json();
    const img = json?.data?.wbi_img?.img_url;
    const sub = json?.data?.wbi_img?.sub_url;
    if (!img || !sub) throw new Error("无法获取 WBI 密钥，请确认已登录 B 站");
    cached = { imgKey: fileKey(img), subKey: fileKey(sub) };
    cachedAt = Date.now();
    return cached;
  }

  async function signQuery(params) {
    const { imgKey, subKey } = await getKeys();
    const key = mixinKey(imgKey, subKey);
    const next = { ...params, wts: Math.floor(Date.now() / 1000) };
    const filtered = {};
    for (const [k, v] of Object.entries(next)) {
      filtered[k] = String(v).replace(/[!'()*]/g, "");
    }
    const query = Object.keys(filtered)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k])}`)
      .join("&");
    const wrid = global.BiliCaptionMD5(query + key);
    return `${query}&w_rid=${wrid}`;
  }

  global.BiliCaptionWbi = { signQuery };
})(globalThis);
