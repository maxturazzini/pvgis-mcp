# PVGIS MCP — Cloudflare Worker

Remote **MCP server** che stima la produzione fotovoltaica di un impianto via
**PVGIS** (Photovoltaic Geographical Information System, Commissione Europea / JRC).
Gira **dentro Cloudflare** (serverless, sempre acceso, niente Mac acceso).

> Questo connettore è usato dal plugin **valutazione-fv** del marketplace
> [AI, MAX Plugins](https://github.com/maxturazzini/aimax-marketplace) — materiale
> didattico dei workshop AI, MAX. La skill recupera da qui la produzione reale di
> un tetto e la passa al suo script di calcolo ROI.

API PVGIS: pubblica, gratuita, senza key. Worker su Cloudflare: **free tier**
(100.000 richieste/giorno incluse) — costo atteso **€0**.

Endpoint MCP una volta deployato: `https://<worker>.workers.dev/mcp`

## Tool esposti
- **`pv_production`** (lat, lon, peakpower_kwp, angle=30, aspect=0, loss=14) → produzione annua + mensile, irraggiamento.
- **`monthly_radiation`** (lat, lon, angle=30, aspect=0) → irraggiamento mensile.

> `aspect`: 0 = SUD, -90 = est, 90 = ovest. `angle`: inclinazione falda in gradi.

---

## Deploy — via GitHub (consigliato)

1. Questo è il contenuto del repo **github.com/maxturazzini/pvgis-mcp**.
2. Su Cloudflare: **Workers & Pages → Create → Workers → Connect GitHub** → seleziona `pvgis-mcp`.
3. Cloudflare rileva `wrangler.jsonc`, installa le dipendenze e fa il build/deploy.
4. Ad ogni `git push` su `main` → **deploy automatico**.
5. URL finale: `https://pvgis-mcp.<tuo-subdominio>.workers.dev`

## Deploy — via CLI (alternativa)

```bash
cd worker-cloudflare
npm install
npx wrangler login        # apre il browser, autorizza
npx wrangler deploy       # stampa l'URL del worker
```

## Collegare a Claude.ai

Claude.ai → Impostazioni → **Connettori** → **Aggiungi connettore personalizzato (BETA)**:
- **Nome**: `PVGIS`
- **URL del server MCP remoto**: `https://pvgis-mcp.<tuo-subdominio>.workers.dev/mcp`
- **OAuth**: lasciare vuoto (il server è pubblico, no-auth).
- **Aggiungi**.

Poi in chat attiva il connettore PVGIS e chiedi la produzione di un tetto date le coordinate.

## Test rapido dopo il deploy

```bash
# health check
curl https://pvgis-mcp.<tuo-subdominio>.workers.dev/
# handshake MCP (atteso: 200 + serverInfo "pvgis")
curl -sL -X POST https://pvgis-mcp.<tuo-subdominio>.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

## Note
- **No-auth**: chiunque conosca l'URL può usarlo. Per un tool read-only su dati pubblici (PVGIS) è accettabile; se vuoi limitarlo, si aggiunge OAuth (Workers OAuth Provider) — non incluso qui per semplicità.
- **Geocoding**: PVGIS prende coordinate, non indirizzi. Per accettare un indirizzo serve un geocoder a monte (es. Nominatim/OSM, libero). Non incluso: lo si può aggiungere come terzo tool.
- La versione **Python stdio** (`../server.py`) resta per Claude Desktop; la versione **tunnel** (`../server_http.py` + `../run_tunnel.sh`) resta come alternativa locale.
