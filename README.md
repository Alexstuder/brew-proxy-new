# brew-proxy

Zentraler API-Proxy für das Brewing-Ökosystem.

- OpenAI-Proxy (hält den API-Key serverseitig, Frontend kann ohne Secret rufen)
- RAPT.io API-Proxy mit Token-Refresh und Telemetrie-Cache
- Brewing-Shop Crawler (Playwright + Chromium)

## Lokal
```bash
cp .env.example .env   # Keys eintragen
npm install
npm start              # läuft auf :3000
```

## Container
Image: `<DOCKERHUB_USERNAME>/brew_proxy:latest`
Build: GitHub Actions on push to `main`.
