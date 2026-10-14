import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { firstSeen, unsee } from "../../lib/cursor.js";
import { preflight, withCors } from "../../lib/cors.js";
import { log } from "../../lib/log.js";
import { safely, sendEvents, sendMetrics } from "../../lib/newrelic.js";
import { hashId, summarizeIntegrationResponse } from "../../lib/transform.js";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const num = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * Receives a Talon.One Integration API response forwarded by the caller's middleware.
 * This service never calls Talon.One.
 *
 * Body: the Talon.One response JSON as-is, or an envelope { response: <T1 response>, ...meta }.
 * Optional metadata (headers win over envelope fields):
 *   X-T1-Route, X-T1-Method, X-T1-Status, X-T1-Duration-Ms, X-T1-Session-Id, X-Request-Id (dedupe)
 * Auth: X-Webhook-Secret = WEBHOOK_SHARED_SECRET.
 */
async function handle(request: Request): Promise<Response> {
  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (!secret || !safeEqual(request.headers.get("x-webhook-secret") ?? "", secret)) {
    log("integration.rejected", { reason: secret ? "bad_secret" : "server_secret_unset" });
    return new Response("Unauthorized", { status: 401 });
  }

  let raw: any;
  try {
    raw = await request.json();
  } catch {
    log("integration.rejected", { reason: "invalid_json" });
    return new Response("Bad Request", { status: 400 });
  }
  const envelope = raw && typeof raw === "object" && "response" in raw;
  const t1 = envelope ? raw.response : raw;
  const meta = (envelope ? raw : {}) as Record<string, any>;
  const h = request.headers;

  const route = String(h.get("x-t1-route") ?? meta.route ?? "").replace(/customer_sessions\/[^/?]+/, "customer_sessions/:id");
  const method = String(h.get("x-t1-method") ?? meta.method ?? "");
  const status = num(h.get("x-t1-status")) ?? (typeof meta.status === "number" ? meta.status : undefined);
  const durationMs = num(h.get("x-t1-duration-ms")) ?? (typeof meta.durationMs === "number" ? meta.durationMs : undefined);
  const sessionId = h.get("x-t1-session-id") ?? meta.sessionId ?? t1?.customerSession?.integrationId ?? t1?.customerSession?.id;
  const requestId = h.get("x-request-id") ?? meta.requestId;

  log("integration.received", { envelope, route, method, status, durationMs, hasSession: Boolean(sessionId), requestId });
  if (requestId && !(await firstSeen(`api:${requestId}`))) {
    log("integration.duplicate", { requestId });
    return Response.json({ status: "duplicate" });
  }

  waitUntil(
    safely("integration push", async () => {
      try {
        const summary = summarizeIntegrationResponse(t1);
        log("integration.summary", { ...summary });
        const isError = status !== undefined ? status >= 400 : false;
        const now = Date.now();
        const attrs = { route, method, ...(status !== undefined ? { status } : {}) };
        await Promise.all([
          sendEvents([
            {
              eventType: "TalonOneApiCall",
              route,
              method,
              ...(status !== undefined ? { status } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              isError,
              sessionIdHash: sessionId ? hashId(sessionId) : "",
              requestId: requestId ?? "",
              ...summary,
            },
          ]),
          sendMetrics([
            { name: "talon.integration.requests", type: "count", value: 1, timestamp: now, "interval.ms": 1, attributes: attrs },
            ...(durationMs !== undefined
              ? [{ name: "talon.integration.latency_ms", type: "gauge" as const, value: durationMs, timestamp: now, attributes: attrs }]
              : []),
            ...(isError
              ? [{ name: "talon.integration.errors", type: "count" as const, value: 1, timestamp: now, "interval.ms": 1, attributes: attrs }]
              : []),
          ]),
        ]);
      } catch (e) {
        if (requestId) await unsee(`api:${requestId}`);
        throw e;
      }
    }),
  );
  return Response.json({ status: "accepted" }, { status: 202 });
}

export const POST = async (request: Request) => withCors(await handle(request));
export const OPTIONS = () => preflight();
