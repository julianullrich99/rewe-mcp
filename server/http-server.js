#!/usr/bin/env node
// Netzwerk-Variante: läuft dauerhaft auf einem Server.
//   POST /mcp  – MCP (Streamable HTTP) für Claude. Anmeldung per "Authorization: Bearer <Passwort>"
//                oder – mit REWE_PUBLIC_URL – per OAuth (jede Person meldet sich einzeln an, z.B. claude.ai)
//   GET  /health – Status ohne Anmeldung (Browser bereit? bei REWE angemeldet?)
// Standard: REWE läuft in einem Chrome im Container (browser.js, Login per noVNC).
// Mit REWE_BACKEND=extension stattdessen über die Chrome-Extension auf dem PC (WS /ext).
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBridge, registerTools, checkPassword, startKeepAlive, log } from "./lib.js";
import { createOAuth } from "./oauth.js";

const PORT = Number(process.env.REWE_MCP_PORT || 47823);
const HOST = process.env.REWE_MCP_HOST || "0.0.0.0";
const PASSWORD = process.env.REWE_MCP_PASSWORD;
const MAX_BODY = 1_000_000;
const BACKEND = process.env.REWE_BACKEND || "browser";

if (!PASSWORD || PASSWORD.length < 8) {
  console.error("REWE_MCP_PASSWORD muss gesetzt sein (mindestens 8 Zeichen).");
  process.exit(1);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body zu groß"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body zu groß"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const LOGIN_DONE_PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>REWE-Login fertig?</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px}
button{font:inherit;font-weight:600;padding:12px 22px;border:0;border-radius:8px;background:#cc071e;color:#fff;cursor:pointer}
#s{margin-top:18px}</style></head><body>
<h1>REWE-Login</h1>
<ol><li>Im ersten Tab bei REWE anmelden (Cloudflare-Prüfung, Passwort, E-Mail-Code).</li>
<li>Prüfen, dass dein Abholmarkt gewählt ist.</li><li>Dann hier klicken:</li></ol>
<button id="b">Fertig – Server übernimmt</button><div id="s"></div>
<script>document.getElementById("b").onclick=async()=>{const s=document.getElementById("s");s.textContent="Prüfe Anmeldung…";
try{const r=await (await fetch(location.pathname,{method:"POST"})).json();
s.textContent=r.loggedIn?"✅ Angemeldet – du kannst die Fernansicht schließen.":"❌ Anmeldung nicht erkannt – bitte im ersten Tab erneut anmelden und dann noch mal klicken.";}
catch(e){s.textContent="Fehler: "+e.message}};</script></body></html>`;

// OAuth nur, wenn eine öffentliche Adresse bekannt ist (für Issuer/Redirects)
const PUBLIC_URL = process.env.REWE_PUBLIC_URL;
const oauth = PUBLIC_URL
  ? createOAuth({
      publicUrl: PUBLIC_URL,
      checkLoginPassword: (p) => checkPassword(p, PASSWORD),
      storeFile: process.env.REWE_OAUTH_STORE || "/data/oauth.json",
      log,
    })
  : null;
const PUBLIC_PATHS = new Set(["/mcp", ...(oauth?.publicPaths || [])]);

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;

  // Über Cloudflare Tunnel (erkennbar am Header cf-connecting-ip) ist nur /mcp erreichbar –
  // Status, Login-Seite und Debug bleiben im Heimnetz, auch wenn die Pfadregel im Tunnel fehlt.
  if (req.headers["cf-connecting-ip"] && !PUBLIC_PATHS.has(path)) return send(res, 404, { error: "not found" });

  if (oauth && (await oauth.handle(req, res, path, () => readRaw(req)))) return;

  if (path === "/health")
    return send(res, 200, { ok: true, backend: BACKEND, connected: backend.isConnected(), reweSession: backend.status });
  // "Fertig"-Seite im Server-Chrome: nach dem REWE-Login klickt der Nutzer hier, dann verbindet sich
  // der Server wieder mit Chrome. Ohne Passwort – löst nur eine Prüfung aus.
  if (path === "/login/done" && backend.finishLogin) {
    if (req.method === "POST") return send(res, 200, await backend.finishLogin());
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(LOGIN_DONE_PAGE);
  }
  const debug = path === "/debug/fetch" && process.env.REWE_MCP_DEBUG === "1";
  if (path !== "/mcp" && !debug) return send(res, 404, { error: "not found" });

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const authorized = checkPassword(token, PASSWORD) || (oauth && oauth.verifyAccessToken(token));
  if (!authorized) {
    res.setHeader("WWW-Authenticate", oauth ? oauth.wwwAuthenticate : 'Bearer realm="rewe-mcp"');
    return send(res, 401, { error: "unauthorized" });
  }

  // Nur zur Entwicklung (REWE_MCP_DEBUG=1): Rohantwort einer REWE-Shop-Anfrage
  if (debug) {
    try {
      const u = new URL(req.url, "http://x");
      const headers = JSON.parse(u.searchParams.get("headers") || '{"accept":"application/json"}');
      return send(res, 200, await backend.callExtension("fetch", { path: u.searchParams.get("path"), headers }));
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  // Zustandslos: pro Anfrage ein frischer MCP-Server + Transport
  if (req.method !== "POST") {
    return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }
  try {
    const body = await readJson(req);
    const server = new McpServer({ name: "rewe-shop", version: "2.0.0" });
    registerTools(server, backend.callExtension, { loginStatus: backend.status });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log("Fehler bei /mcp:", e.message);
    if (!res.headersSent)
      send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Ungültige Anfrage" }, id: null });
  }
});

let backend;
if (BACKEND === "extension") {
  const bridge = createBridge(httpServer, { password: PASSWORD });
  backend = { ...bridge, status: startKeepAlive(bridge, { intervalMin: Number(process.env.REWE_KEEPALIVE_MIN || 4) }) };
} else {
  const { createBrowserBackend } = await import("./browser.js");
  backend = await createBrowserBackend();
}

httpServer.listen(PORT, HOST, () => {
  log(`MCP:       http://${HOST}:${PORT}/mcp`);
  if (BACKEND === "extension") log(`Extension: ws://${HOST}:${PORT}/ext`);
});
