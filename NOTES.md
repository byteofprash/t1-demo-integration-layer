# Assumptions and open items

Verified in docs: Talon.One `GET /v1/changes` (createdAfter/Before, pageSize, skip, sort), `GET /v1/applications/{id}/access_logs/no_total`
(rangeStart/rangeEnd required), `GET /v1/message_logs` (createdAfter/Before, cursor, entityType, pageSize); all 3 req/s.
Webhooks carry an `X-UUID` header (used for dedupe). New Relic Event API limits (1 MB, gzip, 255 attrs, flat values).

Not confirmed:
- Talon.One webhook signing: none found in docs. Auth is a custom header `X-Webhook-Secret` you set on the webhook.
- Row timestamp field names in changes / access logs responses (`created`, `timestamp`); `lib`'s poller tries candidates and skips rows without one.
- `sort=created` is accepted on /changes and access_logs (docs say not all fields sort).
- EU Event API path assumed identical to US; Log/Metric EU hosts from memory.
- Event timestamps in NR must be within 24h; polled backlog older than that goes to Logs, not Events.
- Vercel plan limits: Hobby crons run at most daily. */5 needs Pro. Verify before deploying; else move poller to Cloud Run.
- Integration receiver: the middleware payload shape is my proposal (raw T1 response or envelope; metadata via X-T1-* headers). Session id fallback `customerSession.integrationId` is unconfirmed.
- Whether notification-type message logs appear under `entityType`; poller currently pulls all entity types.
