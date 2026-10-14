const CORS = {
  "access-control-allow-origin": process.env.CORS_ALLOW_ORIGIN ?? "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-webhook-secret, x-request-id, x-uuid, x-t1-route, x-t1-method, x-t1-status, x-t1-duration-ms, x-t1-session-id",
  "access-control-max-age": "86400",
};

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS });

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
