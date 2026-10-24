# Development reference

Moved from the root README; the quick start stays there.

## Optional local checks in Docker

These commands are available on request; they are not required for the hackathon.
With the stack running, execute them from `app/`:

```sh
docker compose exec frontend npm run check
docker compose exec frontend npm run test:coverage
docker compose exec backend ruff check .
docker compose exec backend ruff format --check .
docker compose exec backend python manage.py check
docker compose exec backend python manage.py test --noinput
```

`npm run check` runs Prettier, ESLint, TypeScript, Vitest, and the frontend build.
Individual commands are `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build`. Use `npm run test:watch`
while developing. Tests use mocked network/database boundaries; Docker startup
and the health endpoint check the real database connection.

## Run app processes on your host

Use the versions above and the existing Atlas connection (or a running local
MongoDB server), then create a local Python environment. From `app/`:

```sh
export MONGODB_URI="$(cat ~/.mongodb_uri)"
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
backend/.venv/bin/python backend/manage.py runserver 127.0.0.1:8000
```

In a second terminal, from `app/`:

```sh
nvm use
npm ci
npm run dev
```

Django reads environment variables from the shell; it does not load `.env`
automatically. Export `MONGODB_URI` and, if needed, `MONGODB_DATABASE` in the backend
shell. The default database is `crisistwin` for both host and Compose.
Vite proxies `/api` to `http://127.0.0.1:8000` on the host and `http://backend:8000`
in Docker. To change the host target, use
`VITE_API_PROXY_TARGET=http://127.0.0.1:8000 npm run dev`.

Optional host backend checks run from `app/backend/` using `.venv/bin/ruff check .`,
`.venv/bin/ruff format --check .`, `.venv/bin/python manage.py check`, and
`.venv/bin/python manage.py test --noinput`.

## Build runtime images

From `app/`, `docker build -t crisistwin-frontend .` builds the Nginx frontend
image. `docker build --target runtime -t crisistwin-backend backend` builds the
Gunicorn backend image. Nginx expects a backend reachable at `backend:8000`.
`npm run preview` only previews static build output; use Compose to exercise
the full stack. Deployment, TLS, hosting, and production secrets are not
configured by this scaffold.

