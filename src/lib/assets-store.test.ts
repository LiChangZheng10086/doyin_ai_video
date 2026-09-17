import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AssetError, AssetStore } from "./assets-store.js";
import { LocalStorage } from "./storage.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "assets-store-"));
  const storage = new LocalStorage(root);
  await storage.ensureBaseDirs();
  const store = new AssetStore(storage);
  return { root, storage, store };
}

/** 最小但结构正确的 PNG（仅头部用于解析尺寸）。 */
function pngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type
  return Buffer.concat([signature, ihdr]);
}

/** 最小 JPEG：SOI + SOF0（带尺寸）+ EOI。 */
function jpegBytes(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

/** 最小 WAV 头 + 1 秒静音（16kHz 单声道 16bit）便于断言时长。 */
function wavBytes(): Buffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataBytes = sampleRate * channels * (bitsPerSample / 8); // 1 秒
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

test("add writes a record with a server-generated filename and keeps the original name", async () => {
  const { root, store } = await fixture();

  const record = await store.add("image", {
    originalName: "我的封面.png",
    data: pngBytes(1080, 1920),
  });

  assert.equal(record.kind, "image");
  assert.equal(record.originalName, "我的封面.png");
  assert.match(record.filename, /^[0-9a-f-]{36}\.png$/u);
  assert.equal(record.bytes, pngBytes(1080, 1920).byteLength);
  assert.equal(record.width, 1080);
  assert.equal(record.height, 1920);

  const onDisk = await readFile(path.join(root, "assets", "images", record.filename));
  assert.equal(onDisk.byteLength, record.bytes);
  const listed = await store.list("image");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
});

test("add never uses the client filename as a path (path traversal is neutralised)", async () => {
  const { root, store } = await fixture();
  const outside = path.join(root, "evil.png");

  for (const originalName of ["../../evil.png", "..\\..\\evil.png", "/etc/passwd.png", "a/b/c.png"]) {
    const record = await store.add("image", { originalName, data: pngBytes(10, 10) });
    assert.match(record.filename, /^[0-9a-f-]{36}\.png$/u);
    assert.equal(record.originalName, originalName);
    const resolved = await store.resolveFile(record.id);
    assert.ok(resolved);
    assert.ok(resolved.path.startsWith(path.join(root, "assets") + path.sep));
  }

  // 越界文件不得被创建
  await assert.rejects(() => stat(outside), { code: "ENOENT" });
  const strayFiles = (await readdir(root)).filter((name) => name.includes("evil"));
  assert.deepEqual(strayFiles, []);
});

test("add rejects extensions outside the whitelist with a 415 asset error", async () => {
  const { store } = await fixture();

  for (const [kind, originalName] of [
    ["image", "evil.exe"],
    ["image", "vector.svg"],
    ["image", "no-extension"],
    ["audio", "clip.flac"],
  ] as const) {
    await assert.rejects(
      () => store.add(kind, { originalName, data: Buffer.from("x") }),
      (error: unknown) => {
        assert.ok(error instanceof AssetError);
        assert.equal(error.code, "asset_extension_forbidden");
        assert.equal(error.status, 415);
        return true;
      }
    );
  }
});

test("add rejects a mismatched kind/extension pair", async () => {
  const { store } = await fixture();

  await assert.rejects(
    () => store.add("audio", { originalName: "cover.png", data: pngBytes(4, 4) }),
    (error: unknown) => error instanceof AssetError && error.code === "asset_kind_mismatch"
  );
});

test("add rejects oversized files with a 413 asset error", async () => {
  const { store } = await fixture();

  const oversizedImage = Buffer.alloc(20 * 1024 * 1024 + 1);
  await assert.rejects(
    () => store.add("image", { originalName: "big.png", data: oversizedImage }),
    (error: unknown) => {
      assert.ok(error instanceof AssetError);
      assert.equal(error.code, "asset_too_large");
      assert.equal(error.status, 413);
      return true;
    }
  );

  const oversizedAudio = Buffer.alloc(50 * 1024 * 1024 + 1);
  await assert.rejects(
    () => store.add("audio", { originalName: "big.mp3", data: oversizedAudio }),
    (error: unknown) => error instanceof AssetError && error.status === 413
  );
});

test("remove deletes both the index entry and the file on disk", async () => {
  const { root, store } = await fixture();
  const record = await store.add("image", { originalName: "a.png", data: pngBytes(8, 8) });
  const filePath = path.join(root, "assets", "images", record.filename);

  assert.equal(await store.remove(record.id), true);
  await assert.rejects(() => stat(filePath), { code: "ENOENT" });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get(record.id), null);

  // 重复删除：返回 false，不抛
  assert.equal(await store.remove(record.id), false);
});

test("list filters by kind and tolerates a missing or corrupt index", async () => {
  const { root, store } = await fixture();
  await store.add("image", { originalName: "a.png", data: pngBytes(8, 8) });
  await store.add("audio", { originalName: "b.wav", data: wavBytes() });

  assert.equal((await store.list("image")).length, 1);
  assert.equal((await store.list("audio")).length, 1);
  assert.equal((await store.list()).length, 2);

  await writeFile(path.join(root, "cache", "assets-index.json"), "{ not json", "utf8");
  assert.deepEqual(await store.list(), []);
});

test("resolveFile reports mime type and size, and refuses unknown ids", async () => {
  const { store } = await fixture();
  const image = await store.add("image", { originalName: "a.png", data: pngBytes(8, 8) });
  const audio = await store.add("audio", { originalName: "b.wav", data: wavBytes() });

  const resolvedImage = await store.resolveFile(image.id);
  assert.ok(resolvedImage);
  assert.equal(resolvedImage.mimeType, "image/png");
  assert.equal(resolvedImage.size, image.bytes);
  assert.equal((await stat(resolvedImage.path)).size, image.bytes);

  const resolvedAudio = await store.resolveFile(audio.id);
  assert.ok(resolvedAudio);
  assert.equal(resolvedAudio.mimeType, "audio/wav");

  assert.equal(await store.resolveFile("does-not-exist"), null);
  assert.equal(await store.resolveFile("../../etc/passwd"), null);
});

test("audio records carry a duration when the container exposes one", async () => {
  const { store } = await fixture();

  const wav = await store.add("audio", { originalName: "one-second.wav", data: wavBytes() });
  assert.equal(wav.durationMs, 1000);

  const mp3 = await store.add("audio", {
    originalName: "unknown.mp3",
    data: Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]),
  });
  assert.equal(mp3.durationMs, undefined);
});

test("index writes are readable by a second store instance", async () => {
  const { root, storage, store } = await fixture();
  const record = await store.add("image", { originalName: "persist.png", data: pngBytes(3, 4) });

  const reopened = new AssetStore(new LocalStorage(root));
  const listed = await reopened.list("image");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
  assert.equal((await reopened.get(record.id))?.originalName, "persist.png");
  void storage;
});

test("assets directories are created lazily", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "assets-lazy-"));
  // 只建 cache，不建 assets/*
  await mkdir(path.join(root, "cache"), { recursive: true });
  const store = new AssetStore(new LocalStorage(root));

  const record = await store.add("image", { originalName: "lazy.png", data: pngBytes(5, 5) });

  assert.equal((await stat(path.join(root, "assets", "images", record.filename))).isFile(), true);
});
