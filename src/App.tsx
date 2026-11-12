import {
  Check,
  ChevronLeft,
  Copy,
  Download,
  File as FileIcon,
  Paperclip,
  Send,
  Users,
  Wifi,
  X,
  Zap,
  Trash2,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { readIdentity, saveDeviceName } from "./device-identity";
import { useChatScroll } from "./use-chat-scroll";
import { ImageStack } from "./ImageStack";
import { MediaLibrary } from "./MediaLibrary";
import { chatMediaKind as mediaKind } from "../shared/media";
import { deleteAsHost } from "./host-actions";

type Peer = { deviceId: string; name: string; connectedAt: number };
type ChatFile = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  received: number;
  ready: boolean;
};
type ChatRecord = {
  id: string;
  conversationId: string;
  fromDeviceId: string;
  fromName: string;
  toDeviceId?: string;
  toName?: string;
  text?: string;
  files?: ChatFile[];
  status: "uploading" | "ready" | "error";
  createdAt: number;
  expiresAt: number;
  readBy?: ChatReceipt[];
  downloadedBy?: ChatReceipt[];
};
type ChatReceipt = { deviceId: string; name: string; at: number };

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeIdentity() {
  return readIdentity(localStorage, navigator, makeId);
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function avatarLetter(name: string) {
  return [...name.trim()][0]?.toUpperCase() || "?";
}

function conversationId(fromDeviceId: string, toDeviceId: string) {
  return [fromDeviceId, toDeviceId].sort().join(":");
}

function receiptNames(receipts: ChatReceipt[] | undefined) {
  if (!receipts?.length) return "";
  const names = receipts.slice(0, 3).map((receipt) => receipt.name).join("、");
  return receipts.length > 3 ? `${names} 等 ${receipts.length} 人` : names;
}

function PendingFilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const kind = mediaKind(file.type, file.name);
  const previewUrl = useMemo(() => {
    try { return kind ? URL.createObjectURL(file) : ""; }
    catch { return ""; }
  }, [file, kind]);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div className="pending-file">
      <div className="pending-file-preview">
        {kind === "image" && previewUrl ? <img src={previewUrl} alt={`预览 ${file.name}`} /> : null}
        {kind === "video" && previewUrl ? <video src={previewUrl} controls playsInline preload="metadata" aria-label={`预览 ${file.name}`} /> : null}
        {!previewUrl ? <FileIcon size={26} /> : null}
      </div>
      <div className="pending-file-info"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div>
      <button type="button" onClick={onRemove} aria-label={`移除 ${file.name}`}><X size={16} /></button>
    </div>
  );
}

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // LAN pages commonly use HTTP, so fall back to selection-based copying.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("COPY_FAILED");
}

function uploadRaw(url: string, file: File, headers: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.responseType = "json";
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(request.response?.message || "文件上传失败，请重试"));
    request.onerror = () => reject(new Error("网络连接中断，请重试"));
    request.onabort = () => reject(new Error("上传已取消"));
    request.send(file);
  });
}

