// Minimaler OAuth-2.1-Server für Claude-Connectors: jede Person meldet sich einzeln mit dem
// Server-Passwort an und erhält eigene Tokens. Unterstützt, was claude.ai erwartet:
//   - Protected Resource Metadata (RFC 9728) und Authorization Server Metadata (RFC 8414)
//   - Dynamic Client Registration (RFC 7591)
//   - Authorization Code + PKCE (S256), Refresh Tokens (rotierend)
// Tokens werden nur als SHA-256-Hash gespeichert (Datei im Daten-Volume), damit sie Neustarts überstehen.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const ACCESS_TTL_S = 3600; // 1 Stunde
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 Tage, wird bei jeder Nutzung erneuert
const CODE_TTL_MS = 5 * 60_000;
const MAX_CLIENTS = 100;
const LOCKOUT_FAILS = 10; // so viele Fehlversuche in LOCKOUT_WINDOW → Login gesperrt
const LOCKOUT_WINDOW_MS = 15 * 60_000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createOAuth({ publicUrl, checkLoginPassword, storeFile, log = () => {} }) {
  const issuer = publicUrl.replace(/\/$/, "");
  const resource = `${issuer}/mcp`;
  const codes = new Map();
  let fails = [];

  let db = { clients: {}, access: {}, refresh: {} };
  if (existsSync(storeFile)) {
    try {
      db = { ...db, ...JSON.parse(readFileSync(storeFile, "utf8")) };
    } catch (e) {
      log("OAuth-Speicher unlesbar, starte leer:", e.message);
    }
  }
  function save() {
    const t = nowS();
    for (const k of ["access", "refresh"]) for (const [h, v] of Object.entries(db[k])) if (v.exp < t) delete db[k][h];
    writeFileSync(storeFile + ".tmp", JSON.stringify(db));
    renameSync(storeFile + ".tmp", storeFile);
  }

  // ---------- Metadaten ----------

  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_name: "REWE Einkauf",
  };
  const serverMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["rewe"],
  };

  // ---------- Tokens ----------

  function issueTokens(clientId) {
    const access = token();
    const refresh = token();
    db.access[sha(access)] = { clientId, exp: nowS() + ACCESS_TTL_S };
    db.refresh[sha(refresh)] = { clientId, exp: nowS() + REFRESH_TTL_S };
    save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "rewe" };
  }

  function verifyAccessToken(t) {
    const e = t && db.access[sha(t)];
    return !!e && e.exp > nowS() && !!db.clients[e.clientId];
  }

  // ---------- Login-Seite ----------

  function loginPage(params, client, error) {
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
      .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`)
      .join("");
    const app = esc(client.client_name || "Ein Programm");
    const host = esc(new URL(params.redirect_uri).host);
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>REWE-Zugang freigeben</title><style>
body{font:17px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1a1a1a}
h1{font-size:22px;color:#cc071e}input[type=password]{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #bbb;border-radius:8px}
button{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:8px;background:#cc071e;color:#fff;cursor:pointer}
.err{color:#b00020;margin:10px 0}.hint{color:#666;font-size:14px}</style></head><body>
<h1>REWE-Zugang freigeben</h1>
<p><b>${app}</b> (${host}) möchte auf deinen REWE-Einkauf zugreifen: Produkte suchen, Warenkorb ändern, Bestellungen ansehen.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label>Server-Passwort<br><input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">Zugang erlauben</button></form>
<p class="hint">Nur freigeben, wenn du selbst diese Verbindung gerade eingerichtet hast.</p></body></html>`;
  }

  // ---------- Hilfen ----------

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }
  const html = (res, status, body) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };
  function parseBody(raw, contentType = "") {
    if (!raw) return {};
    if (contentType.includes("application/json")) return JSON.parse(raw);
    return Object.fromEntries(new URLSearchParams(raw));
  }
  const validRedirect = (u) => {
    try {
      const x = new URL(u);
      return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname));
    } catch {
      return false;
    }
  };

  // ---------- Endpunkte ----------

  /** Bearbeitet OAuth-Pfade. Gibt true zurück, wenn die Anfrage beantwortet wurde. */
  async function handle(req, res, path, readRaw) {
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      send(res, 200, resourceMetadata);
      return true;
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      send(res, 200, serverMetadata);
      return true;
    }

    if (path === "/register" && req.method === "POST") {
      let meta;
      try {
        meta = parseBody(await readRaw(), req.headers["content-type"]);
      } catch {
        send(res, 400, { error: "invalid_client_metadata" });
        return true;
      }
      const uris = meta.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || !uris.every(validRedirect)) {
        send(res, 400, { error: "invalid_redirect_uri" });
        return true;
      }
      if (Object.keys(db.clients).length >= MAX_CLIENTS) {
        // Älteste Registrierung ohne gültige Tokens entfernen
        const used = new Set([...Object.values(db.refresh), ...Object.values(db.access)].map((t) => t.clientId));
        const oldest = Object.entries(db.clients)
          .filter(([id]) => !used.has(id))
          .sort((a, b) => a[1].created - b[1].created)[0];
        if (!oldest) {
          send(res, 400, { error: "invalid_client_metadata", error_description: "zu viele Clients" });
          return true;
        }
        delete db.clients[oldest[0]];
      }
      const clientId = token();
      db.clients[clientId] = { redirect_uris: uris, client_name: String(meta.client_name || "").slice(0, 100), created: nowS() };
      save();
      log(`OAuth: Client registriert (${db.clients[clientId].client_name || "ohne Namen"})`);
      send(res, 201, {
        client_id: clientId,
        client_id_issued_at: db.clients[clientId].created,
        client_name: db.clients[clientId].client_name || undefined,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      return true;
    }

    if (path === "/authorize") {
      const params =
        req.method === "POST"
          ? parseBody(await readRaw(), req.headers["content-type"])
          : Object.fromEntries(new URL(req.url, issuer).searchParams);
      const client = db.clients[params.client_id];
      if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
        html(res, 400, "<p>Unbekannter Client oder ungültige Weiterleitungsadresse. Bitte den Connector in Claude neu verbinden.</p>");
        return true;
      }
      if (req.method === "GET" && params.response_type !== "code") {
        const u = new URL(params.redirect_uri);
        u.searchParams.set("error", "unsupported_response_type");
        if (params.state) u.searchParams.set("state", params.state);
        res.writeHead(302, { location: u.toString() });
        res.end();
        return true;
      }
      if (!params.code_challenge || (params.code_challenge_method || "S256") !== "S256") {
        html(res, 400, "<p>PKCE (S256) ist erforderlich.</p>");
        return true;
      }
      if (req.method !== "POST") {
        html(res, 200, loginPage(params, client));
        return true;
      }

      // Passwort prüfen (mit Sperre gegen Durchprobieren)
      const t = Date.now();
      fails = fails.filter((f) => t - f < LOCKOUT_WINDOW_MS);
      if (fails.length >= LOCKOUT_FAILS) {
        html(res, 429, loginPage(params, client, "Zu viele Fehlversuche – bitte in 15 Minuten erneut versuchen."));
        return true;
      }
      await new Promise((r) => setTimeout(r, 400));
      if (!checkLoginPassword(params.password || "")) {
        fails.push(t);
        log(`OAuth: falsches Passwort (${fails.length}/${LOCKOUT_FAILS})`);
        html(res, 401, loginPage(params, client, "Falsches Passwort."));
        return true;
      }

      const code = token();
      codes.set(code, {
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        challenge: params.code_challenge,
        exp: Date.now() + CODE_TTL_MS,
      });
      log(`OAuth: Zugang erteilt für ${client.client_name || params.client_id.slice(0, 8)}`);
      const u = new URL(params.redirect_uri);
      u.searchParams.set("code", code);
      if (params.state) u.searchParams.set("state", params.state);
      res.writeHead(302, { location: u.toString(), "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (path === "/token" && req.method === "POST") {
      let p;
      try {
        p = parseBody(await readRaw(), req.headers["content-type"]);
      } catch {
        send(res, 400, { error: "invalid_request" });
        return true;
      }
      if (p.grant_type === "authorization_code") {
        const c = codes.get(p.code);
        codes.delete(p.code); // Codes sind nur einmal gültig
        const challengeOk =
          c && p.code_verifier && createHash("sha256").update(p.code_verifier).digest("base64url") === c.challenge;
        if (!c || c.exp < Date.now() || c.clientId !== p.client_id || c.redirectUri !== p.redirect_uri || !challengeOk) {
          send(res, 400, { error: "invalid_grant" });
          return true;
        }
        send(res, 200, issueTokens(c.clientId));
        return true;
      }
      if (p.grant_type === "refresh_token") {
        const h = sha(p.refresh_token || "");
        const r = db.refresh[h];
        if (!r || r.exp < nowS() || (p.client_id && p.client_id !== r.clientId) || !db.clients[r.clientId]) {
          send(res, 400, { error: "invalid_grant" });
          return true;
        }
        delete db.refresh[h]; // Rotation: alter Refresh-Token wird ungültig
        send(res, 200, issueTokens(r.clientId));
        return true;
      }
      send(res, 400, { error: "unsupported_grant_type" });
      return true;
    }

    return false;
  }

  /** Alle Freigaben widerrufen (z.B. nach Passwortwechsel). */
  function revokeAll() {
    db = { clients: {}, access: {}, refresh: {} };
    save();
  }

  return {
    handle,
    verifyAccessToken,
    revokeAll,
    wwwAuthenticate: `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    publicPaths: [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/authorize",
      "/token",
      "/register",
    ],
  };
}
