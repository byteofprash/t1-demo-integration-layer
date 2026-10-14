import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { env } from "./env";

const gzipAsync = promisify(gzip);
const MAX_BYTES = 900_000; // NR limit is 1 MB (10^6) per POST, uncompressed-safe margin
const MAX_ATTEMPTS = 4;

export type Attrs = Record<string, string | number | boolean>;
export type NrEvent = Attrs & { eventType: string };

function hosts() {
  const eu = (process.env.NEW_RELIC_REGION ?? "US").toUpperCase() === "EU";
  return {
    events: eu
      ? "https://insights-collector.eu01.nr-data.net"
      : "https://insights-collector.newrelic.com",
    logs: eu ? "https://log-api.eu.newrelic.com" : "https://log-api.newrelic.com",
    metrics: eu ? "https://metric-api.eu.newrelic.com" : "https://metric-api.newrelic.com",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, body: unknown): Promise<void> {
  const payload = await gzipAsync(Buffer.from(JSON.stringify(body)));
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Api-Key": env("NEW_RELIC_INGEST_KEY"),
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      // 4xx other than 408/429 will not succeed on retry
      if (res.status < 500 && res.status !== 429 && res.status !== 408) {
        throw new Error(`New Relic rejected payload: ${res.status} ${await res.text()}`);
      }
      lastErr = new Error(`New Relic ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message.startsWith("New Relic rejected")) throw e;
    }
    await sleep(2 ** attempt * 250 + Math.random() * 100);
  }
  throw lastErr;
}

/** Split items into chunks whose JSON size stays under MAX_BYTES. */
function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 2;
  for (const it of items) {
    const s = Buffer.byteLength(JSON.stringify(it)) + 1;
    if (cur.length && size + s > MAX_BYTES) {
      out.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(it);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function sendEvents(events: NrEvent[]): Promise<void> {
  if (!events.length) return;
  const url = `${hosts().events}/v1/accounts/${env("NEW_RELIC_ACCOUNT_ID")}/events`;
  for (const c of chunk(events)) await post(url, c);
}

export interface NrLog {
  message: string;
  timestamp?: number; // epoch ms
  attributes?: Attrs;
}

export async function sendLogs(logs: NrLog[], common: Attrs = {}): Promise<void> {
  if (!logs.length) return;
  const url = `${hosts().logs}/log/v1`;
  for (const c of chunk(logs)) {
    await post(url, [{ common: { attributes: { service: "talon-one", ...common } }, logs: c }]);
  }
}

export interface NrMetric {
  name: string;
  type: "gauge" | "count" | "summary";
  value: number;
  timestamp?: number; // epoch ms
  "interval.ms"?: number; // required for count
  attributes?: Attrs;
}

export async function sendMetrics(metrics: NrMetric[]): Promise<void> {
  if (!metrics.length) return;
  const url = `${hosts().metrics}/metric/v1`;
  for (const c of chunk(metrics)) await post(url, [{ metrics: c }]);
}

/** For request paths: swallow and log errors so New Relic problems never surface to callers. */
export async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[newrelic] ${label} failed:`, e instanceof Error ? e.message : e);
  }
}