function App() {
  const [identity, setIdentity] = useState(makeIdentity);
  const [connected, setConnected] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [preferredPeer, setSelectedPeer] = useState("");
  const [isPublicChat, setIsPublicChat] = useState(true);
  const [messages, setMessages] = useState<ChatRecord[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [qrData, setQrData] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [downloadedFiles, setDownloadedFiles] = useState<Record<string, boolean>>({});
  const socketRef = useRef<Socket | null>(null);
  const [pickerVersion, setPickerVersion] = useState(0);
  const handledPicker = useRef<HTMLInputElement | null>(null);
  const activeConversationRef = useRef("");

  const otherPeers = useMemo(() => peers.filter((peer) => peer.deviceId !== identity.deviceId), [peers, identity.deviceId]);
  const chatPeers = useMemo(() => {
    const history = new Map<string, { deviceId: string; name: string; lastAt: number }>();
    for (const message of messages) {
      if (!message.toDeviceId) continue;
      const outgoing = message.fromDeviceId === identity.deviceId;
      if (!outgoing && message.toDeviceId !== identity.deviceId) continue;
      const deviceId = outgoing ? message.toDeviceId : message.fromDeviceId;
      const name = outgoing ? message.toName : message.fromName;
      const existing = history.get(deviceId);
      if (!existing || (name && message.createdAt >= existing.lastAt)) {
        history.set(deviceId, { deviceId, name: name || "离线设备 · " + deviceId.slice(-6), lastAt: name ? message.createdAt : 0 });
      }
    }
    const online = new Set(otherPeers.map((peer) => peer.deviceId));
    return [
      ...otherPeers.map((peer) => ({ ...peer, online: true })),
      ...[...history.values()].filter((peer) => !online.has(peer.deviceId))
        .sort((a, b) => b.lastAt - a.lastAt).map((peer) => ({ ...peer, online: false })),
    ];
  }, [messages, identity.deviceId, otherPeers]);
  const activePeer = chatPeers.find((peer) => peer.deviceId === preferredPeer) ?? chatPeers[0];
  const selectedPeer = activePeer?.deviceId ?? "";
  const canSend = isPublicChat || activePeer?.online === true;
  const activeConversation = isPublicChat ? "public" : selectedPeer ? conversationId(identity.deviceId, selectedPeer) : "";
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.conversationId === activeConversation).sort((left, right) => left.createdAt - right.createdAt),
    [activeConversation, messages],
  );
  const activeTitle = isPublicChat ? "公共聊天" : activePeer?.name || "选择一个设备";
  const { messagesRef, contentRef } = useChatScroll(activeConversation, visibleMessages.length, historyRevision);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const upsertMessage = useCallback((message: ChatRecord) => {
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return [...current, message];
      const next = [...current];
      next[index] = { ...next[index], ...message };
      return next;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      root.style.setProperty("--app-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty("--app-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
    };
  }, []);

  useEffect(() => {
    activeConversationRef.current = libraryOpen ? "" : activeConversation;
  }, [activeConversation, libraryOpen]);

  useEffect(() => {
    if (libraryOpen || !activeConversation || !socketRef.current) return;
    const messageIds = visibleMessages.filter((message) => message.fromDeviceId !== identity.deviceId).map((message) => message.id);
    if (messageIds.length) socketRef.current.emit("chat:read", { conversationId: activeConversation, messageIds });
  }, [activeConversation, identity.deviceId, visibleMessages, libraryOpen]);

  useEffect(() => {
    void QRCode.toDataURL(window.location.href, { width: 320, margin: 1, color: { dark: "#153941", light: "#ffffff" } }).then(setQrData);
  }, []);

  useEffect(() => {
    const socket = io({ auth: { deviceId: identity.deviceId, name: identity.name } });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true); setMediaRevision((revision) => revision + 1);
      void fetch("/api/host", { cache: "no-store" }).then((response) => response.json()).then((body) => setCanManage(body.canManage === true)).catch(() => setCanManage(false));
    });
    socket.on("media:changed", () => setMediaRevision((revision) => revision + 1));
    socket.on("disconnect", () => setConnected(false));
    socket.on("peers:update", (list: Peer[]) => {
      setPeers(list);
    });
    socket.on("chat:history", ({ messages: history }: { messages: ChatRecord[] }) => {
      setMessages(history);
      setHistoryRevision((revision) => revision + 1);
    });
    socket.on("chat:message", ({ message }: { message: ChatRecord }) => {
      upsertMessage(message);
      if (message.fromDeviceId !== identity.deviceId && message.conversationId !== activeConversationRef.current) {
        setUnreadCounts((current) => ({ ...current, [message.conversationId]: (current[message.conversationId] || 0) + 1 }));
      }
    });
    socket.on("chat:message:updated", ({ message }: { message: ChatRecord }) => upsertMessage(message));
    socket.on("chat:message:deleted", ({ id }: { id: string }) => setMessages((current) => current.filter((message) => message.id !== id)));
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [identity.deviceId, identity.name, upsertMessage]);

  function choosePublicChat() {
    setLibraryOpen(false);
    setIsPublicChat(true);
    setFiles([]);
    setUnreadCounts((current) => {
      if (!current.public) return current;
      const next = { ...current };
      delete next.public;
      return next;
    });
  }

  function choosePeer(peer: { deviceId: string }) {
    setLibraryOpen(false);
    setSelectedPeer(peer.deviceId);
    setIsPublicChat(false);
    setFiles([]);
    const chatId = conversationId(identity.deviceId, peer.deviceId);
    setUnreadCounts((current) => {
      if (!current[chatId]) return current;
      const next = { ...current };
      delete next[chatId];
      return next;
    });
  }

  function saveName() {
    const name = saveDeviceName(localStorage, identity.name, navigator);
    setIdentity((current) => ({ ...current, name }));
    socketRef.current?.emit("peer:update", { name });
    setEditingName(false);
  }

  function addFiles(input: FileList | File[]) {
    const selected = Array.from(input);
    setFiles((current) => [...current, ...selected].slice(0, 20));
  }

  function acceptPickedFiles(input: HTMLInputElement) {
    if (handledPicker.current === input || !input.files?.length) return;
    handledPicker.current = input;
    addFiles(input.files);
    // Replace the picker only after copying the selection. This also allows
    // picking the same photo again without clearing the live native input.
    setPickerVersion((version) => version + 1);
  }

  function removePendingFile(index: number) {
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
  }

  function sendText() {
    const text = draft.trim();
    if (!text) return;
    if (!canSend) return showToast(activePeer ? "设备已离线，重新上线后可发送" : "请选择接收设备");
    socketRef.current?.emit(
      "chat:message",
      isPublicChat ? { public: true, text } : { toDeviceId: selectedPeer, text },
      (result: { ok: boolean; message?: string }) => {
        if (!result.ok) return showToast(result.message || "消息发送失败");
        setDraft("");
      },
    );
  }

  function sendFiles() {
    if (!files.length) return;
    if (!canSend) return showToast(activePeer ? "设备已离线，重新上线后可发送" : "请选择接收设备");
    const socket = socketRef.current;
    if (!socket?.connected) return showToast("尚未连接主机，请刷新页面后重试");
    setBusy(true);
    const localFiles = [...files];
    socket.timeout(10000).emit(
      "chat:file:prepare",
      isPublicChat
        ? { public: true, files: localFiles.map((file) => ({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" })) }
        : { toDeviceId: selectedPeer, files: localFiles.map((file) => ({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" })) },
      async (failure: Error | null, result?: { ok: boolean; message?: ChatRecord | string; uploadToken?: string }) => {
        if (failure || !result?.ok || !result.message || typeof result.message === "string" || !result.uploadToken) {
          setBusy(false);
          return showToast(failure ? "主机未响应，请检查连接后重试" : typeof result?.message === "string" ? result.message : "文件消息发送失败");
        }
        upsertMessage(result.message);
        try {
          for (let index = 0; index < localFiles.length; index += 1) {
            const remote = result.message.files?.[index];
            if (!remote) throw new Error("文件准备失败");
            await uploadRaw(`/api/chat-files/${result.message.id}/${remote.id}`, localFiles[index], {
              "X-Device-Id": identity.deviceId,
              "X-Upload-Token": result.uploadToken,
              "X-File-Size": String(localFiles[index].size),
              "Content-Type": localFiles[index].type || "application/octet-stream",
            });
          }
          setFiles([]);
        } catch (error) {
          showToast(error instanceof Error ? error.message : "文件发送失败");
        } finally {
          setBusy(false);
        }
      },
    );
  }

  async function copyMessageText(text: string) {
    try {
      await writeClipboard(text);
      showToast("消息已复制");
    } catch {
      showToast("复制失败，请长按消息复制");
    }
  }

  async function deleteChat(message?: ChatRecord) {
    if (deleting || !activeConversation) return;
    const prompt = message ? "永久删除这条消息及其附件？对应的媒体库图片、视频也会删除，所有设备同步生效，无法恢复。" : "永久清空当前聊天的全部记录及附件？对应的媒体库图片、视频也会删除，所有设备同步生效，无法恢复。";
    if (!window.confirm(prompt)) return;
    setDeleting(true);
    try {
      await deleteAsHost(message ? `/api/chat/messages/${message.id}` : `/api/chat/conversations/${encodeURIComponent(activeConversation)}`);
      setMessages((current) => current.filter((item) => message ? item.id !== message.id : item.conversationId !== activeConversation));
      setMediaRevision((revision) => revision + 1);
      showToast(message ? "消息及对应附件已删除" : "当前聊天已清空");
    } catch (error) { showToast(error instanceof Error ? error.message : "删除失败，请重试"); }
    finally { setDeleting(false); }
  }

  async function copyAddress() {
    try {
      await writeClipboard(window.location.href);
      showToast("访问地址已复制");
    } catch {
      showToast("复制失败，请长按地址复制");
    }
  }

  return (
    <div className="chat-app">
      <header className="chat-topbar">
        <div className="chat-brand"><span><Zap size={20} /></span><div><strong>局域网聊天</strong><small>同一网络，消息与文件即时送达</small></div></div>
        <nav className="app-view-switch" aria-label="功能切换"><button type="button" aria-pressed={!libraryOpen} onClick={() => setLibraryOpen(false)}>聊天</button><button type="button" aria-pressed={libraryOpen} onClick={() => setLibraryOpen(true)}>媒体库</button></nav>
        <div className="network-state"><span className={connected ? "online" : ""} /><Wifi size={15} /> {connected ? "局域网已连接" : "正在连接"}</div>
        <div className="online-count"><Users size={17} /> {otherPeers.length + 1} 台设备在线</div>
        <button className="profile-button" type="button" onClick={() => setEditingName(true)} aria-label="编辑我的设备名称">{avatarLetter(identity.name)}</button>
      </header>

      <main className="chat-layout">
        <aside className="chat-sidebar">
          <div className="sidebar-heading"><strong>附近设备</strong><button type="button" onClick={() => socketRef.current?.emit("peer:update", {})} aria-label="刷新设备"><Wifi size={17} /></button></div>
          <button className={`public-chat-item ${isPublicChat ? "active" : ""}`} type="button" onClick={choosePublicChat}>
            <span className="group-avatar"><Users size={21} /></span><span><strong>公共聊天</strong><small>所有局域网设备都能看到</small></span>{unreadCounts.public ? <span className="unread-badge">{unreadCounts.public > 99 ? "99+" : unreadCounts.public}</span> : null}{isPublicChat && <Check size={17} />}
          </button>
          <div className="device-items">
            <div className="device-label">设备聊天</div>
            {chatPeers.length ? chatPeers.map((peer) => (
              <button className={`device-item ${!isPublicChat && selectedPeer === peer.deviceId ? "active" : ""}`} type="button" key={peer.deviceId} onClick={() => choosePeer(peer)}>
                <span className="letter-avatar">{avatarLetter(peer.name)}</span>
                <span><strong>{peer.name}</strong><small>{peer.online ? <><i /> 在线</> : "已离线 · 可查看记录"}</small></span>{unreadCounts[conversationId(identity.deviceId, peer.deviceId)] ? <span className="unread-badge">{unreadCounts[conversationId(identity.deviceId, peer.deviceId)] > 99 ? "99+" : unreadCounts[conversationId(identity.deviceId, peer.deviceId)]}</span> : null}
              </button>
            )) : <p className="no-devices">等待其他设备加入同一局域网</p>}
          </div>
          <div className="network-note"><Wifi size={23} /><strong>所有设备都在同一网络</strong><small>消息和文件不会离开局域网</small><button type="button" onClick={() => setQrOpen(true)}>显示加入二维码</button></div>
        </aside>

        <MediaLibrary identity={identity} revision={mediaRevision} active={libraryOpen} canManage={canManage} />
        <section className="conversation-panel" hidden={libraryOpen}>
          <div className="conversation-top">
            <button className="back-button" type="button" aria-label="返回设备列表"><ChevronLeft size={21} /></button>
            <span className={isPublicChat ? "conversation-avatar group" : "conversation-avatar"}>{isPublicChat ? <Users size={23} /> : avatarLetter(activePeer?.name || "?")}</span>
            <div><strong>{activeTitle}</strong><small>{isPublicChat ? `${otherPeers.length + 1} 台设备可参与 · 保存 30 天` : activePeer ? activePeer.online ? <><i /> 在线</> : "已离线 · 可查看记录和下载文件" : "从左侧选择设备"}</small></div>
            <select
              className="mobile-chat-picker"
              value={isPublicChat ? "public" : selectedPeer}
              onChange={(event) => {
                if (event.target.value === "public") choosePublicChat();
                else {
                  const peer = chatPeers.find((item) => item.deviceId === event.target.value);
                  if (peer) choosePeer(peer);
                }
              }}
              aria-label="选择聊天对象"
            >
              <option value="public">公共聊天</option>
              {chatPeers.map((peer) => <option key={peer.deviceId} value={peer.deviceId}>{peer.name}{peer.online ? "" : "（离线）"}</option>)}
            </select>
            {canManage && <button className="host-clear-button" type="button" aria-label="清空当前聊天" disabled={deleting || !visibleMessages.length} onClick={() => void deleteChat()} title="主机管理：清空当前聊天"><Trash2 size={15} /><span>清空当前聊天</span></button>}
          </div>

          <div className="message-area" ref={messagesRef} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
            <div className="message-content" ref={contentRef}>
            <span className="day-divider">聊天记录保留 30 天</span>
            {visibleMessages.length ? visibleMessages.map((message) => {
              const mine = message.fromDeviceId === identity.deviceId;
              const imageFiles = message.files?.filter((file) => mediaKind(file.contentType, file.name) === "image") ?? [];
              const stackedImages = imageFiles.length > 1;
              const progress = message.files?.length ? Math.round(message.files.reduce((sum, file) => sum + file.received, 0) / message.files.reduce((sum, file) => sum + file.size, 0) * 100) : 100;
              const fileDownloadNames = receiptNames(message.downloadedBy);
              const readNames = receiptNames(message.readBy);
              const receipt = mine && message.status === "ready"
                ? isPublicChat
                  ? fileDownloadNames ? `已下载：${fileDownloadNames}` : readNames ? `已读：${readNames}` : "未读"
                  : readNames ? "对方已读" : "已发送"
                : "";
              return (
                <article className={`message-row ${mine ? "mine" : "theirs"}`} key={message.id}>
                  {!mine && <span className="message-avatar">{avatarLetter(message.fromName)}</span>}
                  <div className={`message-bubble ${message.files?.length ? "has-files" : ""}`}>
                    {isPublicChat && !mine && <strong className="sender-name">{message.fromName}</strong>}
                    {message.text && <div className="message-text-content"><p>{message.text}</p><button className="copy-message-button" type="button" onClick={() => void copyMessageText(message.text || "")} title="复制消息" aria-label="复制消息"><Copy size={14} /></button></div>}
                    {stackedImages && <ImageStack messageId={message.id} deviceId={identity.deviceId} files={imageFiles} failed={message.status === "error"} downloadedFiles={downloadedFiles} onDownload={(fileId) => setDownloadedFiles((current) => ({ ...current, [`${message.id}:${fileId}`]: true }))} />}
                    {message.files?.filter((file) => !stackedImages || mediaKind(file.contentType, file.name) !== "image").map((file) => {
                      const kind = mediaKind(file.contentType, file.name);
                      const previewUrl = `/api/chat-files/${message.id}/${file.id}/preview?deviceId=${encodeURIComponent(identity.deviceId)}`;
                      const downloadKey = `${message.id}:${file.id}`;
                      const downloaded = Boolean(downloadedFiles[downloadKey]);
                      return (
                        <div className="file-attachment" key={file.id}>
                          {file.ready && kind === "image" ? <img className="message-media-preview" src={previewUrl} alt={file.name} loading="lazy" /> : null}
                          {file.ready && kind === "video" ? <video className="message-media-preview" src={previewUrl} controls playsInline preload="metadata" aria-label={file.name} /> : null}
                          <div className="file-message">
                            <span><FileIcon size={23} /></span>
                            <div><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.contentType.split("/").pop()?.toUpperCase() || "文件"}</small>
                              {message.status === "uploading" && <div className="file-progress"><i style={{ width: `${progress}%` }} /></div>}
                            </div>
                            {file.ready ? <a className={`file-download-button ${downloaded ? "downloaded" : ""}`} href={`/api/chat-files/${message.id}/${file.id}/download?deviceId=${encodeURIComponent(identity.deviceId)}`} download onClick={() => setDownloadedFiles((current) => ({ ...current, [downloadKey]: true }))} aria-label={downloaded ? `${file.name} 已下载，可再次下载` : `下载 ${file.name}`}>{downloaded ? <><Check size={15} /><span>已下载</span></> : <Download size={18} />}</a> : <span className="file-status">{message.status === "error" ? "失败" : `${progress}%`}</span>}
                          </div>
                        </div>
                      );
                    })}
                    <small className="message-time">{canManage && <button className="host-delete-button" type="button" aria-label="删除消息" title="主机管理：删除消息及对应附件" disabled={deleting} onClick={() => void deleteChat(message)}><Trash2 size={14} /></button>}{receipt && <span className="message-receipt">{receipt}</span>}{formatTime(message.createdAt)} {mine && message.status === "ready" && <Check size={12} />}</small>
                  </div>
                </article>
              );
            }) : <div className="empty-conversation"><span>{isPublicChat ? <Users size={26} /> : <Send size={26} />}</span><strong>{isPublicChat ? "开始公共聊天" : "开始设备聊天"}</strong><p>发送消息或文件，它们会保存 30 天。</p></div>}
            </div>
          </div>

          {files.length > 0 && <div className="attachment-tray"><div className="pending-file-list">{files.map((file, index) => <PendingFilePreview file={file} onRemove={() => removePendingFile(index)} key={`${file.name}-${file.size}-${file.lastModified}-${index}`} />)}</div><div className="attachment-actions"><div><strong>准备发送 {files.length} 个文件</strong><small>{formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</small></div><button type="button" onClick={() => setFiles([])} aria-label="移除全部待发送文件"><X size={17} /></button><button className="send-file-button" type="button" onClick={sendFiles} disabled={busy || !canSend}>{busy ? "发送中…" : "发送文件"}</button></div></div>}
          <div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
            <label title="添加文件"><input key={pickerVersion} aria-label="添加文件" type="file" multiple disabled={busy} onInput={(event) => acceptPickedFiles(event.currentTarget)} onChange={(event) => acceptPickedFiles(event.currentTarget)} /><Paperclip size={22} aria-hidden="true" /></label>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); sendText(); } }} maxLength={1000} placeholder={isPublicChat ? "发送一条公共消息…" : activePeer ? activePeer.online ? `发消息给 ${activePeer.name}…` : "设备已离线，可查看历史记录" : "先在左侧选择设备"} disabled={!canSend} aria-label="聊天消息" />
            <button type="button" onClick={sendText} disabled={!draft.trim() || !canSend}><Send size={18} /> 发送</button>
          </div>
        </section>
      </main>

      {qrOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="加入局域网聊天"><div className="qr-modal"><button type="button" onClick={() => setQrOpen(false)} aria-label="关闭"><X size={18} /></button><h2>邀请设备加入</h2><p>使用同一局域网的设备扫描二维码</p>{qrData && <img src={qrData} alt="局域网聊天访问二维码" />}<code>{window.location.href}</code><button className="copy-address" type="button" onClick={() => void copyAddress()}><Copy size={16} /> 复制地址</button></div></div>}
      {editingName && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="编辑设备名称"><div className="name-modal"><h2>我的设备名称</h2><input autoFocus value={identity.name} maxLength={32} onChange={(event) => setIdentity((current) => ({ ...current, name: event.target.value }))} onKeyDown={(event) => event.key === "Enter" && saveName()} /><div><button type="button" onClick={() => setEditingName(false)}>取消</button><button type="button" onClick={saveName}>保存</button></div></div></div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
