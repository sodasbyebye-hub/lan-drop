import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io } from "socket.io-client";
import { createLanServer } from "../dist-server/server/app.js";

async function start(dataDir) {
  const server = createLanServer({ dataDir, host: "127.0.0.1", port: 0, serveFrontend: false, production: true });
  const { port } = await server.start();
  return { server, url: `http://127.0.0.1:${port}` };
}
async function cleanup(dataDir) {
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith("lan-drop-media-test-"));
  await rm(dataDir, { recursive: true, force: true });
}
function upload(url, name, type, body, caption = "") {
  return fetch(`${url}/api/media`, { method: "POST", headers: { "Content-Type": type,
    "X-File-Name": encodeURIComponent(name), "X-File-Size": String(body.length),
    "X-Device-Id": "owner", "X-Device-Name": encodeURIComponent("我的电脑"), "X-Media-Caption": encodeURIComponent(caption) }, body });
}
async function list(url, deviceId = "owner") { return (await fetch(`${url}/api/media?deviceId=${deviceId}`).then(res => res.json())).items; }
const connect = async (url, id) => {
  const socket = io(url, { auth: { deviceId: id, name: id }, transports: ["websocket"] });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
};
const ack = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));

test("媒体独立上传、分类存储、配文编辑、原文件下载和视频分段读取，重启后保留", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-media-test-"));
  let running = await start(dataDir);
  try {
    const image = Buffer.from("image-original-fixture");
    const video = Buffer.from("video-original-fixture");
    const imageUpload = await upload(running.url, "中文图片.png", "image/png", image, "第一行\n第二行");
    assert.equal(imageUpload.status, 201);
    const photo = (await imageUpload.json()).item;
    const videoUpload = await upload(running.url, "视频.mp4", "video/mp4", video);
    assert.equal(videoUpload.status, 201);
    const clip = (await videoUpload.json()).item;
    const items = await list(running.url);
    assert.equal(items.length, 2);
    assert.equal(items.find(item => item.id === photo.id).caption, "第一行\n第二行");
    assert.equal(photo.kind, "image"); assert.equal(clip.kind, "video");
    assert.deepEqual(await readdir(path.join(dataDir, "media/images")), [`${photo.id}.bin`]);
    assert.deepEqual(await readdir(path.join(dataDir, "media/videos")), [`${clip.id}.bin`]);
    const edited = await fetch(`${running.url}/api/media/${photo.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Device-Id": "other-viewer" }, body: JSON.stringify({ caption: "新的配文\n<script>不可执行</script>" }) });
    assert.equal(edited.status, 200);
    const download = await fetch(`${running.url}/api/media/${photo.id}/download`);
    assert.match(download.headers.get("content-disposition"), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), image);
    const range = await fetch(`${running.url}/api/media/${clip.id}/preview`, { headers: { Range: "bytes=2-7" } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(2, 8));
    await running.server.stop(); running = await start(dataDir);
    assert.equal((await list(running.url)).find(item => item.id === photo.id).caption, "新的配文\n<script>不可执行</script>");
    const restored = await fetch(`${running.url}/api/media/${clip.id}/download`);
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), video);
  } finally { await running.server.stop(); await cleanup(dataDir); }
});

test("聊天素材自动收录和去重，私聊访问隔离，聊天过期后原媒体仍保留", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-media-test-"));
  let running = await start(dataDir);
  const sender = await connect(running.url, "sender");
  const receiver = await connect(running.url, "receiver");
  try {
    for (const isPublic of [true, false]) {
      const prepared = await ack(sender, "chat:file:prepare", { ...(isPublic ? { public: true } : { toDeviceId: "receiver" }), files: [{ name: "聊天照片.png", size: 5, contentType: "image/png" }] });
      assert.equal(prepared.ok, true);
      const response = await fetch(`${running.url}/api/chat-files/${prepared.message.id}/${prepared.message.files[0].id}`, { method: "POST", headers: { "Content-Type": "image/png", "X-Device-Id": "sender", "X-Upload-Token": prepared.uploadToken, "X-File-Size": "5" }, body: Buffer.from("hello") });
      assert.equal(response.status, 201);
    }
    assert.equal((await list(running.url, "stranger")).length, 1);
    assert.equal((await list(running.url, "sender")).length, 2);
    assert.equal((await list(running.url, "receiver")).length, 2);
    const privateItem = (await list(running.url, "receiver")).find(item => item.private);
    for (const action of ["preview", "download"]) {
      assert.equal((await fetch(`${running.url}/api/media/${privateItem.id}/${action}?deviceId=stranger`)).status, 404);
      const allowed = await fetch(`${running.url}/api/media/${privateItem.id}/${action}?deviceId=receiver`);
      assert.equal(allowed.status, 200); assert.equal(await allowed.text(), "hello");
    }
    assert.equal((await fetch(`${running.url}/api/media/${privateItem.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Device-Id": "stranger" }, body: JSON.stringify({ caption: "no" }) })).status, 404);
    sender.disconnect(); receiver.disconnect();
    await running.server.stop(); running = await start(dataDir);
    assert.equal((await list(running.url, "sender")).length, 2);
    await running.server.stop();
    const chatPath = path.join(dataDir, "chat.json");
    const messages = JSON.parse(await readFile(chatPath, "utf8"));
    for (const message of messages) message.expiresAt = 1;
    await writeFile(chatPath, JSON.stringify(messages));
    running = await start(dataDir);
    assert.equal((await readdir(path.join(dataDir, "chat"))).length, 0);
    assert.equal((await list(running.url, "sender")).length, 2);
    const preserved = await fetch(`${running.url}/api/media/${privateItem.id}/download?deviceId=receiver`);
    assert.equal(await preserved.text(), "hello");
  } finally { sender.disconnect(); receiver.disconnect(); await running.server.stop(); await cleanup(dataDir); }
});

test("媒体库拒绝非媒体、空文件及过长配文", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-media-test-"));
  const { server, url } = await start(dataDir);
  try {
    assert.equal((await upload(url, "脚本.html", "text/html", Buffer.from("bad"))).status, 415);
    assert.equal((await upload(url, "empty.png", "image/png", Buffer.alloc(0))).status, 400);
    assert.equal((await list(url)).length, 0);
    const response = await upload(url, "fallback.jpg", "application/octet-stream", Buffer.from("photo"));
    assert.equal(response.status, 201);
    const item = (await response.json()).item;
    assert.equal(item.contentType, "image/jpeg");
    const tooLong = await fetch(`${url}/api/media/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Device-Id": "owner" }, body: JSON.stringify({ caption: "长".repeat(1001) }) });
    assert.equal(tooLong.status, 400);
    assert.equal((await list(url))[0].caption, "");
  } finally { await server.stop(); await cleanup(dataDir); }
});
