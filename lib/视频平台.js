/* 平台编号沿用旧存储字段 bvid，新增前缀不含冒号，兼容缓存与 WebDAV。 */
(function (global) {
  // manifest 的 content_scripts、后台安装时补注入、侧栏补注入共用这一份清单；
  // 只注入 content.js 时 YouTube / X 会被当成非视频页，内容脚本也会直接报错。
  const CONTENT_SCRIPT_FILES = Object.freeze(['lib/视频平台.js', 'lib/字幕工具.js', '内容/样式.js', 'content.js']);
  // 支持站点的域名只在这里列一份。manifest 是静态清单，readPage / readBangumiPage 注入页面时
  // 只序列化函数源码、引用不到这些常量，这两处仍各自写死。
  const YOUTUBE_HOSTS = Object.freeze(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
  const X_HOSTS = Object.freeze(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  // chrome.tabs.query 用的地址匹配式：启用侧栏、补注入内容脚本、找仍开着某个视频的标签页。
  const TAB_URL_PATTERNS = Object.freeze(['*://*.bilibili.com/*', '*://*.youtube.com/*', '*://youtube.com/*', ...X_HOSTS.map((host) => `*://${host}/*`)]);
  // 后台只监听 YouTube 播放器发出的字幕请求（webRequest 过滤器）。
  const YOUTUBE_CUE_URL_PATTERNS = Object.freeze(YOUTUBE_HOSTS.map((host) => `https://${host}/api/timedtext*`));
  /** 内容脚本所在页面的域名：B 站各子域、YouTube、X */
  function isSupportedHost(host) {
    const name = String(host || '').toLowerCase();
    return name === 'www.bilibili.com' || name.endsWith('.bilibili.com') || YOUTUBE_HOSTS.includes(name) || X_HOSTS.includes(name);
  }
  function platform(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return '';
      if (u.hostname === 'www.bilibili.com') return 'bilibili';
      if (YOUTUBE_HOSTS.includes(u.hostname)) return 'youtube';
      if (X_HOSTS.includes(u.hostname)) return 'x';
    } catch {}
    return '';
  }
  function parse(url) {
    const site = platform(url);
    if (!site || site === 'bilibili') return null;
    const u = new URL(url);
    if (site === 'youtube') {
      const id = u.searchParams.get('v');
      if (u.pathname !== '/watch' || !/^[\w-]{11}$/.test(id || '')) return { kind: 'other', platform: site };
      return { kind: 'youtube', platform: site, videoId: id, bvid: `yt_${id}`, cid: 1 };
    }
    const m = u.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status)\/(\d+)(?:\/video\/([1-4]))?\/?$/);
    if (!m) return { kind: 'other', platform: site };
    const mediaIndex = Number(m[2]) || 1;
    return { kind: 'x', platform: site, videoId: m[1], mediaIndex, explicitMedia: Boolean(m[2]), bvid: `x_${m[1]}_${mediaIndex}`, cid: 1 };
  }
  function xSelection(doc, page) {
    // 只认本帖自己的时间或媒体链接，不拿回复、引用帖或推荐视频充当当前视频。
    const article = [...doc.querySelectorAll('article')].find((el) =>
      [...el.querySelectorAll('a[href]')].some((a) => (a.querySelector('time') || a.hasAttribute('data-timezone') || a.getAttribute('aria-label') === 'View media') &&
        new RegExp(`/status/${page.videoId}(?:/|$)`).test(new URL(a.href, 'https://x.com').pathname)));
    const dialog = doc.querySelector('[role="dialog"]');
    const scope = page.explicitMedia && dialog?.querySelector('video') ? dialog : article;
    if (!scope) return { video: null, mediaIndex: page.mediaIndex };
    const videos = [...scope.querySelectorAll('video')].filter((v) => !v.closest('[data-testid="quoteTweet"]'));
    let video = page.explicitMedia ? videos[page.mediaIndex - 1] : videos.find((v) => !v.paused) || videos[0];
    // 视频详情弹层通常只挂载一个播放器。
    if (!video && page.explicitMedia && scope !== article && videos.length === 1) video = videos[0];
    const mediaIndex = page.explicitMedia ? page.mediaIndex : Math.max(1, videos.indexOf(video) + 1);
    return { video: video || null, mediaIndex };
  }
  function videoUrl(id, time = 0) {
    const t = Math.max(0, Math.floor(Number(time) || 0));
    if (/^yt_[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id.slice(3)}${t ? `&t=${t}s` : ''}`;
    const x = String(id).match(/^x_(\d+)_([1-4])$/);
    if (x) return `https://x.com/i/web/status/${x[1]}/video/${x[2]}${t ? `?t=${t}` : ''}`;
    return `https://www.bilibili.com/video/${id}${t ? `?t=${t}` : ''}`;
  }
  function cueUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
      if (YOUTUBE_HOSTS.includes(u.hostname)) return u.pathname === '/api/timedtext';
      return u.hostname === 'video.twimg.com' || u.hostname === 'pbs.twimg.com';
    } catch { return false; }
  }
  function siteName(platform) {
    if (platform === 'youtube') return 'YouTube';
    if (platform === 'x') return 'X';
    return 'B 站';
  }
  function chromeTitle(platform) {
    return platform === 'youtube' || platform === 'x' ? `${siteName(platform)} 字幕` : 'BiliCaption';
  }
  function actionTitle(platform) {
    return platform === 'youtube' || platform === 'x' ? `打开 ${siteName(platform)} 字幕侧边栏` : '打开 BiliCaption 侧边栏';
  }
  function labels(platform) {
    const site = siteName(platform);
    const external = platform === 'youtube' || platform === 'x';
    return {
      site,
      panel: chromeTitle(platform),
      action: actionTitle(platform),
      other: external ? `当前不是${site}视频页` : '当前标签页不是视频页',
      login: external ? site : '未登录',
      loginError: '未登录 B 站',
      waiting: '正在读取视频信息…',
      ad: '广告播放中，结束后会自动读取字幕'
    };
  }
  function isPending(error) {
    return /尚未就绪|广告播放中|请先播放本帖视频/.test(String(error?.message || error || ''));
  }
  function clipChars(text, max) {
    const chars = Array.from(String(text || ''));
    if (chars.length <= max) return chars.join('');
    return `${chars.slice(0, max).join('').trimEnd()}…`;
  }
  function cleanPageTitle(raw) {
    let text = String(raw || '').trim();
    text = text.replace(/\s*[/|]\s*(?:X|Twitter)\s*$/i, '');
    text = text.replace(/^.*?\bon X:\s*/i, '');
    text = text.replace(/^["“]|["”]$/g, '').trim();
    if (/^(?:X|Twitter)$/i.test(text)) return '';
    return text;
  }
  // X 没有独立视频标题。顶栏只用短句，悬停和缓存里的完整说明另存，避免整段推文进状态。
  function xHeadline({ text = '', author = '', pageTitle = '' } = {}) {
    const raw = String(text || '').replace(/\r/g, '').trim();
    const body = raw || cleanPageTitle(pageTitle);
    if (!body) {
      const name = String(author || '').replace(/\s+/g, ' ').trim();
      if (!name) return { title: '', titleFull: '' };
      const title = clipChars(`${name}的视频`, 40);
      return { title, titleFull: title };
    }
    const flat = body.replace(/[ \t]+/g, ' ').trim();
    const firstLine = flat.split(/\n/)[0].trim();
    const sentence = (firstLine.split(/[。！？!?]/)[0] || firstLine).trim() || flat;
    const title = clipChars(sentence, 40);
    const titleFull = clipChars(flat.replace(/\n+/g, ' '), 200);
    return { title, titleFull };
  }
  function headerLabel(next) {
    const platform = next?.platform || next?.login?.platform || '';
    const ready = Boolean(next?.cues?.length) || (next?.page === 'video' && (next?.bvid || next?.cid));
    const waiting = next?.page === 'loading' || next?.subtitleStatus === 'pending';
    if (next?.page === 'other') {
      return { text: labels(platform).other, tip: '' };
    }
    let title = String(next?.title || '').trim();
    let tip = String(next?.titleFull || '').trim();
    const part = String(next?.part || '').trim();
    if (platform === 'x') {
      const shaped = title
        ? xHeadline({ text: tip || title })
        : xHeadline({ author: next?.up || '' });
      if (title || (ready && !waiting)) {
        title = shaped.title || (ready && !waiting ? '视频' : '');
        tip = shaped.titleFull || title;
      }
    }
    if (!title) {
      if (waiting) return { text: labels(platform).waiting, tip: '' };
      if (ready) return { text: '视频', tip: '' };
      return { text: '等待视频', tip: '' };
    }
    const text = part && part !== title ? `${title} · ${part}` : title;
    return { text, tip: tip || text };
  }
  function isRateLimited(error) {
    return /限流|429/.test(String(error?.message || error || ''));
  }
  // ---- YouTube 自动字幕（ASR）json3：滚动式逐词字幕拼回整句 ----
  // 思路参考开源项目 read-frog（GPLv3），代码为独立实现。
  // 滚动式 ASR 的 json3：每个带 wWinId 的 event 是滚动窗口里新出现的一行（几个词），
  // segs[].tOffsetMs 是词相对 event 起点的偏移；aAppend=1 的 event 往当前行追加内容（多为换行）。
  // event 的 dDurationMs 是这一行在屏幕上停留的时长，会和后面几行重叠，不能直接当字幕时间。
  // 断句长度与 后台/切句.js 的 shouldSplitCue / splitLongCue 保持一致（该文件只在后台加载，这里不能直接引用）：
  // 超过 56 字（不计空白）或 12 秒优先找逗号 / 停顿处断开，72 字或 16 秒强制断开。
  const ROLLING_SOFT_CHARS = 56;
  const ROLLING_HARD_CHARS = 72;
  const ROLLING_SOFT_MS = 12000;
  const ROLLING_HARD_MS = 16000;
  // 词之间停顿超过这个值就断句；末词没有下一词可参照时，时长最多按这个值估。
  const ROLLING_PAUSE_MS = 1000;
  const ROLLING_WORD_MAX_MS = 1500;
  // 声音标注里常见的词：方括号 / 圆括号里只有这些词时整段丢掉。
  const ROLLING_SOUND_WORDS = /^(?:music|musique|música|musik|applause|laughter|laughs?|laughing|cheering|cheers|crowd|noise|silence|inaudible|foreign|bleep|sighs?|gasps?|coughs?|clapping|whistling|singing|instrumental|音乐|音樂|掌声|掌聲|笑声|笑聲|鼓掌|欢呼|歡呼|笑|音楽|拍手|笑い|음악|박수|웃음)$/i;
  // 没有逗号只能硬切时，优先切在这些连接词前面
  const ROLLING_JOINERS = /^(?:and|but|or|so|because|since|then|which|who|where|when|while|if|although|though|until|after|before)$/i;
  // 这些以句点结尾的词不算句末
  const ROLLING_ABBREV = /^(?:mr|mrs|ms|dr|prof|st|vs|etc|jr|sr|no|e\.g|i\.e|u\.s|a\.m|p\.m)\.$/i;

  /** 只有同时出现 aAppend，且带窗口编号或词级偏移时，才按滚动式 ASR 处理；人工字幕不带这些字段 */
  function isRollingAsrJson3(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    let append = false;
    let rolling = false;
    for (const e of events) {
      if (!e || !Array.isArray(e.segs)) continue;
      if (e.aAppend) append = true;
      if (e.wWinId != null || e.segs.some((s) => s && s.tOffsetMs != null)) rolling = true;
      if (append && rolling) return true;
    }
    return false;
  }

  /** 整段是声音标注（[Music]、(applause)、[音乐] 之类）时返回 true */
  function isRollingSoundTag(text) {
    const m = String(text || '').trim().match(/^[[(（【]\s*([^\])）】]{1,40}?)\s*[\])）】]$/);
    if (!m) return false;
    if (text.trim().startsWith('[')) return true;
    return m[1].split(/[\s,，/&]+/).filter(Boolean).every((w) => ROLLING_SOUND_WORDS.test(w));
  }

  function rollingCharCount(text) {
    return String(text || '').replace(/\s+/g, '').length;
  }

  /** 两段拼接时要不要加空格：中日文字两侧不加，其它（英文等）加 */
  function rollingJoin(left, right, spaced) {
    if (!left) return right;
    if (!right) return left;
    const cjk = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
    const space = spaced == null ? !(cjk.test(left.slice(-1)) || cjk.test(right[0])) : spaced;
    return space ? `${left} ${right}` : `${left}${right}`;
  }

  /** 把全部 event 摊平成带时间的词：{ text, start, end, spaced, speaker, breakBefore }（毫秒） */
  function rollingAsrWords(data) {
    const events = (Array.isArray(data?.events) ? data.events : [])
      .filter((e) => e && Array.isArray(e.segs) && Number.isFinite(Number(e.tStartMs)))
      .map((e, order) => ({ e, order, start: Number(e.tStartMs) }))
      .sort((a, b) => a.start - b.start || a.order - b.order);
    const words = [];
    let pendingBreak = false;
    for (const { e, start } of events) {
      const eventEnd = start + Math.max(0, Number(e.dDurationMs) || 0);
      e.segs.forEach((seg, index) => {
        let text = String(seg?.utf8 || '');
        let speaker = Boolean(seg?.isSpeakerChange);
        // ">>" 是说话人切换的标记，不属于正文
        if (/^\s*>>/.test(text)) { speaker = true; text = text.replace(/^\s*>>\s*/, ''); }
        const spacedRaw = index > 0 ? /^\s/.test(text) : null;
        text = text.replace(/[[(（【][^\])）】]{1,40}[\])）】]/g, (tag) => (isRollingSoundTag(tag) ? ' ' : tag));
        const clean = text.replace(/\s+/g, ' ').trim();
        if (speaker) pendingBreak = true;
        if (!clean) {
          // 纯换行只是滚动窗口换行，不断句；被去掉的声音标注要断句
          if (/\S/.test(String(seg?.utf8 || '').replace(/^\s*>>/, ''))) {
            pendingBreak = true;
            // 声音标注开始时，上一个词一定已经说完
            const last = words[words.length - 1];
            const tagStart = start + Math.max(0, Number(seg?.tOffsetMs) || 0);
            if (last && tagStart > last.start) last.limit = Math.min(last.limit ?? Infinity, tagStart);
          }
          return;
        }
        const wordStart = start + Math.max(0, Number(seg?.tOffsetMs) || 0);
        words.push({ text: clean, start: wordStart, eventEnd, spaced: spacedRaw, breakBefore: pendingBreak });
        pendingBreak = false;
      });
    }
    words.sort((a, b) => a.start - b.start);
    // 词的结束：下一词开始、所在 event 结束、估算上限三者取最早
    words.forEach((w, i) => {
      const next = words[i + 1];
      let end = Math.min(w.eventEnd > w.start ? w.eventEnd : Infinity, w.start + ROLLING_WORD_MAX_MS);
      if (next) end = Math.min(end, next.start);
      if (w.limit != null) end = Math.min(end, w.limit);
      w.end = Math.max(w.start, end);
    });
    return words;
  }

  /** 滚动式 ASR json3 → 整句字幕行（秒），相邻句不重叠 */
  function rollingAsrRows(data) {
    const words = rollingAsrWords(data);
    const textOf = (list) => list.reduce((acc, w) => rollingJoin(acc, w.text, acc ? w.spaced : null), '');
    const endsSentence = (t) => /[.!?…。！？]["'”’)]*$/.test(t) && !ROLLING_ABBREV.test(t) && !/^\d+\.$/.test(t);
    const endsClause = (t) => /[,;:，、；：]["'”’)]*$/.test(t);
    // 第一步：按句末标点、说话人切换、声音标注、停顿切成整句
    const sentences = [];
    let buf = [];
    for (const w of words) {
      const prev = buf[buf.length - 1];
      if (prev && (w.breakBefore || w.start - prev.end >= ROLLING_PAUSE_MS)) { sentences.push(buf); buf = []; }
      buf.push(w);
      if (endsSentence(w.text)) { sentences.push(buf); buf = []; }
    }
    if (buf.length) sentences.push(buf);
    // 第二步：过长的句子二分：优先在逗号处、两边尽量均衡；没有逗号且不超硬上限就整句保留，
    // 超了再在中段停顿最长的词缝处切。两边都至少留 ROLLING_MIN_CHARS 个字，避免「Well,」这种碎片。
    const ROLLING_MIN_CHARS = 10;
    const pieces = [];
    const splitLong = (list) => {
      const chars = rollingCharCount(textOf(list));
      const span = list[list.length - 1].end - list[0].start;
      if (list.length < 2 || (chars <= ROLLING_SOFT_CHARS && span <= ROLLING_SOFT_MS)) { pieces.push(list); return; }
      const before = [0];
      for (const w of list) before.push(before[before.length - 1] + rollingCharCount(w.text));
      const fair = (i) => before[i] >= ROLLING_MIN_CHARS && chars - before[i] >= ROLLING_MIN_CHARS;
      let cut = 0;
      let best = Infinity;
      for (let i = 1; i < list.length; i += 1) {
        if (!fair(i) || !endsClause(list[i - 1].text)) continue;
        const off = Math.abs(before[i] - chars / 2);
        if (off < best) { best = off; cut = i; }
      }
      if (!cut) {
        if (chars <= ROLLING_HARD_CHARS && span <= ROLLING_HARD_MS) { pieces.push(list); return; }
        let score = -Infinity;
        for (let i = 1; i < list.length; i += 1) {
          const ratio = before[i] / chars;
          if (ratio < 0.3 || ratio > 0.7) continue;
          const gap = list[i].start - list[i - 1].end;
          const s = gap - Math.abs(ratio - 0.5) * 1000 + (ROLLING_JOINERS.test(list[i].text) ? 400 : 0);
          if (s > score) { score = s; cut = i; }
        }
        if (!cut) cut = Math.ceil(list.length / 2);
      }
      splitLong(list.slice(0, cut));
      splitLong(list.slice(cut));
    };
    sentences.forEach(splitLong);
    const rows = pieces.map((part) => ({ from: part[0].start / 1000, to: part[part.length - 1].end / 1000, content: textOf(part) }));
    // 保证不重叠、时长为正：上一句最多到下一句开始；和下一句同时开始的并进下一句
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const next = rows[i + 1];
      if (next && row.to > next.from) row.to = next.from;
      if (row.to <= row.from) {
        if (next) {
          next.content = rollingJoin(row.content, next.content, null);
          next.from = row.from;
          continue;
        }
        row.to = row.from + 0.2;
      }
      out.push({ from: Math.round(row.from * 1000) / 1000, to: Math.round(row.to * 1000) / 1000, content: row.content });
    }
    return out;
  }

  function parseCues(raw) {
    let rows;
    if (typeof raw === 'object' && isRollingAsrJson3(raw)) {
      rows = rollingAsrRows(raw);
    } else if (typeof raw === 'object') {
      rows = (Array.isArray(raw?.events) ? raw.events : []).filter((e) => Array.isArray(e?.segs)).map((e) => ({
        from: Number(e.tStartMs) / 1000, to: (Number(e.tStartMs) + Number(e.dDurationMs || 0)) / 1000,
        content: e.segs.map((s) => s?.utf8 || '').join('')
      }));
    } else {
      const text = String(raw || '').replace(/^\uFEFF/, '').trim();
      if (text.startsWith('{')) return parseCues(JSON.parse(text));
      if (!text.startsWith('WEBVTT')) throw new Error('字幕格式无法识别，请刷新后重试');
      const clock = (s) => s.split(':').reduce((n, part) => n * 60 + Number(part), 0);
      rows = text.split(/\r?\n\s*\r?\n/).flatMap((block) => {
        const lines = block.split(/\r?\n/);
        if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) return [];
        const index = lines.findIndex((line) => line.includes('-->'));
        const m = lines[index]?.match(/([\d:.]+)\s+-->\s+([\d:.]+)/);
        if (!m) return [];
        return [{ from: clock(m[1]), to: clock(m[2]), content: lines.slice(index + 1).join(' ').replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[key]) }];
      });
    }
    return (rows || []).map((c) => ({ ...c, content: String(c.content || '').replace(/\s+/g, ' ').trim() }))
      .filter((c) => c.content && Number.isFinite(c.from) && Number.isFinite(c.to) && c.from >= 0 && c.to > c.from)
      .sort((a, b) => a.from - b.from).map((c, i) => ({ ...c, sid: i + 1 }));
  }
  // 此函数整体通过 executeScript 在网页 MAIN world 执行，不传入密钥。
  // 注入时只序列化函数源码，没有外围闭包：不能调用本模块的其它函数（如 xHeadline），
  // 需要加工的字段原样返回，由后台再处理。出错一律 return { error }，不把 throw 留给 executeScript。
  async function readPage(page, trackUrl = '', loadedUrl = '', waitMs = 0) {
    const yt = page.kind === 'youtube';
    const host = location.hostname;
    if (yt ? !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(host) : !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) return { error: '视频页面已切换' };
    if (yt ? new URL(location.href).searchParams.get('v') !== page.videoId : !location.pathname.includes(`/status/${page.videoId}`)) return { error: '视频页面已切换' };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    let video = yt ? document.querySelector('#movie_player video') : [...document.querySelectorAll('video')].find((v) => v.dataset.bilicaptionVideoKey === page.bvid);
    if (yt) {
      let player;
      let data;
      for (;;) {
        if (new URL(location.href).searchParams.get('v') !== page.videoId) return { error: '视频页面已切换' };
        player = document.getElementById('movie_player');
        const ad = Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'));
        let live;
        try { live = player?.getPlayerResponse?.(); } catch {}
        const initial = window.ytInitialPlayerResponse;
        const responseId = (item) => item?.videoDetails?.videoId || item?.microformat?.playerMicroformatRenderer?.externalVideoId || '';
        let videoDataId = '';
        try { videoDataId = player?.getVideoData?.()?.video_id || ''; } catch {}
        const match = (item) => responseId(item) === page.videoId;
        data = match(live) ? live : match(initial) ? initial : (live || initial);
        if (!match(data) && videoDataId === page.videoId && match(initial)) data = initial;
        // 广告中 getPlayerResponse 往往已是正片；有身份就读字幕，不必空等广告结束。
        if (match(data)) break;
        const status = data?.playabilityStatus?.status;
        if (status && status !== 'OK' && Date.now() >= deadline) {
          return { error: data.playabilityStatus?.reason || '无法读取该视频' };
        }
        if (Date.now() >= deadline) {
          return ad
            ? { pending: true, notice: '广告播放中，请在正片开始后刷新字幕' }
            : { pending: true, notice: '视频信息尚未就绪，请稍后刷新字幕' };
        }
        await pause(200);
      }
      const details = data.videoDetails || {};
      if (details.isLiveContent && !Number(details.lengthSeconds)) return { error: '暂不支持正在直播的视频' };
      const renderer = data.captions?.playerCaptionsTracklistRenderer || {};
      const nativeTracks = renderer.captionTracks || [];
      const tracks = nativeTracks.map((t) => ({
        lan: `${t.languageCode}${t.kind === 'asr' ? '-auto' : ''}`, lanDoc: (t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode) + (t.kind === 'asr' ? '（自动）' : ''),
        url: t.baseUrl
      }));
      // 自动翻译不是独立的 captionTrack，必须用可翻译的原轨加目标语言。
      // 保留原轨，供侧栏中 / EN 切换；已有中文字幕时优先使用原生中文。
      if (!nativeTracks.some((t) => /^zh(?:-|$)/i.test(t.languageCode || ''))) {
        const target = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW'].find((code) =>
          (renderer.translationLanguages || []).some((t) => t.languageCode === code));
        const source = nativeTracks.find((t) => t.isTranslatable && /^en(?:-|$)/i.test(t.languageCode || ''))
          || nativeTracks.find((t) => t.isTranslatable);
        if (target && source?.baseUrl) {
          const translated = new URL(source.baseUrl);
          translated.searchParams.set('tlang', target);
          tracks.push({ lan: target, lanDoc: '中文（YouTube 自动翻译）', url: translated.href, autoTranslated: true });
        }
      }
      if (!trackUrl) return { title: details.title || document.title, up: details.author || '', duration: Number(details.lengthSeconds) || 0, pic: details.thumbnail?.thumbnails?.at(-1)?.url || '', tracks };
      let url;
      try { url = new URL(trackUrl); } catch { return { error: '字幕轨已失效，请刷新后重试' }; }
      if (url.protocol !== 'https:' || !['www.youtube.com','youtube.com','m.youtube.com'].includes(url.hostname) || url.pathname !== '/api/timedtext') return { error: '字幕轨已失效，请刷新后重试' };
      if (url.searchParams.get('v') && url.searchParams.get('v') !== page.videoId) return { error: '字幕轨已失效，请刷新后重试' };
      const targetLanguage = url.searchParams.get('tlang') || '';
      const sameCue = (href) => {
        try {
          const other = new URL(href);
          return other.pathname === '/api/timedtext'
            && ['v', 'lang', 'kind'].every((key) => (other.searchParams.get(key) || '') === (url.searchParams.get(key) || ''));
        } catch { return false; }
      };
      const live = tracks.find((t) => sameCue(t.url));
      if (!live) return { error: '字幕轨已失效，请刷新后重试' };
      url = new URL(live.url);
      if (loadedUrl) {
        const loaded = new URL(loadedUrl);
        if (loaded.protocol === 'https:' && loaded.hostname === url.hostname && loaded.pathname === '/api/timedtext' &&
            ['v', 'lang', 'kind'].every((key) => loaded.searchParams.get(key) === url.searchParams.get(key)) && (!loaded.searchParams.has('tlang') || loaded.searchParams.get('tlang') === targetLanguage)) {
          url.search = loaded.search;
        }
      }
      // 后台没捕获到播放器请求时，再找两处已经带 pot 的地址（参考 read-frog）：
      // 1. 播放器音轨上挂的字幕地址（getAudioTrack().captionTracks[].url）；
      // 2. 页面资源计时里播放器发过的 timedtext 请求。
      // 同一条轨的地址整段沿用；只有别的轨时只借 pot（令牌绑视频，不绑语言）。
      if (!url.searchParams.get('pot')) {
        const candidates = [];
        try {
          for (const t of player?.getAudioTrack?.()?.captionTracks || []) {
            if (t?.url) candidates.push({ href: String(t.url), own: true });
          }
        } catch {}
        try {
          const entries = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
            ? performance.getEntriesByType('resource') : [];
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            const name = String(entries[i]?.name || '');
            if (name.includes('/api/timedtext')) candidates.push({ href: name, own: false });
          }
        } catch {}
        let exact = null;
        let donor = null;
        for (const item of candidates) {
          let other;
          try { other = new URL(item.href, location.href); } catch { continue; }
          if (other.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(other.hostname) || other.pathname !== '/api/timedtext') continue;
          if (!other.searchParams.get('pot')) continue;
          // 资源计时里可能留着站内切走前上一支视频的请求，必须对上视频号。
          const vid = other.searchParams.get('v') || '';
          if (vid ? vid !== page.videoId : !item.own) continue;
          const sameTrack = ['lang', 'kind'].every((key) => (other.searchParams.get(key) || '') === (url.searchParams.get(key) || ''));
          if (sameTrack && !exact) exact = other;
          if (!donor) donor = other;
        }
        if (exact) {
          url.search = exact.search;
          if (!url.searchParams.get('v')) url.searchParams.set('v', page.videoId);
        } else if (donor) {
          for (const key of ['pot', 'potc', 'c', 'cver']) {
            const value = donor.searchParams.get(key);
            if (value) url.searchParams.set(key, value);
          }
        }
      }
      // 播放器音轨上挂的字幕地址带 pot 却没有 c / cver，原样请求会拿到空内容：
      // 从页面的 ytcfg 补上客户端名和版本号（播放器自己发请求时就带这两项）。
      if (url.searchParams.get('pot')) {
        let clientName = '';
        let clientVersion = '';
        try {
          clientName = String(window.ytcfg?.get?.('INNERTUBE_CLIENT_NAME') || '');
          clientVersion = String(window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '');
        } catch {}
        if (!url.searchParams.get('c')) url.searchParams.set('c', clientName || 'WEB');
        if (!url.searchParams.get('cver') && clientVersion) url.searchParams.set('cver', clientVersion);
      }
      if (targetLanguage) url.searchParams.set('tlang', targetLanguage);
      else url.searchParams.delete('tlang');
      const usable = (text) => {
        const raw = String(text || '').replace(/^\uFEFF/, '').trim();
        return raw.startsWith('{') || raw.startsWith('WEBVTT') ? raw : '';
      };
      const pull = async (href) => {
        const res = await fetch(href, { credentials: 'include', signal: AbortSignal.timeout(12000) });
        if (res.status === 429) return { error: 'YouTube 字幕接口限流，请稍后再试', limited: true };
        if (!res.ok) return { error: `字幕请求失败（${res.status}）` };
        const text = await res.text();
        if (text.length > 8 * 1024 * 1024) return { error: '字幕文件过大' };
        return { raw: usable(text) };
      };
      const pullFormats = async (base) => {
        let lastError = '';
        for (const fmt of ['json3', '', 'vtt', 'srv3']) {
          const next = new URL(base.href);
          if (fmt) next.searchParams.set('fmt', fmt);
          else next.searchParams.delete('fmt');
          const got = await pull(next.href);
          if (got.limited || got.error === '字幕文件过大') return got;
          if (got.raw) return got;
          if (got.error) lastError = got.error;
        }
        return lastError ? { error: lastError } : {};
      };
      // 自拼 timedtext 没有播放器 pot 时 YouTube 会 200 空 HTML；先听播放器自己的请求。
      const askPlayerOnce = () => new Promise((resolve) => {
        if (typeof player?.setOption !== 'function' || typeof XMLHttpRequest !== 'function') return resolve('');
        let done = false;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const origFetch = window.fetch;
        // setOption 会真的打开用户播放器上的字幕。先记下原状，取完再还原：
        // 原本关着就关回去，原本开着别的轨就切回那条轨。
        let prevTrack = null;
        try { prevTrack = player.getOption?.('captions', 'track') || null; } catch {}
        let captionsOn = Boolean(prevTrack && prevTrack.languageCode);
        try {
          if (document.querySelector?.('#movie_player .ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true') captionsOn = true;
        } catch {}
        const restoreCaptions = () => {
          try {
            if (!captionsOn) {
              player.setOption('captions', 'track', {});
              player.unloadModule?.('captions');
            } else if (prevTrack?.languageCode) {
              player.setOption('captions', 'track', prevTrack);
            }
          } catch {}
        };
        let touched = false;
        let patchedOpen = null;
        let patchedSend = null;
        let patchedFetch = null;
        const finish = (text) => {
          if (done) return;
          done = true;
          // 只在当前值仍是自己装的包装时才还原，不把别人（页面或另一次读取）后装的覆盖掉
          if (XMLHttpRequest.prototype.open === patchedOpen) XMLHttpRequest.prototype.open = origOpen;
          if (XMLHttpRequest.prototype.send === patchedSend) XMLHttpRequest.prototype.send = origSend;
          if (patchedFetch && window.fetch === patchedFetch) window.fetch = origFetch;
          clearTimeout(timer);
          if (touched) restoreCaptions();
          resolve(text || '');
        };
        const matchCue = (href) => {
          try {
            const other = new URL(href, location.href);
            return other.pathname === '/api/timedtext'
              && ['v', 'lang', 'kind', 'tlang'].every((key) => (other.searchParams.get(key) || '') === (url.searchParams.get(key) || (key === 'v' ? page.videoId : '')));
          } catch { return false; }
        };
        patchedOpen = function (method, href) {
          this.__bcCue = String(href || '');
          return origOpen.apply(this, arguments);
        };
        patchedSend = function () {
          if (!done && matchCue(this.__bcCue)) this.addEventListener('load', () => {
            const text = usable(this.responseText);
            if (text) finish(text);
          });
          return origSend.apply(this, arguments);
        };
        XMLHttpRequest.prototype.open = patchedOpen;
        XMLHttpRequest.prototype.send = patchedSend;
        if (typeof origFetch === 'function') {
          patchedFetch = function (input, init) {
            const href = String(input?.url || input || '');
            const req = origFetch.apply(this, arguments);
            if (!done && matchCue(href) && req?.then) {
              req.then((res) => res.clone().text().then((text) => { if (usable(text)) finish(text); }).catch(() => {})).catch(() => {});
            }
            return req;
          };
          window.fetch = patchedFetch;
        }
        const timer = setTimeout(() => finish(''), 3500);
        touched = true;
        try { player.loadModule?.('captions'); } catch {}
        try {
          const opt = { languageCode: url.searchParams.get('lang') || '' };
          if (url.searchParams.get('kind')) opt.kind = url.searchParams.get('kind');
          if (targetLanguage) opt.translationLanguage = targetLanguage;
          player.setOption('captions', 'track', opt);
          player.setOption('captions', 'reload', true);
        } catch { finish(''); }
      });
      // 同一页面上两次读取可能重叠（侧栏强制刷新赶上页面初次读取、重复注入各读一次）。
      // 借播放器要改用户的字幕开关和全局 fetch / XHR，重叠时后一次会把前一次的包装当原值记下、
      // 把「临时打开的字幕」当成用户原状，所以用挂在页面上的 Promise 排队，一次做完再做下一次。
      // 前一次最多等 6 秒（它自己 3.5 秒就会超时收尾），避免被卡住的一次拖住后面所有读取。
      const askPlayer = () => {
        const previous = window.__bcAskPlayer;
        let waitTimer = 0;
        const waitPrevious = previous
          ? Promise.race([previous, new Promise((r) => { waitTimer = setTimeout(r, 6000); })])
            .catch(() => {})
            .finally(() => clearTimeout(waitTimer))
          : Promise.resolve();
        const mine = waitPrevious.then(() => askPlayerOnce());
        window.__bcAskPlayer = mine.catch(() => '');
        return mine;
      };
      let raw = '';
      let lastError = '';
      if (url.searchParams.has('pot')) {
        const got = await pullFormats(url);
        if (got.limited || got.error === '字幕文件过大') return { error: got.error };
        raw = got.raw || '';
        lastError = got.error || '';
      }
      if (!raw) raw = await askPlayer();
      if (!raw) {
        const got = await pullFormats(url);
        if (got.limited || got.error === '字幕文件过大') return { error: got.error };
        raw = got.raw || '';
        lastError = got.error || lastError;
      }
      if (!raw) return { error: lastError || 'YouTube 未返回字幕内容，请开启播放器字幕后重试' };
      return { raw };
    }
    while (!video && Date.now() < deadline) {
      if (!location.pathname.includes(`/status/${page.videoId}`)) return { error: '视频页面已切换' };
      await pause(200);
      video = [...document.querySelectorAll('video')].find((v) => v.dataset.bilicaptionVideoKey === page.bvid);
    }
    if (!video) return { pending: true, notice: '请先播放本帖视频，再刷新字幕' };
    let article = video.closest('article');
    if (!article && page.videoId) {
      article = [...document.querySelectorAll('article')].find((el) =>
        [...el.querySelectorAll('a[href]')].some((a) => String(a.href || a.getAttribute('href') || '').includes(`/status/${page.videoId}`))) || null;
    }
    const tracks = [...video.querySelectorAll('track')].filter((t) => ['subtitles','captions'].includes(t.kind)).map((t, i) => ({ lan: t.srclang || `track-${i}`, lanDoc: t.label || t.srclang || '字幕', url: t.src, embedded: !/^https:/.test(t.src) }));
    const textTracks = [...video.textTracks].filter((t) => ['subtitles','captions'].includes(t.kind));
    for (const [i, t] of textTracks.entries()) {
      const lan = t.language || `track-${i}`;
      if (!tracks.some((r) => r.lan === lan)) tracks.push({ lan, lanDoc: t.label || lan, url: '', embedded: true });
    }
    // 标题只回原始正文、作者和页面标题，由后台用 xHeadline 截成短标题。
    const author = article?.querySelector('[data-testid="User-Name"]')?.textContent || '';
    return {
      mediaId: (video.poster || '').match(/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)/)?.[1] || '',
      xText: article?.querySelector('[data-testid="tweetText"]')?.textContent || '',
      xAuthor: author,
      pageTitle: document.title || '',
      up: author,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      pic: video.poster || '',
      tracks
    };
  }
  // 番剧 ss 链接不带集数，地址栏也不会变成 ep；当前集只在页面 MAIN world 的播放器里
  // （window.player.getManifest()）。内容脚本在隔离环境读不到，由后台用 executeScript 注入。
  // 同 readPage：只序列化函数源码，不能引用外部函数。
  async function readBangumiPage(seasonId = '', waitMs = 0) {
    if (location.hostname !== 'www.bilibili.com' || !/^\/bangumi\/play\//.test(location.pathname)) return { error: '视频页面已切换' };
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
      let manifest = null;
      try { manifest = window.player?.getManifest?.() || null; } catch {}
      const sameSeason = !seasonId || String(manifest?.seasonId || '') === String(seasonId);
      if (manifest && sameSeason && (manifest.episodeId || manifest.cid)) {
        return { epId: String(manifest.episodeId || ''), cid: Number(manifest.cid) || 0, aid: Number(manifest.aid) || 0 };
      }
      if (Date.now() >= deadline) return { pending: true };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  global.BiliCaptionPlatforms = { CONTENT_SCRIPT_FILES, YOUTUBE_HOSTS, X_HOSTS, TAB_URL_PATTERNS, YOUTUBE_CUE_URL_PATTERNS, isSupportedHost, platform, parse, xSelection, videoUrl, cueUrl, parseCues, readPage, readBangumiPage, siteName, chromeTitle, actionTitle, labels, isPending, isRateLimited, xHeadline, headerLabel };
})(globalThis);
