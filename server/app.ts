import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Request, type Response } from "express";
import { Server as SocketServer, type Socket } from "socket.io";

// File sizes remain JavaScript-safe integers; there is no product-level size cap.
export const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;
const PUBLIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRIVATE_RETENTION_MS = 60 * 60 * 1000;
const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMPLETED_CLEANUP_MS = 60 * 1000;
const FREE_SPACE_RESERVE = 64 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 4;
const MAX_DEVICE_UPLOADS = 2;

type PublicFileRecord = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: number;
  expiresAt: number;
  uploadedBy: string;
  uploaderDeviceId: string;
  storedName: string;
  ownerTokenHash: string;
};

type TransferFile = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storedName: string;
  received: number;
  ready: boolean;
  downloaded: boolean;
};

type TransferRecord = {
  id: string;
  fromDeviceId: string;
  fromName: string;
  toDeviceId: string;
  toName: string;
  status: "offered" | "accepted" | "uploading" | "ready" | "completed" | "cancelled" | "rejected";
  createdAt: number;
  expiresAt: number;
  uploadToken: string;
  downloadToken: string;
  files: TransferFile[];
  cleanupTimer?: NodeJS.Timeout;
};

type PeerRecord = {
  deviceId: string;
  name: string;
  connectedAt: number;
  sockets: Set<string>;
};

type ChatFileRecord = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storedName: string;
  received: number;
  ready: boolean;
};

type DurableChatRecord = {
  id: string;
  conversationId: string;
  fromDeviceId: string;
  fromName: string;
  toDeviceId?: string;
  text?: string;
  files?: ChatFileRecord[];
  status: "uploading" | "ready" | "error";
  createdAt: number;
  expiresAt: number;
  uploadToken?: string;
};

type ServerOptions = {
  dataDir?: string;
  host?: string;
  port?: number;
  serveFrontend?: boolean;
  production?: boolean;
};

type Ack = (response: Record<string, unknown>) => void;

function cleanName(value: unknown, fallback: string, max = 180) {
  if (typeof value !== "string") return fallback;
  const cleaned = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, max);
  return cleaned || fallback;
}

function headerValue(req: Request, name: string) {
  const value = req.header(name);
  return typeof value === "string" ? value : "";
}

function decodeHeaderName(value: string) {
  try {
    return cleanName(decodeURIComponent(value), "未命名文件");
  } catch {
    return cleanName(value, "未命名文件");
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string) {
  const received = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function publicView(file: PublicFileRecord) {
  const { storedName: _storedName, ownerTokenHash: _ownerTokenHash, ...view } = file;
  void _storedName;
  void _ownerTokenHash;
  return view;
}

function transferView(transfer: TransferRecord) {
  return {
    id: transfer.id,
    fromDeviceId: transfer.fromDeviceId,
    fromName: transfer.fromName,
    toDeviceId: transfer.toDeviceId,
    toName: transfer.toName,
    status: transfer.status,
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt,
    files: transfer.files.map(({ storedName: _storedName, ...file }) => {
      void _storedName;
      return file;
    }),
  };
}

function contentDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function getLanAddresses(port: number) {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family === "IPv4" && !item.internal) addresses.push(`http://${item.address}:${port}`);
    }
  }
  return addresses;
}

function apiError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

