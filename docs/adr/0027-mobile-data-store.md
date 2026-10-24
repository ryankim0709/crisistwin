# 0027: Mobile data store in MongoDB Atlas

Date: 2026-10-24. Status: accepted as an interim store, until the app's schema is designed.

Builds on [0008-mongodb-backend](0008-mongodb-backend.md) and
[0016-resident-live-and-family](0016-resident-live-and-family.md).

## Context

The iOS app needs to push data to the team's MongoDB Atlas database and pull it back. Its
schema is not designed yet. The app can't connect to Atlas directly. MongoDB retired Atlas
Device Sync and the Atlas Data API in September 2025, and the Swift driver is for servers, not
iOS apps. Any direct connection would also put an Atlas credential in the app bundle, which
`AGENTS.md` forbids. The Django API already owns the Atlas connection (`api/mongodb.py`) and
already serves the app's families.

## Decision

Add a schema-free document store to the API, `/api/mobile/…` (`app/backend/api/mobile_data.py`).
The app reaches it through `MobileDataStore` (`mobile/CrisisTwin/Networking/MobileDataStore.swift`).
Any JSON object can be stored under a named collection and read back.

- **Devices.** The phone registers once and receives a random device token. The token goes in
  the Keychain (this device only). The server stores only its SHA-256 hash, as families do. A
  device reads and writes only its own documents. Another device's document returns the same
  404 as a missing one. There are no user accounts and no sharing between devices.
- **Storage.** One Atlas collection `mobile_documents`, with the app's collection name as a field,
  so new app collections don't add Atlas collections. Index `(device_id, collection, updated_at
  desc)`. Devices are stored in `mobile_devices`, with a unique index on `token_hash`.
- **Limits.** Collection names match `[a-z][a-z0-9_]{0,47}`. `data` must be a JSON object of at
  most 64 KiB, nested at most 20 levels. Keys can't start with `$` or contain `.` or NUL. A device
  can hold at most 1,000 documents. Throttles allow 120 requests per minute and 10 registrations
  per minute per client IP.
- **Pull.** Pulls return the newest documents first. An optional `updated_after` filter supports
  incremental sync. The app sends it at second precision, so a pull may repeat a document but
  never misses one.

## Contract

All responses send `Cache-Control: no-store`. Errors are `{"error": code, "detail": text}`.

| Method and path | Auth | Body / query | Success |
| --- | --- | --- | --- |
| `POST /api/mobile/devices` | none | none | 201 `{device_id, device_token}` |
| `GET /api/mobile/data/<collection>` | Bearer | `limit` 1-200 (default 50), `updated_after` ISO 8601 with offset | 200 `{documents: [Document]}` |
| `POST /api/mobile/data/<collection>` | Bearer | `{data: {...}}` | 201 Document |
| `GET /api/mobile/data/<collection>/<id>` | Bearer | none | 200 Document |
| `PUT /api/mobile/data/<collection>/<id>` | Bearer | `{data: {...}}` (replaces `data`) | 200 Document |
| `DELETE /api/mobile/data/<collection>/<id>` | Bearer | none | 204 |

Document, with UTC timestamps:

```json
{
  "id": "0057235950b22ebe834caf58",
  "collection": "notes",
  "data": {"title": "hello", "tags": ["a"]},
  "created_at": "2026-10-24T16:29:51.325+00:00",
  "updated_at": "2026-10-24T16:29:51.325+00:00"
}
```

Errors: 400 `invalid_request` (bad body, limit or timestamp), 401 `unauthorized` (missing or
unknown token; the app registers again and retries once), 404 `not_found` (also returned for
an invalid collection name or id), 409 `quota_exceeded`, 503 `database_unavailable` (no driver
text). Swift keys are converted to snake_case on the wire, like every `BackendClient` call.

## Consequences

- Any data type can be stored in Atlas now, with no backend change, while the schema is designed.
- The server checks only the size and key rules above, not the content. Once the schema exists,
  give each data type a validated endpoint or a JSON Schema check, and migrate it out of
  `mobile_documents` with a new ADR. Sharing data between devices or users also needs a new ADR
  with real access control.
- Data written here is whatever the app sends. Label it observed, assumed or simulated in the
  schema, as `AGENTS.md` requires.
