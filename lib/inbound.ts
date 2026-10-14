import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { firstSeen, unsee } from "./cursor.js";
import { safely, sendEvents } from "./newrelic.js";
import { flatten } from "./transform.js";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Shared handler for Talon.One webhooks and notifications.
 * Talon.One signs nothing that we could confirm in docs, so the sender is verified with a shared
 * secret header configured on the webhook (X-Webhook-Secret). Dedupe uses the X-UUID header that
 * Talon.One adds to every webhook call.
 */
export async function handleInbound(request: Request, eventType: string): Promise<Response> {
  const secret = process.env.WEBHOOK_SHARED_SECRET;
  const provided = request.headers.get("x-webhook-secret") ?? "";
  if (!secret || !safeEqual(provided, secret)) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const id = request.headers.get("x-uuid");
  if (id && !(await firstSeen(`${eventType}:${id}`))) {
    return Response.json({ status: "duplicate" }, { status: 200 });
  }

  waitUntil(
    safely(`${eventType} push`, async () => {
      try {
        await sendEvents([{ eventType, deliveryId: id ?? "", ...flatten(body) }]);
      } catch (e) {
        if (id) await unsee(`${eventType}:${id}`); // allow Talon.One's retry to be processed
        throw e;
      }
    }),
  );
  return Response.json({ status: "accepted" }, { status: 202 });
}
