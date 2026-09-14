/* 平台编号沿用旧存储字段 bvid，新增前缀不含冒号，兼容缓存与 WebDAV。 */
(function (global) {
  function platform(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return '';
      if (u.hostname === 'www.bilibili.com') return 'bilibili';
      if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname)) return 'youtube';
      if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname)) return 'x';
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
      if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname)) return u.pathname === '/api/timedtext';
      return u.hostname === 'video.twimg.com' || u.hostname === 'pbs.twimg.com';
    } catch { return false; }
  }
  function parseCues(raw) {
    let rows;
    if (typeof raw === 'object') {
      rows = (raw?.events || []).filter((e) => e.segs).map((e) => ({
        from: Number(e.tStartMs) / 1000, to: (Number(e.tStartMs) + Number(e.dDurationMs || 0)) / 1000,
        content: e.segs.map((s) => s.utf8 || '').join('')
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
  async function readPage(page, trackUrl = '', loadedUrl = '') {
    const yt = page.kind === 'youtube';
    const host = location.hostname;
    if (yt ? !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(host) : !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) throw new Error('视频页面已切换');
    if (yt ? new URL(location.href).searchParams.get('v') !== page.videoId : !location.pathname.includes(`/status/${page.videoId}`)) throw new Error('视频页面已切换');
    const video = yt ? document.querySelector('#movie_player video') : [...document.querySelectorAll('video')].find((v) => v.dataset.bilicaptionVideoKey === page.bvid);
    if (yt) {
      const player = document.getElementById('movie_player');
      if (player?.classList.contains('ad-showing')) throw new Error('广告播放中，请在正片开始后刷新字幕');
      const data = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      if (data?.videoDetails?.videoId !== page.videoId) throw new Error('视频信息尚未就绪，请稍后刷新字幕');
      if (data.videoDetails.isLiveContent && !Number(data.videoDetails.lengthSeconds)) throw new Error('暂不支持正在直播的视频');
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
      const details = data.videoDetails;
      if (!trackUrl) return { title: details.title || document.title, up: details.author || '', duration: Number(details.lengthSeconds) || 0, pic: details.thumbnail?.thumbnails?.at(-1)?.url || '', tracks };
      const url = new URL(trackUrl);
      if (url.protocol !== 'https:' || !['www.youtube.com','youtube.com','m.youtube.com'].includes(url.hostname) || url.pathname !== '/api/timedtext' || !tracks.some((t) => t.url === trackUrl)) throw new Error('字幕轨已失效，请刷新后重试');
      const targetLanguage = url.searchParams.get('tlang');
      if (loadedUrl) {
        const loaded = new URL(loadedUrl);
        if (loaded.protocol === 'https:' && loaded.hostname === url.hostname && loaded.pathname === '/api/timedtext' &&
            ['v', 'lang', 'kind'].every((key) => loaded.searchParams.get(key) === url.searchParams.get(key)) && (!loaded.searchParams.has('tlang') || loaded.searchParams.get('tlang') === targetLanguage)) {
          url.search = loaded.search;
        }
      }
      if (targetLanguage) url.searchParams.set('tlang', targetLanguage);
      else url.searchParams.delete('tlang');
      url.searchParams.set('fmt', 'json3');
      const res = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`字幕请求失败（${res.status}）`);
      const raw = await res.text();
      if (raw.length > 8 * 1024 * 1024) throw new Error('字幕文件过大');
      if (!raw.trim()) throw new Error('YouTube 未返回字幕内容，请开启播放器字幕后重试');
      return { raw };
    }
    if (!video) throw new Error('请先播放本帖视频，再刷新字幕');
    const article = video.closest('article');
    const tracks = [...video.querySelectorAll('track')].filter((t) => ['subtitles','captions'].includes(t.kind)).map((t, i) => ({ lan: t.srclang || `track-${i}`, lanDoc: t.label || t.srclang || '字幕', url: t.src, embedded: !/^https:/.test(t.src) }));
    const textTracks = [...video.textTracks].filter((t) => ['subtitles','captions'].includes(t.kind));
    for (const [i, t] of textTracks.entries()) {
      const lan = t.language || `track-${i}`;
      if (!tracks.some((r) => r.lan === lan)) tracks.push({ lan, lanDoc: t.label || lan, url: '', embedded: true });
    }
    return { mediaId: (video.poster || '').match(/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)/)?.[1] || '', title: article?.querySelector('[data-testid="tweetText"]')?.textContent?.slice(0, 200) || document.title, up: article?.querySelector('[data-testid="User-Name"]')?.textContent || '', duration: Number.isFinite(video.duration) ? video.duration : 0, pic: video.poster || '', tracks };
  }
  global.BiliCaptionPlatforms = { platform, parse, xSelection, videoUrl, cueUrl, parseCues, readPage };
})(globalThis);
