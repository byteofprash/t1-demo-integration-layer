import { createHmac } from "node:crypto";
import type { Attrs } from "./newrelic.js";

/** PII protection is off unless PII_PROTECTION=on (then ids are hashed and PII keys dropped). */
const protect = () => (process.env.PII_PROTECTION ?? "off").toLowerCase() === "on";

/** Keyed hash so ids are stable for correlation but not reversible without the salt. */
export function hashId(value: unknown): string {
  if (!protect()) return String(value);
  const salt = process.env.PII_HASH_SALT;
  if (!salt) throw new Error("PII_HASH_SALT must be set");
  return createHmac("sha256", salt).update(String(value)).digest("hex").slice(0, 32);
}

// Keys whose values are PII and must be hashed; matched on the last path segment, case-insensitive.
const HASH_KEYS = new Set([
  "profileid", "integrationid", "customerprofileid", "sessionid", "referral", "customersessionid",
  "userid", "attributes.email",
]);
// Keys dropped entirely.
const DROP_KEY_RE = /(email|(first|last|full|user|customer)_?name|phone|address|password|token|secret|authorization|birth)/i;

/** Flatten nested objects/arrays into dotted keys, hashing/dropping PII keys. */
export function flatten(input: unknown, prefix = "", out: Attrs = {}, depth = 0): Attrs {
  if (input === null || input === undefined) return out;
  if (depth > 6) return out;
  if (typeof input !== "object") {
    const key = prefix || "value";
    const last = key.split(".").pop()!.toLowerCase();
    if (protect() && (HASH_KEYS.has(last) || HASH_KEYS.has(key.toLowerCase()))) {
      out[key] = hashId(input);
    } else if (protect() && DROP_KEY_RE.test(last)) {
      // PII: dropped
    } else if (typeof input === "string") {
      out[key] = input.length > 4000 ? input.slice(0, 4000) : input;
    } else if (typeof input === "number" || typeof input === "boolean") {
      out[key] = input;
    }
    return out;
  }
  if (Array.isArray(input)) {
    input.slice(0, 50).forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

/** Summarise an Integration API response (v2 customer session style). */
export function summarizeIntegrationResponse(body: unknown): { effectTypes: string; campaignIds: string; effectCount: number } {
  const effects = (body as { effects?: Array<{ effectType?: string; campaignId?: number }> } | null)?.effects;
  if (!Array.isArray(effects)) return { effectTypes: "", campaignIds: "", effectCount: 0 };
  const types = new Set<string>();
  const camps = new Set<string>();
  for (const e of effects) {
    if (e.effectType) types.add(e.effectType);
    if (e.campaignId !== undefined) camps.add(String(e.campaignId));
  }
  return { effectTypes: [...types].sort().join(","), campaignIds: [...camps].sort().join(","), effectCount: effects.length };
}

/** Extract the session id from /v2/customer_sessions/{id}[...] paths. */
export function sessionIdFromPath(path: string): string | undefined {
  const m = path.match(/customer_sessions\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}
