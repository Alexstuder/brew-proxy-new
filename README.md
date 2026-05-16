# brew-proxy

Zentraler API-Proxy (Node.js/Express) für das Brewing-Ecosystem. Verwaltet alle externen API-Calls sicher auf dem Server – kein API-Key gelangt je in den Browser.

## Verantwortlichkeiten
- RAPT API Polling (Sensordaten holen & cachen)
- OpenAI API (Rezeptgenerator für brew_assistent)
- Authentifizierung & Rate-Limiting

## Architektur
- Container: `api_proxy`
- Port intern: `3000`
- Deployment: GitOps via Watchtower
- Kein direkter Inbound-Port – nur intern im Docker-Netzwerk erreichbar

## Lokale Entwicklung
```bash
npm install
npm run dev
```

## Umgebungsvariablen (.env)
```
RAPT_EMAIL=deine@email.ch
RAPT_PASSWORD=deinPasswort
OPENAI_API_KEY=sk-...
PORT=3000
```

## Deployment
Push auf `main` → GitHub Actions → Docker Hub → Watchtower deployed automatisch.
