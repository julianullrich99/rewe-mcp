(() => {
  "use strict";

  const GRID_SELECTOR = "ul.plrProductGrid";
  const TILE = 'div[id^="plr-"][class*="product-tile"]';
  const TILE_SELECTOR = ':scope > li > ' + TILE;
  const DEFAULTS = { mode: "all", maxPages: 30 };
  const CONCURRENCY = 4;

  let settings = { ...DEFAULTS };
  let runId = 0;
  let panel = null;

  // ---------- Preis-Parsing ----------

  const num = (s) => parseFloat(String(s).replace(/\./g, "").replace(",", "."));

  // Faktor, um eine Mengenangabe in kg bzw. l umzurechnen
  const UNIT = {
    kg: { f: 1, base: "kg" },
    g: { f: 0.001, base: "kg" },
    l: { f: 1, base: "l" },
    ml: { f: 0.001, base: "l" },
    cl: { f: 0.01, base: "l" },
  };

  // Grundpreis direkt aus dem Text, z.B. "500g (1 kg = 3,98 €)" oder "100 g = 1,29 €"
  function parseBasePrice(text) {
    const re = /(\d+(?:[.,]\d+)?)?\s*(kg|g|ml|cl|l)\s*=\s*(\d+(?:[.,]\d+)?)\s*€/i;
    const m = text.match(re);
    if (!m) return null;
    const unit = UNIT[m[2].toLowerCase()];
    const qty = (m[1] ? num(m[1]) : 1) * unit.f;
    const price = num(m[3]);
    if (!qty || !isFinite(price)) return null;
    return { value: price / qty, base: unit.base };
  }

  // Menge aus dem Produktnamen, z.B. "Paprika rot 500g", "Wasser 6x1,5l"
  function parseQuantity(title) {
    const multi = title.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
    if (multi) {
      const unit = UNIT[multi[3].toLowerCase()];
      return { qty: num(multi[1]) * num(multi[2]) * unit.f, base: unit.base };
    }
    const single = title.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
    if (single) {
      const unit = UNIT[single[2].toLowerCase()];
      return { qty: num(single[1]) * unit.f, base: unit.base };
    }
    return null;
  }

  function parsePrice(text) {
    const prices = [...text.matchAll(/(\d+(?:[.,]\d{2}))\s*€/g)].map((m) => num(m[1]));
    return prices.length ? Math.min(...prices) : null;
  }

  function unitPriceOf(tile) {
    const grammage = tile.querySelector('[id$="-grammage"]');
    const priceEl = tile.querySelector('[id$="-price"]');
    const titleEl = tile.querySelector('[id$="-title"]');

    const direct =
      (grammage && parseBasePrice(grammage.textContent)) ||
      parseBasePrice(tile.textContent);
    if (direct) return direct;

    const price = priceEl ? parsePrice(priceEl.textContent) : null;
    const q = parseQuantity((titleEl || tile).textContent);
    if (price != null && q && q.qty > 0) return { value: price / q.qty, base: q.base };
    return null;
  }

  // Für api.js (gleiche isolierte Content-Script-Welt, für die Seite unsichtbar)
  globalThis.RKP = { TILE, unitPriceOf, parsePrice };

  // ---------- DOM-Helfer ----------

  function productItems(root) {
    const grid = root.querySelector(GRID_SELECTOR);
    if (!grid) return [];
    return [...grid.querySelectorAll(TILE_SELECTOR)].map((tile) => tile.parentElement);
  }

  function productId(li) {
    const tile = li.querySelector(TILE);
    const m = tile && tile.id.match(/-(\d+)$/);
    return m ? m[1] : tile ? tile.id : Math.random().toString();
  }

  function totalPages(doc) {
    let max = 1;
    doc.querySelectorAll(".plr-pagination-item[aria-label^='Seite ']").forEach((el) => {
      const n = parseInt(el.getAttribute("aria-label").replace(/\D/g, ""), 10);
      if (n > max) max = n;
    });
    return max;
  }

  function currentPage() {
    return parseInt(new URL(location.href).searchParams.get("page") || "1", 10);
  }

  function pageUrl(n) {
    const u = new URL(location.href);
    u.searchParams.set("page", String(n));
    return u.toString();
  }

  function formatEuro(v) {
    return v.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
  }

  function annotate(li, up) {
    li.querySelector(".rkp-badge")?.remove();
    const tile = li.querySelector(TILE);
    if (!tile) return;
    const badge = document.createElement("div");
    badge.className = "rkp-badge" + (up ? "" : " rkp-badge--none");
    badge.textContent = up ? `${formatEuro(up.value)} / ${up.base}` : "kein Grundpreis";
    tile.prepend(badge);
  }

  // ---------- Sortieren ----------

  function sortAndRender(grid, items) {
    const scored = items.map((li) => {
      const tile = li.querySelector(TILE);
      return { li, up: unitPriceOf(tile) };
    });
    scored.sort((a, b) => {
      if (!a.up && !b.up) return 0;
      if (!a.up) return 1;
      if (!b.up) return -1;
      return a.up.value - b.up.value;
    });

    const others = [...grid.children].filter((li) => !items.includes(li));
    const frag = document.createDocumentFragment();
    for (const { li, up } of scored) {
      annotate(li, up);
      frag.appendChild(li);
    }
    others.forEach((li) => frag.appendChild(li)); // Werbe-/Inspirationskacheln ans Ende
    grid.replaceChildren(frag);

    return scored.filter((s) => s.up).length;
  }

  async function fetchPage(n) {
    const res = await fetch(pageUrl(n), { credentials: "include" });
    if (!res.ok) throw new Error(`Seite ${n}: HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    return productItems(doc).map((li) => document.importNode(li, true));
  }

  async function run() {
    const id = ++runId;
    const grid = document.querySelector(GRID_SELECTOR);
    if (!grid) return;

    if (settings.mode === "off") {
      setStatus("Sortierung aus – Seite neu laden für Originalreihenfolge.");
      return;
    }

    const own = productItems(document);

    if (settings.mode === "page") {
      const n = sortAndRender(grid, own);
      setStatus(`Diese Seite sortiert (${n}/${own.length} mit Grundpreis).`);
      return;
    }

    // mode === "all"
    const pages = totalPages(document);
    const last = Math.min(pages, settings.maxPages);
    const cur = currentPage();
    const todo = [];
    for (let p = 1; p <= last; p++) if (p !== cur) todo.push(p);

    const seen = new Set(own.map(productId));
    const all = [...own];
    let done = 0;
    let failed = 0;
    setStatus(`Lade Seiten… 1/${last}`);

    const queue = [...todo];
    const worker = async () => {
      while (queue.length && id === runId) {
        const p = queue.shift();
        try {
          for (const li of await fetchPage(p)) {
            const pid = productId(li);
            if (!seen.has(pid)) {
              seen.add(pid);
              all.push(li);
            }
          }
        } catch (e) {
          failed++;
          console.warn("[REWE Kilopreis]", e);
        }
        done++;
        if (id === runId) setStatus(`Lade Seiten… ${done + 1}/${last}`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (id !== runId) return;

    const n = sortAndRender(grid, all);
    document.querySelectorAll(".plr-pagination-item").forEach((el) => {
      const nav = el.closest("nav") || el.parentElement;
      if (nav) nav.classList.add("rkp-hidden");
    });

    let msg = `${all.length} Produkte von ${last} Seite(n) sortiert, ${n} mit Grundpreis.`;
    if (pages > last) msg += ` (Limit: ${last} von ${pages} Seiten)`;
    if (failed) msg += ` ${failed} Seite(n) fehlgeschlagen.`;
    setStatus(msg);
  }

  // ---------- UI ----------

  function setStatus(text) {
    if (panel) panel.querySelector(".rkp-status").textContent = text;
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "rkp-panel";
    panel.innerHTML = `
      <div class="rkp-head">
        <strong>€/kg-Sortierung</strong>
        <button class="rkp-toggle" title="Ein-/Ausklappen">–</button>
      </div>
      <div class="rkp-body">
        <label>Modus
          <select class="rkp-mode">
            <option value="all">Alle Seiten</option>
            <option value="page">Nur diese Seite</option>
            <option value="off">Aus</option>
          </select>
        </label>
        <label>Max. Seiten
          <input class="rkp-max" type="number" min="1" max="200" />
        </label>
        <button class="rkp-run">Jetzt sortieren</button>
        <div class="rkp-status"></div>
      </div>`;
    document.body.appendChild(panel);

    const mode = panel.querySelector(".rkp-mode");
    const max = panel.querySelector(".rkp-max");
    mode.value = settings.mode;
    max.value = settings.maxPages;

    mode.addEventListener("change", () => {
      settings.mode = mode.value;
      chrome.storage.local.set({ mode: settings.mode });
      if (settings.mode === "off") location.reload();
      else run();
    });
    max.addEventListener("change", () => {
      settings.maxPages = Math.max(1, parseInt(max.value, 10) || DEFAULTS.maxPages);
      max.value = settings.maxPages;
      chrome.storage.local.set({ maxPages: settings.maxPages });
    });
    panel.querySelector(".rkp-run").addEventListener("click", run);
    panel.querySelector(".rkp-toggle").addEventListener("click", (e) => {
      panel.classList.toggle("rkp-collapsed");
      e.target.textContent = panel.classList.contains("rkp-collapsed") ? "+" : "–";
    });
  }

  // ---------- Start ----------

  function waitForGrid(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const found = document.querySelector(GRID_SELECTOR);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const g = document.querySelector(GRID_SELECTOR);
        if (g) {
          obs.disconnect();
          resolve(g);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  async function init() {
    const grid = await waitForGrid();
    if (!grid) return;
    if (!panel) buildPanel();
    run();
  }

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    init();
  });

  // Falls der Shop clientseitig navigiert: bei URL-Wechsel neu sortieren
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      runId++;
      init();
    }
  }, 1000);
})();
