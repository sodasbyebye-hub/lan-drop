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
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

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
  text?: string;
  files?: ChatFile[];
  status: "uploading" | "ready" | "error";
  createdAt: number;
  expiresAt: number;
};

const DEVICE_KEY = "lan-drop-device-id";
const NAME_KEY = "lan-drop-device-name";
const NAME_VERSION_KEY = "lan-drop-device-name-version";
const NAME_VERSION = "whimsical-zh-v1";

const QUIRKY_PREFIXES = ["会飞的", "倒立的", "发光的", "迷路的", "会唱歌的", "隐形的", "熬夜的", "跳舞的", "生气的", "爱摸鱼的", "打嗝的", "戴墨镜的"];
const QUIRKY_NOUNS = ["西瓜", "章鱼", "土豆", "拖鞋", "企鹅", "海豹", "蘑菇", "鲨鱼", "月亮", "煎饼", "胡萝卜", "小笼包", "仙人掌", "河马", "云朵"];

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeIdentity() {
  let deviceId = localStorage.getItem(DEVICE_KEY);
  if (!deviceId) {
    deviceId = makeId();
    localStorage.setItem(DEVICE_KEY, deviceId);
  }
  const savedName = localStorage.getItem(NAME_KEY);
  const version = localStorage.getItem(NAME_VERSION_KEY);
  const name = savedName && version === NAME_VERSION ? savedName : makeQuirkyName();
  localStorage.setItem(NAME_KEY, name);
  localStorage.setItem(NAME_VERSION_KEY, NAME_VERSION);
  return { deviceId, name };
}

function makeQuirkyName() {
  const prefix = QUIRKY_PREFIXES[Math.floor(Math.random() * QUIRKY_PREFIXES.length)];
  const noun = QUIRKY_NOUNS[Math.floor(Math.random() * QUIRKY_NOUNS.length)];
  return `${prefix}${noun}`;
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

function uploadRaw(url: string, file: File, headers: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("文件上传失败，请重试"));
    request.onerror = () => reject(new Error("网络连接中断，请重试"));
    request.onabort = () => reject(new Error("上传已取消"));
    request.send(file);
  });
}

