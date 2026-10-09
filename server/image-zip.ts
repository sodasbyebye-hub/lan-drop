import { createReadStream, type ReadStream } from "node:fs";
import path from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import { ZipFile } from "yazl";

function uniqueName(original: string, used: Set<string>) {
  // Keep all entries at the archive root and usable on Windows as well as macOS.
  let name = [...path.posix.basename(original.replaceAll("\\", "/"))]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character).join("")
    .replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/g, "") || "图片";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let number = 2; used.has(candidate.normalize("NFC").toLowerCase()); number += 1) {
    candidate = `${stem} (${number})${extension}`;
  }
  used.add(candidate.normalize("NFC").toLowerCase());
  return candidate;
}

export async function streamImageZip(files: Array<{ name: string; path: string; size: number }>, res: Response) {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  let active: ReadStream | undefined;
  const stop = () => { active?.destroy(); output.destroy(); };
  res.once("close", stop);
  zip.on("error", (error: Error) => output.destroy(error));
  const completed = pipeline(output, res);
  try {
    const used = new Set<string>();
    for (const file of files) {
      zip.addReadStreamLazy(uniqueName(file.name, used), { size: file.size, compress: false }, (callback) => {
        if (res.destroyed) return;
        active = createReadStream(file.path);
        active.on("error", (error) => output.destroy(error));
        callback(null, active);
      });
    }
    zip.end();
    await completed;
  } finally {
    stop();
    res.off("close", stop);
  }
}
