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
  assert.ok(chunks[0].end > 479 && chunks[0].end < 481);
  assert.ok(chunks[1].start < chunks[0].end);
  assert.equal(chunks[1].overlap, 0.8);

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
});

test("fMP4 的 moof/mdat 跨网络块时仍能边下边切，不退回整文件", { skip: !canRun }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilicaption-流式-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "分片音频.m4a");
  makeAudio(source, true);
  const bytes = fs.readFileSync(source);
  let offset = 0;
  const reader = {
    async read() {
      if (offset >= bytes.length) return { done: true, value: undefined };
      const end = Math.min(bytes.length, offset + 137);
      const value = Uint8Array.from(bytes.subarray(offset, end));
      offset = end;
      return { done: false, value };
    }
  };

  const M = loadMp4();
  const chunks = [];
  for await (const chunk of M.iterateFmp4Chunks(reader)) chunks.push(chunk);

  assert.equal(chunks.some((chunk) => chunk.fallback), false);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].end > 479 && chunks[0].end < 481);
  assert.ok(chunks[1].start < chunks[0].end);
  for (let i = 0; i < chunks.length; i += 1) {
    const info = await writeAndProbe(chunks[i].blob, dir, i + 1);
    assert.equal(info.sampleRate, 48000);
    assert.ok(info.duration > 0);
  }
});
