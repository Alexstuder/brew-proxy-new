# brew-proxy

Zentraler Node.js-API-Proxy für das Brewing-Ökosystem. Hält Provider-Secrets
serverseitig, sodass Frontends ohne API-Keys auskommen.

Ein Docker-Image, zwei Container-Instanzen. Die Env-Var `PROXY_ROLE` entscheidet
zur Laufzeit, welche Routen registriert sind und gegen welche Supabase-Instanz
der Proxy validiert:

| `PROXY_ROLE` | Routen | Auth-Instanz | DB-Sync |
|---|---|---|---|
| `assistent` | OpenAI + Brewfather + Shop-Crawler | assistent-Supabase (kong-assistent) | aus |
| `rapt` | RAPT-Telemetrie + Cache | rapt-Supabase (kong-rapt) + db-rapt | ein |

## Status: Source-Repo

Dieses Repo ist **nur Source**. Auf `push main` baut GitHub Actions ein
Container-Image und pusht es zu Docker Hub:

```
${DOCKERHUB_USERNAME}/brew_proxy:latest
```

**Production-Deployment läuft via** [`webPage_infra`](https://github.com/alexstuder-web/webPage_infra) — dort werden zwei Service-Instanzen
(`api-proxy-assistent` / `api-proxy-rapt`) desselben Images betrieben. Watchtower aktualisiert beide Container automatisch.

Image-Definition: siehe [`Dockerfile`](Dockerfile) (Playwright-Base + Node).

## Lokales Dev

```bash
cp .env.example .env       # OPENAI_API_KEY, PROXY_ROLE, SUPABASE_INTERNAL_URL, SUPABASE_ANON_KEY
npm install

# assistent-Proxy (Port 3000, gegen lokalen kong-assistent :54321)
PROXY_ROLE=assistent SUPABASE_INTERNAL_URL=http://localhost:54321 SUPABASE_ANON_KEY=<anon-a> \
  OPENAI_API_KEY=<key> node server.js

# rapt-Proxy (Port 3001, gegen lokalen kong-rapt :54331)
PROXY_ROLE=rapt SUPABASE_INTERNAL_URL=http://localhost:54331 SUPABASE_ANON_KEY=<anon-r> \
  DATABASE_URL=postgresql://proxy_sync:<pw>@localhost:54332/postgres PORT=3001 node server.js
```

## Endpoints — assistent-Proxy (`PROXY_ROLE=assistent`)

Valide gegen assistent-Supabase (Auth A). Keine DB-Verbindung, kein db-sync.

| Route | Methode | Zweck | Auth |
|---|---|---|---|
| `/` | GET | Health-Check | — |
| `/api/chat` | POST | OpenAI Chat-Completion (Rezept-Generierung) | JWT (requireAuthenticatedUser) |
| `/api/brew` | POST | OpenAI Brau-Assistent | JWT (requireAuthenticatedUser) |
| `/api/picture` | POST | OpenAI Bildgenerierung (gpt-image-1) | JWT (requireAuthenticatedUser) |
| `/api/proxy-image` | GET | CORS-Proxy für externe Bilder | SSRF-Guard (kein JWT — bestehend) |
| `/api/shop-search` | POST | Brewing-Shop-Crawler | kein JWT — bestehend, siehe Open-Points |
| `/api/brewfather/*` | alle | Brewfather-API-Proxy (Rezepte/Batches) | JWT + get_my_brewfather_creds |

## Endpoints — rapt-Proxy (`PROXY_ROLE=rapt`)

Valide gegen rapt-Supabase (Auth R) + db-rapt (db-sync). Kein OpenAI.

| Route | Methode | Zweck | Auth |
|---|---|---|---|
| `/` | GET | Health-Check | — |
| `/api/rapt/token` | POST | RAPT JWT-Token via User-ID/API-Key | JWT (requireRaptCreds) |
| `/api/rapt/profiles` | GET | RAPT Profiles (Sude) | JWT (requireRaptCreds) |
| `/api/rapt/hydrometers` | GET | RAPT Pill-Hydrometer-Liste | JWT (requireRaptCreds) |
| `/api/rapt/hydrometer-telemetry` | GET | Hydrometer-Telemetrie (direkt) | JWT (requireRaptCreds) |
| `/api/rapt/telemetry` | GET | Controller-Telemetrie (gecached) | JWT (requireRaptCreds) |
| `/api/rapt/telemetry/start-override` | GET/POST/PUT/DELETE | Startdatum-Override | JWT (requireRaptCreds) |
| `/api/cache/telemetry` | GET | Telemetrie-Cache | JWT (requireRaptCreds) |
| `/api/cache/controllers` | GET | Controller-Cache | JWT (requireRaptCreds) |

## DB-Sync Worker (nur rapt-Proxy)

`db-sync.js` läuft nur im `PROXY_ROLE=rapt`-Container. Pollt periodisch die RAPT-Cloud-API
und UPSERTet in db-rapt (`rapt.controllers`, `rapt.hydrometers`,
`rapt.telemetry_*`, `rapt.brew_sessions`). DB-Verbindung kommt via
`DATABASE_URL` (zeigt auf `db-rapt`, nicht auf die assistent-DB).

## Env-Vertrag

| Var | assistent-Proxy | rapt-Proxy |
|---|---|---|
| `PROXY_ROLE` | `assistent` (Pflicht) | `rapt` (Pflicht) |
| `SUPABASE_INTERNAL_URL` | `http://kong-assistent:8000` | `http://kong-rapt:8000` |
| `SUPABASE_ANON_KEY` | assistent-ANON | rapt-ANON |
| `OPENAI_API_KEY` | Pflicht | nicht gesetzt |
| `DATABASE_URL` | nicht gesetzt | `…@db-rapt:5432/…` (proxy_sync) |
| `RAPT_SYNC_ENABLED` | unbenutzt | `true`/unset |
| `CORS_ORIGIN` | assistent-Origins | rapt-Origins |
| `PORT` | 3000 | 3000 (eigener Container) |

## Verwandte Repos

- [`webPage_infra`](https://github.com/alexstuder-web/webPage_infra) — Production-Compose + Bootstrap (zwei Container-Instanzen: `api-proxy-assistent` + `api-proxy-rapt`)
- [`brew_assistent-new`](https://github.com/alexstuder-web/brew_assistent-new) — nutzt assistent-Proxy (`/api/chat`, `/api/brew`, `/api/picture`, `/api/brewfather/*`)
- [`RAPT_Brewing_Dashboard-new`](https://github.com/alexstuder-web/RAPT_Brewing_Dashboard-new) — nutzt rapt-Proxy (`/api/rapt/*`, `/api/cache/*`)
