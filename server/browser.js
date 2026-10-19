// Server-Browser: EIN normaler Chrome läuft dauerhaft im Container (sichtbar per noVNC, Profil im Volume).
// Der Server verbindet sich per Chrome-Debug-Schnittstelle (CDP), um REWE-Anfragen darin auszuführen.
//
// Modi:
//  - "automation": verbunden, Shop-Anfragen laufen über einen eigenen Tab.
//  - "login": Server ist getrennt – Chrome ist dann ein ganz normaler, nicht ferngesteuerter Browser.
//    Der Nutzer meldet sich per noVNC an (Cloudflare-Prüfung, E-Mail-Code) und klickt im Tab
//    "Fertig" (http://127.0.0.1:<port>/login/done). Danach verbindet sich der Server wieder.
// Chrome wird dabei nie beendet, damit Sitzungs-Cookies (z.B. REWEs "rstp") erhalten bleiben.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { log } from "./lib.js";

const SHOP = "https://www.rewe.de/shop/";
const LOGIN = "https://www.rewe.de/mydata/login";
const ALLOWED_PATH = /^\/shop\//;
const CDP_PORT = 9222;

export async function createBrowserBackend({
  profileDir = process.env.REWE_PROFILE_DIR || "/data/profile",
  chromeBin = process.env.REWE_CHROME_BIN || "google-chrome",
  loginUrl = process.env.REWE_LOGIN_URL || "http://<server>:6080/vnc.html",
  doneUrl = `http://127.0.0.1:${process.env.REWE_MCP_PORT || 47823}/login/done`,
  keepAliveMin = Number(process.env.REWE_KEEPALIVE_MIN || 4),
} = {}) {
  let browser = null; // Playwright-Verbindung (CDP)
  let apiPage = null;
  let mode = "automation";
  let connecting = null;
  const status = { mode, loggedIn: null, lastCheck: null, since: null, loginUrl, changes: [] };

  // ---------- Chrome-Prozess (läuft dauerhaft, wird bei Absturz/Schließen neu gestartet) ----------

  let chromeStarted;
  function startChrome() {
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(profileDir, f), { force: true });
    const proc = spawn(
      chromeBin,
      [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
        "--remote-debugging-address=127.0.0.1",
        "--password-store=basic",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox", // Sandbox ist im Container nicht verfügbar
        "--start-maximized",
        SHOP,
      ],
      { stdio: "ignore" }
    );
    chromeStarted = Date.now();
    proc.on("exit", (code) => {
      log(`Chrome beendet (Code ${code}) – Neustart in 3 s`);
      browser = null;
      apiPage = null;
      setTimeout(startChrome, Date.now() - chromeStarted < 10_000 ? 30_000 : 3_000);
    });
    log("Chrome gestartet");
  }

  async function connect() {
    for (let i = 0; i < 30; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        browser.on("disconnected", () => {
          browser = null;
          apiPage = null;
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("Chrome im Container antwortet nicht");
  }

  async function ensureConnected() {
    if (mode === "login") {
      throw new Error(
        `REWE-Login nötig: bitte unter ${loginUrl} im Chrome anmelden und danach im Tab "Fertig" auf den Knopf klicken.`
      );
    }
    if (!browser) {
      connecting ??= connect().finally(() => (connecting = null));
      await connecting;
    }
  }

  async function getApiPage() {
    await ensureConnected();
    if (!apiPage || apiPage.isClosed()) {
      apiPage = await browser.contexts()[0].newPage();
      await apiPage.goto(SHOP, { waitUntil: "domcontentloaded" });
    }
    if (!apiPage.url().startsWith("https://www.rewe.de/")) await apiPage.goto(SHOP, { waitUntil: "domcontentloaded" });
    const title = await apiPage.title().catch(() => "");
    if (/just a moment|einen moment|attention required/i.test(title)) {
      await startLogin("Cloudflare-Prüfung");
      throw new Error(`Cloudflare-Prüfung aktiv – bitte unter ${loginUrl} bestätigen und danach "Fertig" klicken.`);
    }
    return apiPage;
  }

  // ---------- Login-Modus ----------

  async function startLogin(reason) {
    if (mode === "login") return;
    mode = status.mode = "login";
    log(`Login-Modus (${reason}) – Anmeldung unter ${loginUrl}`);
    try {
      await ensureConnectedRaw();
      const ctx = browser.contexts()[0];
      await apiPage?.close().catch(() => {});
      apiPage = null;
      // Tab 1: REWE-Login, Tab 2: "Fertig"-Knopf. Login-Tab nach vorn.
      const pages = ctx.pages();
      const loginPage = pages[0] || (await ctx.newPage());
      for (const p of pages.slice(1)) await p.close().catch(() => {});
      const donePage = await ctx.newPage();
      await donePage.goto(doneUrl).catch(() => {});
      await loginPage.goto(LOGIN, { waitUntil: "domcontentloaded" }).catch(() => {});
      await loginPage.bringToFront().catch(() => {});
    } catch (e) {
      log("Login-Modus vorbereiten fehlgeschlagen:", e.message);
    }
    // Verbindung trennen: Chrome ist jetzt ein normaler Browser ohne Fernsteuerung
    await browser?.close().catch(() => {});
    browser = null;
  }

  async function ensureConnectedRaw() {
    if (!browser) await connect();
  }

  async function finishLogin() {
    if (mode !== "login") return { loggedIn: status.loggedIn };
    mode = status.mode = "automation";
    log("Nutzer meldet: Login fertig – prüfe Anmeldung");
    await check({ allowLoginMode: false });
    if (!status.loggedIn) await startLogin("Anmeldung nicht erkannt");
    return { loggedIn: status.loggedIn };
  }

  // ---------- Shop-Anfragen ----------

  async function shopFetch({ path, method = "GET", headers = {}, body } = {}) {
    if (typeof path !== "string" || !ALLOWED_PATH.test(path)) throw new Error(`Pfad nicht erlaubt: ${path}`);
    const page = await getApiPage();
    return page.evaluate(
      async ({ path, method, headers, body }) => {
        const res = await fetch(path, {
          method,
          headers,
          body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
          credentials: "include",
        });
        return {
          status: res.status,
          ok: res.ok,
          url: res.url,
          contentType: res.headers.get("content-type"),
          body: await res.text(),
        };
      },
      { path, method, headers, body }
    );
  }

  // ---------- Anmeldung wachhalten ----------
  // REWEs Shop-Token "rstp" gilt nur 10 Minuten und wird beim Seitenaufruf erneuert; die Login-Sitzung
  // dahinter verfällt bei Inaktivität. Deshalb regelmäßig neu laden; fehlt die Anmeldung, zuerst eine
  // stille Anmeldung über die Login-Adresse versuchen (klappt ohne E-Mail-Code, solange "Angemeldet
  // bleiben" gilt), erst danach den Nutzer bitten.

  const readCustomerUuid = (page) =>
    page.evaluate(
      () =>
        document
          .getElementById("basketStateInitialize")
          ?.textContent.match(/window\.ReweBasket\.customerUuid\s*=\s*'([^']*)'/)?.[1] || ""
    );

  async function trySilentLogin(page) {
    try {
      await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    } catch (e) {
      log("Stille Anmeldung: Fehler beim Aufruf:", e.message);
    }
    const u = new URL(page.url());
    log(`Stille Anmeldung endete auf ${u.host}${u.pathname}`);
    await page.goto(SHOP, { waitUntil: "domcontentloaded" });
  }

  async function check({ allowLoginMode = true } = {}) {
    if (mode === "login") return;
    try {
      const page = await getApiPage();
      await page.reload({ waitUntil: "domcontentloaded" });
      let uuid = await readCustomerUuid(page);
      if (!uuid) {
        await trySilentLogin(page);
        uuid = await readCustomerUuid(page);
      }
      const loggedIn = !!uuid;
      const now = new Date().toISOString();
      if (loggedIn !== status.loggedIn) {
        status.changes = [...status.changes, { at: now, loggedIn }].slice(-20);
        status.since = now;
        log(`REWE-Anmeldung: ${loggedIn ? "aktiv" : "NICHT angemeldet"}`);
      }
      status.loggedIn = loggedIn;
      status.lastCheck = now;
      delete status.error;
      if (!loggedIn && allowLoginMode) await startLogin("nicht angemeldet");
    } catch (e) {
      status.lastCheck = new Date().toISOString();
      if (mode !== "login") {
        status.error = e.message;
        log("Keepalive-Fehler:", e.message);
      }
    }
  }

  startChrome();
  status.checkNow = () => check();
  setTimeout(check, 8_000);
  setInterval(check, keepAliveMin * 60_000);

  return {
    callExtension: (method, params) => {
      if (method !== "fetch") return Promise.reject(new Error(`Unbekannte Methode ${method}`));
      return shopFetch(params);
    },
    isConnected: () => mode === "automation",
    status,
    checkNow: () => check(),
    finishLogin,
  };
}
