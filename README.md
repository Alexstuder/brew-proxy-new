# brew-proxy

Zentraler Node.js-API-Proxy für das Brewing-Ökosystem. Hält Provider-Secrets
serverseitig, sodass Frontends ohne API-Keys auskommen.

- **OpenAI** — Chat-Completion + Bildgenerierung (gpt-image-1)
- **RAPT.io** — Cloud-API mit Token-Refresh; periodischer Sync nach Postgres
  (`db-sync.js`) ins `rapt` Schema
- **Brewfather** — Recipe-Import (geplant)
- **Shop-Crawler** — Playwright + Chromium für Brewing-Shop-Preisabfragen

## Status: Source-Repo

Dieses Repo ist **nur Source**. Auf `push main` baut GitHub Actions ein
Container-Image und pusht es zu Docker Hub:

```
${DOCKERHUB_USERNAME}/brew_proxy:latest
```

**Production-Deployment läuft via** [`webPage_infra`](https://github.com/alexstuder-web/webPage_infra) — dort wird das Image
gezogen als Service `api-proxy`. Watchtower aktualisiert den Container alle
5 Min automatisch.

Image-Definition: siehe [`Dockerfile`](Dockerfile) (Playwright-Base + Node).

## Lokales Dev

```bash
cp .env.example .env       # OPENAI_API_KEY, RAPT_USERNAME, RAPT_API_KEY
npm install
npm start                  # läuft auf :3000
```

## Endpoints

| Route | Methode | Zweck |
|---|---|---|
| `/api/chat` | POST | OpenAI Chat-Completion (Rezept-Generierung) |
| `/api/picture` | POST | OpenAI Bildgenerierung (Label-Mockups) |
| `/api/proxy-image` | GET | CORS-Proxy für externe Bilder |
| `/api/brew` | POST | Legacy-Rezept-Endpoint |
| `/api/rapt/token` | POST | RAPT JWT-Token via User-ID/API-Key |
| `/api/rapt/profiles` | GET | RAPT Profiles (Sude) |
| `/api/rapt/hydrometers` | GET | RAPT Pill-Hydrometer-Liste |
| `/api/rapt/hydrometer-telemetry` | GET | Hydrometer-Telemetrie |
| `/api/rapt/telemetry` | GET | Controller-Telemetrie |
| `/api/cache/telemetry` | GET | Cache-Status |
| `/api/cache/controllers` | GET | Cache-Status |
| `/api/shop-search` | POST | Brewing-Shop-Crawler |

## DB-Sync Worker

`db-sync.js` läuft im selben Container und pollt periodisch die RAPT-Cloud-API,
UPSERTet in Supabase (`rapt.controllers`, `rapt.hydrometers`,
`rapt.telemetry_*`, `rapt.brew_sessions`). DB-Verbindung kommt via
`DATABASE_URL` (gesetzt vom Compose, zeigt auf `supabase-db`).

## Verwandte Repos

- [`webPage_infra`](https://github.com/alexstuder-web/webPage_infra) — Production-Compose + Bootstrap
- [`brew_assistent-new`](https://github.com/alexstuder-web/brew_assistent-new) — nutzt `/api/chat`, `/api/picture`
- [`RAPT_Brewing_Dashboard-new`](https://github.com/alexstuder-web/RAPT_Brewing_Dashboard-new) — liest aus dem von `db-sync.js` gefüllten `rapt` Schema
