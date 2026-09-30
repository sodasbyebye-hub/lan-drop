import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { mediaTypeOf } from "../shared/media.js";

type MediaRecord = {
  id: string; kind: "image" | "video"; name: string; contentType: string; size: number;
  caption: string; uploadedAt: number; uploadedBy: string; uploaderDeviceId: string;
  storedName: string; source: "upload" | "chat"; sourceKey?: string; toDeviceId?: string;
};
type ChatSource = {
  id: string; fromDeviceId: string; fromName: string; toDeviceId?: string; createdAt: number; text?: string;
  files?: Array<{ id: string; name: string; contentType: string; size: number; ready: boolean; storedName: string }>;
};
type Options = {
  dataDir: string; chatDir: string;
  beginUpload: (deviceId: string) => boolean;
  endUpload: (deviceId: string) => void;
  hasSpace: (size: number) => Promise<boolean>;
  receiveStream: (req: Request, destination: string, size: number) => Promise<number>;
  changed: (record: MediaRecord) => void;
};

function safeText(input: unknown, max: number) {
  return typeof input === "string" ? [...input].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("").trim().slice(0, max) : "";
}
function headerText(req: Request, name: string, max: number) {
  try { return safeText(decodeURIComponent(req.header(name) || ""), max); } catch { return ""; }
}
function fail(res: Response, status: number, message: string) { res.status(status).json({ message }); }

