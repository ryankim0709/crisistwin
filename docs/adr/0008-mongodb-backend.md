# 0008: MongoDB application backend

Date: 2026-10-23. Status: accepted.

Replace the PostgreSQL portion of ADR 0001 with MongoDB using the official
PyMongo 4 driver. Keep Django 5.2 and DRF as the HTTP layer. On `origin/main` the
only database consumer is readiness; there are no application models, stored
scenarios, or user-facing authentication flows to migrate. Direct PyMongo keeps
this change small and matches the team's existing Atlas `crisistwin` database
and historical artifact tooling, without adding an ORM compatibility layer.

Require `MONGODB_URI` in the server environment and select `MONGODB_DATABASE`
explicitly (default `crisistwin`), since the team URI has no database path. Accept
both Atlas SRV URIs and explicit local MongoDB URIs. Do not provision Atlas access,
make up credentials, or silently fall back to another database. Compose now runs
only frontend/backend. Existing PostgreSQL volumes are left intact; data transfer
is outside this change because no application persistence schema exists yet.

`api/mongodb.py` owns one lazily constructed connection pool per worker, bounds
operations and connection waits, decodes datetimes in UTC, and closes the client
on process exit. Keep driver calls in adapters, outside numerical calculations.
The existing health endpoint pings MongoDB while preserving its JSON/status/cache
contract, so web and mobile callers are unchanged. A ping does not verify dataset
presence or write permissions. Driver failures return a generic 503. Django's
debug exception filter redacts the MongoDB URI key as well as normal secrets.

Remove psycopg, the PostgreSQL Compose service, SQL migration startup, and unused
Django auth/contenttypes/session apps and middleware. Set `DATABASES = {}` and
DRF's unauthenticated user to `None`, following the
[DRF settings guidance](https://www.django-rest-framework.org/api-guide/settings/#unauthenticated_user).
Keep the default `IsAuthenticated` permission with no configured authentication
classes: future endpoints fail closed until a deliberate auth implementation is
added. The health endpoint remains explicitly public and read-only.

Tradeoff: Django ORM models, migrations, database sessions, and built-in auth are
not available. Future persistence must define validated document contracts,
indexes, access controls, and schema evolution explicitly, or propose a new ADR
before adopting a MongoDB ORM backend. No new public data API is added here.
The separate historical replay branch retains ownership of its content-addressed
artifact schema; this change neither reads nor writes those collections.

Driver lifecycle and timeout options follow the official
[MongoClient guidance](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/connect/mongoclient/)
and [client-side timeout documentation](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/connect/connection-options/csot/).
