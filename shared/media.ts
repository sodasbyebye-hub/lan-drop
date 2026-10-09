const mediaTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v", ogv: "video/ogg",
};

// Chat previews and ZIP downloads must select the same attachments.
export function chatMediaKind(contentType: string, name: string): "image" | "video" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (mediaTypes[extension]?.startsWith("image/")) return "image";
  if (mediaTypes[extension]?.startsWith("video/") || extension === "ogg") return "video";
  return null;
}

export function mediaTypeOf(name: string, contentType: string) {
  const supplied = contentType.toLowerCase().split(";")[0].trim();
  const type = supplied && supplied !== "application/octet-stream" ? supplied : mediaTypes[name.split(".").pop()?.toLowerCase() ?? ""];
  if (!Object.values(mediaTypes).includes(type)) return null;
  return { contentType: type, kind: type.startsWith("image/") ? "image" as const : "video" as const };
}