export function createMediaLibrary(options: Options) {
  const root = path.join(options.dataDir, "media");
  const indexPath = path.join(root, "index.json");
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  let records: MediaRecord[] = [];
  let queue = Promise.resolve();
  const pendingImports = new Map<string, Promise<void>>();
  const filePath = (item: MediaRecord) => path.join(root, item.kind === "image" ? "images" : "videos", path.basename(item.storedName));
  const mayAccess = (item: MediaRecord, deviceId: string) => !item.toDeviceId || item.uploaderDeviceId === deviceId || item.toDeviceId === deviceId;
  const view = (item: MediaRecord) => ({ id: item.id, kind: item.kind, name: item.name, contentType: item.contentType, size: item.size,
    caption: item.caption, uploadedAt: item.uploadedAt, uploadedBy: item.uploadedBy, source: item.source, private: Boolean(item.toDeviceId) });

  function transaction(change: (current: MediaRecord[]) => MediaRecord[]) {
    const task = queue.then(async () => {
      const next = change(records);
      const temporary = `${indexPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), "utf8");
        await rename(temporary, indexPath);
        records = next;
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    queue = task.catch(() => undefined);
    return task;
  }

  async function initialize() {
    await Promise.all([mkdir(path.join(root, "images"), { recursive: true }), mkdir(path.join(root, "videos"), { recursive: true })]);
    let parsed: MediaRecord[];
    try { parsed = JSON.parse(await readFile(indexPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!Array.isArray(parsed)) throw new Error("Invalid media library index");
    for (const item of parsed) {
      if ((item.kind !== "image" && item.kind !== "video") || typeof item.storedName !== "string") continue;
      try { const info = await stat(filePath(item)); if (info.isFile() && info.size === item.size) records.push(item); } catch { /* Missing media is excluded. */ }
    }
  }

  async function importChat(message: ChatSource) {
    for (const file of message.files ?? []) {
      const mediaType = mediaTypeOf(file.name, file.contentType);
      if (!file.ready || !mediaType) continue;
      const sourceKey = `${message.id}:${file.id}`;
      if (records.some((item) => item.sourceKey === sourceKey)) continue;
      const pending = pendingImports.get(sourceKey);
      if (pending) { await pending; continue; }
      const task = (async () => {
        const id = randomUUID();
        const item: MediaRecord = { id, ...mediaType, name: file.name, size: file.size, caption: safeText(message.text, 1000),
          uploadedAt: message.createdAt, uploadedBy: message.fromName, uploaderDeviceId: message.fromDeviceId,
          storedName: `${id}.bin`, source: "chat", sourceKey, ...(message.toDeviceId ? { toDeviceId: message.toDeviceId } : {}) };
        const original = path.join(options.chatDir, path.basename(file.storedName));
        try {
          // Separate directory entries retain media after chat history expires,
          // while hard links avoid duplicating large files on the same disk.
          try { await link(original, filePath(item)); }
          catch { if (!(await options.hasSpace(file.size))) throw new Error("Media library disk full"); await copyFile(original, filePath(item)); }
          await transaction((current) => [...current, item]);
          options.changed(item);
        } catch (error) { await rm(filePath(item), { force: true }).catch(() => undefined); throw error; }
      })();
      pendingImports.set(sourceKey, task);
      try { await task; } finally { pendingImports.delete(sourceKey); }
    }
  }

  router.get("/", (req, res) => {
    const deviceId = safeText(req.query.deviceId, 80);
    res.json({ items: records.filter((item) => mayAccess(item, deviceId)).sort((a, b) => b.uploadedAt - a.uploadedAt).map(view) });
  });

  router.post("/", async (req, res) => {
    const deviceId = safeText(req.header("x-device-id"), 80);
    const name = headerText(req, "x-file-name", 180);
    const type = mediaTypeOf(name, req.header("content-type") || "");
    const size = Number(req.header("x-file-size"));
    if (!deviceId || !name) return fail(res, 400, "设备信息或文件名无效");
    if (!type) return fail(res, 415, "仅支持图片和视频文件");
    if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 400, "文件大小无效");
    if (!options.beginUpload(deviceId)) return fail(res, 429, "同时上传的文件过多，请稍后重试");
    const id = randomUUID();
    const item: MediaRecord = { id, ...type, name, size, caption: headerText(req, "x-media-caption", 1000), uploadedAt: Date.now(),
      uploadedBy: headerText(req, "x-device-name", 32) || "未知设备", uploaderDeviceId: deviceId, storedName: `${id}.bin`, source: "upload" };
    const destination = filePath(item);
    const temporary = `${destination}.upload`;
    try {
      if (!(await options.hasSpace(size))) return fail(res, 507, "主机磁盘空间不足");
      await options.receiveStream(req, temporary, size);
      await rename(temporary, destination);
      await transaction((current) => [...current, item]);
      options.changed(item);
      res.status(201).json({ item: view(item) });
    } catch {
      await rm(destination, { force: true }).catch(() => undefined);
      fail(res, 400, "上传失败，请重试");
    } finally {
      options.endUpload(deviceId);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });

  router.patch("/:id", express.json({ limit: "16kb" }), async (req, res) => {
    const deviceId = safeText(req.header("x-device-id"), 80);
    const item = records.find((record) => record.id === req.params.id);
    if (!item || !deviceId || !mayAccess(item, deviceId)) return fail(res, 404, "素材不存在或无权访问");
    if (typeof req.body?.caption !== "string" || req.body.caption.length > 1000) return fail(res, 400, "配文最多 1000 字");
    const updated = { ...item, caption: safeText(req.body.caption, 1000) };
    try {
      await transaction((current) => current.map((record) => record.id === item.id ? updated : record));
      options.changed(updated);
      res.json({ item: view(updated) });
    } catch { fail(res, 500, "配文保存失败，请重试"); }
  });

  for (const action of ["preview", "download"]) {
    router.get(`/:id/${action}`, (req, res) => {
      const item = records.find((record) => record.id === req.params.id);
      if (!item || !mayAccess(item, safeText(req.query.deviceId, 80))) return fail(res, 404, "素材不存在或无权访问");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", item.contentType);
      const done = (error?: Error) => { if (error && !res.headersSent) fail(res, 404, "素材文件不可用"); };
      // sendFile supports byte ranges so videos can seek without buffering.
      if (action === "download") res.download(filePath(item), item.name, done);
      else res.sendFile(filePath(item), done);
    });
  }
  return { router, initialize, importChat, flush: () => queue };
}
