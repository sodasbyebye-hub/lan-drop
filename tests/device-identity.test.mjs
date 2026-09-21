import assert from "node:assert/strict";
import test from "node:test";
import { getDeviceName, readIdentity, saveDeviceName } from "../src/device-identity.ts";

const windows = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" };
function storage(values = {}) {
  const items = new Map(Object.entries(values));
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}

test("根据设备信息命名，兼容 iPad 桌面模式和精简安卓信息", () => {
  for (const [info, expected] of [
    [windows, "Windows 电脑"],
    [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, "iPhone"],
    [{ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" }, "iPad"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 }, "iPad"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 }, "Mac 电脑"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AB123) Mobile Safari/537.36" }, "Pixel 8"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0.0.0 Mobile Safari/537.36" }, "Android 手机"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0.0.0 Safari/537.36" }, "Android 平板"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 8; zh-cn; SM-T870 Build/ABC)" }, "SM-T870"],
    [{ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)" }, "Chromebook"],
    [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }, "Linux 电脑"],
    [{ userAgent: "" }, "未知设备"],
  ]) assert.equal(getDeviceName(info), expected);
});

test("已有随机名称自动迁移，设备身份保持不变", () => {
  const saved = storage({ "lan-drop-device-id": "existing-id", "lan-drop-device-name": "会飞的西瓜", "lan-drop-device-name-version": "whimsical-zh-v1" });
  assert.deepEqual(readIdentity(saved, windows, () => assert.fail("不应重建设备身份")), { deviceId: "existing-id", name: "Windows 电脑" });
  assert.equal(readIdentity(saved, windows, () => "unused").name, "Windows 电脑");
});

test("新设备直接按设备命名，自动名称可跟随设备信息更新", () => {
  const saved = storage();
  assert.deepEqual(readIdentity(saved, windows, () => "new-id"), { deviceId: "new-id", name: "Windows 电脑" });
  assert.equal(readIdentity(saved, { userAgent: "iPhone" }, () => "unused").name, "iPhone");
});

test("保留手动名称，清空后恢复自动命名", () => {
  const saved = storage({ "lan-drop-device-name": "小明的电脑", "lan-drop-device-name-version": "whimsical-zh-v1" });
  assert.equal(readIdentity(saved, windows, () => "id").name, "小明的电脑");
  saveDeviceName(saved, "会飞的西瓜", windows);
  assert.equal(readIdentity(saved, windows, () => "unused").name, "会飞的西瓜");
  assert.equal(saveDeviceName(saved, "  ", windows), "Windows 电脑");
  assert.equal(saved.getItem("lan-drop-device-name-mode"), "auto");
});
