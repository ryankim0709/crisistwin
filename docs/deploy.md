# Deploying the demo on one VM

One Ubuntu VM (Vultr or any other) runs everything: Caddy (automatic HTTPS, the built web
app, `/api` proxy), the Django API with the live traffic twin, and a local `mongod` for the big
caches. App data stays on MongoDB Atlas. Phones join over `https://<your-host>`.

Files: `deploy/docker-compose.yml`, `deploy/Dockerfile.api`, `deploy/Dockerfile.web`,
`deploy/Caddyfile`, `deploy/.env.example`, `.dockerignore`. Nothing here is deployed or
created for you; these are the steps you run.

```
phone / browser --HTTPS--> Caddy :443 --/api/*--> api:8000 (gunicorn, 1 worker, 32 threads)
                              |                      |-- MongoDB Atlas   (app data)
                              '-- static dist/       '-- cachedb:27017   (local mongod: caches)
```

## 1. Prerequisites (outside this repo)

- A VM: Ubuntu 22.04/24.04, public IPv4, ports 22, 80, 443 open (and 443/udp for HTTP/3).
  Sizing below. Vultr credits: claim them through the MLH "Best Use of Vultr" offer on the
  hackathon's MLH page; the code or link comes from MLH, not from this repo.
- A DNS name, e.g. `drill.<your-domain>`, with an A record to the VM's IP. Let's Encrypt cannot
  issue the certificate until DNS resolves to the VM.
- MongoDB Atlas: in Network Access add the VM's public IP (a free-tier cluster blocks
  everything else). The data already pushed there is reused.

## 2. Set up the VM

```sh
ssh root@<vm-ip>
curl -fsSL https://get.docker.com | sh          # Docker Engine + Compose v2
git clone <repo-url> crisistwin && cd crisistwin
git checkout <branch-to-demo>
```

## 3. Fetch the generated data (not in Git)

The Camp replay bundle and mobility sidecars live in Atlas (`app/public/replays/README.md`).
The API image and the web build both need them, so pull before building. No host Python needed:

```sh
docker run --rm -v "$PWD":/repo -w /repo -e MONGODB_URI='<atlas-uri>' python:3.12-slim \
  sh -c "pip install -q -r tools/requirements.txt && python -m tools.mongo_data pull"
ls -lh app/public/replays/camp-2018.json        # about 18 MB
```

## 4. Configure

```sh
cd deploy
cp .env.example .env && chmod 600 .env && nano .env
```

Required (compose refuses to start without them): `SITE_ADDRESS`, `DJANGO_SECRET_KEY`,
`MONGODB_URI`, `LIVE_CONTROLLER_TOKEN`, `LIVE_INVITE_CODE`. Generate secrets with
`python3 -c "import secrets; print(secrets.token_urlsafe(40))"`.

| Variable | Purpose |
|---|---|
| `SITE_ADDRESS` | Public host name. Caddy gets a certificate for it; also feeds `DJANGO_ALLOWED_HOSTS` and `DJANGO_CSRF_TRUSTED_ORIGINS` (`https://<host>`) in compose. |
| `DJANGO_SECRET_KEY` | Required because compose sets `DJANGO_DEBUG=false`. |
| `MONGODB_URI`, `MONGODB_DATABASE` | App data on Atlas. |
| `LIVE_CONTROLLER_TOKEN` | Required for multi-phone. Empty means every client is the controller. Typed into the /live console once (kept in sessionStorage); never in a bundle. |
| `LIVE_INVITE_CODE` | Responder join code; unset means phone joins get 403. |
| `ANTHROPIC_API_KEY`, `CARTESIA_*`, `VOICE_MODEL`, `APIFY_*` | Optional, server-side only; the web bundle never contains them. Paid usage. |

`DJANGO_BEHIND_PROXY=true` (set by compose) makes Django trust Caddy's `X-Forwarded-Proto`.
The API port is not published on the host; only Caddy is reachable.

## 5. Start

```sh
docker compose up -d --build        # from deploy/; first build takes a few minutes
docker compose ps                   # api should become "healthy"
curl -s https://<your-host>/api/health     # {"status":"ok",...}
```

Open `https://<your-host>/live`, enter the controller token, then use the "..." menu >
Invite phones for the join link and QR code (`crisistwin://join?server=https://<your-host>&code=...`).

## Separate cache database

The geo tile cache (`geo_cache`), the landscape cache (GridFS bucket `landscape_cache`) and the
conditions cache (`conditions_cache`) read and write through `get_cache_database()` in
`app/backend/api/mongodb.py`. Settings (`app/backend/config/settings.py`):

