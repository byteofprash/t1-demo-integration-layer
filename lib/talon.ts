import { env } from "./env.js";
import { log } from "./log.js";

const MIN_INTERVAL_MS = 400; // stay under the documented 3 req/s limit
let last = 0;

async function throttle() {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

export async function mgmtGet<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, env("TALON_BASE_URL"));
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    const t0 = Date.now();
    const res = await fetch(url, {
      headers: { Authorization: `ManagementKey-v1 ${env("TALON_MANAGEMENT_KEY")}` },
      signal: AbortSignal.timeout(20_000),
    });
    log("talon.response", { path, params: Object.fromEntries(url.searchParams), status: res.status, ms: Date.now() - t0, attempt });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Talon.One ${path} -> ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`Talon.One ${path} rate limited`);
}
