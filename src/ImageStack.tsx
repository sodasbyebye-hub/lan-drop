import { Check, ChevronDown, Download, ImageOff, Images } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

type ImageFile = { id: string; name: string; size: number; received: number; ready: boolean };
type Props = {
  messageId: string;
  deviceId: string;
  files: ImageFile[];
  failed: boolean;
  downloadedFiles: Record<string, boolean>;
  onDownload: (fileId: string) => void;
};

function Thumbnail({ file, url, failed }: { file: ImageFile; url: string; failed: boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  if (!file.ready) {
    const percent = file.size ? Math.min(100, Math.round(file.received / file.size * 100)) : 0;
    return <span className="image-stack-placeholder">{failed ? "上传失败" : `上传中 ${percent}%`}</span>;
  }
  return unavailable
    ? <span className="image-stack-placeholder"><ImageOff size={24} />无法预览，可下载原图</span>
    : <img src={url} alt={file.name} loading="lazy" onError={() => setUnavailable(true)} />;
}

export function ImageStack({ messageId, deviceId, files, failed, downloadedFiles, onDownload }: Props) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const gridId = useId();
  const expanded = hovered || pinned;
  const allReady = files.every((file) => file.ready);
  const fileUrl = (file: ImageFile, action: string) => `/api/chat-files/${messageId}/${file.id}/${action}?deviceId=${encodeURIComponent(deviceId)}`;

  useEffect(() => () => { clearTimeout(timer.current); busy.current = false; }, []);

  function downloadAll() {
    if (busy.current || !allReady) return;
    busy.current = true;
    setDownloading(true);
    let index = 0;
    const next = () => {
      const file = files[index];
      // Let the browser stream each original file to disk, without buffering
      // the entire album in memory or recompressing the images.
      const link = document.createElement("a");
      link.href = fileUrl(file, "download");
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      onDownload(file.id);
      index += 1;
      if (index < files.length) {
        setNotice(`正在发起下载 ${index}/${files.length}…`);
        timer.current = setTimeout(next, 400);
      } else {
        busy.current = false;
        setDownloading(false);
        setNotice(`已发起 ${files.length} 张原图下载。若未全部保存，请允许浏览器下载多个文件后重试。`);
      }
    };
    next();
  }

  return (
    <section className={`image-stack ${expanded ? "is-expanded" : ""}`} aria-label={`${files.length} 张图片`}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPinned(false); }}
      onKeyDown={(event) => { if (event.key === "Escape") { setPinned(false); setHovered(false); toggleRef.current?.focus(); } }}>
      <div className="image-stack-toolbar">
        <button ref={toggleRef} className="image-stack-toggle" type="button" aria-expanded={expanded} aria-controls={gridId} onClick={() => { setPinned(!expanded); setHovered(false); }}>
          <Images size={16} /><strong>{files.length} 张图片</strong><ChevronDown size={15} />
        </button>
        <button className="image-stack-download-all" type="button" disabled={!allReady || downloading} onClick={downloadAll}>
          <Download size={15} />{downloading ? "发起下载中…" : "下载全部"}
        </button>
      </div>
      <div className="image-stack-stage">
        <button className="image-stack-cover" type="button" hidden={expanded} aria-label={`展开 ${files.length} 张图片`} aria-expanded={expanded} aria-controls={gridId} onClick={() => { setPinned(true); toggleRef.current?.focus(); }}>
          {files.slice(0, 3).map((file, index) => <span className={`image-stack-card layer-${index}`} key={file.id}><Thumbnail file={file} url={fileUrl(file, "preview")} failed={failed} /></span>)}
          <span className="image-stack-hint">悬浮或点击展开</span>
        </button>
        <div id={gridId} className="image-stack-grid" hidden={!expanded} onFocusCapture={() => setPinned(true)}>
          {expanded && files.map((file) => <div className="image-stack-item" key={file.id}>
            <div className="image-stack-thumb"><Thumbnail file={file} url={fileUrl(file, "preview")} failed={failed} /></div>
            <div className="image-stack-caption"><span title={file.name}>{file.name}</span>
              {file.ready ? <a href={fileUrl(file, "download")} download onClick={() => onDownload(file.id)} aria-label={`下载 ${file.name}`} title={`下载原图：${file.name}`}>
                {downloadedFiles[`${messageId}:${file.id}`] ? <Check size={16} /> : <Download size={16} />}
              </a> : <span className="image-stack-wait">{failed ? "失败" : "上传中"}</span>}
            </div>
          </div>)}
        </div>
      </div>
      {!allReady && <p className="image-stack-notice">{failed ? "部分图片上传失败，已上传的图片可单独下载。" : `已上传 ${files.filter((file) => file.ready).length}/${files.length} 张，全部上传完成后可一键下载。`}</p>}
      <p className="image-stack-notice" role="status" aria-live="polite" hidden={!notice}>{notice}</p>
    </section>
  );
}