- `CACHE_MONGODB_URI` defaults to `MONGODB_URI`; `CACHE_MONGODB_DATABASE` defaults to
  `MONGODB_DATABASE`. Unset, nothing changes locally: the same client and database are used.
- Compose points them at the `cachedb` container (`mongodb://cachedb:27017`, database
  `crisistwin_cache`, volume `cache_data`). It has no auth and no published port, so only the
  compose network reaches it. Do not publish 27017.
- Caches are rebuildable, so an empty `cachedb` after a volume loss only means slower first
  requests. Existing cache documents already in Atlas (about 270 MB of the 512 MB free tier)
  are not moved; they become unused. To reclaim the space, drop `geo_cache`,
  `conditions_cache` and the `landscape_cache.*` collections in Atlas (your decision, after
  the VM is serving). Optional warm-up instead: `mongodump --uri=<atlas> --collection=...` then
  `mongorestore` into `cachedb`.

## Why one worker

The live drill's traffic twin and simulated people are Python objects in the Django process
(`app/backend/api/live/twin_service.py`: one `Twin` per incident per process, plus inputs built in a
background thread; the drill indexes in `live/drillcache.py` and the controller state are also
per process). With several gunicorn workers every worker would build and advance its own twin, so
phones would get different people and roads depending on which worker answered, and each would
cost its own RAM. The image therefore runs `--workers 1 --worker-class gthread --threads 32`:
one owner of the simulation, concurrency from threads (calls into a twin are already serialized
by a per-incident lock; Mongo and network waits release the GIL). A distributed lock would add
moving parts the demo does not need. Do not scale `api` replicas or raise `--workers`; if you
ever need more throughput, scale the VM up instead. The cost is that a restart of `api` drops
the in-memory twin: it rebuilds from the drill's stored state (a short "warming" period).

## Sizing

The twin builds its inputs once (road graph, history, fire timeline from `data/incidents`),
then advances on reads. Rough guidance, measure on your VM with `docker stats`:

| Use | VM |
|---|---|
| Demo, a handful of phones, one drill | 2 vCPU / 4 GB RAM, 40 GB disk |
| Safer for a live judging session, ~20+ phones, Studio drills | 4 vCPU / 8 GB RAM |

Memory is dominated by the twin plus gunicorn threads (watch `api`); the `mongod` cache is
capped at 0.5 GB WiredTiger cache. Load test with `docs/live-loadtest.md` against a copy, not
your live drill.

## Operate

```sh
docker compose logs -f api            # API + gunicorn access log
docker compose logs -f web            # Caddy, certificate issuance
docker compose ps                     # health of api and cachedb
curl -s https://<host>/api/health     # 503 means Atlas is unreachable (check IP allowlist)
curl -s https://<host>/api/live/active
docker stats --no-stream
```

- **Restart the drill process (reset the twin):** `docker compose restart api`. Phones keep their
  join; the twin re-warms. To restart the drill itself use the /live console's restart control;
  the twin rebuilds when the drill's `started_at` changes.
- **Update code:** `git pull && docker compose up -d --build` (the web build needs the replay
  bundle from step 3 in `app/public/replays/`).
- **Stop everything:** `docker compose down` (add `-v` only to delete caches and Studio packages).
- Studio drill packages are written under `/data/packages` (volume `api_data`).
- Certificates are stored in volume `caddy_data`; do not delete it between restarts or you may hit
  Let's Encrypt rate limits.

## Pointing the iOS app at the host

Phones need no rebuild: open the join link or scan the QR code from /live "Invite phones"
(Plan > About > Server also accepts it). The server override is stored on the device and must be
`https://`. For a Release build with the host baked in, set `API_BASE_URL` (and `WEB_BASE_URL`) in
`mobile/Config/Release.xcconfig` to `https://<your-host>`; Release rejects non-HTTPS
origins (ADR 0034).

## Frontend API base

The web app calls relative `/api/...` URLs (`app/src/live/api.ts`, `src/fire/landscape.ts`); Vite
proxies them in development and Caddy does in production, so the same origin works with no
`VITE_*` variable. The dev-only token signing (`app/controllerProxy.ts`) does not exist in the
build: the console asks for the controller token.

## Not covered

No backups of Atlas or the cache volume, no log shipping, no firewall automation. Use the
provider's firewall to allow only 22/80/443. Do not put real credentials in screenshots or chat.
