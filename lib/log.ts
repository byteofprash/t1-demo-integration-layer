/** Structured one-line logs for Vercel. Never pass secrets or payload bodies. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}
