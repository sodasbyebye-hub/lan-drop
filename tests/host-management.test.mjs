import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io } from "socket.io-client";
import { createLanServer } from "../dist-server/server/app.js";
import { isHostRequest, mayManage } from "../dist-server/server/host-access.js";

test("主机权限使用真实连接来源，拒绝远端冒充、外站请求和非本机域名", () => {
  const request = (address, host = "localhost:3000", headers = {}) => ({ socket: { remoteAddress: address }, headers: { host }, protocol: "http", header: (name) => headers[name] });
  assert.equal(isHostRequest(request("::ffff:127.0.0.1")), true);
  assert.equal(mayManage(request("::1", "[::1]:3000", { "x-host-action": "delete", origin: "http://[::1]:3000" })), true);
  assert.equal(isHostRequest(request("203.0.113.123", "localhost:3000", { "x-forwarded-for": "127.0.0.1" })), false);
  assert.equal(isHostRequest(request("127.0.0.1", "evil.example:3000")), false);
  assert.equal(mayManage(request("127.0.0.1")), false);
  assert.equal(mayManage(request("127.0.0.1", "localhost:3000", { "x-host-action": "delete", origin: "http://evil.example" })), false);
  for (const items of Object.values(os.networkInterfaces())) for (const item of items ?? []) {
    if (item.family === "IPv4") assert.equal(isHostRequest(request(item.address, `${item.address}:3000`)), true);
  }
});

test("主机删除消息、清空会话、删除图片和视频，持久清理文件且实时通知", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-host-test-"));
  let server;
  const sockets = [];
  const start = async () => {
    server = createLanServer({ dataDir, host: "127.0.0.1", port: 0, production: true, serveFrontend: false });
    const { port } = await server.start();
    return `http://127.0.0.1:${port}`;
  };
  let url = await start();
  const connect = async (id) => {
    const socket = io(url, { auth: { deviceId: id, name: id }, transports: ["websocket"] });
    sockets.push(socket);
    const history = new Promise((resolve) => socket.once("chat:history", resolve));
    await new Promise((resolve) => socket.once("connect", resolve));
    return { socket, history: (await history).messages };
  };
  const { socket: sender } = await connect("sender");
  const { socket: receiver } = await connect("receiver");
  const ack = (event, payload) => new Promise((resolve, reject) => sender.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
  const list = async () => (await fetch(`${url}/api/media?deviceId=sender`).then((response) => response.json())).items;
  const remove = (resource, headers = { "X-Host-Action": "delete" }) => fetch(`${url}${resource}`, { method: "DELETE", headers });
  const chat = async (privateChat = false) => {
    const prepared = await ack("chat:file:prepare", { ...(privateChat ? { toDeviceId: "receiver" } : { public: true }), files: [{ name: "photo.png", size: 5, contentType: "image/png" }, { name: "clip.mp4", size: 5, contentType: "video/mp4" }] });
    assert.equal(prepared.ok, true);
    for (const file of prepared.message.files) {
      const response = await fetch(`${url}/api/chat-files/${prepared.message.id}/${file.id}`, { method: "POST", headers: { "X-Device-Id": "sender", "X-Upload-Token": prepared.uploadToken, "Content-Type": file.contentType }, body: "hello" });
      assert.equal(response.status, 201);
    }
    return prepared.message;
  };
  try {
    assert.equal((await fetch(`${url}/api/host`).then((response) => response.json())).canManage, true);
    const first = await chat();
    assert.equal((await list()).length, 2);
    assert.equal((await remove(`/api/chat/messages/${first.id}`, {})).status, 403);
    assert.equal((await remove(`/api/chat/messages/${first.id}`, { "X-Host-Action": "delete", Origin: "http://untrusted.example" })).status, 403);
    const notified = new Promise((resolve) => receiver.once("chat:message:deleted", resolve));
    assert.equal((await remove(`/api/chat/messages/${first.id}`)).status, 204);
    assert.equal((await notified).id, first.id);
    assert.equal((await list()).length, 0);
    assert.equal((await fetch(`${url}/api/chat-files/${first.id}/images.zip?deviceId=sender`)).status, 404);
    assert.deepEqual(await readdir(path.join(dataDir, "chat")), []);
    assert.deepEqual(await readdir(path.join(dataDir, "media", "images")), []);
    assert.deepEqual(await readdir(path.join(dataDir, "media", "videos")), []);
    const second = await chat(true);
    let items = await list();
    const photo = items.find((item) => item.kind === "image");
    const updated = new Promise((resolve) => receiver.once("chat:message:updated", resolve));
    assert.equal((await remove(`/api/media/${photo.id}`)).status, 204);
    assert.equal((await updated).message.files.length, 1);
    items = await list();
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "video");
    assert.equal((await fetch(`${url}/api/media/${photo.id}/download?deviceId=sender`)).status, 404);
    const remaining = items[0];
    assert.equal((await remove(`/api/media/${remaining.id}`)).status, 204);
    assert.equal((await remove(`/api/chat/messages/${second.id}`)).status, 404);
    const privateMessage = await ack("chat:message", { toDeviceId: "receiver", text: "private preserved" });
    await chat();
    await ack("chat:message", { public: true, text: "public removed" });
    assert.equal((await remove("/api/chat/conversations/public")).status, 204);
    const persisted = JSON.parse(await readFile(path.join(dataDir, "chat.json"), "utf8"));
    assert.deepEqual(persisted.map((item) => item.id), [privateMessage.message.id]);
    // Standalone uploads also support deletion.
    const uploaded = await fetch(`${url}/api/media`, { method: "POST", headers: { "X-Device-Id": "sender", "X-File-Name": "standalone.mp4", "X-File-Size": "5", "Content-Type": "video/mp4" }, body: "hello" }).then((response) => response.json());
    assert.equal((await remove(`/api/media/${uploaded.item.id}`)).status, 204);
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
    url = await start();
    assert.deepEqual(await list(), []);
    assert.equal((await connect("sender")).history.length, 1);
    assert.deepEqual(await readdir(path.join(dataDir, "chat")), []);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await server.stop();
    assert.equal(path.dirname(dataDir), os.tmpdir());
    await rm(dataDir, { recursive: true, force: true });
  }
});
