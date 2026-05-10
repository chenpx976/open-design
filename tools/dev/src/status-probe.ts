import type { DaemonStatusSnapshot, WebStatusSnapshot } from "@open-design/sidecar-proto";

async function probe(url: string, timeoutMs = 800): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDaemonStatusFromPort(
  port: number | null,
  pid: number | null = null,
): Promise<DaemonStatusSnapshot | null> {
  if (port == null) return null;
  const url = `http://127.0.0.1:${port}`;
  if (!(await probe(`${url}/api/health`))) return null;
  return { pid, state: "running", url };
}

export async function probeWebStatusFromPort(
  port: number | null,
  pid: number | null = null,
): Promise<WebStatusSnapshot | null> {
  if (port == null) return null;
  const url = `http://127.0.0.1:${port}`;
  if (!(await probe(url))) return null;
  return { pid, state: "running", url };
}