function App() {
  const [identity, setIdentity] = useState(makeIdentity);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState("");
  const [isPublicChat, setIsPublicChat] = useState(true);
  const [messages, setMessages] = useState<ChatRecord[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [qrData, setQrData] = useState("");
  const [editingName, setEditingName] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const activeConversationRef = useRef("");

  const otherPeers = useMemo(() => peers.filter((peer) => peer.deviceId !== identity.deviceId), [peers, identity.deviceId]);
  const activePeer = otherPeers.find((peer) => peer.deviceId === selectedPeer);
  const activeConversation = isPublicChat ? "public" : selectedPeer ? conversationId(identity.deviceId, selectedPeer) : "";
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.conversationId === activeConversation).sort((left, right) => left.createdAt - right.createdAt),
    [activeConversation, messages],
  );
  const activeTitle = isPublicChat ? "公共聊天" : activePeer?.name || "选择一个设备";

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const upsertMessage = useCallback((message: ChatRecord) => {
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return [...current, message].slice(-1000);
      const next = [...current];
      next[index] = { ...next[index], ...message };
      return next;
    });
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [activeConversation, visibleMessages.length]);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  useEffect(() => {
    void QRCode.toDataURL(window.location.href, { width: 320, margin: 1, color: { dark: "#153941", light: "#ffffff" } }).then(setQrData);
  }, []);

  useEffect(() => {
    const socket = io({ auth: { deviceId: identity.deviceId, name: identity.name } });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("peers:update", (list: Peer[]) => {
      setPeers(list);
      const available = list.filter((peer) => peer.deviceId !== identity.deviceId);
      setSelectedPeer((current) => available.some((peer) => peer.deviceId === current) ? current : available[0]?.deviceId || "");
    });
    socket.on("chat:history", ({ messages: history }: { messages: ChatRecord[] }) => setMessages(history));
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
    setIsPublicChat(true);
    setFiles([]);
    setUnreadCounts((current) => {
      if (!current.public) return current;
      const next = { ...current };
      delete next.public;
      return next;
    });
  }

  function choosePeer(peer: Peer) {
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
    const name = identity.name.trim().slice(0, 32) || "匿名设备";
    localStorage.setItem(NAME_KEY, name);
    setIdentity((current) => ({ ...current, name }));
    socketRef.current?.emit("peer:update", { name });
    setEditingName(false);
  }

  function addFiles(input: FileList | File[]) {
    const selected = Array.from(input);
    setFiles((current) => [...current, ...selected].slice(0, 20));
  }

  function sendText() {
    const text = draft.trim();
    if (!text) return;
    if (!isPublicChat && !selectedPeer) return showToast("请选择接收设备");
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
    if (!isPublicChat && !selectedPeer) return showToast("请选择接收设备");
    setBusy(true);
    const localFiles = [...files];
    socketRef.current?.emit(
      "chat:file:prepare",
      isPublicChat
        ? { public: true, files: localFiles.map((file) => ({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" })) }
        : { toDeviceId: selectedPeer, files: localFiles.map((file) => ({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" })) },
      async (result: { ok: boolean; message?: ChatRecord; uploadToken?: string; messageText?: string }) => {
        if (!result.ok || !result.message || !result.uploadToken) {
          setBusy(false);
          return showToast(result.messageText || "文件消息发送失败");
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

  async function copyAddress() {
    await navigator.clipboard.writeText(window.location.href);
    showToast("访问地址已复制");
  }

  return (
    <div className="chat-app">
      <header className="chat-topbar">
        <div className="chat-brand"><span><Zap size={20} /></span><div><strong>局域网聊天</strong><small>同一网络，消息与文件即时送达</small></div></div>
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
            {otherPeers.length ? otherPeers.map((peer) => (
              <button className={`device-item ${!isPublicChat && selectedPeer === peer.deviceId ? "active" : ""}`} type="button" key={peer.deviceId} onClick={() => choosePeer(peer)}>
                <span className="letter-avatar">{avatarLetter(peer.name)}</span>
                <span><strong>{peer.name}</strong><small><i /> 在线</small></span>{unreadCounts[conversationId(identity.deviceId, peer.deviceId)] ? <span className="unread-badge">{unreadCounts[conversationId(identity.deviceId, peer.deviceId)] > 99 ? "99+" : unreadCounts[conversationId(identity.deviceId, peer.deviceId)]}</span> : null}
              </button>
            )) : <p className="no-devices">等待其他设备加入同一局域网</p>}
          </div>
          <div className="network-note"><Wifi size={23} /><strong>所有设备都在同一网络</strong><small>消息和文件不会离开局域网</small><button type="button" onClick={() => setQrOpen(true)}>显示加入二维码</button></div>
        </aside>

        <section className="conversation-panel">
          <div className="conversation-top">
            <button className="back-button" type="button" aria-label="返回设备列表"><ChevronLeft size={21} /></button>
            <span className={isPublicChat ? "conversation-avatar group" : "conversation-avatar"}>{isPublicChat ? <Users size={23} /> : avatarLetter(activePeer?.name || "?")}</span>
            <div><strong>{activeTitle}</strong><small>{isPublicChat ? `${otherPeers.length + 1} 台设备可参与 · 保存 30 天` : activePeer ? <><i /> 在线</> : "从左侧选择设备"}</small></div>
            <select
              className="mobile-chat-picker"
              value={isPublicChat ? "public" : selectedPeer}
              onChange={(event) => {
                if (event.target.value === "public") choosePublicChat();
                else {
                  const peer = otherPeers.find((item) => item.deviceId === event.target.value);
                  if (peer) choosePeer(peer);
                }
              }}
              aria-label="选择聊天对象"
            >
              <option value="public">公共聊天</option>
              {otherPeers.map((peer) => <option key={peer.deviceId} value={peer.deviceId}>{peer.name}</option>)}
            </select>
          </div>

          <div className="message-area" ref={messagesRef} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
            <span className="day-divider">聊天记录保留 30 天</span>
            {visibleMessages.length ? visibleMessages.map((message) => {
              const mine = message.fromDeviceId === identity.deviceId;
              const progress = message.files?.length ? Math.round(message.files.reduce((sum, file) => sum + file.received, 0) / message.files.reduce((sum, file) => sum + file.size, 0) * 100) : 100;
              return (
                <article className={`message-row ${mine ? "mine" : "theirs"}`} key={message.id}>
                  {!mine && <span className="message-avatar">{avatarLetter(message.fromName)}</span>}
                  <div className={`message-bubble ${message.files?.length ? "has-files" : ""}`}>
                    {isPublicChat && !mine && <strong className="sender-name">{message.fromName}</strong>}
                    {message.text && <p>{message.text}</p>}
                    {message.files?.map((file) => (
                      <div className="file-message" key={file.id}>
                        <span><FileIcon size={23} /></span>
                        <div><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.contentType.split("/").pop()?.toUpperCase() || "文件"}</small>
                          {message.status === "uploading" && <div className="file-progress"><i style={{ width: `${progress}%` }} /></div>}
                        </div>
                        {file.ready ? <a href={`/api/chat-files/${message.id}/${file.id}/download?deviceId=${encodeURIComponent(identity.deviceId)}`} download aria-label={`下载 ${file.name}`}><Download size={18} /></a> : <span className="file-status">{message.status === "error" ? "失败" : `${progress}%`}</span>}
                      </div>
                    ))}
                    <small className="message-time">{formatTime(message.createdAt)} {mine && message.status === "ready" && <Check size={12} />}</small>
                  </div>
                </article>
              );
            }) : <div className="empty-conversation"><span>{isPublicChat ? <Users size={26} /> : <Send size={26} />}</span><strong>{isPublicChat ? "开始公共聊天" : "开始设备聊天"}</strong><p>发送消息或文件，它们会保存 30 天。</p></div>}
          </div>

          {files.length > 0 && <div className="attachment-tray"><div><strong>准备发送 {files.length} 个文件</strong><small>{formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</small></div><button type="button" onClick={() => setFiles([])} aria-label="移除待发送文件"><X size={17} /></button><button className="send-file-button" type="button" onClick={sendFiles} disabled={busy}>{busy ? "发送中…" : "发送文件"}</button></div>}
          <div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
            <label title="添加文件" aria-label="添加文件"><input ref={fileInputRef} type="file" multiple onChange={(event) => event.target.files && addFiles(event.target.files)} /><Paperclip size={22} /></label>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); sendText(); } }} maxLength={1000} placeholder={isPublicChat ? "发送一条公共消息…" : activePeer ? `发消息给 ${activePeer.name}…` : "先在左侧选择设备"} disabled={!isPublicChat && !activePeer} aria-label="聊天消息" />
            <button type="button" onClick={sendText} disabled={!draft.trim() || (!isPublicChat && !activePeer)}><Send size={18} /> 发送</button>
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