export function createLanServer(options: ServerOptions = {}) {
  const rootDir = process.cwd();
  const dataDir = options.dataDir ?? path.join(rootDir, "data");
  const publicDir = path.join(dataDir, "public");
  const privateDir = path.join(dataDir, "private");
  const chatDir = path.join(dataDir, "chat");
  const tempDir = path.join(dataDir, "tmp");
  const indexPath = path.join(dataDir, "files.json");
  const chatIndexPath = path.join(dataDir, "chat.json");
  const port = options.port ?? Number(process.env.PORT || 3000);
  const host = options.host ?? "0.0.0.0";
  const serveFrontend = options.serveFrontend ?? true;
  const production = options.production ?? process.env.NODE_ENV === "production";

  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    maxHttpBufferSize: 128 * 1024,
    serveClient: false,
  });

  let publicFiles: PublicFileRecord[] = [];
  const transfers = new Map<string, TransferRecord>();
  const peers = new Map<string, PeerRecord>();
  let durableChatMessages: DurableChatRecord[] = [];
  const activeByDevice = new Map<string, number>();
  let activeUploads = 0;
  let persistChain = Promise.resolve();
  let cleanupInterval: NodeJS.Timeout | undefined;
  let vite: { middlewares: express.RequestHandler; close: () => Promise<void> } | undefined;

  async function persistPublicFiles() {
    persistChain = persistChain.then(async () => {
      const snapshot = JSON.stringify(publicFiles, null, 2);
      const temporary = `${indexPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, indexPath);
    });
    return persistChain;
  }

  async function persistChatMessages() {
    persistChain = persistChain.then(async () => {
      const snapshot = JSON.stringify(durableChatMessages, null, 2);
      const temporary = `${chatIndexPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, chatIndexPath);
    });
    return persistChain;
  }

  async function safeRemove(filePath: string) {
    await rm(filePath, { force: true }).catch(() => undefined);
  }

  async function initializeStorage() {
    await Promise.all([
      mkdir(publicDir, { recursive: true }),
      mkdir(privateDir, { recursive: true }),
      mkdir(chatDir, { recursive: true }),
      mkdir(tempDir, { recursive: true }),
    ]);

    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as PublicFileRecord[];
      publicFiles = Array.isArray(parsed) ? parsed : [];
    } catch {
      publicFiles = [];
    }
    try {
      const parsed = JSON.parse(await readFile(chatIndexPath, "utf8")) as DurableChatRecord[];
      durableChatMessages = Array.isArray(parsed) ? parsed : [];
    } catch {
      durableChatMessages = [];
    }

    const now = Date.now();
    const valid: PublicFileRecord[] = [];
    for (const file of publicFiles) {
      const filePath = path.join(publicDir, path.basename(file.storedName));
      if (file.expiresAt <= now) {
        await safeRemove(filePath);
        continue;
      }
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.size === file.size) valid.push(file);
      } catch {
        // Missing or incomplete entries are removed from the index.
      }
    }
    publicFiles = valid;

    const known = new Set(publicFiles.map((file) => file.storedName));
    for (const storedName of await readdir(publicDir)) {
      if (!known.has(storedName)) await safeRemove(path.join(publicDir, storedName));
    }
    for (const temporary of await readdir(tempDir)) await safeRemove(path.join(tempDir, temporary));
    for (const privateFile of await readdir(privateDir)) await safeRemove(path.join(privateDir, privateFile));
    const validMessages: DurableChatRecord[] = [];
    for (const message of durableChatMessages) {
      if (message.expiresAt <= now) continue;
      const files = message.files ?? [];
      let complete = true;
      for (const file of files) {
        try {
          const info = await stat(path.join(chatDir, path.basename(file.storedName)));
          if (!info.isFile() || info.size !== file.size) complete = false;
        } catch {
          complete = false;
        }
      }
      if (!complete && files.length) continue;
      validMessages.push({ ...message, status: files.length ? "ready" : message.status, files: files.map((file) => ({ ...file, ready: true, received: file.size })) });
    }
    durableChatMessages = validMessages;
    const knownChatFiles = new Set(durableChatMessages.flatMap((message) => (message.files ?? []).map((file) => file.storedName)));
    for (const storedName of await readdir(chatDir)) {
      if (!knownChatFiles.has(storedName)) await safeRemove(path.join(chatDir, storedName));
    }
    await persistPublicFiles();
    await persistChatMessages();
  }

  async function hasSpace(size: number) {
    try {
      const disk = await statfs(dataDir);
      return disk.bavail * disk.bsize >= size + FREE_SPACE_RESERVE;
    } catch {
      return true;
    }
  }

  function beginUpload(deviceId: string) {
    const deviceCount = activeByDevice.get(deviceId) ?? 0;
    if (activeUploads >= MAX_ACTIVE_UPLOADS || deviceCount >= MAX_DEVICE_UPLOADS) return false;
    activeUploads += 1;
    activeByDevice.set(deviceId, deviceCount + 1);
    return true;
  }

  function endUpload(deviceId: string) {
    activeUploads = Math.max(0, activeUploads - 1);
    const next = Math.max(0, (activeByDevice.get(deviceId) ?? 1) - 1);
    if (next === 0) activeByDevice.delete(deviceId);
    else activeByDevice.set(deviceId, next);
  }

  async function receiveStream(
    req: Request,
    destination: string,
    declaredSize: number,
    onProgress?: (received: number) => void,
  ) {
    let received = 0;
    let lastUpdate = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_FILE_SIZE || received > declaredSize) {
          callback(new Error("FILE_TOO_LARGE"));
          return;
        }
        const now = Date.now();
        if (onProgress && now - lastUpdate >= 200) {
          lastUpdate = now;
          onProgress(received);
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(req, meter, createWriteStream(destination, { flags: "wx" }));
      if (received !== declaredSize) throw new Error("SIZE_MISMATCH");
      onProgress?.(received);
      return received;
    } catch (error) {
      await safeRemove(destination);
      throw error;
    }
  }

  async function cleanupTransfer(transferId: string, finalStatus: TransferRecord["status"] = "cancelled") {
    const transfer = transfers.get(transferId);
    if (!transfer) return;
    if (transfer.cleanupTimer) clearTimeout(transfer.cleanupTimer);
    transfer.status = finalStatus;
    transfers.delete(transferId);
    await Promise.all(transfer.files.map((file) => safeRemove(path.join(privateDir, file.storedName))));
  }

  async function cleanupExpired() {
    const now = Date.now();
    const expiredPublic = publicFiles.filter((file) => file.expiresAt <= now);
    if (expiredPublic.length) {
      const expiredIds = new Set(expiredPublic.map((file) => file.id));
      publicFiles = publicFiles.filter((file) => !expiredIds.has(file.id));
      await Promise.all(expiredPublic.map((file) => safeRemove(path.join(publicDir, file.storedName))));
      await persistPublicFiles();
      for (const file of expiredPublic) io.emit("file:deleted", { id: file.id });
    }
    const expiredMessages = durableChatMessages.filter((message) => message.expiresAt <= now);
    if (expiredMessages.length) {
      const expiredIds = new Set(expiredMessages.map((message) => message.id));
      durableChatMessages = durableChatMessages.filter((message) => !expiredIds.has(message.id));
      await Promise.all(expiredMessages.flatMap((message) => (message.files ?? []).map((file) => safeRemove(path.join(chatDir, file.storedName)))));
      await persistChatMessages();
      for (const message of expiredMessages) emitChatMessage("chat:message:deleted", { id: message.id, conversationId: message.conversationId }, message);
    }
    for (const transfer of [...transfers.values()]) {
      if (transfer.expiresAt <= now) {
        io.to(`device:${transfer.fromDeviceId}`).to(`device:${transfer.toDeviceId}`).emit("transfer:error", {
          transferId: transfer.id,
          code: "TRANSFER_EXPIRED",
          message: "传输已过期",
        });
        await cleanupTransfer(transfer.id);
      }
    }
  }

  function emitPeers() {
    const view = [...peers.values()].map(({ sockets: _sockets, ...peer }) => {
      void _sockets;
      return peer;
    });
    io.emit("peers:update", view);
  }

  function chatView(message: DurableChatRecord) {
    const { uploadToken: _uploadToken, ...view } = message;
    void _uploadToken;
    return view;
  }

  function conversationIdFor(fromDeviceId: string, toDeviceId?: string) {
    return toDeviceId ? [fromDeviceId, toDeviceId].sort().join(":") : "public";
  }

  function emitChatMessage(event: string, payload: Record<string, unknown>, message: DurableChatRecord) {
    if (message.toDeviceId) io.to(`device:${message.fromDeviceId}`).to(`device:${message.toDeviceId}`).emit(event, payload);
    else io.emit(event, payload);
  }

  function mayAccessMessage(message: DurableChatRecord, deviceId: string) {
    return !message.toDeviceId || message.fromDeviceId === deviceId || message.toDeviceId === deviceId;
  }

  function socketDevice(socket: Socket) {
    return cleanName(socket.data.deviceId, "", 80);
  }

  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      name: "局域网快传",
      peers: peers.size,
      files: publicFiles.length,
      maxFileSize: null,
      retentionMs: PUBLIC_RETENTION_MS,
    });
  });

  app.get("/api/network", (_req, res) => {
    res.json({ addresses: getLanAddresses(port) });
  });

  app.get("/api/files", (_req, res) => {
    res.json({ files: publicFiles.map(publicView).sort((a, b) => b.uploadedAt - a.uploadedAt) });
  });

  app.post("/api/files", async (req, res) => {
    const deviceId = cleanName(headerValue(req, "x-device-id"), "", 80);
    const uploadedBy = decodeHeaderName(headerValue(req, "x-device-name"));
    const ownerToken = headerValue(req, "x-owner-token");
    const fileName = decodeHeaderName(headerValue(req, "x-file-name"));
    const contentType = cleanName(headerValue(req, "content-type"), "application/octet-stream", 120);
    const declaredSize = Number(headerValue(req, "x-file-size"));

    if (!deviceId || ownerToken.length < 16) return apiError(res, 400, "INVALID_CLIENT", "设备信息无效");
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0)
      return apiError(res, 400, "INVALID_SIZE", "文件大小无效");
    if (!beginUpload(deviceId)) return apiError(res, 429, "TOO_MANY_UPLOADS", "同时上传的文件过多，请稍后再试");

    const id = randomUUID();
    const storedName = `${id}.bin`;
    const temporary = path.join(tempDir, `${id}.upload`);
    try {
      if (!(await hasSpace(declaredSize))) return apiError(res, 507, "DISK_FULL", "主机磁盘空间不足");
      await receiveStream(req, temporary, declaredSize);
      await rename(temporary, path.join(publicDir, storedName));
      const now = Date.now();
      const record: PublicFileRecord = {
        id,
        name: fileName,
        size: declaredSize,
        contentType,
        uploadedAt: now,
        expiresAt: now + PUBLIC_RETENTION_MS,
        uploadedBy,
        uploaderDeviceId: deviceId,
        storedName,
        ownerTokenHash: hashToken(ownerToken),
      };
      publicFiles.push(record);
      await persistPublicFiles();
      io.emit("file:created", publicView(record));
      res.status(201).json({ file: publicView(record) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "UPLOAD_FAILED";
      const code = message === "SIZE_MISMATCH" ? "SIZE_MISMATCH" : "UPLOAD_FAILED";
      apiError(res, 400, code, code === "SIZE_MISMATCH" ? "文件大小与声明不一致" : "上传中断，请重试");
    } finally {
      endUpload(deviceId);
      await safeRemove(temporary);
    }
  });

  app.get("/api/files/:id/download", async (req, res) => {
    const file = publicFiles.find((item) => item.id === req.params.id);
    if (!file || file.expiresAt <= Date.now()) return apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
    const filePath = path.join(publicDir, file.storedName);
    try {
      await access(filePath);
      res.setHeader("Content-Type", file.contentType || "application/octet-stream");
      res.setHeader("Content-Length", String(file.size));
      res.setHeader("Content-Disposition", contentDisposition(file.name));
      createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
    } catch {
      apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
    }
  });

  app.delete("/api/files/:id", async (req, res) => {
    const index = publicFiles.findIndex((item) => item.id === req.params.id);
    if (index < 0) return apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已删除");
    const file = publicFiles[index];
    if (!tokenMatches(headerValue(req, "x-owner-token"), file.ownerTokenHash))
      return apiError(res, 403, "FORBIDDEN", "只有上传者可以删除此文件");
    publicFiles.splice(index, 1);
    await safeRemove(path.join(publicDir, file.storedName));
    await persistPublicFiles();
    io.emit("file:deleted", { id: file.id });
    res.status(204).end();
  });

  app.post("/api/chat-files/:messageId/:fileId", async (req, res) => {
    const message = durableChatMessages.find((item) => item.id === req.params.messageId);
    const file = message?.files?.find((item) => item.id === req.params.fileId);
    const deviceId = cleanName(headerValue(req, "x-device-id"), "", 80);
    const uploadToken = headerValue(req, "x-upload-token");
    if (!message || !file) return apiError(res, 404, "MESSAGE_NOT_FOUND", "聊天文件不存在或已过期");
    if (message.fromDeviceId !== deviceId || message.uploadToken !== uploadToken)
      return apiError(res, 403, "FORBIDDEN", "无权上传此文件");
    if (message.expiresAt <= Date.now()) return apiError(res, 410, "MESSAGE_EXPIRED", "聊天文件已过期");
    if (file.ready) return apiError(res, 409, "ALREADY_UPLOADED", "文件已经上传");
    if (!beginUpload(deviceId)) return apiError(res, 429, "TOO_MANY_UPLOADS", "同时上传的文件过多，请稍后再试");
    const destination = path.join(chatDir, file.storedName);
    try {
      if (!(await hasSpace(file.size))) return apiError(res, 507, "DISK_FULL", "主机磁盘空间不足");
      await receiveStream(req, destination, file.size, (received) => {
        file.received = received;
        emitChatMessage("chat:message:updated", { message: chatView(message) }, message);
      });
      file.received = file.size;
      file.ready = true;
      if (message.files?.every((item) => item.ready)) {
        message.status = "ready";
        delete message.uploadToken;
      }
      await persistChatMessages();
      emitChatMessage("chat:message:updated", { message: chatView(message) }, message);
      res.status(201).json({ ok: true });
    } catch {
      message.status = "error";
      await persistChatMessages();
      emitChatMessage("chat:message:updated", { message: chatView(message) }, message);
      apiError(res, 400, "UPLOAD_FAILED", "文件上传中断，请重试");
    } finally {
      endUpload(deviceId);
    }
  });

  app.get("/api/chat-files/:messageId/:fileId/download", async (req, res) => {
    const message = durableChatMessages.find((item) => item.id === req.params.messageId);
    const file = message?.files?.find((item) => item.id === req.params.fileId);
    const deviceId = cleanName(req.query.deviceId, "", 80);
    if (!message || !file || !file.ready || message.expiresAt <= Date.now() || !mayAccessMessage(message, deviceId))
      return apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
    const filePath = path.join(chatDir, file.storedName);
    try {
      await access(filePath);
      res.setHeader("Content-Type", file.contentType || "application/octet-stream");
      res.setHeader("Content-Length", String(file.size));
      res.setHeader("Content-Disposition", contentDisposition(file.name));
      createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
    } catch {
      apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
    }
  });

  app.post("/api/transfers/:transferId/files/:fileId", async (req, res) => {
    const transfer = transfers.get(req.params.transferId);
    const file = transfer?.files.find((item) => item.id === req.params.fileId);
    const deviceId = cleanName(headerValue(req, "x-device-id"), "", 80);
    const uploadToken = headerValue(req, "x-upload-token");
    if (!transfer || !file) return apiError(res, 404, "TRANSFER_NOT_FOUND", "传输不存在或已过期");
    if (transfer.fromDeviceId !== deviceId || transfer.uploadToken !== uploadToken)
      return apiError(res, 403, "FORBIDDEN", "无权上传此文件");
    if (!["accepted", "uploading"].includes(transfer.status))
      return apiError(res, 409, "INVALID_STATE", "传输当前无法上传");
    if (file.ready) return apiError(res, 409, "ALREADY_UPLOADED", "文件已经上传");
    if (!beginUpload(deviceId)) return apiError(res, 429, "TOO_MANY_UPLOADS", "同时上传的文件过多，请稍后再试");
    const destination = path.join(privateDir, file.storedName);
    try {
      if (!(await hasSpace(file.size))) return apiError(res, 507, "DISK_FULL", "主机磁盘空间不足");
      transfer.status = "uploading";
      await receiveStream(req, destination, file.size, (received) => {
        file.received = received;
        const totalReceived = transfer.files.reduce((sum, item) => sum + item.received, 0);
        const totalBytes = transfer.files.reduce((sum, item) => sum + item.size, 0);
        io.to(`device:${transfer.fromDeviceId}`).to(`device:${transfer.toDeviceId}`).emit("transfer:progress", {
          transferId: transfer.id,
          fileId: file.id,
          received,
          totalReceived,
          totalBytes,
        });
      });
      file.ready = true;
      if (transfer.files.every((item) => item.ready)) {
        transfer.status = "ready";
        io.to(`device:${transfer.toDeviceId}`).emit("transfer:ready", {
          transfer: transferView(transfer),
          downloadToken: transfer.downloadToken,
        });
        io.to(`device:${transfer.fromDeviceId}`).emit("transfer:ready", { transfer: transferView(transfer) });
      }
      res.status(201).json({ ok: true });
    } catch {
      io.to(`device:${transfer.fromDeviceId}`).to(`device:${transfer.toDeviceId}`).emit("transfer:error", {
        transferId: transfer.id,
        code: "UPLOAD_FAILED",
        message: "文件上传中断，请重试",
      });
      apiError(res, 400, "UPLOAD_FAILED", "文件上传中断，请重试");
    } finally {
      endUpload(deviceId);
    }
  });

  app.get("/api/transfers/:transferId/files/:fileId/download", async (req, res) => {
    const transfer = transfers.get(req.params.transferId);
    const file = transfer?.files.find((item) => item.id === req.params.fileId);
    if (!transfer || !file || !file.ready || transfer.downloadToken !== req.query.token)
      return apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
    const filePath = path.join(privateDir, file.storedName);
    try {
      await access(filePath);
      res.setHeader("Content-Type", file.contentType || "application/octet-stream");
      res.setHeader("Content-Length", String(file.size));
      res.setHeader("Content-Disposition", contentDisposition(file.name));
      res.on("finish", () => {
        file.downloaded = true;
        if (transfer.files.every((item) => item.downloaded)) {
          transfer.status = "completed";
          io.to(`device:${transfer.fromDeviceId}`).to(`device:${transfer.toDeviceId}`).emit("transfer:completed", {
            transferId: transfer.id,
          });
          transfer.cleanupTimer = setTimeout(() => void cleanupTransfer(transfer.id, "completed"), COMPLETED_CLEANUP_MS);
        }
      });
      createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
    } catch {
      apiError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
    }
  });

  io.on("connection", (socket) => {
    const deviceId = cleanName(socket.handshake.auth.deviceId, "", 80);
    const name = cleanName(socket.handshake.auth.name, "匿名设备", 32);
    if (!deviceId) {
      socket.disconnect(true);
      return;
    }
    socket.data.deviceId = deviceId;
    socket.join(`device:${deviceId}`);
    const peer = peers.get(deviceId) ?? { deviceId, name, connectedAt: Date.now(), sockets: new Set<string>() };
    peer.name = name;
    peer.sockets.add(socket.id);
    peers.set(deviceId, peer);
    emitPeers();
    socket.emit("chat:history", {
      messages: durableChatMessages.filter((message) => mayAccessMessage(message, deviceId)).map(chatView),
    });

    socket.on("peer:update", (payload: { name?: string }, ack?: Ack) => {
      const nextName = cleanName(payload?.name, peer.name, 32);
      peer.name = nextName;
      peers.set(deviceId, peer);
      emitPeers();
      ack?.({ ok: true, name: nextName });
    });

    socket.on("chat:message", (payload: { toDeviceId?: string; public?: boolean; text?: string }, ack?: Ack) => {
      const toDeviceId = cleanName(payload?.toDeviceId, "", 80);
      const isPublic = payload?.public === true;
      const target = isPublic ? undefined : peers.get(toDeviceId);
      const text = cleanName(payload?.text, "", 1000);
      if (!isPublic && !target) return ack?.({ ok: false, code: "DEVICE_OFFLINE", message: "接收设备已离线" });
      if (!isPublic && toDeviceId === deviceId) return ack?.({ ok: false, code: "INVALID_TARGET", message: "不能发送给自己" });
      if (!text) return ack?.({ ok: false, code: "EMPTY_MESSAGE", message: "请输入消息内容" });
      const now = Date.now();
      const message: DurableChatRecord = {
        id: randomUUID(),
        conversationId: conversationIdFor(deviceId, isPublic ? undefined : toDeviceId),
        fromDeviceId: deviceId,
        fromName: peer.name,
        ...(isPublic ? {} : { toDeviceId }),
        text,
        status: "ready",
        createdAt: now,
        expiresAt: now + CHAT_RETENTION_MS,
      };
      durableChatMessages.push(message);
      void persistChatMessages();
      emitChatMessage("chat:message", { message: chatView(message) }, message);
      ack?.({ ok: true, message: chatView(message) });
    });

    socket.on(
      "chat:file:prepare",
      (
        payload: { toDeviceId?: string; public?: boolean; files?: Array<{ name?: string; size?: number; contentType?: string }> },
        ack?: Ack,
      ) => {
        const toDeviceId = cleanName(payload?.toDeviceId, "", 80);
        const isPublic = payload?.public === true;
        const target = isPublic ? undefined : peers.get(toDeviceId);
        const inputFiles = Array.isArray(payload?.files) ? payload.files.slice(0, 20) : [];
        if (!isPublic && !target) return ack?.({ ok: false, code: "DEVICE_OFFLINE", message: "接收设备已离线" });
        if (!isPublic && toDeviceId === deviceId) return ack?.({ ok: false, code: "INVALID_TARGET", message: "不能发送给自己" });
        if (!inputFiles.length) return ack?.({ ok: false, code: "NO_FILES", message: "请选择文件" });
        const files: ChatFileRecord[] = [];
        for (const input of inputFiles) {
          const size = Number(input?.size);
          if (!Number.isSafeInteger(size) || size < 0)
            return ack?.({ ok: false, code: "INVALID_SIZE", message: "文件大小无效" });
          const id = randomUUID();
          files.push({
            id,
            name: cleanName(input?.name, "未命名文件", 180),
            size,
            contentType: cleanName(input?.contentType, "application/octet-stream", 120),
            storedName: `${id}.bin`,
            received: 0,
            ready: false,
          });
        }
        const now = Date.now();
        const message: DurableChatRecord = {
          id: randomUUID(),
          conversationId: conversationIdFor(deviceId, isPublic ? undefined : toDeviceId),
          fromDeviceId: deviceId,
          fromName: peer.name,
          ...(isPublic ? {} : { toDeviceId }),
          files,
          status: "uploading",
          createdAt: now,
          expiresAt: now + CHAT_RETENTION_MS,
          uploadToken: randomBytes(24).toString("hex"),
        };
        durableChatMessages.push(message);
        void persistChatMessages();
        emitChatMessage("chat:message", { message: chatView(message) }, message);
        ack?.({ ok: true, message: chatView(message), uploadToken: message.uploadToken });
      },
    );

    socket.on(
      "chat:prepare",
      (
        payload: { toDeviceId?: string; files?: Array<{ name?: string; size?: number; contentType?: string }> },
        ack?: Ack,
      ) => {
        const toDeviceId = cleanName(payload?.toDeviceId, "", 80);
        const target = peers.get(toDeviceId);
        const chatFiles = Array.isArray(payload?.files) ? payload.files.slice(0, 20) : [];
        if (!target) return ack?.({ ok: false, code: "DEVICE_OFFLINE", message: "接收设备已离线" });
        if (toDeviceId === deviceId) return ack?.({ ok: false, code: "INVALID_TARGET", message: "不能发送给自己" });
        if (!chatFiles.length) return ack?.({ ok: false, code: "NO_FILES", message: "请选择文件" });
        if (chatFiles.some((file) => !Number.isSafeInteger(file.size) || Number(file.size) < 0))
          return ack?.({ ok: false, code: "INVALID_SIZE", message: "文件大小无效" });

        const now = Date.now();
        const transfer: TransferRecord = {
          id: randomUUID(),
          fromDeviceId: deviceId,
          fromName: peer.name,
          toDeviceId,
          toName: target.name,
          status: "accepted",
          createdAt: now,
          expiresAt: now + PRIVATE_RETENTION_MS,
          uploadToken: randomBytes(24).toString("hex"),
          downloadToken: randomBytes(24).toString("hex"),
          files: chatFiles.map((file) => ({
            id: randomUUID(),
            name: cleanName(file.name, "未命名文件"),
            size: Number(file.size),
            contentType: cleanName(file.contentType, "application/octet-stream", 120),
            storedName: `${randomUUID()}.bin`,
            received: 0,
            ready: false,
            downloaded: false,
          })),
        };
        transfers.set(transfer.id, transfer);
        ack?.({ ok: true, transfer: transferView(transfer) });
        io.to(`device:${toDeviceId}`).emit("chat:pending", { transfer: transferView(transfer) });
        io.to(`device:${deviceId}`).emit("chat:upload-ready", {
          transfer: transferView(transfer),
          uploadToken: transfer.uploadToken,
        });
      },
    );

    socket.on(
      "transfer:offer",
      (
        payload: { toDeviceId?: string; files?: Array<{ name?: string; size?: number; contentType?: string }> },
        ack?: Ack,
      ) => {
        const toDeviceId = cleanName(payload?.toDeviceId, "", 80);
        const target = peers.get(toDeviceId);
        const offeredFiles = Array.isArray(payload?.files) ? payload.files.slice(0, 20) : [];
        if (!target) return ack?.({ ok: false, code: "DEVICE_OFFLINE", message: "接收设备已离线" });
        if (toDeviceId === deviceId) return ack?.({ ok: false, code: "INVALID_TARGET", message: "不能发送给自己" });
        if (!offeredFiles.length) return ack?.({ ok: false, code: "NO_FILES", message: "请选择文件" });
        if (offeredFiles.some((file) => !Number.isSafeInteger(file.size) || Number(file.size) < 0))
          return ack?.({ ok: false, code: "INVALID_SIZE", message: "文件大小无效" });

        const now = Date.now();
        const transfer: TransferRecord = {
          id: randomUUID(),
          fromDeviceId: deviceId,
          fromName: peer.name,
          toDeviceId,
          toName: target.name,
          status: "offered",
          createdAt: now,
          expiresAt: now + PRIVATE_RETENTION_MS,
          uploadToken: randomBytes(24).toString("hex"),
          downloadToken: randomBytes(24).toString("hex"),
          files: offeredFiles.map((file) => ({
            id: randomUUID(),
            name: cleanName(file.name, "未命名文件"),
            size: Number(file.size),
            contentType: cleanName(file.contentType, "application/octet-stream", 120),
            storedName: `${randomUUID()}.bin`,
            received: 0,
            ready: false,
            downloaded: false,
          })),
        };
        transfers.set(transfer.id, transfer);
        io.to(`device:${toDeviceId}`).emit("transfer:offer", { transfer: transferView(transfer) });
        ack?.({ ok: true, transfer: transferView(transfer) });
      },
    );

    socket.on("transfer:accept", (payload: { transferId?: string }, ack?: Ack) => {
      const transfer = transfers.get(cleanName(payload?.transferId, "", 80));
      if (!transfer || transfer.toDeviceId !== socketDevice(socket) || transfer.status !== "offered")
        return ack?.({ ok: false, code: "TRANSFER_NOT_FOUND", message: "传输邀请已失效" });
      transfer.status = "accepted";
      io.to(`device:${transfer.fromDeviceId}`).emit("transfer:accepted", {
        transfer: transferView(transfer),
        uploadToken: transfer.uploadToken,
      });
      io.to(`device:${transfer.toDeviceId}`).emit("transfer:accepted", { transfer: transferView(transfer) });
      ack?.({ ok: true, transfer: transferView(transfer) });
    });

    socket.on("transfer:reject", (payload: { transferId?: string }, ack?: Ack) => {
      const transfer = transfers.get(cleanName(payload?.transferId, "", 80));
      if (!transfer || transfer.toDeviceId !== socketDevice(socket))
        return ack?.({ ok: false, code: "TRANSFER_NOT_FOUND", message: "传输邀请已失效" });
      io.to(`device:${transfer.fromDeviceId}`).emit("transfer:rejected", { transferId: transfer.id });
      void cleanupTransfer(transfer.id, "rejected");
      ack?.({ ok: true });
    });

    socket.on("transfer:cancel", (payload: { transferId?: string }, ack?: Ack) => {
      const transfer = transfers.get(cleanName(payload?.transferId, "", 80));
      const current = socketDevice(socket);
      if (!transfer || ![transfer.fromDeviceId, transfer.toDeviceId].includes(current))
        return ack?.({ ok: false, code: "TRANSFER_NOT_FOUND", message: "传输不存在" });
      io.to(`device:${transfer.fromDeviceId}`).to(`device:${transfer.toDeviceId}`).emit("transfer:cancelled", {
        transferId: transfer.id,
      });
      void cleanupTransfer(transfer.id);
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      const current = peers.get(deviceId);
      current?.sockets.delete(socket.id);
      if (current && current.sockets.size === 0) peers.delete(deviceId);
      emitPeers();
    });
  });

  async function configureFrontend() {
    if (!serveFrontend) return;
    if (production) {
      const distDir = path.join(rootDir, "dist");
      app.use(express.static(distDir, { index: false }));
      app.get(/.*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
      return;
    }
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      root: rootDir,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  async function start() {
    await initializeStorage();
    await configureFrontend();
    cleanupInterval = setInterval(() => void cleanupExpired(), 60_000);
    cleanupInterval.unref();
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    return { port: actualPort, addresses: getLanAddresses(actualPort) };
  }

  async function stop() {
    if (cleanupInterval) clearInterval(cleanupInterval);
    for (const transfer of [...transfers.values()]) await cleanupTransfer(transfer.id);
    await vite?.close();
    io.close();
    if (httpServer.listening) {
      httpServer.closeIdleConnections?.();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    }
  }

  return { app, httpServer, io, start, stop, dataDir };
}

export type LanServer = ReturnType<typeof createLanServer>;
