import {
  Archive,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  File as FileIcon,
  FolderOpen,
  Laptop,
  Paperclip,
  Pencil,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  UploadCloud,
  Users,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type Peer = { deviceId: string; name: string; connectedAt: number };
type PublicFile = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: number;
  expiresAt: number;
  uploadedBy: string;
  uploaderDeviceId: string;
};
type TransferFile = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  received: number;
  ready: boolean;
  downloaded: boolean;
};
type Transfer = {
  id: string;
  fromDeviceId: string;
  fromName: string;
  toDeviceId: string;
  toName: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  files: TransferFile[];
};
type DownloadItem = { id: string; name: string; url: string };
type ActivityStatus = "waiting" | "uploading" | "ready" | "success" | "error" | "rejected";
type Activity = {
  id: string;
  title: string;
  subtitle: string;
  status: ActivityStatus;
  progress: number;
  direction: "send" | "receive" | "public";
  downloads?: DownloadItem[];
  message?: string;
};
type IncomingOffer = { transfer: Transfer };
type ChatMessage = {
  id: string;
  peerId: string;
  mine: boolean;
  files: TransferFile[];
  status: ActivityStatus;
  progress: number;
  createdAt: number;
  downloads?: DownloadItem[];
  message?: string;
};
type TextMessage = {
  id: string;
  peerId: string;
  mine: boolean;
  text: string;
  createdAt: number;
};

const DEVICE_KEY = "lan-drop-device-id";
const NAME_KEY = "lan-drop-device-name";
const OWNER_KEY = "lan-drop-owner-token";

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeIdentity() {
  let deviceId = localStorage.getItem(DEVICE_KEY);
  let ownerToken = localStorage.getItem(OWNER_KEY);
  if (!deviceId) {
    deviceId = makeId();
    localStorage.setItem(DEVICE_KEY, deviceId);
  }
  if (!ownerToken) {
    ownerToken = `${makeId()}${makeId()}`;
    localStorage.setItem(OWNER_KEY, ownerToken);
  }
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const defaultName = `${isMobile ? "我的手机" : "我的电脑"} ${Math.floor(100 + Math.random() * 900)}`;
  const name = localStorage.getItem(NAME_KEY) || defaultName;
  localStorage.setItem(NAME_KEY, name);
  return { deviceId, ownerToken, name };
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function timeAgo(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function expiresIn(timestamp: number) {
  const hours = Math.max(0, Math.ceil((timestamp - Date.now()) / 3_600_000));
  return hours > 0 ? `${hours} 小时后过期` : "即将过期";
}

function uploadRaw(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (value: number) => void,
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {
        // Successful empty responses are valid.
      }
      if (request.status >= 200 && request.status < 300) resolve(body);
      else {
        const error = body.error as { message?: string } | undefined;
        reject(new Error(error?.message || "上传失败，请重试"));
      }
    };
    request.onerror = () => reject(new Error("网络连接中断，请重试"));
    request.onabort = () => reject(new Error("上传已取消"));
    request.send(file);
  });
}

function deviceIcon(name: string) {
  return /手机|iPhone|Android|iPad/i.test(name) ? Smartphone : Laptop;
}

