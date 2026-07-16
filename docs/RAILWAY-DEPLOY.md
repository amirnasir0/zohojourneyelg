# Railway Deployment — Environment Variable Checklist

Code/config side of deploy readiness. Railway project setup, service creation, and domain/DNS are handled
outside this doc. This covers every env var the running server needs, plus the two ephemeral-filesystem
gotchas (JWT keys, tenant config) and the build/start commands Railway will run.

## Build & start

Railway auto-detects Node.js via Nixpacks and runs `npm install`, then the `build` and `start` scripts from
`package.json`:

```json
"build": "prisma generate && tsc -p tsconfig.build.json",
"start": "node dist/server.js"
```

No Dockerfile or custom Railway build command needed — verified locally: clean build produces `dist/server.js`
(previously broken — `tsconfig.json`'s `include: ["src","tests"]` + `rootDir: "."` emitted to `dist/src/server.js`
instead; `tsconfig.build.json` scopes the production build to `src` only, tests stay out of the compiled output).

## Required environment variables

| Var | Production value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Silences the dev-only OTP echo and switches the global error handler to generic error bodies. |
| `PORT` | *(leave unset)* | Railway injects this automatically; the server already reads `process.env.PORT` and binds `0.0.0.0`. Do not set manually. |
| `DATABASE_URL` | Neon **pooled** connection string, `pgbouncer=true` | Same one already used for the sync worker's writes — see TECH-DEBT.md for why pooled is required (PgBouncer transaction-pooling mode). |
| `REDIS_URL` | Upstash `rediss://...` (TLS) | OTP store, rate limits, journeys cache. |
| `TENANT_CONFIG_PATH` | `./seed/elgris.tenant-config.json` | In-repo path — the file is committed to git (not gitignored) so it ships with the code automatically. Nothing writes to it at runtime (verified: the only `writeFileSync` in the codebase is the local one-time `generate-jwt-keys.ts` script). Resolves correctly because `node dist/server.js` runs from the repo root, not from inside `dist/`. |
| `ENABLE_SYNC` | `true` | Arms the 15-min incremental + nightly full-reconcile cron. |
| `WEBHOOK_SECRET` | Long random value (`openssl rand -hex 24`) | Must match the `?secret=` configured in both Zoho Workflow Rules — see `ZOHO-WEBHOOK-SETUP.md`. |
| `CORS_ORIGINS` | Empty, unless a browser client exists | Comma-separated allowlist. Empty/unset denies every browser origin outright. **Does not affect the React Native app** — CORS is browser-only; native HTTP requests never send an `Origin` header. |
| `ZOHO_CLIENT_ID` | From Zoho API console | |
| `ZOHO_CLIENT_SECRET` | From Zoho API console | |
| `ZOHO_REFRESH_TOKEN` | From the one-time `npm run zoho:authorize` flow (run locally, not on Railway) | |
| `ZOHO_REDIRECT_URI` | *(not needed)* | Only read by the local one-time `zoho:authorize` setup script — the running server never touches it. Omit from Railway entirely. |
| `INTERAKT_API_KEY` | From Interakt dashboard | Required for real WhatsApp OTP delivery — confirmed working end-to-end (M7b/M7d). |
| `INTERAKT_OTP_TEMPLATE` | *(not needed)* | **Unused by the running server** — the real template name comes from tenant config (`notifications.interakt_otp_template` in `seed/elgris.tenant-config.json`), not this env var. Present in local `.env` today but dead; omit from Railway or leave it, harmless either way. |
| `MSG91_API_KEY` | *(optional, currently unset)* | SMS fallback channel. Accepted gap per TECH-DEBT — WhatsApp (Interakt) is the working primary channel; configure this before relying on the fallback path for customers without WhatsApp. |
| `JWT_PRIVATE_KEY` | Base64-encoded PEM content — see below | **Use this on Railway, not `JWT_PRIVATE_KEY_PATH`.** Railway's filesystem is ephemeral; a path to a file that isn't in the repo won't survive a redeploy. |
| `JWT_PUBLIC_KEY` | Base64-encoded PEM content — see below | Same reasoning. |

`JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` (file paths, e.g. `./keys/jwt-private.pem`) still work as a
fallback — that's what local dev uses, since `keys/` is gitignored and never deployed. On Railway, set the
`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` content vars instead and leave the `_PATH` vars unset.

### Encoding the JWT keys for Railway

```bash
base64 -i keys/jwt-private.pem | tr -d '\n'   # → JWT_PRIVATE_KEY
base64 -i keys/jwt-public.pem  | tr -d '\n'   # → JWT_PUBLIC_KEY
```

Paste each output as the Railway env var value (single line, no wrapping). The server decodes with
`Buffer.from(value, 'base64').toString('utf-8')` before parsing the PEM — verified locally end-to-end
(signed and verified a real token using only the base64 env vars, `_PATH` vars unset).

## Healthcheck

Set Railway's healthcheck path to `GET /healthz`. It already fails closed — returns `503` if Redis or
Postgres is unreachable, `200 {"status":"ok"}` otherwise (see `src/routes/healthz.ts`). No changes needed.

`GET /healthz/sync` is a second, non-blocking diagnostic endpoint (sync watermark/status) — not meant as
the healthcheck target, since a stale-but-recovering sync shouldn't fail container health.

## Shutdown behavior

Railway sends `SIGTERM` on every redeploy/restart before eventually `SIGKILL`-ing if the process doesn't
exit. The server now handles this: stops the cron scheduler first (no new sync run starts mid-shutdown),
then closes the HTTP server (stops accepting new connections, lets in-flight requests finish, runs Prisma/
Redis disconnect), then exits `0`. A 10-second hard cap forces `process.exit(1)` if something hangs, so a
stuck connection doesn't turn every redeploy into a Railway-forced `SIGKILL`.

## Database migrations

Not part of `npm run build` (that's compilation only). Run `npx prisma migrate deploy` once against the
production `DATABASE_URL` before the first boot — either manually from a local shell pointed at the
production database, or as a Railway "release command" if you want it automated per-deploy. (The Neon
database already in use throughout this project has every migration applied — this only matters if Railway
points at a different/fresh database.)
