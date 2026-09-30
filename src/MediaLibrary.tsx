import { Download, ImageOff, Images, Pencil, Play, Upload, Video, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mediaTypeOf } from "../shared/media";

type MediaItem = {
  id: string; kind: "image" | "video"; name: string; caption: string; size: number;
  contentType: string; uploadedAt: number; uploadedBy: string; source: "chat" | "upload"; private: boolean;
};
type Draft = { id: string; file: File; caption: string; error?: string };
type Props = { identity: { deviceId: string; name: string }; revision: number; active: boolean };

function MediaPreview({ item, url }: { item: MediaItem; url: string }) {
  const [error, setError] = useState(false);
  if (error) return <span className="library-preview-fallback"><ImageOff size={30} />无法预览，可下载原文件</span>;
  return item.kind === "image"
    ? <img src={url} alt={item.name} loading="lazy" onError={() => setError(true)} />
    : <><video src={`${url}#t=0.1`} muted playsInline preload="metadata" onError={() => setError(true)} /><span className="library-play"><Play size={24} fill="currentColor" /></span></>;
}

export function MediaLibrary({ identity, revision, active }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [editing, setEditing] = useState<MediaItem | null>(null);
  const [caption, setCaption] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const url = (item: MediaItem, action = "preview") => `/api/media/${item.id}/${action}?deviceId=${encodeURIComponent(identity.deviceId)}`;

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const response = await fetch(`/api/media?deviceId=${encodeURIComponent(identity.deviceId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("媒体库加载失败，请重试");
      const body = await response.json() as { items: MediaItem[] };
      if (mounted.current && currentRequest === requestId.current) { setItems(body.items); setError(""); }
    } catch (failure) {
      if (mounted.current && currentRequest === requestId.current) setError(failure instanceof Error ? failure.message : "媒体库加载失败");
    } finally { if (mounted.current && currentRequest === requestId.current) setLoading(false); }
  }, [identity.deviceId]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; xhrRef.current?.abort(); }; }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh, revision]);
  useEffect(() => {
    if (selected && active) dialogRef.current?.showModal(); else dialogRef.current?.close();
  }, [selected, active]);
  useEffect(() => {
    if (editing && active) editRef.current?.showModal(); else editRef.current?.close();
  }, [editing, active]);

  function addFiles(files: File[]) {
    if (uploading) return;
    const accepted = files.filter((file) => mediaTypeOf(file.name, file.type) && file.size > 0);
    setNotice(accepted.length !== files.length ? "已跳过不支持的格式或空文件，仅接受图片和视频。" : "");
    setDrafts((current) => [...current, ...accepted.map((file) => ({ id: `${Date.now()}-${Math.random()}`, file, caption: "" }))]);
  }

  function uploadFile(draft: Draft, index: number, total: number) {
    return new Promise<void>((resolve, reject) => {
      const type = mediaTypeOf(draft.file.name, draft.file.type)!;
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", "/api/media");
      const headers = { "Content-Type": type.contentType, "X-File-Name": encodeURIComponent(draft.file.name),
        "X-File-Size": String(draft.file.size), "X-Device-Id": identity.deviceId,
        "X-Device-Name": encodeURIComponent(identity.name), "X-Media-Caption": encodeURIComponent(draft.caption) };
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = (event) => { if (mounted.current) setProgress(`正在上传 ${index + 1}/${total} · ${event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0}%`); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else { let message = "上传失败，请重试"; try { message = JSON.parse(xhr.responseText).message || message; } catch { /* Use fallback. */ } reject(new Error(message)); }
      };
      xhr.onerror = () => reject(new Error("网络中断，请重试"));
      xhr.onabort = () => reject(new Error("上传已取消"));
      xhr.send(draft.file);
    });
  }

  async function uploadAll() {
    if (uploading || !drafts.length) return;
    setUploading(true); setNotice("");
    let count = 0;
    for (const [index, draft] of drafts.entries()) {
      if (!mounted.current) break;
      try {
        await uploadFile(draft, index, drafts.length);
        count += 1;
        if (mounted.current) setDrafts((current) => current.filter((item) => item.id !== draft.id));
      } catch (failure) {
        if (mounted.current) setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, error: failure instanceof Error ? failure.message : "上传失败" } : item));
      }
    }
    if (!mounted.current) return;
    xhrRef.current = null; setUploading(false); setProgress("");
    setNotice(`已上传 ${count}/${drafts.length} 个素材${count < drafts.length ? "，失败项已保留，可重试。" : "。"}`);
    if (count > 0) setKind(mediaTypeOf(drafts[0].file.name, drafts[0].file.type)!.kind);
    await refresh();
  }

  async function saveCaption(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`/api/media/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Device-Id": identity.deviceId }, body: JSON.stringify({ caption }) });
      if (!response.ok) throw new Error((await response.json()).message || "保存失败");
      const body = await response.json() as { item: MediaItem };
      setItems((current) => current.map((item) => item.id === body.item.id ? body.item : item));
      setSelected((current) => current?.id === body.item.id ? body.item : current);
      setEditing(null); setNotice("配文已保存");
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  }

  const visible = items.filter((item) => item.kind === kind);
  return (
    <section className="media-library" hidden={!active} aria-label="媒体库" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}>
      <header className="library-header"><div><h1>媒体库</h1><p>上传收藏，或从聊天自动收录 · 原文件长期保留</p></div>
        <button className="library-primary" type="button" disabled={uploading} onClick={() => inputRef.current?.click()}><Upload size={17} />上传素材</button>
        <input ref={inputRef} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      </header>
      <div className="library-tabs" role="group" aria-label="媒体分类">
        <button type="button" aria-pressed={kind === "image"} onClick={() => setKind("image")}><Images size={17} />图片区 <span>{items.filter((item) => item.kind === "image").length}</span></button>
        <button type="button" aria-pressed={kind === "video"} onClick={() => setKind("video")}><Video size={17} />视频区 <span>{items.filter((item) => item.kind === "video").length}</span></button>
      </div>
      <div className="library-body">
        {notice && <p className="library-feedback" role="status">{notice}</p>}
        {drafts.length > 0 && <section className="library-upload-panel" aria-label="待上传素材"><div className="library-upload-heading"><strong>待上传 {drafts.length} 个素材</strong><span>每个素材可单独配文</span></div>
          <div className="library-drafts">{drafts.map((draft) => <div className="library-draft" key={draft.id}>
            <div><strong>{draft.file.name}</strong><button type="button" aria-label={`移除 ${draft.file.name}`} disabled={uploading} onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><X size={16} /></button></div>
            <textarea aria-label={`配文：${draft.file.name}`} placeholder="为这份素材添加配文（选填）" maxLength={1000} value={draft.caption} disabled={uploading} onChange={(event) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, caption: event.target.value } : item))} />
            {draft.error && <small role="alert">{draft.error}</small>}
          </div>)}</div>
          <div className="library-upload-footer"><small>{progress || "独立上传的素材供同一局域网设备查看"}</small><button className="library-primary" type="button" disabled={uploading} onClick={() => void uploadAll()}>{uploading ? "上传中…" : "开始上传"}</button></div>
        </section>}
        {error && <div role="alert" className="library-feedback">{error}<button type="button" onClick={() => void refresh()}>重试</button></div>}
        {loading ? <p className="library-empty">正在加载媒体库…</p> : !visible.length ? <div className="library-empty">{kind === "image" ? <Images size={42} /> : <Video size={42} />}<h2>还没有{kind === "image" ? "图片" : "视频"}</h2><p>上传素材，或在聊天中发送{kind === "image" ? "图片" : "视频"}后自动收录。</p></div> :
          <div className="library-grid">{visible.map((item) => <article className="library-card" key={item.id}>
            <button className="library-card-preview" type="button" aria-label={`查看 ${item.name}`} onClick={() => setSelected(item)}>
              <MediaPreview item={item} url={url(item)} />
              <span className="library-caption-overlay"><strong>{item.name}</strong><span>{item.caption || "暂无配文"}</span><small>点击查看完整内容</small></span>
            </button>
            <div className="library-card-info"><div><strong title={item.name}>{item.name}</strong><small>{item.private ? "私聊 · 仅双方可见" : item.source === "chat" ? "公共聊天收录" : "独立上传"} · {item.uploadedBy}</small></div>
              <button type="button" title="编辑配文" aria-label={`编辑配文 ${item.name}`} onClick={() => { setEditing(item); setCaption(item.caption); }}><Pencil size={15} /></button>
              <a href={url(item, "download")} download aria-label={`下载 ${item.name}`} title="下载原文件"><Download size={16} /></a>
            </div>
          </article>)}</div>}
      </div>
      <dialog className="library-dialog library-viewer" ref={dialogRef} onCancel={() => setSelected(null)} onClose={() => setSelected(null)}>
        {selected && <><header><strong>{selected.name}</strong><button type="button" aria-label="关闭预览" onClick={() => setSelected(null)}><X size={20} /></button></header>
          <div className="library-full-media">{selected.kind === "image" ? <img src={url(selected)} alt={selected.name} /> : <video src={url(selected)} controls playsInline preload="metadata" />}</div>
          <p className="library-full-caption">{selected.caption || "暂无配文"}</p><footer><span>{selected.private ? "私聊素材，仅会话双方可见" : `由 ${selected.uploadedBy} 上传`}</span><a className="library-primary" href={url(selected, "download")} download><Download size={16} />下载原文件</a></footer></>}
      </dialog>
      <dialog className="library-dialog library-caption-editor" ref={editRef} onCancel={(event) => { if (saving) event.preventDefault(); else setEditing(null); }} onClose={() => setEditing(null)}>
        {editing && <form onSubmit={(event) => void saveCaption(event)}><header><strong>编辑配文</strong><button type="button" aria-label="关闭配文编辑" disabled={saving} onClick={() => setEditing(null)}><X size={20} /></button></header>
          <p>{editing.name}</p><textarea autoFocus aria-label="素材配文" maxLength={1000} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="写下这份素材的故事…" disabled={saving} />
          <small>{caption.length}/1000 · 可查看此素材的设备可共同编辑配文</small>{notice && <p role="alert">{notice}</p>}<footer><button className="library-primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存配文"}</button></footer>
        </form>}
      </dialog>
    </section>
  );
}