function App() {
  const [identity, setIdentity] = useState(makeIdentity);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState("");
  const [mode, setMode] = useState<"direct" | "public">("direct");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [publicFiles, setPublicFiles] = useState<PublicFile[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [textMessages, setTextMessages] = useState<TextMessage[]>([]);
  const [incoming, setIncoming] = useState<IncomingOffer | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrData, setQrData] = useState("");
  const [nicknameEditing, setNicknameEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [draft, setDraft] = useState("");
  const socketRef = useRef<Socket | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingUploads = useRef(new Map<string, File[]>());
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const otherPeers = useMemo(() => peers.filter((peer) => peer.deviceId !== identity.deviceId), [peers, identity.deviceId]);
  const selectedDevice = otherPeers.find((peer) => peer.deviceId === selectedPeer);
  const selectedSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const conversationItems = useMemo(() => [
    ...chatMessages
      .filter((message) => message.peerId === selectedPeer)
      .map((message) => ({ kind: "file" as const, createdAt: message.createdAt, message })),
    ...textMessages
      .filter((message) => message.peerId === selectedPeer)
      .map((message) => ({ kind: "text" as const, createdAt: message.createdAt, message })),
  ].sort((left, right) => left.createdAt - right.createdAt), [chatMessages, selectedPeer, textMessages]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const upsertActivity = useCallback((activity: Activity) => {
    setActivities((current) => {
      const index = current.findIndex((item) => item.id === activity.id);
      if (index < 0) return [activity, ...current].slice(0, 12);
      const next = [...current];
      next[index] = { ...next[index], ...activity };
      return next;
    });
  }, []);

  const upsertChat = useCallback((message: ChatMessage) => {
    setChatMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return [...current, message].slice(-60);
      const next = [...current];
      next[index] = { ...next[index], ...message };
      return next;
    });
  }, []);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, selectedPeer, textMessages]);

  const loadPublicFiles = useCallback(async () => {
    try {
      const response = await fetch("/api/files");
      const data = (await response.json()) as { files: PublicFile[] };
      setPublicFiles(data.files);
    } catch {
      showToast("无法读取共享文件");
    }
  }, [showToast]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadPublicFiles(), 0);
    void QRCode.toDataURL(window.location.href, {
      width: 320,
      margin: 1,
      color: { dark: "#14343d", light: "#ffffff" },
    }).then(setQrData);
    return () => window.clearTimeout(initialLoad);
  }, [loadPublicFiles]);

  useEffect(() => {
    const socket = io({ auth: { deviceId: identity.deviceId, name: identity.name } });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("peers:update", (list: Peer[]) => {
      setPeers(list);
      const available = list.filter((peer) => peer.deviceId !== identity.deviceId);
      setSelectedPeer((current) => (available.some((peer) => peer.deviceId === current) ? current : available[0]?.deviceId || ""));
    });
    socket.on("file:created", (file: PublicFile) => {
      setPublicFiles((current) => [file, ...current.filter((item) => item.id !== file.id)]);
    });
    socket.on("file:deleted", ({ id }: { id: string }) => {
      setPublicFiles((current) => current.filter((item) => item.id !== id));
    });
    socket.on("transfer:offer", (offer: IncomingOffer) => setIncoming(offer));
    socket.on("chat:history", ({ messages }: { messages: Array<{ id: string; fromDeviceId: string; toDeviceId: string; text: string; createdAt: number }> }) => {
      setTextMessages(messages.map((message) => ({
        id: message.id,
        peerId: message.fromDeviceId === identity.deviceId ? message.toDeviceId : message.fromDeviceId,
        mine: message.fromDeviceId === identity.deviceId,
        text: message.text,
        createdAt: message.createdAt,
      })));
    });
    socket.on("chat:message", ({ message }: { message: { id: string; fromDeviceId: string; toDeviceId: string; text: string; createdAt: number } }) => {
      const item: TextMessage = {
        id: message.id,
        peerId: message.fromDeviceId === identity.deviceId ? message.toDeviceId : message.fromDeviceId,
        mine: message.fromDeviceId === identity.deviceId,
        text: message.text,
        createdAt: message.createdAt,
      };
      setTextMessages((current) => current.some((existing) => existing.id === item.id) ? current : [...current, item].slice(-300));
    });
    socket.on("chat:pending", ({ transfer }: { transfer: Transfer }) => {
      upsertChat({
        id: transfer.id,
        peerId: transfer.fromDeviceId,
        mine: false,
        files: transfer.files,
        status: "uploading",
        progress: 0,
        createdAt: transfer.createdAt,
      });
      upsertActivity({
        id: transfer.id,
        title: `正在接收 ${transfer.files.length} 个文件`,
        subtitle: `来自 ${transfer.fromName}`,
        direction: "receive",
        status: "uploading",
        progress: 0,
      });
    });
    socket.on("chat:upload-ready", ({ transfer, uploadToken }: { transfer: Transfer; uploadToken: string }) => {
      upsertChat({
        id: transfer.id,
        peerId: transfer.toDeviceId,
        mine: true,
        files: transfer.files,
        status: "uploading",
        progress: 0,
        createdAt: transfer.createdAt,
      });
      upsertActivity({
        id: transfer.id,
        title: `发送给 ${transfer.toName}`,
        subtitle: `${transfer.files.length} 个文件 · ${formatBytes(transfer.files.reduce((sum, file) => sum + file.size, 0))}`,
        direction: "send",
        status: "uploading",
        progress: 0,
      });
      const run = async () => {
        try {
          const localFiles = pendingUploads.current.get(transfer.id) ?? [];
          for (let index = 0; index < transfer.files.length; index += 1) {
            const remote = transfer.files[index];
            const local = localFiles[index];
            if (!local) throw new Error("本地文件已不可用，请重新选择");
            await uploadRaw(
              `/api/transfers/${transfer.id}/files/${remote.id}`,
              local,
              {
                "X-Device-Id": identity.deviceId,
                "X-Upload-Token": uploadToken,
                "X-File-Size": String(local.size),
                "Content-Type": local.type || "application/octet-stream",
              },
              () => undefined,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "上传失败";
          upsertChat({ id: transfer.id, peerId: transfer.toDeviceId, mine: true, files: transfer.files, status: "error", progress: 0, createdAt: transfer.createdAt, message });
          upsertActivity({ id: transfer.id, title: `发送给 ${transfer.toName}`, subtitle: "传输失败", direction: "send", status: "error", progress: 0, message });
        }
      };
      window.setTimeout(() => void run(), 0);
    });
    socket.on("transfer:accepted", ({ transfer, uploadToken }: { transfer: Transfer; uploadToken?: string }) => {
      if (!uploadToken) {
        upsertActivity({
          id: transfer.id,
          title: `正在接收 ${transfer.files.length} 个文件`,
          subtitle: `来自 ${transfer.fromName}`,
          direction: "receive",
          status: "uploading",
          progress: 0,
        });
        return;
      }
      const localFiles = pendingUploads.current.get(transfer.id) ?? [];
      upsertActivity({
        id: transfer.id,
        title: `发送给 ${transfer.toName}`,
        subtitle: `${transfer.files.length} 个文件 · ${formatBytes(transfer.files.reduce((sum, file) => sum + file.size, 0))}`,
        direction: "send",
        status: "uploading",
        progress: 0,
      });
      const run = async () => {
        try {
          for (let index = 0; index < transfer.files.length; index += 1) {
            const remote = transfer.files[index];
            const local = localFiles[index];
            if (!local) throw new Error("本地文件已不可用，请重新选择");
            await uploadRaw(
              `/api/transfers/${transfer.id}/files/${remote.id}`,
              local,
              {
                "X-Device-Id": identity.deviceId,
                "X-Upload-Token": uploadToken,
                "X-File-Size": String(local.size),
                "Content-Type": local.type || "application/octet-stream",
              },
              () => undefined,
            );
          }
        } catch (error) {
          upsertActivity({
            id: transfer.id,
            title: `发送给 ${transfer.toName}`,
            subtitle: "传输失败",
            direction: "send",
            status: "error",
            progress: 0,
            message: error instanceof Error ? error.message : "上传失败",
          });
        }
      };
      void run();
    });
    socket.on(
      "transfer:progress",
      ({ transferId, totalReceived, totalBytes }: { transferId: string; totalReceived: number; totalBytes: number }) => {
        setActivities((current) =>
          current.map((item) =>
            item.id === transferId
              ? { ...item, status: "uploading" as const, progress: totalBytes ? Math.round((totalReceived / totalBytes) * 100) : 100 }
              : item,
          ),
        );
        setChatMessages((current) =>
          current.map((item) =>
            item.id === transferId
              ? { ...item, status: "uploading" as const, progress: totalBytes ? Math.round((totalReceived / totalBytes) * 100) : 100 }
              : item,
          ),
        );
      },
    );
    socket.on("transfer:ready", ({ transfer, downloadToken }: { transfer: Transfer; downloadToken?: string }) => {
      if (downloadToken) {
        upsertChat({
          id: transfer.id,
          peerId: transfer.fromDeviceId,
          mine: false,
          files: transfer.files,
          status: "ready",
          progress: 100,
          createdAt: transfer.createdAt,
          downloads: transfer.files.map((file) => ({
            id: file.id,
            name: file.name,
            url: `/api/transfers/${transfer.id}/files/${file.id}/download?token=${encodeURIComponent(downloadToken)}`,
          })),
        });
        upsertActivity({
          id: transfer.id,
          title: `${transfer.files.length} 个文件已送达`,
          subtitle: `来自 ${transfer.fromName} · 请点击下载`,
          direction: "receive",
          status: "ready",
          progress: 100,
          downloads: transfer.files.map((file) => ({
            id: file.id,
            name: file.name,
            url: `/api/transfers/${transfer.id}/files/${file.id}/download?token=${encodeURIComponent(downloadToken)}`,
          })),
        });
      } else {
        upsertChat({ id: transfer.id, peerId: transfer.toDeviceId, mine: true, files: transfer.files, status: "success", progress: 100, createdAt: transfer.createdAt });
        upsertActivity({
          id: transfer.id,
          title: `已发送给 ${transfer.toName}`,
          subtitle: `${transfer.files.length} 个文件已等待对方下载`,
          direction: "send",
          status: "success",
          progress: 100,
        });
        pendingUploads.current.delete(transfer.id);
      }
    });
    socket.on("transfer:completed", ({ transferId }: { transferId: string }) => {
      setActivities((current) => current.map((item) => (item.id === transferId ? { ...item, status: "success" as const } : item)));
      setChatMessages((current) => current.map((item) => (item.id === transferId ? { ...item, status: "success" as const } : item)));
    });
    socket.on("transfer:rejected", ({ transferId }: { transferId: string }) => {
      setActivities((current) =>
        current.map((item) =>
          item.id === transferId ? { ...item, status: "rejected" as const, subtitle: "对方已拒绝接收", progress: 0 } : item,
        ),
      );
      setChatMessages((current) => current.map((item) => (item.id === transferId ? { ...item, status: "error" as const, message: "对方拒绝接收" } : item)));
      pendingUploads.current.delete(transferId);
    });
    socket.on("transfer:cancelled", ({ transferId }: { transferId: string }) => {
      setActivities((current) =>
        current.map((item) =>
          item.id === transferId ? { ...item, status: "error" as const, subtitle: "传输已取消", progress: 0 } : item,
        ),
      );
    });
    socket.on("transfer:error", ({ transferId, message }: { transferId: string; message: string }) => {
      setActivities((current) =>
        current.map((item) => (item.id === transferId ? { ...item, status: "error" as const, message } : item)),
      );
      setChatMessages((current) => current.map((item) => (item.id === transferId ? { ...item, status: "error" as const, message } : item)));
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [identity.deviceId, identity.name, upsertActivity, upsertChat]);

  function saveNickname() {
    const name = identity.name.trim().slice(0, 32) || "匿名设备";
    localStorage.setItem(NAME_KEY, name);
    setIdentity((current) => ({ ...current, name }));
    socketRef.current?.emit("peer:update", { name });
    setNicknameEditing(false);
  }

  function addFiles(files: FileList | File[]) {
    const next = Array.from(files);
    const oversized = next.find((file) => file.size > 2 * 1024 * 1024 * 1024);
    if (oversized) {
      showToast(`${oversized.name} 超过 2GB，无法添加`);
      return;
    }
    setSelectedFiles((current) => [...current, ...next].slice(0, 20));
  }

  function sendText() {
    const text = draft.trim();
    if (!text) return;
    if (!selectedPeer) return showToast("请选择接收设备");
    socketRef.current?.emit("chat:message", { toDeviceId: selectedPeer, text }, (response: { ok: boolean; message?: string }) => {
      if (!response.ok) return showToast(response.message || "消息发送失败");
      setDraft("");
    });
  }

  async function sendSelected() {
    if (!selectedFiles.length) return showToast("请先选择文件");
    if (mode === "direct") {
      if (!selectedPeer) return showToast("请选择接收设备");
      setBusy(true);
      socketRef.current?.emit(
        "chat:prepare",
        {
          toDeviceId: selectedPeer,
          files: selectedFiles.map((file) => ({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" })),
        },
        (response: { ok: boolean; transfer?: Transfer; message?: string }) => {
          setBusy(false);
          if (!response.ok || !response.transfer) return showToast(response.message || "发送邀请失败");
          pendingUploads.current.set(response.transfer.id, [...selectedFiles]);
          upsertChat({ id: response.transfer.id, peerId: response.transfer.toDeviceId, mine: true, files: response.transfer.files, status: "waiting", progress: 0, createdAt: response.transfer.createdAt });
          setSelectedFiles([]);
          showToast("文件消息已发送");
        },
      );
      return;
    }

    setBusy(true);
    for (const file of selectedFiles) {
      const activityId = `public-${makeId()}`;
      upsertActivity({
        id: activityId,
        title: file.name,
        subtitle: `上传到公共文件柜 · ${formatBytes(file.size)}`,
        direction: "public",
        status: "uploading",
        progress: 0,
      });
      try {
        await uploadRaw(
          "/api/files",
          file,
          {
            "X-Device-Id": identity.deviceId,
            "X-Device-Name": encodeURIComponent(identity.name),
            "X-Owner-Token": identity.ownerToken,
            "X-File-Name": encodeURIComponent(file.name),
            "X-File-Size": String(file.size),
            "Content-Type": file.type || "application/octet-stream",
          },
          (progress) =>
            upsertActivity({
              id: activityId,
              title: file.name,
              subtitle: `上传到公共文件柜 · ${formatBytes(file.size)}`,
              direction: "public",
              status: "uploading",
              progress,
            }),
        );
        upsertActivity({
          id: activityId,
          title: file.name,
          subtitle: "已共享，24 小时后自动删除",
          direction: "public",
          status: "success",
          progress: 100,
        });
      } catch (error) {
        upsertActivity({
          id: activityId,
          title: file.name,
          subtitle: "上传失败",
          direction: "public",
          status: "error",
          progress: 0,
          message: error instanceof Error ? error.message : "上传失败",
        });
      }
    }
    setSelectedFiles([]);
    setBusy(false);
  }

  function respondToOffer(accept: boolean) {
    if (!incoming) return;
    socketRef.current?.emit(accept ? "transfer:accept" : "transfer:reject", { transferId: incoming.transfer.id }, (response: { ok: boolean; message?: string }) => {
      if (!response.ok) showToast(response.message || "邀请已失效");
    });
    setIncoming(null);
  }

  async function deletePublicFile(file: PublicFile) {
    const response = await fetch(`/api/files/${file.id}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": identity.ownerToken },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      showToast(body.error?.message || "删除失败");
    } else showToast("文件已删除");
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(window.location.href);
    showToast("访问地址已复制");
  }

  const activeCount = activities.filter((activity) => ["waiting", "uploading", "ready"].includes(activity.status)).length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Zap size={20} strokeWidth={2.7} /></span>
          <span>局域网快传</span>
        </div>
        <div className="topbar-actions">
          <button className="status-pill" type="button" onClick={() => setQrOpen(true)}>
            <span className={`status-dot ${connected ? "online" : ""}`} />
            {connected ? "局域网已连接" : "正在连接"}
            <QrCode size={16} />
          </button>
          <div className={`nickname ${nicknameEditing ? "editing" : ""}`}>
            <Laptop size={16} />
            {nicknameEditing ? (
              <input
                autoFocus
                value={identity.name}
                maxLength={32}
                onChange={(event) => setIdentity((current) => ({ ...current, name: event.target.value }))}
                onBlur={saveNickname}
                onKeyDown={(event) => event.key === "Enter" && saveNickname()}
                aria-label="设备昵称"
              />
            ) : (
              <button type="button" onClick={() => setNicknameEditing(true)}>
                {identity.name}<Pencil size={13} />
              </button>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="workspace-grid">
          <aside className="panel device-panel">
            <div className="panel-heading">
              <div><span className="step">01</span><h2>选择设备</h2></div>
              <span className="live-label"><i /> 实时</span>
            </div>
            <div className="device-list">
              {otherPeers.length ? otherPeers.map((peer) => {
                const Icon = deviceIcon(peer.name);
                const active = selectedPeer === peer.deviceId;
                return (
                  <button key={peer.deviceId} className={`device-card ${active ? "selected" : ""}`} type="button" onClick={() => { setSelectedPeer(peer.deviceId); setMode("direct"); }}>
                    <span className="device-icon"><Icon size={22} /></span>
                    <span className="device-copy"><strong>{peer.name}</strong><small><i /> 在线 · 可接收</small></span>
                    {active ? <span className="selected-check"><Check size={15} /></span> : <ChevronRight size={17} className="chevron" />}
                  </button>
                );
              }) : (
                <div className="empty-devices">
                  <span><Wifi size={24} /></span>
                  <strong>等待其他设备加入</strong>
                  <p>让对方打开本页地址或扫描二维码</p>
                  <button type="button" onClick={() => setQrOpen(true)}><QrCode size={15} /> 显示二维码</button>
                </div>
              )}
              <button
                className={`device-card public-device ${mode === "public" ? "selected" : ""}`}
                type="button"
                onClick={() => setMode("public")}
              >
                <span className="device-icon"><Archive size={22} /></span>
                <span className="device-copy"><strong>公共文件柜</strong><small>所有局域网设备都可下载</small></span>
                {mode === "public" ? <span className="selected-check"><Check size={15} /></span> : <ChevronRight size={17} className="chevron" />}
              </button>
            </div>
            <div className="privacy-note"><ShieldCheck size={17} /><span><strong>仅限局域网</strong><small>文件不会上传到互联网</small></span></div>
          </aside>

          <section className="panel send-panel">
            <div className="conversation-header">
              <span className={`conversation-avatar ${mode === "public" ? "cabinet" : ""}`}>
                {mode === "public" ? <Archive size={22} /> : selectedDevice ? (deviceIcon(selectedDevice.name) === Smartphone ? <Smartphone size={22} /> : <Laptop size={22} />) : <Users size={22} />}
              </span>
              <div>
                <h2>{mode === "direct" ? (selectedDevice ? selectedDevice.name : "选择一个设备开始聊天") : "公共文件柜"}</h2>
                <p>{mode === "direct" ? (selectedDevice ? <><i /> 在线 · 局域网聊天</> : "从左侧选择在线设备") : "局域网内所有设备均可下载 · 保留 24 小时"}</p>
              </div>
              {mode === "direct" && selectedDevice && <span className="conversation-state"><i /> 在线</span>}
            </div>
            {mode === "direct" && (
              <div className="chat-thread" ref={chatScrollRef} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
                {selectedDevice ? (
                  conversationItems.length ? (
                    conversationItems.map((item) => item.kind === "text" ? (
                      <article className={`chat-bubble text-message ${item.message.mine ? "mine" : "theirs"}`} key={item.message.id}>
                        <small className="chat-meta">{item.message.mine ? "你" : selectedDevice.name} · {timeAgo(item.message.createdAt)}</small>
                        <p>{item.message.text}</p>
                      </article>
                    ) : (
                      <article className={`chat-bubble ${item.message.mine ? "mine" : "theirs"}`} key={item.message.id}>
                        <small className="chat-meta">{item.message.mine ? "你" : selectedDevice.name} · {timeAgo(item.message.createdAt)}</small>
                        {item.message.files.map((file) => (
                          <div className="chat-file" key={file.id}>
                            <span><FileIcon size={17} /></span>
                            <div><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div>
                          </div>
                        ))}
                        {item.message.status === "uploading" && <div className="chat-progress"><i style={{ width: `${item.message.progress}%` }} /></div>}
                        <p className={`chat-status ${item.message.status}`}>
                          {item.message.status === "waiting" ? "正在建立传输…" : item.message.status === "uploading" ? `传输中 ${item.message.progress}%` : item.message.status === "ready" ? "文件已送达，请下载" : item.message.status === "success" ? "已发送" : "传输失败"}
                        </p>
                        {item.message.message && <p className="chat-error">{item.message.message}</p>}
                        {item.message.downloads?.map((download) => <a className="chat-download" key={download.id} href={download.url} download><Download size={14} /> 下载 {download.name}</a>)}
                      </article>
                    ))
                  ) : (
                    <div className="chat-empty"><span><Send size={22} /></span><strong>开始聊天</strong><p>发送文字或选择文件，它们都会出现在这段会话中</p></div>
                  )
                ) : (
                  <div className="chat-empty"><span><Users size={22} /></span><strong>先在左侧选择设备</strong><p>对方在线后即可开始文件会话</p></div>
                )}
              </div>
            )}
            {mode === "direct" ? (
              <div className="text-composer">
                <label className="chat-attach" title="添加文件" aria-label="添加文件">
                  <input ref={inputRef} type="file" multiple onChange={(event) => event.target.files && addFiles(event.target.files)} />
                  <Paperclip size={19} />
                </label>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); sendText(); }
                }} maxLength={1000} placeholder={selectedDevice ? `发消息给 ${selectedDevice.name}` : "先在左侧选择设备"} disabled={!selectedPeer} aria-label="聊天消息" />
                <button type="button" onClick={sendText} disabled={!draft.trim() || !selectedPeer}><Send size={17} /> 发送</button>
              </div>
            ) : (
              <div
                className="dropzone"
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && inputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}
              >
                <input ref={inputRef} type="file" multiple onChange={(event) => event.target.files && addFiles(event.target.files)} />
                <span className="upload-orbit"><UploadCloud size={30} /></span>
                <strong>拖拽文件到这里</strong>
                <p>或点击选择文件 · 单文件最大 2GB</p>
              </div>
            )}
            {selectedFiles.length > 0 && (
              <div className="selected-files">
                <div className="selected-summary"><span>{selectedFiles.length} 个文件</span><span>{formatBytes(selectedSize)}</span></div>
                {selectedFiles.slice(0, 4).map((file, index) => (
                  <div className="selected-file" key={`${file.name}-${index}`}>
                    <span className="file-badge"><FileIcon size={17} /></span>
                    <span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
                    <button type="button" aria-label={`移除 ${file.name}`} onClick={(event) => { event.stopPropagation(); setSelectedFiles((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}><X size={16} /></button>
                  </div>
                ))}
                {selectedFiles.length > 4 && <small className="more-files">还有 {selectedFiles.length - 4} 个文件</small>}
                {mode === "direct" && <button className="send-attachments" type="button" disabled={busy || !selectedPeer} onClick={() => void sendSelected()}>{busy ? <RefreshCw size={15} className="spinning" /> : <Send size={15} />} 发送附件</button>}
              </div>
            )}
            {mode === "public" && <button className="primary-action" type="button" disabled={busy || !selectedFiles.length} onClick={() => void sendSelected()}>
              {busy ? <RefreshCw size={18} className="spinning" /> : <UploadCloud size={19} />}
              {busy ? "正在上传" : "上传并共享"}
            </button>}
            {mode === "public" && (
              <section className="public-library" aria-label="公共文件柜文件列表">
                <div className="public-library-heading">
                  <strong>共享文件</strong><span>{publicFiles.length} 个文件</span>
                </div>
                {publicFiles.length ? (
                  <div className="public-library-list">
                    {publicFiles.map((file) => (
                      <article className="public-library-file" key={file.id}>
                        <span className="public-file-icon"><FileIcon size={20} /></span>
                        <div className="public-file-main"><strong>{file.name}</strong><p>{formatBytes(file.size)} · 由 {file.uploadedBy} 上传</p></div>
                        <div className="public-file-time"><span><Clock3 size={13} /> {timeAgo(file.uploadedAt)}</span><small>{expiresIn(file.expiresAt)}</small></div>
                        <div className="file-actions">
                          <a href={`/api/files/${file.id}/download`} download aria-label={`下载 ${file.name}`}><Download size={17} /></a>
                          {file.uploaderDeviceId === identity.deviceId && <button type="button" onClick={() => void deletePublicFile(file)} aria-label={`删除 ${file.name}`}><Trash2 size={16} /></button>}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="public-empty"><Archive size={28} /><strong>文件柜还是空的</strong><p>上传一个文件，让局域网里的设备都能取用</p></div>
                )}
              </section>
            )}
          </section>

          <aside className="panel activity-panel">
            <div className="panel-heading">
              <div><span className="step">03</span><h2>传输记录</h2></div>
              {activeCount > 0 && <span className="count-badge">{activeCount}</span>}
            </div>
            <div className="activity-list">
              {activities.length ? activities.map((activity) => (
                <article className="activity-item" key={activity.id}>
                  <div className="activity-top">
                    <span className={`activity-icon ${activity.direction}`}>
                      {activity.direction === "receive" ? <Download size={17} /> : activity.direction === "public" ? <Archive size={17} /> : <Send size={17} />}
                    </span>
                    <div><strong>{activity.title}</strong><small>{activity.subtitle}</small></div>
                    <span className={`activity-state ${activity.status}`}>
                      {activity.status === "waiting" ? "待确认" : activity.status === "uploading" ? `${activity.progress}%` : activity.status === "ready" ? "待下载" : activity.status === "success" ? "完成" : activity.status === "rejected" ? "已拒绝" : "失败"}
                    </span>
                  </div>
                  {activity.status === "uploading" && <div className="progress-track"><i style={{ width: `${activity.progress}%` }} /></div>}
                  {activity.message && <p className="activity-error">{activity.message}</p>}
                  {activity.downloads?.map((download) => (
                    <a className="download-link" key={download.id} href={download.url} download><Download size={14} /> 下载 {download.name}</a>
                  ))}
                </article>
              )) : (
                <div className="empty-activity"><span><FolderOpen size={25} /></span><strong>还没有传输记录</strong><p>发送或接收的文件会显示在这里</p></div>
              )}
            </div>
          </aside>
        </section>

      </main>

      <footer><span><ShieldCheck size={15} /> 文件只在你的局域网内流转</span><span>公共文件 24 小时后自动清理 · 私人传输 1 小时有效</span></footer>

      {incoming && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="收到文件">
          <div className="offer-modal">
            <span className="modal-signal"><Send size={24} /></span>
            <span className="modal-kicker">收到文件邀请</span>
            <h2>{incoming.transfer.fromName} 想发给你</h2>
            <div className="offer-files">
              {incoming.transfer.files.map((file) => <div key={file.id}><FileIcon size={17} /><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span></div>)}
            </div>
            <p className="offer-note"><ShieldCheck size={15} /> 接受后才会开始上传，不会自动下载</p>
            <div className="modal-actions"><button type="button" onClick={() => respondToOffer(false)}>拒绝</button><button className="accept" type="button" onClick={() => respondToOffer(true)}><Check size={17} /> 接收文件</button></div>
          </div>
        </div>
      )}

      {qrOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="局域网访问二维码" onMouseDown={(event) => event.target === event.currentTarget && setQrOpen(false)}>
          <div className="qr-modal">
            <button className="modal-close" type="button" onClick={() => setQrOpen(false)} aria-label="关闭"><X size={18} /></button>
            <span className="modal-kicker">邀请设备加入</span>
            <h2>扫描二维码打开快传</h2>
            <p>确保手机或电脑连接了同一个 Wi-Fi</p>
            <div className="qr-frame">{qrData && <img src={qrData} alt="当前网页访问二维码" />}</div>
            <code>{window.location.href}</code>
            <button className="copy-button" type="button" onClick={() => void copyAddress()}><Copy size={16} /> 复制访问地址</button>
          </div>
        </div>
      )}

      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </div>
  );
}

export default App;
