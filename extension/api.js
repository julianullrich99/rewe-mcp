// Führt Anfragen des MCP-Servers im REWE-Tab aus, damit sie mit der Sitzung des
// Nutzers (Login, gewählter Markt) laufen. Die Auswertung passiert auf dem Server –
// so muss die Extension bei neuen Funktionen nicht neu geladen werden.
(() => {
  "use strict";

  const ALLOWED_PATH = /^\/shop\//; // nur Shop-Seiten und -Schnittstellen von rewe.de
  const MAX_BODY = 8_000_000;

  async function shopFetch({ path, method = "GET", headers = {}, body } = {}) {
    if (typeof path !== "string" || !ALLOWED_PATH.test(path)) throw new Error(`Pfad nicht erlaubt: ${path}`);
    const res = await fetch(path, {
      method,
      headers,
      body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      credentials: "include",
    });
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error(`Antwort zu groß (${text.length} Zeichen)`);
    return { status: res.status, ok: res.ok, url: res.url, contentType: res.headers.get("content-type"), body: text };
  }

  const HANDLERS = { fetch: shopFetch };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.rkpApi) return;
    const fn = HANDLERS[msg.rkpApi];
    if (!fn) {
      sendResponse({ ok: false, error: `Unbekannte Methode ${msg.rkpApi} – bitte Extension aktualisieren` });
      return;
    }
    fn(msg.params || {}).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true; // asynchrone Antwort
  });
})();
