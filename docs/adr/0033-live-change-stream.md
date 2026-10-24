# 0033: Push the live broadcast with a MongoDB change stream

Date: 2026-10-24. Status: accepted for the demo. Amends
[0016-resident-live-and-family](0016-resident-live-and-family.md).

## Context

The resident app polled `GET /api/live` every 3 s while the Web simulation screen was open: up to
3 s late, and a request every 3 s per phone even when nothing changed. The broadcast is one
document in Atlas (`live_broadcast/current`) that the pages replace about every 2 s while playing.
Atlas is a replica set, so it supports change streams.

## Decision

- **`GET /api/live/stream`** (`api/live_stream.py`, plain Django view so `text/event-stream` is not
  refused by DRF content negotiation): opens a change stream on that document
  (`fullDocument: updateLookup`) before reading it, sends the current snapshot, then each
  replacement as `event: snapshot` with the same envelope as `GET /api/live`, and `event: cleared`
  when it is deleted. Each event's `id` is the change stream resume token; a client reconnecting
  with `Last-Event-ID` resumes exactly where it left off (falling back to the current snapshot when
  the token is too old). A keep-alive comment every 15 s; streams end after 10 min; at most 32 per
  worker; `event: error` on a database failure. No change streams (standalone MongoDB) → 503.
- **Waits stay under the client timeout**: `maxAwaitTimeMS` 1 s, below the 3 s operation timeout
  of `api/mongodb.py`, so idle streams loop instead of timing out.
- **iOS** (`BroadcastStore.follow`, `BackendClient.events`): reads the stream with
  `URLSession.bytes`; on any failure it polls `GET /api/live` as before and tries the stream again
  after 30 s. The screen shows "Updates: Pushed live" or "Checked every few seconds".
- **Serving.** Each open stream holds a server thread. Dev (`runserver`) is threaded; the
  production image now runs gunicorn with 16 threads.

## Consequences

- Phones see each broadcast as soon as Atlas commits it, and idle phones cost a keep-alive every
  15 s instead of a request every 3 s.
- Same unauthenticated, simulated-only data as `GET /api/live`.
- Not done: the web pages still post snapshots by HTTP (that is the write side), and the live
  drill feeds (`/api/live/…`) still poll.
