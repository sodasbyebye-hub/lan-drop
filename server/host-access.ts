import os from "node:os";
import type { Request } from "express";

const normalize = (address: string) => address.replace(/^::ffff:/, "").split("%")[0];

export function isHostRequest(req: Request) {
  const addresses = new Set(["127.0.0.1", "::1", ...Object.values(os.networkInterfaces()).flatMap((items) => (items ?? []).map((item) => normalize(item.address)))]);
  // Use the TCP peer, never device IDs or forwarded headers supplied by clients.
  if (!addresses.has(normalize(req.socket.remoteAddress ?? ""))) return false;
  try {
    const hostname = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, "");
    return hostname === "localhost" || addresses.has(normalize(hostname));
  } catch { return false; }
}

export function mayManage(req: Request) {
  if (!isHostRequest(req) || req.header("x-host-action") !== "delete") return false;
  const origin = req.header("origin");
  return !origin || origin === `${req.protocol}://${req.headers.host}`;
}
