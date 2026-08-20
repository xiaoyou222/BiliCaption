const BiliCaptionMp4 = (() => {
  const CHUNK_BYTES = 20 * 1024 * 1024;
  const CHUNK_SECONDS = 8 * 60;
  const OVERLAP_SECONDS = 0.8;

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
      if (!size || size < header || offset + size > end + 1) break;
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
    let i = 4;
    const skipSize = () => {
      let value = 0;
      for (let n = 0; n < 4; n += 1) {
        const b = bytes[i];
        i += 1;
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      return value;
    };
    while (i < bytes.length) {
      const tag = bytes[i];
      i += 1;
      const size = skipSize();
      if (tag === 5 && size >= 2) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        let objectType = (b0 >> 3) & 0x1f;
        let freqIndex = ((b0 & 7) << 1) | ((b1 >> 7) & 1);
        let channels = (b1 >> 3) & 0xf;
        if (objectType === 31 && size >= 3) {
          objectType = 32 + ((b1 >> 1) & 0x3f);
        }
        return {
          objectType,
          freqIndex,
          channels,
          asc: bytes.slice(i, i + size)
        };
      }
      i += size;
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
    const esds = findFirst(view, mdia.dataStart, mdia.dataEnd, "esds");
    const stts = findFirst(view, stbl.dataStart, stbl.dataEnd, "stts");
    const stsc = findFirst(view, stbl.dataStart, stbl.dataEnd, "stsc");
    const stsz = findFirst(view, stbl.dataStart, stbl.dataEnd, "stsz");
    const stco = findFirst(view, stbl.dataStart, stbl.dataEnd, "co64")
      || findFirst(view, stbl.dataStart, stbl.dataEnd, "stco");
    if (!mdhd || !stts || !stsc || !stsz || !stco) return null;

    const { timescale } = parseMdhd(view, mdhd);
    const config = esds ? parseEsdsConfig(view, esds) : { objectType: 2, freqIndex: 4, channels: 2 };
    const deltas = parseStts(view, stts);
    const chunks = parseStsc(view, stsc);
    const sizes = parseStsz(view, stsz);
    const offsets = parseChunkOffsets(view, stco);

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
      bytes = bytes.subarray(7);
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
    return new Blob([ftyp, moov, box("mdat", concatBytes(samples.map((sample) => sample.data)))], {
      type: "audio/mp4"
    });
  }

  function frameSize(frame) {
    return (frame.data || frame.bytes || []).length || 0;
  }

  function buildAdtsChunks(buffer, track) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    let startIndex = 0;
    while (startIndex < track.samples.length) {
      const startTime = track.samples[startIndex].start;
      let endIndex = startIndex;
      let bytesUsed = 0;
      while (endIndex < track.samples.length) {
        const sample = track.samples[endIndex];
        const nextBytes = bytesUsed + sample.size + 4096;
        const nextDur = sample.end - startTime;
        if (endIndex > startIndex && (nextBytes > CHUNK_BYTES || nextDur > CHUNK_SECONDS)) break;
        bytesUsed += sample.size;
        endIndex += 1;
      }
      const frames = [];
      for (let i = startIndex; i < endIndex; i += 1) {
        const sample = track.samples[i];
        if (sample.offset < 0 || sample.offset + sample.size > bytes.length) {
          throw new Error("音频切片越界，请换更短视频或使用官方字幕");
        }
        frames.push({
          start: sample.start,
          end: sample.end,
          data: bytes.slice(sample.offset, sample.offset + sample.size)
        });
      }
      chunks.push({
        blob: makeM4a(frames, track.config),
        filename: "audio.m4a",
        start: startTime,
        end: track.samples[endIndex - 1].end,
        overlap: startIndex === 0 ? 0 : OVERLAP_SECONDS
      });
      if (endIndex >= track.samples.length) break;
      const resumeAt = Math.max(startTime, track.samples[endIndex - 1].end - OVERLAP_SECONDS);
      let next = endIndex;
      while (next > startIndex + 1 && track.samples[next - 1].start > resumeAt) next -= 1;
      startIndex = Math.max(startIndex + 1, next);
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
    let dataOffset = 0;
    if (flags & 0x000001) {
      if (pos + 4 > limit) return { dataOffset: 0, samples: [] };
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
    return { dataOffset, samples };
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
    for (const trun of truns) {
      const parsed = parseTrun(view, trun, tfhd);
      let dataPos = tfhd.baseDataOffset + parsed.dataOffset;
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
      frames.push({
        start: sample.start,
        end: sample.end,
        data: bytes.slice(sample.offset, sample.offset + sample.size)
      });
    }
    return frames;
  }

  function splitFragmented(buffer, view, boxes) {
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
    const chunks = [];
    let i = 0;
    while (i < fragments.length) {
      const chunkStartIndex = i;
      const parts = [init];
      let size = init.size || init.byteLength;
      const start = fragments[i].start;
      let end = start;
      while (i < fragments.length) {
        const piece = fragments[i];
        const pieceSize = piece.bytes.size || piece.bytes.byteLength;
        if (i > chunkStartIndex && (size + pieceSize > CHUNK_BYTES || piece.start - start > CHUNK_SECONDS)) break;
        parts.push(piece.bytes);
        size += pieceSize;
        end = piece.start;
        i += 1;
      }
      if (i < fragments.length) end = fragments[i].start;
      chunks.push({
        blob: new Blob(parts, { type: "audio/mp4" }),
        filename: "audio.m4a",
        start,
        end,
        overlap: chunks.length > 1 ? OVERLAP_SECONDS : 0
      });
      if (i >= fragments.length) break;
      const resumeAt = Math.max(start, end - OVERLAP_SECONDS);
      let next = i;
      while (next > chunkStartIndex + 1 && fragments[next - 1].start > resumeAt) next -= 1;
      i = Math.max(chunkStartIndex + 1, next);
    }
    return chunks;
  }

  function splitAudio(blob) {
    return blob.arrayBuffer().then((buffer) => {
      const view = new DataView(buffer);
      const boxes = readBoxes(view, 0, buffer.byteLength);
      if (boxes.some((box) => box.type === "moof")) {
        const track = collectFragmentedSamples(buffer, view, boxes);
        if (track?.samples?.length) return buildAdtsChunks(buffer, track);
        const frag = splitFragmented(buffer, view, boxes);
        if (frag.length) return frag;
      }
      const traks = findBoxes(view, 0, buffer.byteLength, "trak");
      for (const trak of traks) {
        const track = collectSamples(view, trak);
        if (track?.samples?.length) return buildAdtsChunks(buffer, track);
      }
      throw new Error("音频封装无法切片，请换更短视频或使用官方字幕");
    });
  }

  async function* iterateFmp4Chunks(reader, options = {}) {
    const { signal, onBytes } = options;
    let buf = new Uint8Array(0);
    let parsed = 0;
    let received = 0;
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
    let emitted = 0;
    let useAdts = false;

    const append = (chunk) => {
      if (!chunk?.byteLength) return;
      received += chunk.byteLength;
      onBytes?.(received);
      if (parsed > 0) {
        const rest = buf.subarray(parsed);
        const next = new Uint8Array(rest.length + chunk.byteLength);
        next.set(rest, 0);
        next.set(chunk, rest.length);
        buf = next;
        parsed = 0;
      } else {
        const next = new Uint8Array(buf.length + chunk.byteLength);
        next.set(buf, 0);
        next.set(chunk, buf.length);
        buf = next;
      }
    };

    const viewOf = () => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const tryBox = () => {
      if (parsed + 8 > buf.length) return null;
      const v = viewOf();
      let size = u32(v, parsed);
      let header = 8;
      const type = readType(v, parsed + 4);
      if (size === 1) {
        if (parsed + 16 > buf.length) return null;
        size = u64(v, parsed + 8);
        header = 16;
      } else if (size === 0) {
        return null;
      }
      if (!size || size < header) return { skip: 8 };
      if (parsed + size > buf.length) return null;
      return {
        type,
        offset: parsed,
        size,
        dataStart: parsed + header,
        dataEnd: parsed + size
      };
    };

    const frameSeconds = (frame) => {
      const rate = SAMPLE_RATES[audioConfig?.freqIndex] || 44100;
      const claimed = Number(frame.end) - Number(frame.start);
      if (Number.isFinite(claimed) && claimed > 0 && claimed <= 0.25) return claimed;
      return 1024 / rate;
    };

    const cutFrames = (count) => {
      if (count <= 0) return null;
      const taken = frames.splice(0, count);
      const start = Number(taken[0].start) || 0;
      const mediaDur = taken.reduce((sum, frame) => sum + frameSeconds(frame), 0);
      const end = start + mediaDur;
      const chunk = {
        blob: makeM4a(taken, audioConfig),
        filename: "audio.m4a",
        start,
        end,
        overlap: emitted ? OVERLAP_SECONDS : 0
      };
      const resumeAt = Math.max(start, end - OVERLAP_SECONDS);
      for (let i = taken.length - 1; i >= 1; i -= 1) {
        if (taken[i].start > resumeAt) frames.unshift(taken[i]);
        else break;
      }
      emitted += 1;
      return chunk;
    };

    const takeChunk = (count, nextStart) => {
      if (useAdts) return cutFrames(count, nextStart);
      if (!initBlob || count <= 0) return null;
      const taken = frags.slice(0, count);
      const start = taken[0].start;
      const end = nextStart != null ? nextStart : (taken[taken.length - 1].end || taken[taken.length - 1].start);
      const chunk = {
        blob: new Blob([initBlob, ...taken.map((item) => item.bytes)], { type: "audio/mp4" }),
        filename: "audio.m4a",
        start,
        end,
        overlap: emitted ? OVERLAP_SECONDS : 0
      };
      const resumeAt = Math.max(start, end - OVERLAP_SECONDS);
      let next = count;
      while (next > 1 && frags[next - 1].start > resumeAt) next -= 1;
      frags = frags.slice(Math.max(1, next));
      emitted += 1;
      return chunk;
    };

    const maybeChunk = () => {
      if (!useAdts || !frames.length) return null;
      let size = 0;
      let mediaDur = 0;
      let i = 0;
      while (i < frames.length) {
        const nextSize = size + frameSize(frames[i]);
        const nextDur = mediaDur + frameSeconds(frames[i]);
        const jumped = i > 0 && Number(frames[i].start) - Number(frames[i - 1].end) > 2;
        if (i > 0 && (nextSize > CHUNK_BYTES || nextDur > CHUNK_SECONDS || jumped)) break;
        size = nextSize;
        mediaDur = nextDur;
        i += 1;
      }
      if (i <= 0) return null;
      if (i >= frames.length && mediaDur < CHUNK_SECONDS && size < CHUNK_BYTES) return null;
      return cutFrames(i);
    };

    const parseAvailable = function* () {
      if (fallback) return;
      for (;;) {
        const box = tryBox();
        if (!box) break;
        if (box.skip) {
          parsed += box.skip;
          continue;
        }
        if (box.type === "ftyp" || box.type === "moov") {
          initParts.push(buf.slice(box.offset, box.dataEnd));
          initSize += box.size;
          if (box.type === "moov") {
            try {
              const mdhd = findFirst(viewOf(), box.dataStart, box.dataEnd, "mdhd");
              if (mdhd) timescale = parseMdhd(viewOf(), mdhd).timescale || 1;
              const cfg = findAudioConfig(viewOf(), box);
              if (cfg.timescale) timescale = cfg.timescale;
              audioConfig = cfg.config;
              trex = parseTrex(viewOf(), box);
            } catch {
              audioConfig = { objectType: 2, freqIndex: freqIndexFromRate(timescale), channels: 2 };
            }
            initBlob = new Blob(initParts, { type: "audio/mp4" });
          }
        } else if (box.type === "moof") {
          pendingMoof = { offset: box.offset, dataStart: box.dataStart, dataEnd: box.dataEnd };
        } else if (box.type === "mdat" && pendingMoof) {
          let start = 0;
          let bytes;
          try {
            start = parseTfdt(viewOf(), pendingMoof) / timescale;
            bytes = buf.slice(pendingMoof.offset, box.dataEnd);
            if (audioConfig && !fallback) {
              const extracted = framesFromFragmentBytes(bytes, audioConfig, trex, timescale);
              if (extracted.length) {
                useAdts = true;
                frames.push(...extracted);
              } else if (!useAdts) {
                const prev = frags[frags.length - 1];
                if (prev) prev.end = start;
                frags.push({ start, end: start, bytes });
              }
            } else {
              const prev = frags[frags.length - 1];
              if (prev) prev.end = start;
              frags.push({ start, end: start, bytes });
            }
          } catch {
            pendingMoof = null;
            parsed = box.dataEnd;
            continue;
          }
          pendingMoof = null;
          let chunk = maybeChunk();
          while (chunk) {
            yield chunk;
            chunk = maybeChunk();
          }
        } else if (box.type === "mdat" && !pendingMoof && !frags.length) {
          fallback = true;
          parsed = box.dataEnd;
          return;
        }
        parsed = box.dataEnd;
      }
    };

    for (;;) {
      if (signal?.aborted) {
        const error = new Error("已取消生成");
        error.name = "AbortError";
        throw error;
      }
      const { done, value } = await reader.read();
      if (value) append(value);
      if (!fallback) yield* parseAvailable();
      if (done) break;
    }

    if (fallback) {
      yield { fallback: true, blob: new Blob([buf], { type: "audio/mp4" }) };
      return;
    }
    if (useAdts && frames.length) {
      const last = cutFrames(frames.length, frames[frames.length - 1].end);
      if (last) yield last;
    } else if (initBlob) {
      yield {
        fallback: true,
        blob: new Blob([initBlob, ...frags.map((item) => item.bytes)], { type: "audio/mp4" })
      };
    }
  }

  return { splitAudio, iterateFmp4Chunks, CHUNK_BYTES, CHUNK_SECONDS };
})();
