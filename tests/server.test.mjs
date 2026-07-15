import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io as connectSocket } from "socket.io-client";
import { createLanServer } from "../dist-server/server/app.js";

async function createTestServer(dataDir) {
  const server = createLanServer({ dataDir, host: "127.0.0.1", port: 0, serveFrontend: false, production: true });
  const started = await server.start();
  return { server, baseUrl: `http://127.0.0.1:${started.port}` };
}

function socketEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test("公共文件支持上传、下载、权限删除和重启恢复", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-public-"));
  const ownerToken = "owner-token-that-is-long-enough";
  const body = Buffer.from("局域网测试内容", "utf8");
  let running = await createTestServer(dataDir);
  try {
    const health = await fetch(`${running.baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);

    const uploadResponse = await fetch(`${running.baseUrl}/api/files`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Device-Id": "device-a",
        "X-Device-Name": encodeURIComponent("测试电脑"),
        "X-Owner-Token": ownerToken,
        "X-File-Name": encodeURIComponent("中文 空格 #1.txt"),
        "X-File-Size": String(body.length),
      },
      body,
    });
    assert.equal(uploadResponse.status, 201);
    const uploaded = (await uploadResponse.json()).file;
    assert.equal(uploaded.name, "中文 空格 #1.txt");

    await running.server.stop();
    running = await createTestServer(dataDir);
    const listed = await fetch(`${running.baseUrl}/api/files`).then((response) => response.json());
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, "中文 空格 #1.txt");

    const downloaded = await fetch(`${running.baseUrl}/api/files/${uploaded.id}/download`);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), body);

    const forbidden = await fetch(`${running.baseUrl}/api/files/${uploaded.id}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": "wrong-token-that-is-long-enough" },
    });
    assert.equal(forbidden.status, 403);

    const removed = await fetch(`${running.baseUrl}/api/files/${uploaded.id}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": ownerToken },
    });
    assert.equal(removed.status, 204);
    const index = JSON.parse(await readFile(path.join(dataDir, "files.json"), "utf8"));
    assert.equal(index.length, 0);
  } finally {
    await running.server.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("私人传输需要接收确认并可完整下载", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-private-"));
  const { server, baseUrl } = await createTestServer(dataDir);
  const sender = connectSocket(baseUrl, { auth: { deviceId: "sender", name: "发送电脑" }, transports: ["websocket"] });
  const receiver = connectSocket(baseUrl, { auth: { deviceId: "receiver", name: "接收手机" }, transports: ["websocket"] });
  try {
    await Promise.all([socketEvent(sender, "connect"), socketEvent(receiver, "connect")]);
    const offerPromise = socketEvent(receiver, "transfer:offer");
    const offered = await emitAck(sender, "transfer:offer", {
      toDeviceId: "receiver",
      files: [{ name: "演示.dat", size: 6, contentType: "application/octet-stream" }],
    });
    assert.equal(offered.ok, true);
    const incoming = await offerPromise;
    assert.equal(incoming.transfer.fromName, "发送电脑");

    const acceptedPromise = socketEvent(sender, "transfer:accepted");
    const readyPromise = socketEvent(receiver, "transfer:ready");
    const accepted = await emitAck(receiver, "transfer:accept", { transferId: offered.transfer.id });
    assert.equal(accepted.ok, true);
    const senderAccepted = await acceptedPromise;

    const file = offered.transfer.files[0];
    const upload = await fetch(`${baseUrl}/api/transfers/${offered.transfer.id}/files/${file.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Device-Id": "sender",
        "X-Upload-Token": senderAccepted.uploadToken,
        "X-File-Size": "6",
      },
      body: Buffer.from("123456"),
    });
    assert.equal(upload.status, 201);
    const ready = await readyPromise;
    const download = await fetch(
      `${baseUrl}/api/transfers/${offered.transfer.id}/files/${file.id}/download?token=${ready.downloadToken}`,
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "123456");
  } finally {
    sender.disconnect();
    receiver.disconnect();
    await server.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("聊天文件消息会直接上传并在对方会话中可下载", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-chat-"));
  const { server, baseUrl } = await createTestServer(dataDir);
  const sender = connectSocket(baseUrl, { auth: { deviceId: "chat-sender", name: "发送电脑" }, transports: ["websocket"] });
  const receiver = connectSocket(baseUrl, { auth: { deviceId: "chat-receiver", name: "接收手机" }, transports: ["websocket"] });
  try {
    await Promise.all([socketEvent(sender, "connect"), socketEvent(receiver, "connect")]);
    const textPromise = socketEvent(receiver, "chat:message");
    const textAck = await emitAck(sender, "chat:message", { toDeviceId: "chat-receiver", text: "你好，文件马上发来" });
    assert.equal(textAck.ok, true);
    const textMessage = await textPromise;
    assert.equal(textMessage.message.text, "你好，文件马上发来");

    const pendingPromise = socketEvent(receiver, "chat:pending");
    const uploadReadyPromise = socketEvent(sender, "chat:upload-ready");
    const ack = await emitAck(sender, "chat:prepare", {
      toDeviceId: "chat-receiver",
      files: [{ name: "聊天文件.txt", size: 5, contentType: "text/plain" }],
    });
    assert.equal(ack.ok, true);
    const pending = await pendingPromise;
    assert.equal(pending.transfer.status, "accepted");
    const uploadReady = await uploadReadyPromise;
    const readyPromise = socketEvent(receiver, "transfer:ready");
    const file = ack.transfer.files[0];
    const upload = await fetch(`${baseUrl}/api/transfers/${ack.transfer.id}/files/${file.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Device-Id": "chat-sender",
        "X-Upload-Token": uploadReady.uploadToken,
        "X-File-Size": "5",
      },
      body: Buffer.from("hello"),
    });
    assert.equal(upload.status, 201);
    const ready = await readyPromise;
    const download = await fetch(`${baseUrl}/api/transfers/${ack.transfer.id}/files/${file.id}/download?token=${ready.downloadToken}`);
    assert.equal(await download.text(), "hello");
  } finally {
    sender.disconnect();
    receiver.disconnect();
    await server.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("公共聊天文字和文件会保留并在重启后可继续下载", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-durable-chat-"));
  let running = await createTestServer(dataDir);
  const sender = connectSocket(running.baseUrl, { auth: { deviceId: "group-sender", name: "发送设备" }, transports: ["websocket"] });
  const receiver = connectSocket(running.baseUrl, { auth: { deviceId: "group-receiver", name: "接收设备" }, transports: ["websocket"] });
  try {
    await Promise.all([socketEvent(sender, "connect"), socketEvent(receiver, "connect")]);
    const textPromise = socketEvent(receiver, "chat:message");
    const text = await emitAck(sender, "chat:message", { public: true, text: "公共聊天会保留 30 天" });
    assert.equal(text.ok, true);
    assert.equal((await textPromise).message.conversationId, "public");

    const filePromise = socketEvent(receiver, "chat:message");
    const prepared = await emitAck(sender, "chat:file:prepare", {
      public: true,
      files: [{ name: "group.txt", size: 5, contentType: "text/plain" }],
    });
    assert.equal(prepared.ok, true);
    const fileMessage = await filePromise;
    assert.equal(fileMessage.message.files[0].ready, false);
    const file = prepared.message.files[0];
    const upload = await fetch(`${running.baseUrl}/api/chat-files/${prepared.message.id}/${file.id}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Device-Id": "group-sender", "X-Upload-Token": prepared.uploadToken, "X-File-Size": "5" },
      body: Buffer.from("hello"),
    });
    assert.equal(upload.status, 201);
    const download = await fetch(`${running.baseUrl}/api/chat-files/${prepared.message.id}/${file.id}/download?deviceId=group-receiver`);
    assert.equal(await download.text(), "hello");

    sender.disconnect();
    receiver.disconnect();
    await running.server.stop();
    running = await createTestServer(dataDir);
    const restored = connectSocket(running.baseUrl, { auth: { deviceId: "group-receiver", name: "接收设备" }, transports: ["websocket"] });
    const historyPromise = socketEvent(restored, "chat:history");
    await socketEvent(restored, "connect");
    const history = await historyPromise;
    assert.equal(history.messages.filter((message) => message.conversationId === "public").length, 2);
    restored.disconnect();
  } finally {
    sender.disconnect();
    receiver.disconnect();
    await running.server.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("拒绝无效文件大小且不会写入文件柜", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lan-drop-limit-"));
  const { server, baseUrl } = await createTestServer(dataDir);
  try {
    const response = await fetch(`${baseUrl}/api/files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Device-Id": "device-a",
        "X-Device-Name": encodeURIComponent("测试电脑"),
        "X-Owner-Token": "owner-token-that-is-long-enough",
        "X-File-Name": "large.bin",
        "X-File-Size": "-1",
      },
      body: Buffer.alloc(0),
    });
    assert.equal(response.status, 400);
    const listed = await fetch(`${baseUrl}/api/files`).then((item) => item.json());
    assert.equal(listed.files.length, 0);
  } finally {
    await server.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
