(function (global) {
  // 字幕助手的纯逻辑：字幕上下文与提示词、多轮历史、回答里的时间点、每个视频一份的对话状态。
  // 不碰 DOM 和 chrome API（存储与模型请求由调用方注入），侧栏界面在 侧栏/字幕助手.js。
  // 依赖 lib/字幕工具.js（formatClock），需先加载；lib/outline.js、lib/translate.js 可选。

  // 字幕全文的字符预算：沿用大纲一次塞全文的上限（lib/outline.js 的 SUMMARY_CUE_CHAR_BUDGET）
  const DEFAULT_CONTEXT_BUDGET = 100000;
  // 超出预算改用节选：大纲最多占预算的 15%，当前播放位置附近最多占 25%
  const OUTLINE_SHARE = 0.15;
  const AROUND_SHARE = 0.25;
  // 当前播放位置前后各取 3 分钟；问题里写了时间点（如「12:30 那里」）的，前后各取 1.5 分钟
  const AROUND_SECONDS = 180;
  const QUESTION_TIME_SECONDS = 90;
  // 关键词匹配按段打分：相邻字幕拼成约 1500 字一段，取得分最高的至多 12 段
  const SEGMENT_CHARS = 1500;
  const KEYWORD_SEGMENT_MAX = 12;
  // 多轮历史：最多带最近 6 轮问答，合计不超过 8000 字
  const HISTORY_MAX_TURNS = 6;
  const HISTORY_CHAR_BUDGET = 8000;
  // 每个视频最多存 60 条消息（约 30 轮）
  const MAX_STORED_MESSAGES = 60;
  const ABORTED_MARK = "（已中断）";

  const ROLE_PROMPT = "你是视频助手，只根据下面的字幕回答问题，字幕里没有的就说没提到。用简洁中文回答，不要使用 Markdown。";
  const TIME_PROMPT = "提到视频里具体内容的位置时，在句中附上对应字幕行开头的时间点，格式为 [mm:ss]，超过 1 小时写成 [h:mm:ss]，例如 [03:12]、[1:02:05]。时间点只能取自下面字幕里出现过的时间，不要编造。";
  const EXCERPT_NOTE = "字幕全文太长，以下为节选：包括全片大纲（如有）、当前播放位置前后和与问题相关的片段，按时间顺序排列，片段之间用「……」隔开。节选里没有的内容不代表视频没讲，涉及时请说明只看到了部分字幕。";

  function formatClock(seconds) {
    return global.BiliCaptionCueTools.formatClock(seconds);
  }

  function contextBudget() {
    return Number(global.BiliCaptionOutline?.SUMMARY_CUE_CHAR_BUDGET) || DEFAULT_CONTEXT_BUDGET;
  }

  /** 去掉推理模型混进正文的 <think>，与翻译、统一调用层同一规则 */
  function stripFiller(text) {
    const fn = global.BiliCaptionTranslate?.stripModelFiller || global.BiliCaptionModelCall?.stripThinking;
    if (typeof fn === "function") return fn(text);
    return String(text || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*$/gi, "")
      .trim();
  }

  // ---------- 时间点 ----------

  const CLOCK = "(?:\\d{1,2}:)?\\d{1,3}:\\d{2}";
  // [03:12]、【1:02:05】、[03:12–04:30]：方括号或全角方头括号里的时间点（或时间段）
  const TIME_TOKEN = new RegExp(`[\\[【]\\s*(${CLOCK})(?:\\s*[-–—~～至到]\\s*(${CLOCK}))?\\s*[\\]】]`, "g");
  const BARE_CLOCK = new RegExp(`(?<![\\d:])(${CLOCK})(?![\\d:])`, "g");

  /** "03:12" → 192，"1:02:05" → 3725；秒数或（带小时时的）分钟数不合法返回 NaN */
  function clockToSeconds(value) {
    const hit = String(value ?? "").trim().match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
    if (!hit) return NaN;
    const hours = hit[1] ? Number(hit[1]) : 0;
    const minutes = Number(hit[2]);
    const seconds = Number(hit[3]);
    if (seconds >= 60) return NaN;
    if (hit[1] && minutes >= 60) return NaN;
    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * 把回答切成文字段和时间点段，供界面把时间点做成可点击的元素。
   * 时间段 [03:12–04:30] 算一个时间点，跳到开头；不合法的（如 [03:75]）原样留在文字里。
   */
  function parseAnswerSegments(text) {
    const src = String(text || "");
    const out = [];
    const pushText = (piece) => {
      if (!piece) return;
      const prev = out[out.length - 1];
      if (prev?.type === "text") prev.text += piece;
      else out.push({ type: "text", text: piece });
    };
    let last = 0;
    for (const hit of src.matchAll(TIME_TOKEN)) {
      const seconds = clockToSeconds(hit[1]);
      if (!Number.isFinite(seconds)) continue;
      if (hit[2] && !Number.isFinite(clockToSeconds(hit[2]))) continue;
      pushText(src.slice(last, hit.index));
      out.push({
        type: "time",
        text: hit[0],
        label: hit[2] ? `${hit[1]}–${hit[2]}` : hit[1],
        seconds
      });
      last = hit.index + hit[0].length;
    }
    pushText(src.slice(last));
    return out;
  }

  /** 问题里写到的时间点（可不带括号），用来把那附近的字幕也放进节选 */
  function questionTimes(question) {
    const out = [];
    for (const hit of String(question || "").matchAll(BARE_CLOCK)) {
      const seconds = clockToSeconds(hit[1]);
      if (Number.isFinite(seconds)) out.push(seconds);
    }
    return out;
  }

  // ---------- 关键词 ----------

  const CJK_STOP_WORDS = [
    "可不可以", "是不是", "有没有", "能不能", "为什么", "怎么样", "什么", "怎么", "怎样", "如何", "为何",
    "哪些", "哪个", "哪里", "哪儿", "多少", "是否", "这个", "那个", "这些", "那些", "这里", "那里",
    "视频", "一下", "一些", "一个", "可以", "还是", "我们", "你们", "他们", "她们", "它们",
    "讲了", "说了", "讲的", "说的", "提到", "介绍", "解释", "请问", "告诉", "以及", "然后", "就是",
    "的话", "时候", "里面", "之前", "之后", "博主", "作者"
  ];
  const CJK_STOP_CHARS = /[的了吗呢吧啊呀么哦嘛是在和与及或把被给对从向着过得地之其这那个有我你他她它们]/;
  const EN_STOP_WORDS = new Set([
    "the", "is", "are", "was", "were", "be", "to", "of", "and", "or", "in", "on", "for", "with", "this", "that",
    "it", "you", "we", "can", "will", "do", "does", "what", "how", "why", "when", "which", "who", "an", "at",
    "as", "by", "from", "about", "up"
  ]);

  /**
   * 从问题里取检索词：英文 / 数字按词；中文先去掉疑问词、虚词，再按两字切片（长片段另加整段）。
   * 不做分词，只求把「节点」「实例化」这类实词找出来。返回 [{ term, weight }]。
   */
  function questionTerms(question, weight = 1) {
    let text = String(question || "").toLowerCase().replace(BARE_CLOCK, " ");
    const out = new Map();
    const add = (term, w) => {
      if (!term) return;
      out.set(term, Math.max(out.get(term) || 0, w));
    };
    for (const word of text.match(/[a-z0-9][a-z0-9+#._-]*/g) || []) {
      const clean = word.replace(/[._-]+$/g, "");
      if (clean.length >= 2 && !EN_STOP_WORDS.has(clean)) add(clean, weight);
    }
    for (const stop of CJK_STOP_WORDS) text = text.split(stop).join(" ");
    for (const run of text.match(/[一-鿿]+/g) || []) {
      for (const piece of run.split(CJK_STOP_CHARS)) {
        if (piece.length < 2) continue;
        if (piece.length === 2) {
          add(piece, weight);
          continue;
        }
        if (piece.length <= 6) add(piece, weight * 1.5);
        for (let i = 0; i + 2 <= piece.length; i += 1) add(piece.slice(i, i + 2), weight);
      }
    }
    return [...out.entries()].map(([term, w]) => ({ term, weight: w }));
  }

  function countOccurrences(text, term, cap = 3) {
    let n = 0;
    let at = text.indexOf(term);
    while (at >= 0 && n < cap) {
      n += 1;
      at = text.indexOf(term, at + term.length);
    }
    return n;
  }

  /** 按检索词给各段打分（出现的段越少的词越值钱），高分在前；同分按时间先后 */
  function rankSegments(texts, terms) {
    const lower = texts.map((text) => String(text || "").toLowerCase());
    const count = lower.length;
    const weights = terms.map(({ term, weight }) => {
      const df = lower.filter((text) => text.includes(term)).length;
      return df ? weight * Math.log(1 + count / df) : 0;
    });
    return lower
      .map((text, index) => {
        let score = 0;
        terms.forEach(({ term }, k) => {
          if (!weights[k]) return;
          const n = countOccurrences(text, term);
          if (n) score += weights[k] * (1 + Math.log(n));
        });
        return { index, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  // ---------- 字幕上下文 ----------

  function cueText(cue) {
    return String(cue?.content || cue?.original || "").replace(/\s+/g, " ").trim();
  }

  function cueRows(cues) {
    const rows = [];
    (Array.isArray(cues) ? cues : []).forEach((cue, index) => {
      const text = cueText(cue);
      if (!text) return;
      const from = Math.max(0, Number(cue?.from) || 0);
      rows.push({ index, from, text, line: `[${formatClock(from)}] ${text}` });
    });
    // 按时间顺序（同一时间按原顺序）
    return rows.sort((a, b) => a.from - b.from || a.index - b.index);
  }

  function clip(text, max) {
    const src = String(text || "");
    if (src.length <= max) return src;
    return max > 1 ? `${src.slice(0, max - 1)}…` : "";
  }

  /** 已缓存的大纲转成给模型看的文字：全片总结 + 章节（含小节） */
  function formatOutlineForChat(chapters, summary = "") {
    const lines = [];
    const sum = String(summary || "").trim();
    if (sum) lines.push(`全片总结：${sum}`);
    const list = (Array.isArray(chapters) ? chapters : []).filter((ch) => String(ch?.title || "").trim());
    if (list.length) {
      lines.push("章节：");
      for (const ch of list) {
        const synopsis = String(ch.synopsis || "").trim();
        lines.push(`[${formatClock(ch.start)}–${formatClock(ch.end)}] ${String(ch.title).trim()}${synopsis ? `：${synopsis}` : ""}`);
        for (const sub of ch.subs || []) {
          if (String(sub?.title || "").trim()) lines.push(`  [${formatClock(sub.start)}] ${String(sub.title).trim()}`);
        }
      }
    }
    return lines.join("\n");
  }

  /** 相邻字幕拼段，每段约 SEGMENT_CHARS 字；返回每段的行下标 */
  function segmentRows(rows, target = SEGMENT_CHARS) {
    const segments = [];
    let current = [];
    let size = 0;
    rows.forEach((row, i) => {
      current.push(i);
      size += row.line.length + 1;
      if (size >= target) {
        segments.push(current);
        current = [];
        size = 0;
      }
    });
    if (current.length) segments.push(current);
    return segments;
  }

  /**
   * 给模型的字幕上下文。每行「[mm:ss] 字幕」（满 1 小时 h:mm:ss）。
   * 全文不超预算就全给（mode: "full"）；超了改给节选（mode: "excerpt"）：
   * 已有大纲 + 当前播放位置前后（及问题里写到的时间点附近）+ 与问题关键词最匹配的若干段，
   * 按时间顺序排列，不相邻的片段之间放一行「……」。
   */
  function buildSubtitleContext({
    cues = [],
    question = "",
    previousQuestion = "",
    currentTime = NaN,
    outline = [],
    videoSummary = "",
    budget = contextBudget()
  } = {}) {
    const rows = cueRows(cues);
    const fullChars = rows.reduce((n, row) => n + row.line.length + 1, 0);
    if (fullChars <= budget) {
      return { mode: "full", text: rows.map((row) => row.line).join("\n"), outline: "", lines: rows.length, total: rows.length };
    }

    const outlineText = clip(formatOutlineForChat(outline, videoSummary), Math.floor(budget * OUTLINE_SHARE));
    let room = budget - outlineText.length - EXCERPT_NOTE.length;
    const picked = new Set();
    const cost = (i) => rows[i].line.length + 1;
    const take = (i) => {
      if (picked.has(i)) return true;
      if (cost(i) > room) return false;
      picked.add(i);
      room -= cost(i);
      return true;
    };

    // 1. 当前播放位置、问题里写到的时间点附近：离锚点近的行优先
    const anchors = [];
    if (Number.isFinite(Number(currentTime)) && currentTime !== "" && currentTime != null) {
      anchors.push({ at: Number(currentTime), span: AROUND_SECONDS });
    }
    for (const at of questionTimes(question)) anchors.push({ at, span: QUESTION_TIME_SECONDS });
    let aroundRoom = Math.floor(budget * AROUND_SHARE);
    for (const anchor of anchors) {
      const near = rows
        .map((row, i) => ({ i, dist: Math.abs(row.from - anchor.at) }))
        .filter((item) => item.dist <= anchor.span)
        .sort((a, b) => a.dist - b.dist || a.i - b.i);
      for (const { i } of near) {
        if (picked.has(i)) continue;
        if (cost(i) > aroundRoom || !take(i)) break;
        aroundRoom -= cost(i);
      }
    }

    // 2. 关键词：本次问题为主，上一问（追问时常省略主语）减半计分
    const terms = [...questionTerms(question, 1)];
    for (const extra of questionTerms(previousQuestion, 0.5)) {
      if (!terms.some((item) => item.term === extra.term)) terms.push(extra);
    }
    if (terms.length) {
      const segments = segmentRows(rows);
      const ranked = rankSegments(segments.map((seg) => seg.map((i) => rows[i].text).join("\n")), terms);
      let used = 0;
      for (const { index, score } of ranked) {
        if (score <= 0 || used >= KEYWORD_SEGMENT_MAX) break;
        const seg = segments[index];
        const need = seg.filter((i) => !picked.has(i)).reduce((n, i) => n + cost(i), 0);
        if (!need) continue;
        if (need > room) continue;
        seg.forEach(take);
        used += 1;
      }
    }

    const order = [...picked].sort((a, b) => a - b);
    const lines = [];
    let prev = -1;
    for (const i of order) {
      if (prev >= 0 && i !== prev + 1) lines.push("……");
      lines.push(rows[i].line);
      prev = i;
    }
    return { mode: "excerpt", text: lines.join("\n"), outline: outlineText, lines: order.length, total: rows.length };
  }

  // ---------- 历史与请求消息 ----------

  /**
   * 挑出要带给模型的历史问答：只要有回答的轮次（出错的、没回答的不带；中断的部分回答带上并注明），
   * 保留最近 maxTurns 轮，再从最早的开始丢，直到合计不超过 maxChars。
   * 返回 [{ role: "user" | "assistant", content }]，按时间顺序。
   */
  function selectHistory(messages, { maxTurns = HISTORY_MAX_TURNS, maxChars = HISTORY_CHAR_BUDGET } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const pairs = [];
    for (let i = 0; i < list.length; i += 1) {
      const ask = list[i];
      const reply = list[i + 1];
      if (ask?.role !== "user" || reply?.role !== "ai") continue;
      if (reply.status === "error") continue;
      const question = String(ask.text || "").trim();
      const answer = String(reply.text || "").trim();
      if (!question || !answer) continue;
      pairs.push([
        { role: "user", content: question },
        { role: "assistant", content: reply.status === "aborted" ? `${answer}${ABORTED_MARK}` : answer }
      ]);
    }
    let kept = pairs.slice(-Math.max(0, maxTurns));
    const size = (items) => items.reduce((n, [ask, reply]) => n + ask.content.length + reply.content.length, 0);
    while (kept.length > 1 && size(kept) > maxChars) kept = kept.slice(1);
    if (kept.length === 1 && size(kept) > maxChars) {
      const [ask, reply] = kept[0];
      const room = Math.max(1, maxChars - ask.content.length);
      kept = [[ask, { ...reply, content: clip(reply.content, room) }]];
    }
    return kept.flat();
  }

  function buildSystemPrompt({ title = "", context }) {
    const parts = [ROLE_PROMPT, TIME_PROMPT];
    const name = String(title || "").trim();
    if (name) parts.push(`视频标题：${name}`);
    if (context.mode === "excerpt") {
      parts.push(EXCERPT_NOTE);
      if (context.outline) parts.push(`【大纲】\n${context.outline}`);
      parts.push(`【字幕节选】\n${context.text}`);
    } else {
      parts.push(`【字幕】\n${context.text}`);
    }
    return parts.join("\n\n");
  }

  /**
   * 一次提问的 messages：system（角色说明 + 字幕上下文，放最前，全文模式下同一视频每轮都一样，
   * 利于服务商的前缀缓存）→ 历史问答 → 本次问题（带当前播放位置）。
   */
  function buildChatMessages({
    cues = [],
    question = "",
    history = [],
    currentTime = NaN,
    outline = [],
    videoSummary = "",
    title = "",
    budget = contextBudget()
  } = {}) {
    const q = String(question || "").trim();
    const past = Array.isArray(history) ? history : [];
    const previousQuestion = [...past].reverse().find((item) => item?.role === "user")?.content || "";
    const context = buildSubtitleContext({ cues, question: q, previousQuestion, currentTime, outline, videoSummary, budget });
    const messages = [{ role: "system", content: buildSystemPrompt({ title, context }) }];
    for (const item of past) {
      if ((item?.role === "user" || item?.role === "assistant") && String(item.content || "").trim()) {
        messages.push({ role: item.role, content: String(item.content) });
      }
    }
    const t = Number(currentTime);
    const where = Number.isFinite(t) && t > 0 ? `（当前播放到 [${formatClock(t)}]）\n` : "";
    messages.push({ role: "user", content: `${where}${q}` });
    return messages;
  }

  /** Enter 发送；Shift+Enter 换行；输入法组字中（isComposing / keyCode 229）不发送 */
  function shouldSendOnKey(event) {
    if (!event || event.key !== "Enter") return false;
    if (event.shiftKey || event.isComposing || event.keyCode === 229) return false;
    return true;
  }

  /** 每个视频一份对话：与标记同一视频身份（bvid + cid；YouTube / X 是 yt_ / x_ 编号 + 1） */
  function chatStorageKey(video) {
    const bvid = String(video?.bvid || "");
    const cid = Number(video?.cid) || 0;
    if (!bvid && !cid) return "";
    return `chat:${bvid}:${cid}`;
  }

  // ---------- 对话状态 ----------

  function normalizeStored(raw) {
    const list = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || (item.role !== "user" && item.role !== "ai")) continue;
      const text = String(item.text ?? "");
      const status = item.role === "ai" && (item.status === "error" || item.status === "aborted") ? item.status : "";
      if (item.role === "user" && !text.trim()) continue;
      const next = { id: String(item.id || ""), role: item.role, text, at: Number(item.at) || 0 };
      if (status) next.status = status;
      list.push(next);
    }
    // 侧栏在回答途中被关掉：问题存下了、回答没有，按「已中断」补上，便于重新发送
    if (list.length && list[list.length - 1].role === "user") {
      list.push({ id: "", role: "ai", text: "", status: "aborted", at: 0 });
    }
    return list;
  }

  /** 没有 chrome.storage.session 时（测试、旧浏览器）退回内存存储 */
  function memoryStorage(seed = {}) {
    const store = { ...seed };
    return {
      store,
      async get(key) {
        return key in store ? { [key]: JSON.parse(JSON.stringify(store[key])) } : {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values || {})) store[key] = JSON.parse(JSON.stringify(value));
      },
      async remove(key) {
        for (const item of [].concat(key)) delete store[item];
      }
    };
  }

  function errorText(error) {
    const message = String(error?.message || error || "").trim();
    return message || "请求失败，请稍后重试";
  }

  /**
   * 对话状态机。storage：chrome.storage.session 风格（get / set / remove）；
   * request({ messages, signal, onDelta }) → 回答全文（onDelta 收到的是到目前为止的全文）；
   * hasConfig() → 是否已配置总结服务与 Key；onChange(kind) 在状态变化时调用，kind 为 "delta" 表示只是流式多了字。
   *
   * 中止（关面板、清空、切视频）：进行中的请求立即作废；关面板和切视频时，已收到的半截回答
   * 存成带「已中断」标记的消息（status: "aborted"），不当作完整回答；清空时直接丢弃。
   */
  function createChatController(options = {}) {
    const storage = options.storage || memoryStorage();
    const request = options.request;
    const hasConfig = options.hasConfig || (async () => true);
    const onChange = options.onChange || (() => {});
    const now = options.now || (() => Date.now());
    const maxStored = Math.max(2, Number(options.maxStored) || MAX_STORED_MESSAGES);

    const convos = new Map();
    const EMPTY = Object.freeze([]);
    let key = "";
    let ready = Promise.resolve();
    let openToken = 0;
    let epoch = 0;
    let pending = null;
    let starting = false;
    let notice = "";
    let seq = 0;

    const nextId = () => `${now().toString(36)}-${(seq += 1).toString(36)}`;
    const emit = (kind = "update") => {
      try {
        onChange(kind);
      } catch {
        // 界面刷新出错不影响对话状态
      }
    };

    function listFor(k) {
      if (!convos.has(k)) convos.set(k, []);
      return convos.get(k);
    }

    function append(k, message) {
      const list = listFor(k);
      list.push({ id: nextId(), at: now(), ...message });
      if (list.length > maxStored) list.splice(0, list.length - maxStored);
    }

    function persist(k) {
      if (!k) return Promise.resolve();
      const list = convos.get(k) || [];
      let task;
      try {
        task = list.length ? storage.set({ [k]: list.slice(-maxStored) }) : storage.remove(k);
      } catch {
        task = null;
      }
      return Promise.resolve(task).catch(() => {});
    }

    async function load(k) {
      let raw = null;
      try {
        raw = (await storage.get(k))?.[k];
      } catch {
        raw = null;
      }
      return normalizeStored(raw);
    }

    function abort({ keep = true } = {}) {
      const req = pending;
      if (!req) return false;
      pending = null;
      try {
        req.ctrl.abort();
      } catch {
        // ignore
      }
      if (keep) {
        append(req.key, { role: "ai", status: "aborted", text: req.text });
        persist(req.key);
      }
      emit();
      return true;
    }

    /** 切到某个视频的对话：先中止进行中的请求（半截回答存回它自己的视频），再读这个视频的对话 */
    function open(nextKey) {
      const k = String(nextKey || "");
      if (k === key) return ready;
      abort({ keep: true });
      key = k;
      epoch += 1;
      const token = ++openToken;
      if (!k || convos.has(k)) {
        ready = Promise.resolve();
        emit();
        return ready;
      }
      emit();
      ready = load(k).then((list) => {
        if (!convos.has(k)) convos.set(k, list);
        if (token === openToken) emit();
      });
      return ready;
    }

    function finish(req, message) {
      if (pending === req) pending = null;
      append(req.key, message);
      persist(req.key);
      emit();
    }

    /**
     * 发送一个问题。返回状态：done / error / aborted（请求被中止或期间切了视频）/
     * busy（已有请求在进行）/ empty（空问题）/ no-cues（没有字幕）/ no-config（没配置服务）。
     * retry：重新发送最后一个没答成的问题（去掉它后面的错误 / 中断消息，不重复加问题）。
     * onStart：问题已被接受、即将请求时调用（界面据此清空输入框）。
     */
    async function send(question, context = {}, { retry = false, onStart } = {}) {
      const q = String(question || "").trim();
      if (!q) return "empty";
      if (pending || starting) return "busy";
      const k = key;
      const e = epoch;
      starting = true;
      let status = "";
      try {
        await ready;
        if (key !== k || epoch !== e) status = "aborted";
        else if (!context?.cues?.length) status = "no-cues";
        else {
          let ok = false;
          try {
            ok = Boolean(await hasConfig());
          } catch {
            ok = false;
          }
          if (key !== k || epoch !== e) status = "aborted";
          else if (!ok) status = "no-config";
        }
      } finally {
        starting = false;
      }
      if (status === "no-config") {
        notice = "config";
        emit();
        return status;
      }
      if (status) return status;
      if (pending) return "busy";
      notice = "";

      const list = listFor(k);
      if (retry) {
        while (list.length && list[list.length - 1].role === "ai" && list[list.length - 1].status) list.pop();
        const last = list[list.length - 1];
        if (!(last?.role === "user" && String(last.text).trim() === q)) append(k, { role: "user", text: q });
      } else {
        append(k, { role: "user", text: q });
      }
      const history = selectHistory(list.slice(0, -1));
      const messages = buildChatMessages({ ...context, question: q, history });
      const req = { id: nextId(), key: k, question: q, text: "", started: false, ctrl: new AbortController() };
      pending = req;
      persist(k);
      try {
        onStart?.();
      } catch {
        // ignore
      }
      emit();
      try {
        const raw = await request({
          messages,
          signal: req.ctrl.signal,
          onDelta(full) {
            if (pending !== req) return;
            const clean = stripFiller(full);
            if (!clean || clean === req.text) return;
            req.text = clean;
            req.started = true;
            emit("delta");
          }
        });
        if (pending !== req) return "aborted";
        const text = stripFiller(raw) || req.text;
        if (!text) throw new Error("模型响应为空");
        finish(req, { role: "ai", text });
        return "done";
      } catch (error) {
        if (pending !== req) return "aborted";
        if (req.ctrl.signal.aborted || error?.name === "AbortError") {
          finish(req, { role: "ai", status: "aborted", text: req.text });
          return "aborted";
        }
        finish(req, { role: "ai", status: "error", text: errorText(error) });
        return "error";
      }
    }

    /** 可重新发送的问题：最后一条是出错 / 中断的回答时，它前面那个问题 */
    function retryQuestion() {
      const list = convos.get(key) || [];
      let i = list.length - 1;
      if (!(list[i]?.role === "ai" && list[i].status)) return "";
      while (i >= 0 && list[i].role === "ai" && list[i].status) i -= 1;
      return list[i]?.role === "user" ? String(list[i].text || "").trim() : "";
    }

    function retry(context, opts = {}) {
      const q = retryQuestion();
      if (!q) return Promise.resolve("empty");
      return send(q, context, { ...opts, retry: true });
    }

    /** 清空当前视频的对话（进行中的请求直接丢弃） */
    async function clear() {
      abort({ keep: false });
      epoch += 1;
      notice = "";
      const k = key;
      if (!k) {
        emit();
        return;
      }
      convos.set(k, []);
      emit();
      await persist(k);
    }

    /** 打开面板时先查一次配置，没配置就先给出提示 */
    async function checkConfig() {
      let ok = false;
      try {
        ok = Boolean(await hasConfig());
      } catch {
        ok = false;
      }
      const next = ok ? "" : "config";
      if (next !== notice) {
        notice = next;
        emit();
      }
      return ok;
    }

    return {
      get key() { return key; },
      get messages() { return convos.get(key) || EMPTY; },
      get pending() { return pending ? { text: pending.text, started: pending.started, question: pending.question } : null; },
      get busy() { return Boolean(pending || starting); },
      get notice() { return notice; },
      get canRetry() { return !pending && Boolean(retryQuestion()); },
      ready: () => ready,
      open,
      send,
      retry,
      abort,
      clear,
      checkConfig
    };
  }

  global.BiliCaptionChat = {
    DEFAULT_CONTEXT_BUDGET,
    AROUND_SECONDS,
    QUESTION_TIME_SECONDS,
    SEGMENT_CHARS,
    KEYWORD_SEGMENT_MAX,
    HISTORY_MAX_TURNS,
    HISTORY_CHAR_BUDGET,
    MAX_STORED_MESSAGES,
    ABORTED_MARK,
    ROLE_PROMPT,
    TIME_PROMPT,
    EXCERPT_NOTE,
    contextBudget,
    stripFiller,
    clockToSeconds,
    parseAnswerSegments,
    questionTimes,
    questionTerms,
    rankSegments,
    formatOutlineForChat,
    buildSubtitleContext,
    selectHistory,
    buildSystemPrompt,
    buildChatMessages,
    shouldSendOnKey,
    chatStorageKey,
    normalizeStored,
    memoryStorage,
    createChatController
  };
})(globalThis);
