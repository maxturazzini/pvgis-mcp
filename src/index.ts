/**
 * MCP PVGIS — Cloudflare Worker (remote MCP server, no-auth)
 *
 * Espone via streamable-http due tool MCP che interrogano PVGIS
 * (Photovoltaic Geographical Information System, Joint Research Centre della
 * Commissione Europea) per stimare la produzione fotovoltaica di un impianto.
 *
 * API PVGIS: pubblica, gratuita, senza registrazione e senza API key. Solo GET.
 * Docs: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_en
 *
 * Endpoint MCP dopo il deploy:   https://<worker>.workers.dev/mcp
 * Da incollare su Claude.ai > Connettori > Aggiungi connettore personalizzato.
 *
 * Implementazione: McpAgent (package "agents") montato con McpAgent.serve("/mcp").
 * Richiede un Durable Object binding (vedi wrangler.jsonc).
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3";

interface PvgisMonthly {
  month?: number | string;
  year?: number | string;
  E_m?: number;
  "H(i)_m"?: number;
  "H(h)_m"?: number;
  [k: string]: unknown;
}

async function pvgisGet(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${PVGIS_BASE}/${path}?${qs}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "mcp-pvgis-worker/1.0 (+AIMax Academy)" },
  });
  if (!res.ok) {
    throw new Error(`PVGIS ha risposto ${res.status} ${res.statusText} — ${url}`);
  }
  return { data: (await res.json()) as any, url };
}

export class PvgisMCP extends McpAgent {
  server = new McpServer({ name: "pvgis", version: "1.0.0" });

  async init() {
    // --- Tool principale: produzione annua/mensile ---------------------- //
    this.server.registerTool(
      "pv_production",
      {
        description:
          "Calcola la produzione fotovoltaica annua e mensile di un impianto a " +
          "falda fissa usando PVGIS (Commissione Europea / JRC). lat/lon in gradi " +
          "decimali; peakpower_kwp in kWp; angle = inclinazione falda in gradi; " +
          "aspect = orientamento (0 = SUD, -90 = est, 90 = ovest); loss = perdite " +
          "di sistema in %. Restituisce produzione annua (kWh), produzione mensile " +
          "e irraggiamento.",
        inputSchema: {
          lat: z.number().describe("Latitudine in gradi decimali (es. 45.43)"),
          lon: z.number().describe("Longitudine in gradi decimali (es. 10.99)"),
          peakpower_kwp: z.number().describe("Potenza di picco dell'impianto in kWp"),
          angle: z.number().int().default(30).describe("Inclinazione falda in gradi (0 = orizzontale)"),
          aspect: z.number().int().default(0).describe("Orientamento/azimut: 0 = SUD, -90 = est, 90 = ovest"),
          loss: z.number().default(14).describe("Perdite di sistema in % (default 14)"),
        },
      },
      async ({ lat, lon, peakpower_kwp, angle, aspect, loss }) => {
        const { data, url } = await pvgisGet("PVcalc", {
          lat,
          lon,
          peakpower: peakpower_kwp,
          loss,
          angle,
          aspect,
          outputformat: "json",
        });
        const totals = data?.outputs?.totals?.fixed ?? {};
        const monthlyRaw: PvgisMonthly[] = data?.outputs?.monthly?.fixed ?? [];
        const result = {
          annual_kwh: totals.E_y ?? null,
          annual_irradiation_kwh_m2: totals["H(i)_y"] ?? null,
          monthly_stddev_kwh: totals.SD_m ?? null,
          monthly: monthlyRaw.map((r) => ({
            month: Number(r.month),
            E_m_kwh: r.E_m ?? null,
            irradiation_kwh_m2: r["H(i)_m"] ?? null,
          })),
          parameters: { lat, lon, peakpower_kwp, angle, aspect, loss },
          source: url,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    // --- Tool opzionale: irraggiamento mensile -------------------------- //
    this.server.registerTool(
      "monthly_radiation",
      {
        description:
          "Irraggiamento mensile medio sul piano inclinato del modulo via PVGIS " +
          "MRcalc. lat/lon in gradi decimali; angle = inclinazione piano; aspect = " +
          "orientamento (0 = SUD). Restituisce l'irraggiamento mese per mese.",
        inputSchema: {
          lat: z.number().describe("Latitudine in gradi decimali"),
          lon: z.number().describe("Longitudine in gradi decimali"),
          angle: z.number().int().default(30).describe("Inclinazione piano in gradi"),
          aspect: z.number().int().default(0).describe("Orientamento: 0 = SUD"),
        },
      },
      async ({ lat, lon, angle, aspect }) => {
        const { data, url } = await pvgisGet("MRcalc", {
          lat,
          lon,
          angle,
          aspect,
          // FIX: selectrad=1 popola l'irraggiamento sul piano inclinato H(i)_m,
          // horirrad=1 popola quello orizzontale H(h)_m. Con 0 le righe tornano
          // vuote (null). Verificato sull'API PVGIS v5_3.
          selectrad: 1,
          horirrad: 1,
          outputformat: "json",
        });
        const monthlyRaw: PvgisMonthly[] = data?.outputs?.monthly ?? [];
        const result = {
          monthly: monthlyRaw.map((r) => ({
            year: r.year ?? null,
            month: r.month != null ? Number(r.month) : null,
            irradiation_tilted_kwh_m2: r["H(i)_m"] ?? null,
            irradiation_horizontal_kwh_m2: r["H(h)_m"] ?? null,
          })),
          parameters: { lat, lon, angle, aspect },
          source: url,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
}

interface Env {
  PVGIS_MCP: DurableObjectNamespace;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Health check / landing su "/"
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "MCP PVGIS attivo. Endpoint MCP: /mcp\n" +
          "Aggiungilo su Claude.ai come connettore personalizzato con URL <questo-host>/mcp\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    // Monta l'MCP server su /mcp (streamable-http).
    // binding esplicito: deve combaciare col nome in wrangler.jsonc (PVGIS_MCP).
    return PvgisMCP.serve("/mcp", { binding: "PVGIS_MCP" }).fetch(request, env, ctx);
  },
};
