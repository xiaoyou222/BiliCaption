const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const ffprobe = "/opt/homebrew/bin/ffprobe";
const canRun = fs.existsSync(ffmpeg) && fs.existsSync(ffprobe);

function loadMp4() {
  const context = {
    Blob,
    DataView,
    Uint8Array,
    ArrayBuffer,
    console
  };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/mp4-aac.js"), "utf8"), context);
  return context.BiliCaptionMp4;
}

function makeAudio(file, fragmented) {
  const args = [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "482", "-c:a", "aac", "-b:a", "32k"
  ];
  if (fragmented) {
    args.push("-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "5000000");
  } else {
    args.push("-movflags", "+faststart");
  }
  args.push(file);
  execFileSync(ffmpeg, args, { stdio: "pipe" });
}

/** 466 秒音调 + 4 秒静音 + 40 秒音调：切点应落在静音里 */
function makeGapAudio(file) {
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=466",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=4",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=40",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1,aformat=channel_layouts=stereo",
    "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", file
  ], { stdio: "pipe" });
}

/** 按固定小块吐出字节的 reader，模拟网络分块 */
function chunkedReader(bytes, size = 137) {
  let offset = 0;
  return {
    async read() {
      if (offset >= bytes.length) return { done: true, value: undefined };
      const end = Math.min(bytes.length, offset + size);
      const value = Uint8Array.from(bytes.subarray(offset, end));
      offset = end;
      return { done: false, value };
    }
  };
}

async function writeAndProbe(blob, dir, index) {
  const file = path.join(dir, `分片-${index}.m4a`);
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const raw = execFileSync(ffprobe, [
    "-v", "error", "-of", "json",
    "-show_entries", "stream=sample_rate",
    "-show_entries", "format=duration",
    file
  ], { encoding: "utf8" });
  const info = JSON.parse(raw);
  execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"], { stdio: "pipe" });
  return {
    sampleRate: Number(info.streams?.[0]?.sample_rate) || 0,
    duration: Number(info.format?.duration) || 0
  };
}

test("普通 M4A 按 8 分钟切片，保留 48kHz 配置且每片可完整解码", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-切片-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "普通音频.m4a");
  makeAudio(source, false);

  const M = loadMp4();
  const sourceBlob = new Blob([fs.readFileSync(source)], { type: "audio/mp4" });
  const chunks = await M.splitAudio(sourceBlob);
  assert.equal(chunks.length, 2);
  // 全程静音、帧大小一样时不挪切点
  assert.ok(chunks[0].end > 479 && chunks[0].end < 481);
  assert.ok(chunks[1].start < chunks[0].end);
  // 重叠约 2.5 秒；前一段的 tail 与后一段的 overlap 是同一段时间
  assert.ok(Math.abs(chunks[1].overlap - 2.5) < 0.1);
  assert.ok(Math.abs(chunks[0].end - chunks[1].start - chunks[1].overlap) < 1e-6);
  assert.equal(chunks[0].tail, chunks[1].overlap);
  assert.equal(chunks[0].overlap, 0);
  assert.equal(chunks[1].tail, 0);

  for (let i = 0; i < chunks.length; i += 1) {
    assert.ok(chunks[i].blob.size < 24 * 1024 * 1024);
    const info = await writeAndProbe(chunks[i].blob, dir, i + 1);
    assert.equal(info.sampleRate, 48000);
    assert.ok(info.duration > 0);
  }

  const strictChunks = await M.splitAudio(sourceBlob, {
    maxSeconds: 295,
    maxBytes: 7 * 1024 * 1024
  });
  assert.equal(strictChunks.length, 2);
  assert.ok(strictChunks[0].end > 294 && strictChunks[0].end < 296);
  assert.ok(strictChunks.every((chunk) => chunk.blob.size < 7 * 1024 * 1024));

  // 第一段缩短到约 90 秒，之后恢复正常分段长度
  const firstShort = await M.splitAudio(sourceBlob, { firstSeconds: 90 });
  assert.equal(firstShort.length, 2);
  assert.ok(firstShort[0].end > 89 && firstShort[0].end < 91);
  assert.ok(firstShort[1].end - firstShort[1].start > 380);
  assert.ok(Math.abs(firstShort[1].overlap - 2.5) < 0.1);
});

