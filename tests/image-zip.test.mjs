import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { io } from "socket.io-client";
import { createLanServer } from "../dist-server/server/app.js";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-zip-"));
  const server = createLanServer({ dataDir, host: "127.0.0.1", port: 0, serveFrontend: false, production: true });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  for (const deviceId of ["sender", "receiver"]) {
    const socket = io(url, { auth: { deviceId, name: deviceId }, transports: ["websocket"] });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  }
  const prepare = (files, privateChat = false) => new Promise((resolve, reject) => {
    sockets[0].timeout(5000).emit("chat:file:prepare", {
      ...(privateChat ? { toDeviceId: "receiver" } : { public: true }),
      files: files.map((file) => ({ name: file.name, contentType: file.type ?? "image/png", size: file.body.length })),
    }, (error, result) => error ? reject(error) : resolve(result));
  });
  const upload = async (prepared, files, count = files.length) => {
    for (let index = 0; index < count; index += 1) {
      const response = await fetch(`${url}/api/chat-files/${prepared.message.id}/${prepared.message.files[index].id}`, {
        method: "POST",
        headers: { "X-Device-Id": "sender", "X-Upload-Token": prepared.uploadToken, "Content-Type": files[index].type ?? "image/png" },
        body: files[index].body,
      });
      assert.equal(response.status, 201);
    }
  };
  const zipUrl = (prepared, viewer = "receiver") => `${url}/api/chat-files/${prepared.message.id}/images.zip?deviceId=${viewer}`;
  return { server, dataDir, prepare, upload, zipUrl };
}

test("图片 ZIP 保留全部原图，安全处理中文、重名和路径，仅包含图片", async (t) => {
  const { prepare, upload, zipUrl } = await fixture(t);
  const files = [
    { name: "中文 照片.png", body: Buffer.from([0, 1, 128, 255]) },
    { name: "中文 照片.png", body: Buffer.from("second") },
    { name: "中文 照片 (2).png", body: Buffer.from("third") },
    { name: "../folder/照片.png", type: "application/octet-stream", body: Buffer.from("extension fallback") },
    { name: "C:\\temp\\CON.png", body: Buffer.from("windows") },
    { name: "说明.txt", type: "text/plain", body: Buffer.from("excluded") },
    { name: "video.png", type: "video/mp4", body: Buffer.from("excluded video even with image extension") },
  ];
  const prepared = await prepare(files);
  assert.equal(prepared.ok, true);
  assert.equal((await fetch(zipUrl(prepared))).status, 409);
  // An unfinished non-image attachment does not block downloading the images.
  await upload(prepared, files, 5);
  const head = await fetch(zipUrl(prepared), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const response = await fetch(zipUrl(prepared));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition"), /attachment;.*\.zip/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const names = ["中文 照片.png", "中文 照片 (2).png", "中文 照片 (2) (2).png", "照片.png", "_CON.png"];
  assert.deepEqual(Object.keys(entries), names);
  names.forEach((name, index) => assert.deepEqual(Buffer.from(entries[name]), files[index].body));
  // Independent repeat downloads remain complete.
  const repeated = await fetch(zipUrl(prepared));
  assert.deepEqual(unzipSync(new Uint8Array(await repeated.arrayBuffer())), entries);
});

test("图片 ZIP 检查私聊权限、缺失文件与过期消息", async (t) => {
  const { server, dataDir, prepare, upload, zipUrl } = await fixture(t);
  const files = [{ name: "a.png", body: Buffer.from("a") }, { name: "b.png", body: Buffer.from("b") }];
  const prepared = await prepare(files, true);
  await upload(prepared, files);
  for (const viewer of ["outsider", ""]) {
    assert.equal((await fetch(zipUrl(prepared, viewer))).status, 404);
    assert.equal((await fetch(zipUrl(prepared, viewer), { method: "HEAD" })).status, 404);
  }
  for (const viewer of ["sender", "receiver"]) {
    const response = await fetch(zipUrl(prepared, viewer));
    assert.equal(response.status, 200);
    assert.equal(Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer()))).length, 2);
  }
  const missingPath = path.join(dataDir, "chat", `${prepared.message.files[0].id}.bin`);
  await rm(missingPath);
  assert.equal((await fetch(zipUrl(prepared))).status, 404);
  const noImages = await prepare([{ name: "file.txt", type: "text/plain", body: Buffer.from("text") }]);
  assert.equal((await fetch(zipUrl(noImages))).status, 404);
  await server.stop();
  const indexPath = path.join(dataDir, "chat.json");
  const messages = JSON.parse(await readFile(indexPath, "utf8"));
  messages.find((message) => message.id === prepared.message.id).expiresAt = Date.now() - 1000;
  await writeFile(indexPath, JSON.stringify(messages));
  const restarted = createLanServer({ dataDir, host: "127.0.0.1", port: 0, serveFrontend: false, production: true });
  try {
    const { port } = await restarted.start();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/chat-files/${prepared.message.id}/images.zip?deviceId=receiver`)).status, 404);
  } finally {
    await restarted.stop();
  }
});
