import { createLanServer } from "./app.js";

const server = createLanServer();

try {
  const { port, addresses } = await server.start();
  const lines = addresses.length ? addresses : [`http://localhost:${port}`];
  console.log("\n  局域网快传已启动");
  console.log("  同一局域网的设备请打开：");
  for (const address of lines) console.log(`  ${address}`);
  console.log("\n  首次运行若出现 Windows 防火墙提示，请选择“允许访问”。");
  console.log("  按 Ctrl+C 停止服务。\n");
} catch (error) {
  console.error("启动失败：", error);
  process.exit(1);
}

async function shutdown() {
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
