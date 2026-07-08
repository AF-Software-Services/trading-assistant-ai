export async function getLastScanTime(
  kv: KVNamespace,
  sessionName: string
): Promise<number | null> {
  const raw = await kv.get(`last_scan:${sessionName}`);
  return raw ? parseInt(raw, 10) : null;
}

export async function setLastScanTime(
  kv: KVNamespace,
  sessionName: string,
  timestamp: number
): Promise<void> {
  await kv.put(`last_scan:${sessionName}`, String(timestamp));
}