test("fMP4 的 moof/mdat 跨网络块时仍能边下边切，不退回整文件", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-流式-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "分片音频.m4a");
  makeAudio(source, true);
  const bytes = fs.readFileSync(source);

  const M = loadMp4();
  const chunks = [];
  for await (const chunk of M.iterateFmp4Chunks(chunkedReader(bytes))) chunks.push(chunk);

  assert.equal(chunks.some((chunk) => chunk.fallback), false);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].end > 479 && chunks[0].end < 481);
  assert.ok(chunks[1].start < chunks[0].end);
  assert.ok(Math.abs(chunks[1].overlap - 2.5) < 0.1);
  assert.equal(chunks[0].tail, chunks[1].overlap);
  for (let i = 0; i < chunks.length; i += 1) {
    const info = await writeAndProbe(chunks[i].blob, dir, i + 1);
    assert.equal(info.sampleRate, 48000);
    assert.ok(info.duration > 0);
  }

  // 边下边切同样支持第一段缩短
  const quick = [];
  for await (const chunk of M.iterateFmp4Chunks(chunkedReader(bytes, 4096), { firstSeconds: 90 })) quick.push(chunk);
  assert.equal(quick.length, 2);
  assert.ok(quick[0].end > 89 && quick[0].end < 91);
  assert.ok(Math.abs(quick[1].start - (quick[0].end - quick[1].overlap)) < 1e-6);
});

test("普通 MP4 边下边读时直接转整文件兜底，逐字节原样拼回且不做平方级复制", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-兜底-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "普通音频.m4a");
  makeAudio(source, false);
  const bytes = fs.readFileSync(source);

  const M = loadMp4();
  let seen = 0;
  const started = Date.now();
  const items = [];
  for await (const item of M.iterateFmp4Chunks(chunkedReader(bytes, 137), { onBytes: (n) => { seen = n; } })) {
    items.push(item);
  }
  const elapsed = Date.now() - started;
  assert.equal(items.length, 1);
  assert.equal(items[0].fallback, true);
  assert.equal(seen, bytes.length);
  const back = Buffer.from(await items[0].blob.arrayBuffer());
  assert.equal(back.length, bytes.length);
  assert.ok(back.equals(bytes));
  // 旧实现每收一块就复制整个缓冲区，约 1.9MB / 137 字节会复制上万次整段数据
  assert.ok(elapsed < 3000, `用时 ${elapsed}ms`);
});

test("切点落在目标时长前的静音里，重叠区以静音为中心", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-静音-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "带停顿.m4a");
  makeGapAudio(source);
  const M = loadMp4();
  const chunks = await M.splitAudio(new Blob([fs.readFileSync(source)], { type: "audio/mp4" }));
  assert.equal(chunks.length, 2);
  // 静音在 466–470 秒；重叠区中点（合并时的裁剪点）要落在静音里
  const middle = chunks[1].start + chunks[1].overlap / 2;
  assert.ok(middle > 466.2 && middle < 469.8, `中点 ${middle}`);
  assert.ok(chunks[0].end < 479);
  for (let i = 0; i < chunks.length; i += 1) {
    const info = await writeAndProbe(chunks[i].blob, dir, i + 1);
    assert.ok(info.duration > 0);
  }
});

test("静音切点：只在明显更小的一段帧上挪动，帧大小均匀时不动", () => {
  const M = loadMp4();
  const step = 1024 / 48000;
  const speech = Array.from({ length: 4000 }, (_, i) => 300 + (i % 7) * 11);
  for (let i = 3500; i < 3560; i += 1) speech[i] = 8;
  const cut = M.quietCutIndex((k) => speech[k], 4000, step, 20);
  assert.ok(cut > 3500 && cut < 3560, `切点 ${cut}`);
  const flat = Array.from({ length: 4000 }, () => 200);
  assert.equal(M.quietCutIndex((k) => flat[k], 4000, step, 20), 4000);
  // 搜索范围之外的静音不采用
  const far = speech.slice();
  for (let i = 3500; i < 3560; i += 1) far[i] = 300;
  for (let i = 100; i < 160; i += 1) far[i] = 8;
  assert.equal(M.quietCutIndex((k) => far[k], 4000, step, 20), 4000);
});

/**
 * 仿 B 站 BV1TYN76GEBP 的音轨：fMP4（带 sidx）+ AAC-LC 48kHz，esds 的码率字段是 0x0000FA05。
 * 旧 esds 解析逐字节找 0x05 标签，会把码率尾字节当成 DecoderSpecificInfo，读出 objectType=16 / 88.2kHz 的坏配置：
 * 分片解不开（Groq 400「is it a valid media file?」），边下边切的时间轴还被按 48000/88200 压缩（「只切到 567s / 1041s」）。
 */
