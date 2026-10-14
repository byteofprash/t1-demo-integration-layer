import { Redis } from "@upstash/redis";

let client: Redis | undefined;
const redis = () => (client ??= Redis.fromEnv());

export async function getCursor(source: string): Promise<string | null> {
  return redis().get<string>(`cursor:${source}`);
}

export async function setCursor(source: string, value: string): Promise<void> {
  await redis().set(`cursor:${source}`, value);
}

/** Returns true the first time `id` is seen within ttl; false for duplicates. */
export async function firstSeen(id: string, ttlSeconds = 86_400): Promise<boolean> {
  const r = await redis().set(`seen:${id}`, "1", { nx: true, ex: ttlSeconds });
  return r === "OK";
}

/** Release a dedupe claim so a retried delivery can be processed again. */
export async function unsee(id: string): Promise<void> {
  await redis().del(`seen:${id}`);
}
