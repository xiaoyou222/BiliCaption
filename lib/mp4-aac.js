const BiliCaptionMp4 = (() => {
  // 调用方不传上限时的默认分片：Groq / OpenAI 的 25MB 上传限制留足余量
  const CHUNK_BYTES = 20 * 1024 * 1024;
  const CHUNK_SECONDS = 8 * 60;
  // 调用方最多能放大到这里：只有 ElevenLabs 这类官方支持大文件的服务商才会用到
  const MAX_CHUNK_BYTES = 200 * 1024 * 1024;
  const MAX_CHUNK_SECONDS = 60 * 60;
  // 相邻分片重叠约 2.5 秒，合并时按重叠区中点裁掉重复；重叠也计入 Groq 每小时音频额度，不宜再大
  const OVERLAP_SECONDS = 2.5;
  // 切点在目标时长前这段范围内找编码帧最小（通常是静音）的位置，尽量不把一句话切成两半
  const QUIET_SEARCH_SECONDS = 20;
  const QUIET_WINDOW_SECONDS = 0.4;

  function resolveChunkLimits(options = {}) {
    const requestedBytes = Number(options.maxBytes);
    const requestedSeconds = Number(options.maxSeconds);
    const maxBytes = Number.isFinite(requestedBytes) && requestedBytes > 64 * 1024
      ? Math.min(MAX_CHUNK_BYTES, requestedBytes)
      : CHUNK_BYTES;
    const maxSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 1
      ? Math.min(MAX_CHUNK_SECONDS, requestedSeconds)
      : CHUNK_SECONDS;
    const first = Number(options.firstSeconds);
    const overlap = Number(options.overlapSeconds);
    const quiet = Number(options.quietSeconds);
    return {
      maxBytes,
      maxSeconds,
      // 第一段可以更短，让第一条字幕更快出来；之后恢复 maxSeconds
      firstSeconds: Number.isFinite(first) && first > 1 ? Math.min(maxSeconds, first) : maxSeconds,
      overlap: Number.isFinite(overlap) && overlap >= 0 ? Math.min(10, overlap) : OVERLAP_SECONDS,
      quietSeconds: Number.isFinite(quiet) && quiet >= 0 ? quiet : QUIET_SEARCH_SECONDS
    };
  }

  /**
   * 在切点前 searchSeconds 秒内找编码字节最少的一小段（AAC 静音帧明显更小，无需解码），
   * 返回新的切点帧数。整段大小差不多（恒定码率或一直在说话）时保持原切点。
   */
  function quietCutIndex(sizeAt, count, step, searchSeconds) {
    if (!(step > 0) || !(searchSeconds > 0) || count < 8) return count;
    const win = Math.max(4, Math.round(QUIET_WINDOW_SECONDS / step));
    const lo = Math.max(win, count - Math.round(searchSeconds / step));
    if (count - lo < win) return count;
    let sum = 0;
    for (let k = count - win; k < count; k += 1) sum += sizeAt(k);
    let total = 0;
    for (let k = lo - win; k < count; k += 1) total += sizeAt(k);
    const average = (total / (count - lo + win)) * win;
    let bestSum = sum;
    let bestEnd = count;
    // 从切点往前找，同样小时取离目标最近的位置
    for (let end = count - 1; end >= lo; end -= 1) {
      sum += sizeAt(end - win) - sizeAt(end);
      if (sum < bestSum) {
        bestSum = sum;
        bestEnd = end;
      }
    }
    if (bestEnd === count || !(bestSum < average * 0.5)) return count;
    return Math.max(1, bestEnd - Math.floor(win / 2));
  }

  /**
   * 按块累积的字节队列：只在取出一个完整 box 时拼接一次，
   * 避免每收到一块网络数据就复制整个缓冲区（旧实现是平方复杂度）。
   */
  function createByteQueue() {
    let parts = [];
    let head = 0;
    let length = 0;
    const copyOut = (n, consume) => {
      const out = new Uint8Array(n);
      let filled = 0;
      let idx = 0;
      let off = head;
      while (filled < n) {
        const part = parts[idx];
        const take = Math.min(n - filled, part.byteLength - off);
        out.set(part.subarray(off, off + take), filled);
        filled += take;
        off += take;
        if (off >= part.byteLength) {
          idx += 1;
          off = 0;
        }
      }
      if (consume) {
        if (idx) parts.splice(0, idx);
        head = off;
        length -= n;
      }
      return out;
    };
    return {
      get length() {
        return length;
      },
      push(chunk) {
        if (!chunk?.byteLength) return;
        parts.push(chunk);
        length += chunk.byteLength;
      },
      peek(n) {
        return copyOut(Math.min(n, length), false);
      },
      take(n) {
        return copyOut(Math.min(n, length), true);
      },
      drain() {
        const out = parts.map((part, i) => (i === 0 && head ? part.subarray(head) : part));
        parts = [];
        head = 0;
        length = 0;
        return out;
      }
    };
  }

  function clampEnd(view, end) {
    return Math.min(Math.max(0, Number(end) || 0), view.byteLength);
  }

  function u8(view, offset) {
    if (offset < 0 || offset + 1 > view.byteLength) return 0;
    return view.getUint8(offset);
  }

  function u16(view, offset) {
    if (offset < 0 || offset + 2 > view.byteLength) return 0;
    return view.getUint16(offset);
  }

  function u32(view, offset) {
    if (offset < 0 || offset + 4 > view.byteLength) return 0;
    return view.getUint32(offset);
  }

  function i32(view, offset) {
    if (offset < 0 || offset + 4 > view.byteLength) return 0;
    return view.getInt32(offset);
  }

  function u64(view, offset) {
    if (offset < 0 || offset + 8 > view.byteLength) return 0;
    return Number(view.getBigUint64(offset));
  }

  function readType(view, offset) {
    if (offset < 0 || offset + 4 > view.byteLength) return "    ";
    return String.fromCharCode(
      u8(view, offset),
      u8(view, offset + 1),
      u8(view, offset + 2),
      u8(view, offset + 3)
    );
  }

  function readBoxes(view, start, end) {
    const boxes = [];
    end = clampEnd(view, end);
    let offset = Math.max(0, start);
    while (offset + 8 <= end) {
      let size = u32(view, offset);
      const type = readType(view, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = u64(view, offset + 8);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (!size || size < header || offset + size > end) break;
      boxes.push({
        type,
        offset,
        size,
        header,
        dataStart: offset + header,
        dataEnd: Math.min(end, offset + size)
      });
      offset += size;
    }
    return boxes;
  }

  function findBoxes(view, start, end, type, deep = true, out = []) {
    for (const box of readBoxes(view, start, end)) {
      if (box.type === type) out.push(box);
      if (deep && ["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex"].includes(box.type)) {
        findBoxes(view, box.dataStart, box.dataEnd, type, true, out);
      }
    }
    return out;
  }

  function findFirst(view, start, end, type) {
    return findBoxes(view, start, end, type)[0] || null;
  }

  function readFullBox(view, box) {
    if (!box || box.dataStart + 4 > view.byteLength) {
      return { version: 0, flags: 0, body: (box?.dataStart || 0) + 4 };
    }
    return {
      version: u8(view, box.dataStart),
      flags: u32(view, box.dataStart) & 0xffffff,
      body: box.dataStart + 4
    };
  }

  function parseMdhd(view, box) {
    const { version, body } = readFullBox(view, box);
    if (version === 1) {
      if (body + 28 > view.byteLength) return { timescale: 1, duration: 0 };
      return {
        timescale: u32(view, body + 16) || 1,
        duration: u64(view, body + 20)
      };
    }
    if (body + 16 > view.byteLength) return { timescale: 1, duration: 0 };
    return {
      timescale: u32(view, body + 8) || 1,
      duration: u32(view, body + 12)
    };
  }

  function parseHdlr(view, box) {
    return readType(view, box.dataStart + 8);
  }

  function parseEsdsConfig(view, box) {
    const start = view.byteOffset + box.dataStart;
    const len = Math.max(0, box.dataEnd - box.dataStart);
    if (start < 0 || start + len > view.buffer.byteLength) {
      return { objectType: 2, freqIndex: 4, channels: 2 };
    }
    const bytes = new Uint8Array(view.buffer, start, len);
    const readSize = (startAt) => {
      let i = startAt;
      let value = 0;
      for (let n = 0; n < 4; n += 1) {
        const b = bytes[i];
        if (b == null) return null;
        i += 1;
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) return { value, next: i };
      }
      return null;
    };
    // DecoderSpecificInfo(0x05) 通常嵌在 ES/DecoderConfig 描述符里，不能按
    // 外层 size 整段跳过，否则标准 esds 永远读不到真实采样率和声道数。
    for (let i = 4; i + 3 < bytes.length; i += 1) {
      if (bytes[i] !== 5) continue;
      const sizeInfo = readSize(i + 1);
      if (!sizeInfo || sizeInfo.value < 2 || sizeInfo.next + sizeInfo.value > bytes.length) continue;
      const at = sizeInfo.next;
      const b0 = bytes[at];
      const b1 = bytes[at + 1];
      if (b0 == null || b1 == null) continue;
        let objectType = (b0 >> 3) & 0x1f;
        let freqIndex = ((b0 & 7) << 1) | ((b1 >> 7) & 1);
        let channels = (b1 >> 3) & 0xf;
        if (objectType === 31 && sizeInfo.value >= 3) {
          objectType = 32 + ((b1 >> 1) & 0x3f);
        }
        return {
          objectType,
          freqIndex,
          channels,
          asc: bytes.slice(at, at + sizeInfo.value)
        };
    }
    return { objectType: 2, freqIndex: 4, channels: 2 };
  }

  function parseStts(view, box) {
    const body = readFullBox(view, box).body;
    const limit = Math.min(box.dataEnd, view.byteLength);
    const count = Math.min(u32(view, body), 200000);
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const at = body + 4 + i * 8;
      if (at + 8 > limit) break;
      entries.push({
        sampleCount: u32(view, at),
        delta: u32(view, at + 4)
      });
    }
    return entries;
  }

  function parseStsc(view, box) {
    const body = readFullBox(view, box).body;
    const limit = Math.min(box.dataEnd, view.byteLength);
    const count = Math.min(u32(view, body), 200000);
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const at = body + 4 + i * 12;
      if (at + 12 > limit) break;
      entries.push({
        firstChunk: u32(view, at),
        samplesPerChunk: u32(view, at + 4)
      });
    }
    return entries;
  }

  function parseStsz(view, box) {
    const body = readFullBox(view, box).body;
    const limit = Math.min(box.dataEnd, view.byteLength);
    const sampleSize = u32(view, body);
    const count = Math.min(u32(view, body + 4), 2_000_000);
    if (sampleSize) return { sampleSize, sizes: null, count };
    const sizes = [];
    for (let i = 0; i < count; i += 1) {
      const at = body + 8 + i * 4;
      if (at + 4 > limit) break;
      sizes.push(u32(view, at));
    }
    return { sampleSize: 0, sizes, count: sizes.length };
  }

  function parseChunkOffsets(view, box) {
    const body = readFullBox(view, box).body;
    const limit = Math.min(box.dataEnd, view.byteLength);
    const count = Math.min(u32(view, body), 2_000_000);
    const offsets = [];
    const width = box.type === "co64" ? 8 : 4;
    for (let i = 0; i < count; i += 1) {
      const at = body + 4 + i * width;
      if (at + width > limit) break;
      offsets.push(width === 8 ? u64(view, at) : u32(view, at));
    }
    return offsets;
  }

  function collectSamples(view, trak) {
    const mdia = findFirst(view, trak.dataStart, trak.dataEnd, "mdia");
    if (!mdia) return null;
    const hdlr = findFirst(view, mdia.dataStart, mdia.dataEnd, "hdlr");
    if (!hdlr || parseHdlr(view, hdlr) !== "soun") return null;
    const mdhd = findFirst(view, mdia.dataStart, mdia.dataEnd, "mdhd");
    const stbl = findFirst(view, mdia.dataStart, mdia.dataEnd, "stbl");
    if (!mdhd || !stbl) return null;
    const stts = findFirst(view, stbl.dataStart, stbl.dataEnd, "stts");
    const stsc = findFirst(view, stbl.dataStart, stbl.dataEnd, "stsc");
    const stsz = findFirst(view, stbl.dataStart, stbl.dataEnd, "stsz");
    const stco = findFirst(view, stbl.dataStart, stbl.dataEnd, "co64")
      || findFirst(view, stbl.dataStart, stbl.dataEnd, "stco");
    if (!stts || !stsc || !stsz || !stco) return null;

    const parsedMdhd = parseMdhd(view, mdhd);
    const audio = findAudioConfig(view, trak);
    const timescale = parsedMdhd.timescale || audio.timescale || 1;
    const config = audio.config;
    const deltas = parseStts(view, stts);
    const chunks = parseStsc(view, stsc);
    const sizes = parseStsz(view, stsz);
    const offsets = parseChunkOffsets(view, stco);
    if (!deltas.length || !chunks.length || !offsets.length || !(sizes.count > 0)) return null;

    const samples = [];
    let sample = 0;
    let time = 0;
    let sttsEntry = 0;
    let sttsLeft = deltas[0]?.sampleCount || 0;
    let chunkNo = 0;
    let chunkSample = 0;
    let stscIndex = 0;
    let samplesPerChunk = chunks[0]?.samplesPerChunk || 1;
    let byteInChunk = 0;

    const nextDelta = () => {
      while (sttsEntry < deltas.length && sttsLeft <= 0) {
        sttsEntry += 1;
        sttsLeft = deltas[sttsEntry]?.sampleCount || 0;
      }
      const delta = deltas[sttsEntry]?.delta || 0;
      sttsLeft -= 1;
      return delta;
    };

    while (sample < sizes.count) {
      if (chunkSample === 0) {
        const next = chunks[stscIndex + 1];
        if (next && chunkNo + 1 >= next.firstChunk) {
          stscIndex += 1;
          samplesPerChunk = chunks[stscIndex].samplesPerChunk;
        }
        byteInChunk = 0;
      }
      const size = sizes.sampleSize || sizes.sizes[sample] || 0;
      const offset = (offsets[chunkNo] || 0) + byteInChunk;
      const delta = nextDelta();
      samples.push({
        offset,
        size,
        start: time / timescale,
        end: (time + delta) / timescale
      });
      time += delta;
      byteInChunk += size;
      sample += 1;
      chunkSample += 1;
      if (chunkSample >= samplesPerChunk) {
        chunkSample = 0;
        chunkNo += 1;
      }
    }
    return { samples, config, duration: time / timescale };
  }

  const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function concatBytes(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function be16(value) {
    return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
  }

  function be32(value) {
    const n = value >>> 0;
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  }

  function fourcc(type) {
    return Uint8Array.from([
      type.charCodeAt(0),
      type.charCodeAt(1),
      type.charCodeAt(2),
      type.charCodeAt(3)
    ]);
  }

  function box(type, payload) {
    const data = payload instanceof Uint8Array ? payload : concatBytes(payload);
    return concatBytes([be32(8 + data.length), fourcc(type), data]);
  }

  function fullBox(type, version, flags, payload) {
    const data = payload instanceof Uint8Array ? payload : concatBytes(payload);
    return box(type, concatBytes([
      new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]),
      data
    ]));
  }

  function descr(tag, payload) {
    const data = payload instanceof Uint8Array ? payload : concatBytes(payload);
    const size = data.length;
    if (size < 128) return concatBytes([new Uint8Array([tag, size]), data]);
    return concatBytes([
      new Uint8Array([tag, 0x80 | ((size >> 14) & 0x7f), 0x80 | ((size >> 7) & 0x7f), size & 0x7f]),
      data
    ]);
  }

  function audioSpecificConfig(config) {
    if (config?.asc?.length) return config.asc instanceof Uint8Array ? config.asc : Uint8Array.from(config.asc);
    const objectType = config?.objectType || 2;
    const freq = config?.freqIndex ?? 4;
    const channels = config?.channels || 2;
    return new Uint8Array([
      ((objectType & 0x1f) << 3) | ((freq >> 1) & 0x7),
      ((freq & 1) << 7) | ((channels & 0xf) << 3)
    ]);
  }

  function makeEsds(config) {
    const dsi = descr(5, audioSpecificConfig(config));
    const decoderConfig = descr(4, concatBytes([
      new Uint8Array([0x40, 0x15, 0, 0, 0]),
      be32(128000),
      be32(128000),
      dsi
    ]));
    const sl = descr(6, new Uint8Array([0x02]));
    return fullBox("esds", 0, 0, descr(3, concatBytes([
      be16(0),
      new Uint8Array([0]),
      decoderConfig,
      sl
    ])));
  }

  function makeMp4a(config, sampleRate) {
    const channels = Math.max(1, Math.min(7, config?.channels || 2));
    return box("mp4a", concatBytes([
      new Uint8Array(6),
      be16(1),
      new Uint8Array(8),
      be16(channels),
      be16(16),
      be16(0),
      be16(0),
      be32((sampleRate || 44100) << 16),
      makeEsds(config)
    ]));
  }

  const UNITY_MATRIX = concatBytes([
    be32(0x00010000), be32(0), be32(0),
    be32(0), be32(0x00010000), be32(0),
    be32(0), be32(0), be32(0x40000000)
  ]);

  function stripAdts(data) {
    let bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0) {
      const header = (bytes[1] & 1) === 1 ? 7 : 9;
      if (bytes.length >= header) bytes = bytes.subarray(header);
    }
    return bytes;
  }

  function patchStco(moovBytes, offset) {
    for (let i = 0; i + 20 <= moovBytes.length; i += 1) {
      if (
        moovBytes[i + 4] === 0x73 &&
        moovBytes[i + 5] === 0x74 &&
        moovBytes[i + 6] === 0x63 &&
        moovBytes[i + 7] === 0x6f
      ) {
        moovBytes[i + 16] = (offset >>> 24) & 0xff;
        moovBytes[i + 17] = (offset >>> 16) & 0xff;
        moovBytes[i + 18] = (offset >>> 8) & 0xff;
        moovBytes[i + 19] = offset & 0xff;
        return;
      }
    }
  }

  function makeM4a(frames, config) {
    if (!frames?.length) return new Blob([], { type: "audio/mp4" });
    const sampleRate = SAMPLE_RATES[config?.freqIndex] || 44100;
    const samples = frames.map((frame) => {
      const data = stripAdts(frame.data || frame.bytes);
      const durSec = Math.max(0, (Number(frame.end) || 0) - (Number(frame.start) || 0));
      const typical = 1024;
      const claimed = Math.round(durSec * sampleRate);
      return {
        data,
        delta: claimed > 0 && claimed <= sampleRate / 4 ? claimed : typical
      };
    }).filter((sample) => sample.data.length);
    if (!samples.length) return new Blob([], { type: "audio/mp4" });
    const duration = samples.reduce((sum, sample) => sum + sample.delta, 0);
    const movieDuration = Math.max(1, Math.round(duration * 1000 / sampleRate));
    const sttsEntries = [];
    for (const sample of samples) {
      const last = sttsEntries[sttsEntries.length - 1];
      if (last && last.delta === sample.delta) last.count += 1;
      else sttsEntries.push({ count: 1, delta: sample.delta });
    }
    const stbl = box("stbl", concatBytes([
      fullBox("stsd", 0, 0, concatBytes([be32(1), makeMp4a(config, sampleRate)])),
      fullBox("stts", 0, 0, concatBytes([
        be32(sttsEntries.length),
        ...sttsEntries.flatMap((entry) => [be32(entry.count), be32(entry.delta)])
      ])),
      fullBox("stsc", 0, 0, concatBytes([be32(1), be32(1), be32(samples.length), be32(1)])),
      fullBox("stsz", 0, 0, concatBytes([
        be32(0),
        be32(samples.length),
        ...samples.map((sample) => be32(sample.data.length))
      ])),
      fullBox("stco", 0, 0, concatBytes([be32(1), be32(0)]))
    ]));
    const mdia = box("mdia", concatBytes([
      fullBox("mdhd", 0, 0, concatBytes([
        be32(0), be32(0), be32(sampleRate), be32(duration), be16(0x55c4), be16(0)
      ])),
      fullBox("hdlr", 0, 0, concatBytes([
        be32(0), fourcc("soun"), be32(0), be32(0), be32(0), new Uint8Array([0])
      ])),
      box("minf", concatBytes([
        fullBox("smhd", 0, 0, concatBytes([be16(0), be16(0)])),
        box("dinf", fullBox("dref", 0, 0, concatBytes([
          be32(1),
          fullBox("url ", 0, 1, new Uint8Array(0))
        ]))),
        stbl
      ]))
    ]));
    const trak = box("trak", concatBytes([
      fullBox("tkhd", 0, 3, concatBytes([
        be32(0), be32(0), be32(1), be32(0), be32(movieDuration),
        be32(0), be32(0), be16(0), be16(0), be16(0x0100), be16(0),
        UNITY_MATRIX, be32(0), be32(0)
      ])),
      mdia
    ]));
    const moov = box("moov", concatBytes([
      fullBox("mvhd", 0, 0, concatBytes([
        be32(0), be32(0), be32(1000), be32(movieDuration),
        be32(0x00010000), be16(0x0100), be16(0), be32(0), be32(0),
        UNITY_MATRIX, new Uint8Array(24), be32(2)
      ])),
      trak
    ]));
    const ftyp = box("ftyp", concatBytes([
      fourcc("M4A "), be32(0), fourcc("M4A "), fourcc("mp42"), fourcc("isom")
    ]));
    patchStco(moov, ftyp.length + moov.length + 8);
    // mdat 只写 8 字节头，帧数据直接交给 Blob 拷一次，不再先拼成一大块再拷贝
    let mdatSize = 8;
    for (const sample of samples) mdatSize += sample.data.length;
    return new Blob([ftyp, moov, be32(mdatSize), fourcc("mdat"), ...samples.map((sample) => sample.data)], {
      type: "audio/mp4"
    });
  }

  function frameSize(frame) {
    return (frame.data || frame.bytes || []).length || 0;
  }

  /**
   * 每个分片带 overlap（开头与上一片重叠的秒数）和 tail（结尾与下一片重叠的秒数），
   * 合并时两边都按重叠区中点裁剪，同一句话只留一份。
   */
  function buildAdtsChunks(buffer, track, options = {}) {
    const limits = resolveChunkLimits(options);
    const bytes = new Uint8Array(buffer);
    const samples = track.samples;
    const chunks = [];
    let startIndex = 0;
    let headOverlap = 0;
    while (startIndex < samples.length) {
      const startTime = samples[startIndex].start;
      const limitSec = chunks.length ? limits.maxSeconds : limits.firstSeconds;
      let endIndex = startIndex;
      // stsz 每帧只需 4 字节，另留一小段 moov 余量；旧实现每帧多算 4KB，
      // 会把 8 分钟音频误切成约 1 分钟，成倍增加请求数和限流概率。
      let bytesUsed = 64 * 1024;
      while (endIndex < samples.length) {
        const sample = samples[endIndex];
        const nextBytes = bytesUsed + sample.size + 16;
        const nextDur = sample.end - startTime;
        if (endIndex > startIndex && (nextBytes > limits.maxBytes || nextDur > limitSec)) break;
        bytesUsed += sample.size;
        endIndex += 1;
      }
      let nextIndex = -1;
      if (endIndex < samples.length) {
        // 重叠区以安静点为中心：合并时按重叠区中点裁剪，裁剪点正好落在停顿里，不会把一句话切成两半
        const count = endIndex - startIndex;
        const step = (samples[endIndex - 1].end - startTime) / count;
        const half = limits.overlap > 0 ? Math.max(1, Math.round(limits.overlap / 2 / step)) : 0;
        const mid = quietCutIndex(
          (k) => samples[startIndex + k].size,
          Math.max(1, count - half),
          step,
          Math.min(limits.quietSeconds, limitSec * 0.25)
        );
        endIndex = startIndex + Math.min(count, mid + half);
        nextIndex = startIndex + Math.max(1, mid - half);
      }
      const frames = [];
      for (let i = startIndex; i < endIndex; i += 1) {
        const sample = samples[i];
        if (sample.offset < 0 || sample.offset + sample.size > bytes.length) {
          throw new Error("音频切片越界，请换更短视频或使用官方字幕");
        }
        // subarray 不复制；makeM4a 交给 Blob 时才拷一次
        frames.push({
          start: sample.start,
          end: sample.end,
          data: bytes.subarray(sample.offset, sample.offset + sample.size)
        });
      }
      const chunk = {
        blob: makeM4a(frames, track.config),
        filename: "audio.m4a",
        start: startTime,
        end: samples[endIndex - 1].end,
        overlap: headOverlap,
        tail: 0
      };
      chunks.push(chunk);
      if (endIndex >= samples.length) break;
      startIndex = Math.max(startIndex + 1, nextIndex);
      headOverlap = Math.max(0, chunk.end - samples[startIndex].start);
      chunk.tail = headOverlap;
    }
    return chunks;
  }

  function freqIndexFromRate(rate) {
    const table = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const idx = table.indexOf(Number(rate) || 0);
    return idx >= 0 ? idx : 4;
  }

  function findAudioConfig(view, moov) {
    const mdhd = findFirst(view, moov.dataStart, moov.dataEnd, "mdhd");
    const timescale = mdhd ? parseMdhd(view, mdhd).timescale || 1 : 1;
    const stsd = findFirst(view, moov.dataStart, moov.dataEnd, "stsd");
    let config = { objectType: 2, freqIndex: freqIndexFromRate(timescale), channels: 2 };
    if (!stsd) return { timescale, config };
    const entries = readBoxes(view, stsd.dataStart + 8, stsd.dataEnd);
    for (const entry of entries) {
      if (entry.type !== "mp4a" && entry.type !== "enca") continue;
      if (entry.dataEnd - entry.dataStart >= 28 && entry.dataStart + 28 <= view.byteLength) {
        const channels = u16(view, entry.dataStart + 16) || 2;
        const sampleRate = u32(view, entry.dataStart + 24) >>> 16;
        config = {
          objectType: 2,
          freqIndex: freqIndexFromRate(sampleRate || timescale),
          channels: channels || 2
        };
      }
      const inner = readBoxes(view, entry.dataStart + 28, entry.dataEnd);
      const esds = inner.find((box) => box.type === "esds")
        || findFirst(view, entry.dataStart, entry.dataEnd, "esds");
      if (esds) config = { ...config, ...parseEsdsConfig(view, esds) };
      break;
    }
    return { timescale, config };
  }

  function parseTrex(view, moov) {
    const trex = findFirst(view, moov.dataStart, moov.dataEnd, "trex");
    if (!trex) return { duration: 0, size: 0 };
    const body = readFullBox(view, trex).body;
    if (body + 16 > view.byteLength) return { duration: 0, size: 0 };
    return {
      duration: u32(view, body + 8),
      size: u32(view, body + 12)
    };
  }

  function parseTfhd(view, traf, trex, moofOffset) {
    const box = findFirst(view, traf.dataStart, traf.dataEnd, "tfhd");
    if (!box) {
      return {
        baseDataOffset: moofOffset,
        duration: trex.duration || 0,
        size: trex.size || 0
      };
    }
    const { flags, body } = readFullBox(view, box);
    const limit = Math.min(box.dataEnd, view.byteLength);
    let pos = body + 4;
    let baseDataOffset = moofOffset || 0;
    if (flags & 0x000001) {
      if (pos + 8 > limit) return { baseDataOffset, duration: trex.duration || 0, size: trex.size || 0 };
      baseDataOffset = u64(view, pos);
      pos += 8;
    }
    if (flags & 0x000002) pos += 4;
    let duration = trex.duration || 0;
    if (flags & 0x000008) {
      if (pos + 4 > limit) return { baseDataOffset, duration, size: trex.size || 0 };
      duration = u32(view, pos);
      pos += 4;
    }
    let size = trex.size || 0;
    if (flags & 0x000010) {
      if (pos + 4 > limit) return { baseDataOffset, duration, size };
      size = u32(view, pos);
    }
    return { baseDataOffset, duration, size };
  }

  function parseTrun(view, box, tfhd) {
    const { flags, body } = readFullBox(view, box);
    const limit = Math.min(box.dataEnd, view.byteLength);
    const count = Math.min(u32(view, body), 200000);
    let pos = body + 4;
    const hasDataOffset = Boolean(flags & 0x000001);
    let dataOffset = 0;
    if (hasDataOffset) {
      if (pos + 4 > limit) return { dataOffset: 0, hasDataOffset, samples: [] };
      dataOffset = i32(view, pos);
      pos += 4;
    }
    if (flags & 0x000004) pos += 4;
    const samples = [];
    for (let i = 0; i < count; i += 1) {
      let duration = tfhd.duration;
      let size = tfhd.size;
      if (flags & 0x000100) {
        if (pos + 4 > limit) break;
        duration = u32(view, pos);
        pos += 4;
      }
      if (flags & 0x000200) {
        if (pos + 4 > limit) break;
        size = u32(view, pos);
        pos += 4;
      }
      if (flags & 0x000400) {
        if (pos + 4 > limit) break;
        pos += 4;
      }
      if (flags & 0x000800) {
        if (pos + 4 > limit) break;
        pos += 4;
      }
      samples.push({ duration, size });
    }
    return { dataOffset, hasDataOffset, samples };
  }

  function parseTfdt(view, moof) {
    const tfdt = findFirst(view, moof.dataStart, moof.dataEnd, "tfdt");
    if (!tfdt) return 0;
    const { version, body } = readFullBox(view, tfdt);
    if (version === 1) {
      if (body + 8 > view.byteLength) return 0;
      return u64(view, body);
    }
    if (body + 4 > view.byteLength) return 0;
    return u32(view, body);
  }

  function samplesFromFragment(view, moof, mdat, trex, timescale) {
    const traf = findFirst(view, moof.dataStart, moof.dataEnd, "traf");
    if (!traf) return [];
    const tfhd = parseTfhd(view, traf, trex, moof.offset);
    let time = parseTfdt(view, moof);
    const truns = findBoxes(view, traf.dataStart, traf.dataEnd, "trun", false);
    const samples = [];
    const limit = view.byteLength;
    let nextDataPos = null;
    for (const trun of truns) {
      const parsed = parseTrun(view, trun, tfhd);
      let dataPos = parsed.hasDataOffset
        ? tfhd.baseDataOffset + parsed.dataOffset
        : (nextDataPos ?? (mdat?.dataStart || tfhd.baseDataOffset));
      if (mdat && (dataPos < mdat.offset || dataPos >= mdat.dataEnd)) {
        dataPos = mdat.dataStart;
      }
      for (const sample of parsed.samples) {
        if (sample.size > 0 && dataPos >= 0 && dataPos + sample.size <= limit) {
          samples.push({
            offset: dataPos,
            size: sample.size,
            start: time / timescale,
            end: (time + (sample.duration || 0)) / timescale
          });
        }
        dataPos += sample.size;
        time += sample.duration || 0;
      }
      nextDataPos = dataPos;
    }
    return samples;
  }

  function collectFragmentedSamples(buffer, view, boxes) {
    const moov = boxes.find((box) => box.type === "moov");
    if (!moov) return null;
    const { timescale, config } = findAudioConfig(view, moov);
    const trex = parseTrex(view, moov);
    const samples = [];
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].type !== "moof") continue;
      const mdat = boxes[i + 1]?.type === "mdat" ? boxes[i + 1] : null;
      samples.push(...samplesFromFragment(view, boxes[i], mdat, trex, timescale));
    }
    if (!samples.length) return null;
    return { samples, config, duration: samples[samples.length - 1].end };
  }

  function framesFromFragmentBytes(bytes, config, trex, timescale) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = readBoxes(view, 0, bytes.byteLength);
    const moof = boxes.find((box) => box.type === "moof");
    const mdat = boxes.find((box) => box.type === "mdat");
    if (!moof) return [];
    const samples = samplesFromFragment(view, moof, mdat, trex, timescale);
    const frames = [];
    for (const sample of samples) {
      if (sample.offset + sample.size > bytes.byteLength) continue;
      // bytes 是这一片 moof+mdat 自己的拷贝，帧直接引用它，不再逐帧复制
      frames.push({
        start: sample.start,
        end: sample.end,
        data: bytes.subarray(sample.offset, sample.offset + sample.size)
      });
    }
    return frames;
  }

  function splitFragmented(buffer, view, boxes, options = {}) {
    const limits = resolveChunkLimits(options);
    const { maxBytes } = limits;
    const ftyp = boxes.find((box) => box.type === "ftyp");
    const moov = boxes.find((box) => box.type === "moov");
    if (!ftyp || !moov) return [];
    const mdhd = findFirst(view, moov.dataStart, moov.dataEnd, "mdhd");
    const timescale = mdhd ? parseMdhd(view, mdhd).timescale || 1 : 1;
    const init = buffer.slice(ftyp.offset, moov.dataEnd);
    const fragments = [];
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].type !== "moof") continue;
      const next = boxes[i + 1];
      const end = next?.type === "mdat" ? next.dataEnd : boxes[i].dataEnd;
      fragments.push({
        start: parseTfdt(view, boxes[i]) / timescale,
        bytes: buffer.slice(boxes[i].offset, end)
      });
    }
    if (!fragments.length) return [];
    for (let i = 0; i < fragments.length; i += 1) {
      const nextStart = fragments[i + 1]?.start;
      const previousGap = i > 0 ? fragments[i].start - fragments[i - 1].start : 0;
      fragments[i].end = nextStart != null
        ? nextStart
        : fragments[i].start + Math.max(0.02, previousGap || 1);
    }
    const chunks = [];
    let i = 0;
    let headOverlap = 0;
    while (i < fragments.length) {
      const chunkStartIndex = i;
      const parts = [init];
      let size = init.size || init.byteLength;
      const start = fragments[i].start;
      const limitSec = chunks.length ? limits.maxSeconds : limits.firstSeconds;
      let end = start;
      while (i < fragments.length) {
        const piece = fragments[i];
        const pieceSize = piece.bytes.size || piece.bytes.byteLength;
        if (i > chunkStartIndex && (size + pieceSize > maxBytes || piece.start - start > limitSec)) break;
        parts.push(piece.bytes);
        size += pieceSize;
        end = piece.end || piece.start;
        i += 1;
      }
      if (i < fragments.length) end = fragments[i].start;
      const chunk = {
        blob: new Blob(parts, { type: "audio/mp4" }),
        filename: "audio.m4a",
        start,
        end,
        // 第 2 段起才与上一段重叠（旧实现误写成 > 1，第 2 段的重叠丢了）
        overlap: chunks.length > 0 ? headOverlap : 0,
        tail: 0
      };
      chunks.push(chunk);
      if (i >= fragments.length) break;
      let next = i;
      if (limits.overlap > 0) {
        const resumeAt = Math.max(start, end - limits.overlap);
        while (next > chunkStartIndex + 1 && fragments[next - 1].start > resumeAt) next -= 1;
      }
      i = Math.max(chunkStartIndex + 1, next);
      headOverlap = Math.max(0, end - fragments[i].start);
      chunk.tail = headOverlap;
    }
    return chunks;
  }

  function splitAudio(blob, options = {}) {
    return blob.arrayBuffer().then((buffer) => {
      const view = new DataView(buffer);
      const boxes = readBoxes(view, 0, buffer.byteLength);
      if (boxes.some((box) => box.type === "moof")) {
        const track = collectFragmentedSamples(buffer, view, boxes);
        if (track?.samples?.length) return buildAdtsChunks(buffer, track, options);
        const frag = splitFragmented(buffer, view, boxes, options);
        if (frag.length) return frag;
      }
      const traks = findBoxes(view, 0, buffer.byteLength, "trak");
      for (const trak of traks) {
        const track = collectSamples(view, trak);
        if (track?.samples?.length) return buildAdtsChunks(buffer, track, options);
      }
      throw new Error("音频封装无法切片，请换更短视频或使用官方字幕");
    });
  }

  /**
   * 边下边切：从 reader 持续读取 fMP4，每攒够一段就 yield 一个分片。
   * 普通（非分片）MP4 读到 mdat 立即改为整文件兜底，yield { fallback, blob }，由调用方整段切。
   */
  async function* iterateFmp4Chunks(reader, options = {}) {
    const { signal, onBytes } = options;
    const limits = resolveChunkLimits(options);
    const { maxBytes } = limits;
    const queue = createByteQueue();
    let received = 0;
    // 第一个 moof 之前的所有 box 原样保留：非分片兜底时要拼回和原文件逐字节一致的内容
    const prefixParts = [];
    let sawMoof = false;
    const initParts = [];
    let initSize = 0;
    let initBlob = null;
    let timescale = 1;
    let audioConfig = null;
    let trex = { duration: 0, size: 0 };
    let pendingMoof = null;
    let frags = [];
    let frames = [];
    let fallback = false;
    let fallbackParts = null;
    let emitted = 0;
    let useAdts = false;
    let mediaClock = 0;
    let headOverlap = 0;

    const limitSeconds = () => (emitted ? limits.maxSeconds : limits.firstSeconds);

    const frameSeconds = () => {
      const rate = SAMPLE_RATES[audioConfig?.freqIndex] || 44100;
      return 1024 / rate;
    };

    const cutFrames = (count, final, backFrames = 0) => {
      if (count <= 0) return null;
      const taken = frames.splice(0, count);
      const step = frameSeconds();
      const start = mediaClock;
      const end = start + taken.length * step;
      let back = 0;
      if (!final && backFrames > 0) {
        // 末尾这些帧放回队首，下一段从这里开始，两段在这段时间里重叠
        const keepFrom = Math.max(1, taken.length - backFrames);
        frames.unshift(...taken.slice(keepFrom));
        back = (taken.length - keepFrom) * step;
      }
      const chunk = {
        blob: makeM4a(taken, audioConfig),
        filename: "audio.m4a",
        start,
        end,
        overlap: headOverlap,
        tail: back
      };
      headOverlap = back;
      mediaClock = end - back;
      emitted += 1;
      return chunk;
    };

    const takeChunk = (count, nextStart, final) => {
      if (!initBlob || count <= 0) return null;
      const taken = frags.slice(0, count);
      const start = taken[0].start;
      const end = nextStart != null ? nextStart : (taken[taken.length - 1].end || taken[taken.length - 1].start);
      let keep = count;
      if (!final && limits.overlap > 0) {
        // 从包含 end - overlap 的那一片开始放回，保证至少有 overlap 秒的重叠
        const resumeAt = Math.max(start, end - limits.overlap);
        while (keep > 1 && frags[keep - 1].start > resumeAt) keep -= 1;
        keep = Math.max(1, keep - 1);
      }
      frags = frags.slice(keep);
      const back = !final && frags.length ? Math.max(0, end - frags[0].start) : 0;
      const chunk = {
        blob: new Blob([initBlob, ...taken.map((item) => item.bytes)], { type: "audio/mp4" }),
        filename: "audio.m4a",
        start,
        end,
        overlap: headOverlap,
        tail: back
      };
      headOverlap = back;
      emitted += 1;
      return chunk;
    };

    const maybeChunk = () => {
      const limitSec = limitSeconds();
      if (useAdts) {
        if (!frames.length) return null;
        const step = frameSeconds();
        let size = 64 * 1024;
        let i = 0;
        while (i < frames.length) {
          const nextSize = size + frameSize(frames[i]) + 16;
          const nextDur = (i + 1) * step;
          if (i > 0 && (nextSize > maxBytes || nextDur > limitSec)) break;
          size = nextSize;
          i += 1;
        }
        if (i <= 0) return null;
        if (i >= frames.length && i * step < limitSec && size < maxBytes) return null;
        // 重叠区以安静点为中心，合并时的中点裁剪落在停顿里
        const half = limits.overlap > 0 ? Math.max(1, Math.round(limits.overlap / 2 / step)) : 0;
        const mid = quietCutIndex(
          (k) => frameSize(frames[k]),
          Math.max(1, i - half),
          step,
          Math.min(limits.quietSeconds, limitSec * 0.25)
        );
        const count = Math.min(i, mid + half);
        return cutFrames(count, false, count - Math.max(1, mid - half));
      }

      if (!initBlob || !frags.length) return null;
      const start = frags[0].start;
      let size = initSize;
      let i = 0;
      while (i < frags.length) {
        const pieceSize = frags[i].bytes.size || frags[i].bytes.byteLength || 0;
        const nextSize = size + pieceSize;
        const nextDur = (frags[i].end || frags[i].start) - start;
        if (i > 0 && (nextSize > maxBytes || nextDur > limitSec)) break;
        size = nextSize;
        i += 1;
      }
      if (i <= 0) return null;
      const mediaDur = (frags[i - 1].end || frags[i - 1].start) - start;
      if (i >= frags.length && mediaDur < limitSec && size < maxBytes) return null;
      return takeChunk(i, frags[i]?.start ?? frags[i - 1].end, false);
    };

    const handleMoov = (bytes, view, box) => {
      try {
        const mdhd = findFirst(view, box.dataStart, box.dataEnd, "mdhd");
        if (mdhd) timescale = parseMdhd(view, mdhd).timescale || 1;
        const cfg = findAudioConfig(view, box);
        if (cfg.timescale) timescale = cfg.timescale;
        audioConfig = cfg.config;
        trex = parseTrex(view, box);
      } catch {
        audioConfig = { objectType: 2, freqIndex: freqIndexFromRate(timescale), channels: 2 };
      }
      initBlob = new Blob(initParts, { type: "audio/mp4" });
    };

    const handleFragment = (mdatBytes) => {
      const start = pendingMoof.start || 0;
      const bytes = concatBytes([pendingMoof.bytes, mdatBytes]);
      if (audioConfig && !fallback) {
        const extracted = framesFromFragmentBytes(bytes, audioConfig, trex, timescale);
        if (extracted.length) {
          useAdts = true;
          frames.push(...extracted);
          return;
        }
        if (useAdts) return;
      }
      const prev = frags[frags.length - 1];
      if (prev) prev.end = start;
      frags.push({ start, end: start, bytes });
    };

    const parseAvailable = function* () {
      while (!fallback && queue.length >= 8) {
        const head = queue.peek(16);
        const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        let size = u32(hv, 0);
        const type = readType(hv, 4);
        let header = 8;
        if (size === 1) {
          if (head.byteLength < 16) return;
          size = u64(hv, 8);
          header = 16;
        }
        if (type === "mdat" && !pendingMoof && !frags.length && !frames.length) {
          // 普通 MP4 的 mdat 可能就是整条音轨：不等它收全，直接转为整文件兜底
          fallback = true;
          fallbackParts = [...prefixParts, ...queue.drain()];
          return;
        }
        if (size === 0) return;
        if (size < header) {
          const junk = queue.take(8);
          if (!sawMoof) prefixParts.push(junk);
          continue;
        }
        if (queue.length < size) return;
        const bytes = queue.take(size);
        if (!sawMoof && type !== "moof") prefixParts.push(bytes);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const box = { type, offset: 0, size, header, dataStart: header, dataEnd: size };
        if (type === "ftyp" || type === "moov") {
          initParts.push(bytes);
          initSize += size;
          if (type === "moov") handleMoov(bytes, view, box);
        } else if (type === "moof") {
          if (!sawMoof) {
            sawMoof = true;
            // 确定是分片封装，兜底用的前缀不再需要
            prefixParts.length = 0;
          }
          pendingMoof = {
            bytes,
            start: parseTfdt(view, box) / timescale
          };
        } else if (type === "mdat" && pendingMoof) {
          try {
            handleFragment(bytes);
          } catch {
            // 单个分片解析失败就跳过它
          }
          pendingMoof = null;
          let chunk = maybeChunk();
          while (chunk) {
            yield chunk;
            chunk = maybeChunk();
          }
        }
      }
    };

    for (;;) {
      if (signal?.aborted) {
        const error = new Error("已取消生成");
        error.name = "AbortError";
        throw error;
      }
      const { done, value } = await reader.read();
      if (value?.byteLength) {
        received += value.byteLength;
        onBytes?.(received);
        if (fallback) fallbackParts.push(value);
        else queue.push(value);
      }
      if (!fallback) yield* parseAvailable();
      if (done) break;
    }

    if (fallback) {
      yield { fallback: true, blob: new Blob(fallbackParts, { type: "audio/mp4" }) };
      return;
    }
    if (useAdts && frames.length) {
      const last = cutFrames(frames.length, true);
      if (last) yield last;
    } else if (initBlob && frags.length) {
      const last = frags[frags.length - 1];
      if (!(last.end > last.start)) {
        const previous = frags[frags.length - 2];
        last.end = last.start + Math.max(0.02, previous ? last.start - previous.start : 1);
      }
      const chunk = takeChunk(frags.length, null, true);
      if (chunk) yield chunk;
    } else if (!emitted && (prefixParts.length || queue.length)) {
      yield { fallback: true, blob: new Blob([...prefixParts, ...queue.drain()], { type: "audio/mp4" }) };
    }
  }

  return {
    splitAudio,
    iterateFmp4Chunks,
    quietCutIndex,
    CHUNK_BYTES,
    CHUNK_SECONDS,
    MAX_CHUNK_BYTES,
    MAX_CHUNK_SECONDS,
    OVERLAP_SECONDS
  };
})();

if (typeof self !== "undefined") self.BiliCaptionMp4 = BiliCaptionMp4;
if (typeof window !== "undefined") window.BiliCaptionMp4 = BiliCaptionMp4;
