export async function deleteAsHost(url: string) {
  const response = await fetch(url, { method: "DELETE", headers: { "X-Host-Action": "delete" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "删除失败，请稍后重试");
  }
}
