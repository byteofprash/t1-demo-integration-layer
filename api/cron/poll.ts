import { timingSafeEqual } from "node:crypto";
import { log } from "../../lib/log.js";
import { getCursor, setCursor, storeConfigured } from "../../lib/cursor.js";
import { sendLogs, type NrLog } from "../../lib/newrelic.js";
import { mgmtGet } from "../../lib/talon.js";
import { flatten } from "../../lib/transform.js";

const PAGE = 1000;
const MSG_PAGE = 50; // /v1/message_logs default; max not confirmed in docs
const MAX_PAGES = 5; // per source per run, bounds duration and rate-limit use
const LAG_MS = 30_000; // don't read the very latest window; entries may still be landing

type Row = Record<string, any>;
interface Source {
  name: string;
  fetchPage(from: string, to: string, skip: number): Promise<Row[]>;
  ts(row: Row): string | undefined;
  message(row: Row): string;
  pageSize?: number; // rows per page (default PAGE)
  maxPages?: number; // pages per run (default MAX_PAGES)
}

// ASSUMPTION: row timestamp field names below are unconfirmed in the OpenAPI excerpts I could
// retrieve; ts() tries several candidates and the poller skips rows with none.
const firstTs = (r: Row, keys: string[]) => keys.map((k) => k.split(".").reduce<any>((o, p) => o?.[p], r)).find(Boolean);

const appIds = () => (process.env.TALON_APPLICATION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function sources(): Source[] {
  const list: Source[] = [
    {
      name: "audit",
      fetchPage: async (from, to, skip) =>
        (await mgmtGet<{ data: Row[] }>("/v1/changes", { createdAfter: from, createdBefore: to, pageSize: PAGE, skip, sort: "created" })).data,
      ts: (r) => firstTs(r, ["created"]),
      message: (r) => `audit change ${r.entityPath ?? ""}`,
    },
  ];
  // entityType is required by /v1/message_logs; webhook/notification logs live under these three types.
  for (const entityType of ["webhook", "application", "loyalty_program"]) {
    list.push({
      name: `message_logs:${entityType}`,
      pageSize: MSG_PAGE,
      maxPages: 40,
      fetchPage: (from, to, skip) => pageMessageLogs(entityType, from, to, skip),
      ts: (r) => firstTs(r, ["createdAt", "request.createdAt"]),
      message: (r) => `${r.entityType ?? entityType} ${r.webhookName ?? r.notificationName ?? r.url ?? ""} ${r.response?.status ?? ""}`,
    });
  }
  for (const id of appIds()) {
    list.push({
      name: `access:${id}`,
      fetchPage: async (from, to, skip) =>
        (await mgmtGet<{ data: Row[] }>(`/v1/applications/${id}/access_logs/no_total`, { rangeStart: from, rangeEnd: to, pageSize: PAGE, skip })).data,
      // AccessLogEntry fields per the OpenAPI spec: uuid, status, method, requestUri, time, requestPayload, responsePayload.
      // `sort` is omitted: "created" is not a field of this entity and caused a 400.
      ts: (r) => firstTs(r, ["time"]),
      message: (r) => `access ${r.method ?? ""} ${r.requestUri ?? ""} ${r.status ?? ""}`,
    });
  }
  return list;
}

const msgCursors = new Map<string, string | undefined>();
async function pageMessageLogs(entityType: string, from: string, to: string, skip: number): Promise<Row[]> {
  const key = `${entityType}|${from}|${to}`;
  const cursor = skip === 0 ? undefined : msgCursors.get(key);
  if (skip !== 0 && !cursor) return [];
  const res = await mgmtGet<{ data: Row[]; nextCursor?: string }>("/v1/message_logs", {
    entityType, createdAfter: from, createdBefore: to, pageSize: MSG_PAGE, cursor,
  });
  msgCursors.set(key, res.nextCursor);
  return res.data;
}

async function pollSource(s: Source, now: Date) {
  const to = new Date(now.getTime() - LAG_MS).toISOString();
  // Without a store there is no cursor: fetch a fixed lookback window each run (demo mode; gaps/duplicates possible).
  const stateful = storeConfigured();
  const lookbackMs = Number(process.env.POLL_LOOKBACK_SECONDS ?? 900) * 1000;
  const from = (stateful ? await getCursor(s.name) : null) ?? new Date(now.getTime() - LAG_MS - lookbackMs).toISOString();
  log("poll.start", { source: s.name, from, to, stateful });
  if (from >= to) return { source: s.name, sent: 0 };

  let skip = 0;
  let sent = 0;
  let newest = from;
  let truncated = false;
  const size = s.pageSize ?? PAGE;
  const maxPages = s.maxPages ?? MAX_PAGES;
  for (let page = 0; page < maxPages; page++) {
    const rows = await s.fetchPage(from, to, skip);
    if (!rows.length) break;
    const logs: NrLog[] = rows.map((r) => {
      const t = s.ts(r);
      if (t && t > newest) newest = t;
      return { message: s.message(r), timestamp: t ? Date.parse(t) : undefined, attributes: { logSource: s.name, ...flatten(r) } };
    });
    await sendLogs(logs, { "talon.source": s.name });
    sent += rows.length;
    skip += rows.length;
    if (rows.length < size) break;
    if (page === maxPages - 1) truncated = true;
  }
  // If we hit the page cap, resume from the newest row seen (at-least-once; a boundary row may repeat).
  // Otherwise the whole window was consumed.
  if (stateful) await setCursor(s.name, truncated ? newest : to);
  log("poll.done", { source: s.name, sent, truncated });
  return { source: s.name, sent, truncated };
}

export async function GET(request: Request): Promise<Response> {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  const got = request.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    log("poll.rejected", { reason: "bad_or_missing_cron_secret" });
    return new Response("Unauthorized", { status: 401 });
  }
  const now = new Date();
  const results: unknown[] = [];
  for (const s of sources()) {
    try {
      results.push(await pollSource(s, now)); // sequential keeps us under 3 req/s
    } catch (e) {
      console.error(`[poll] ${s.name} failed:`, e instanceof Error ? e.message : e);
      results.push({ source: s.name, error: true }); // cursor untouched, retried next run
    }
  }
  return Response.json({ results });
}