function makeBiliLikeAudio(file, seconds = 150) {
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    "-ac", "2", "-c:a", "aac", "-b:a", "32k",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof+global_sidx", "-frag_duration", "5000000",
    "-f", "mp4", file
  ], { stdio: "pipe" });
  const bytes = fs.readFileSync(file);
  const at = bytes.indexOf(Buffer.from("esds"));
  assert.ok(at > 0, "测试音频里应有 esds");
  // DecoderConfigDescriptor(0x04)：objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
  const dcd = bytes.indexOf(0x04, at + 8);
  let p = dcd + 1;
  while (bytes[p] & 0x80) p += 1;
  p += 1 + 5;
  bytes.writeUInt32BE(0xfa05, p);
  bytes.writeUInt32BE(0xfa05, p + 4);
  fs.writeFileSync(file, bytes);
}

test("esds 码率字段含 0x05 时仍读出正确的 AAC 配置，分片可解码且时间轴覆盖全长", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-切片-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "仿B站音轨.m4s");
  makeBiliLikeAudio(source, 150);
  const bytes = fs.readFileSync(source);
  assert.ok(bytes.includes(Buffer.from("sidx")));
  assert.ok(bytes.includes(Buffer.from([0x00, 0x00, 0xfa, 0x05, 0x00, 0x00, 0xfa, 0x05, 0x05])));

  const M = loadMp4();
  const options = { maxSeconds: 60, firstSeconds: 30, overlapSeconds: 2.5 };
  const streamed = [];
  for await (const chunk of M.iterateFmp4Chunks(chunkedReader(bytes, 4096), options)) {
    assert.ok(!chunk.fallback, "fMP4 不应退回整文件");
    streamed.push(chunk);
  }
  const whole = await M.splitAudio(new Blob([bytes], { type: "audio/mp4" }), options);
  for (const [name, chunks] of [["边下边切", streamed], ["整文件", whole]]) {
    assert.ok(chunks.length >= 3, `${name}应切成多段`);
    const last = chunks[chunks.length - 1];
    assert.ok(Math.abs(last.end - 150) < 0.5, `${name}最后一段应到 150 秒，实际 ${last.end}`);
    for (let i = 0; i < chunks.length; i += 1) {
      const info = await writeAndProbe(chunks[i].blob, dir, `${name}-${i + 1}`);
      assert.equal(info.sampleRate, 48000);
      // 标注的时长与分片实际能解出的时长一致（旧实现差出 88200/48000 倍）
      assert.ok(Math.abs(info.duration - (chunks[i].end - chunks[i].start)) < 0.2, `${name}第 ${i + 1} 段时长对不上`);
    }
  }
});

test("AudioSpecificConfig：正确解析 AAC-LC / HE-AAC，拒绝不合理的配置", () => {
  const M = loadMp4();
  const lc = M.parseAudioSpecificConfig(Uint8Array.from([0x11, 0x90]));
  assert.equal(lc.objectType, 2);
  assert.equal(lc.freqIndex, 3);
  assert.equal(lc.channels, 2);
  const he = M.parseAudioSpecificConfig(Uint8Array.from([0x2b, 0x10, 0x88, 0x00]));
  assert.equal(he.objectType, 5);
  // 旧实现从码率尾字节误读出的配置：objectType=16、88.2kHz、0 声道
  const junk = M.parseAudioSpecificConfig(Uint8Array.from([0x80, 0x80, 0x80, 0x02, 0x11]));
  assert.ok(!junk || junk.objectType !== 2);
  assert.equal(M.parseAudioSpecificConfig(Uint8Array.from([0x00, 0x00])), null);
  assert.equal(M.parseAudioSpecificConfig(Uint8Array.from([0x17, 0x90])), null);
});

test("非 AAC 音轨（FLAC）给出明确的中文报错，不把解不开的分片发给转写服务", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-切片-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "无损音轨.m4s");
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
    "-c:a", "flac", "-strict", "-2",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "5000000",
    "-f", "mp4", source
  ], { stdio: "pipe" });
  const bytes = fs.readFileSync(source);
  const M = loadMp4();
  await assert.rejects(async () => {
    for await (const chunk of M.iterateFmp4Chunks(chunkedReader(bytes, 4096), { maxSeconds: 60 })) void chunk;
  }, (error) => error.code === "unsupported-codec" && /FLAC/.test(error.message) && /只支持 AAC/.test(error.message));
  await assert.rejects(
    () => M.splitAudio(new Blob([bytes], { type: "audio/mp4" }), { maxSeconds: 60 }),
    (error) => error.code === "unsupported-codec"
  );
});
