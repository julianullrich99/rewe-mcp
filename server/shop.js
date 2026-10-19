// REWE-Shop-Logik. Alle Anfragen laufen über die Extension (shopFetch) im REWE-Tab des Nutzers;
// hier wird nur ausgewertet und in kompakte, lesbare Antworten übersetzt.
import { parse } from "node-html-parser";

const BASKET_HEADERS = {
  pragma: "no-cache",
  "cache-control": "no-cache",
  "content-type": "application/json",
  accept: "application/vnd.com.rewe.digital.basket-v2+json",
  "x-application-id": "rewe-basket",
  "x-origin": "AddToBasketV2",
};
const JSON_HEADERS = { accept: "application/json", "cache-control": "no-cache" };
const TZ = "Europe/Berlin";

// ---------- Helfer ----------

export const eur = (cents) => (typeof cents === "number" && isFinite(cents) ? Math.round(cents) / 100 : null);

const berlin = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "202608241759" → "2026-08-24T17:59"; ISO-Zeitstempel mit Zone → Berliner Ortszeit */
export function isoDate(v) {
  if (v == null || v === "") return null;
  const s = String(v);
  const m = typeof v === "string" && s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : s);
  if (isNaN(d)) return s;
  return berlin.format(d).replace(" ", "T");
}

const num = (s) => parseFloat(String(s).replace(/\./g, "").replace(",", "."));

function parseJson(res, what) {
  try {
    return res.body ? JSON.parse(res.body) : null;
  } catch {
    throw new Error(`${what}: unerwartete Antwort (HTTP ${res.status})`);
  }
}

export function createShop(callExtension, { loginUrl } = {}) {
  const loginHint = loginUrl
    ? `bitte im Server-Browser unter ${loginUrl} bei REWE anmelden (E-Mail-Code).`
    : "bitte im Chrome bei rewe.de einloggen.";
  const shopFetch = (path, opts = {}) => callExtension("fetch", { path, ...opts });

  async function getJson(path, what, headers = JSON_HEADERS) {
    const res = await shopFetch(path, { headers });
    if (res.status === 400 && /no-users-details/.test(res.body)) {
      throw new Error(`Nicht bei REWE angemeldet – ${loginHint}`);
    }
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
    return parseJson(res, what);
  }

  async function getHtml(path) {
    const res = await shopFetch(path, { headers: { accept: "text/html" } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.body;
  }

  // ---------- Suche ----------

  const UNIT = {
    kg: { f: 1, base: "kg" },
    g: { f: 0.001, base: "kg" },
    l: { f: 1, base: "l" },
    ml: { f: 0.001, base: "l" },
    cl: { f: 0.01, base: "l" },
  };

  function basePriceFromText(text) {
    const m = text.match(/(\d+(?:[.,]\d+)?)?\s*(kg|g|ml|cl|l)\s*=\s*(\d+(?:[.,]\d+)?)\s*€/i);
    if (!m) return null;
    const unit = UNIT[m[2].toLowerCase()];
    const qty = (m[1] ? num(m[1]) : 1) * unit.f;
    const price = num(m[3]);
    return qty && isFinite(price) ? { value: price / qty, base: unit.base } : null;
  }

  function quantityFromTitle(title) {
    const multi = title.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
    if (multi) {
      const u = UNIT[multi[3].toLowerCase()];
      return { qty: num(multi[1]) * num(multi[2]) * u.f, base: u.base };
    }
    const single = title.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
    if (single) {
      const u = UNIT[single[2].toLowerCase()];
      return { qty: num(single[1]) * u.f, base: u.base };
    }
    return null;
  }

  const euroAmounts = (text) => [...(text || "").matchAll(/(\d+(?:[.,]\d{2}))\s*€/g)].map((m) => num(m[1]));
  const text = (el) => (el ? el.text.replace(/\s+/g, " ").trim() : null);

  function parseTile(tile) {
    const id = tile.id.match(/(\d+)$/)?.[1] ?? tile.id;
    const title = text(tile.querySelector('[id$="-title"]')) || "";
    const priceArea = tile.querySelector('[id$="-price"]');
    const grammage = text(tile.querySelector('[id$="-grammage"]'));
    const offer = text(tile.querySelector('[id$="-discount-text"]'));
    const link = tile.querySelector("a[href*='/shop/p/']")?.getAttribute("href");

    let tracking = {};
    try {
      tracking = JSON.parse(tile.querySelector('script[data-tracking-type="product"]')?.text || "{}");
    } catch {}

    // Aktueller Preis: Tracking-Daten, sonst kleinster €-Betrag im Preisbereich
    const amounts = euroAmounts(priceArea?.text);
    const trackedPrice = parseFloat(tracking.price);
    const priceEur = isFinite(trackedPrice) ? trackedPrice : amounts.length ? Math.min(...amounts) : null;
    // Angebot: Kachel zeigt "bis TT.MM.JJJJ" (discount-text) bzw. Tracking discount=true.
    // Den Normalpreis enthält die Kachel nicht – er wird für Angebote von der Produktseite nachgeladen.
    const isOffer = tracking.discount === true || !!offer;

    // Grundpreis: "(1 kg = 3,98 €)"; bei 1-l/1-kg-Packungen zeigt REWE nur "1l" → Menge aus Grammatur/Titel
    let unit = (grammage && basePriceFromText(grammage)) || basePriceFromText(tile.text);
    if (!unit && priceEur != null) {
      const q = (grammage && quantityFromTitle(grammage)) || quantityFromTitle(title);
      if (q && q.qty > 0) unit = { value: priceEur / q.qty, base: q.base };
    }

    // REWE meldet in den Tracking-Daten immer availability "unknown". Bestellbar ist ein Produkt,
    // wenn die Kachel einen Preis, eine Listing-ID und einen Warenkorb-Button hat.
    const available =
      priceEur != null &&
      !!tile.querySelector('input[name="listingId"]') &&
      !!tile.querySelector('[id$="-basket"]') &&
      !/nicht (mehr )?(verfügbar|lieferbar)|ausverkauft/i.test(tile.text);

    return {
      productId: id,
      title,
      priceEur,
      offer: isOffer ? offer || "Angebot" : undefined,
      grammage,
      unitPriceEur: unit ? Math.round(unit.value * 100) / 100 : null,
      unitBase: unit?.base ?? null,
      available,
      url: link ? `https://www.rewe.de${link}` : null,
    };
  }

  // Preisdaten von der Produktseite (Normalpreis, Rabatt, Gültigkeit, Bestelllimit)
  async function productData(productId) {
    const html = await getHtml(`/shop/p/x/${encodeURIComponent(productId)}`);
    const store = parse(html).querySelector('script[id^="pdpr-propstore"]');
    if (!store) throw new Error(`Produkt ${productId} nicht gefunden`);
    return JSON.parse(store.text).productData || {};
  }

  async function withOfferDetails(products) {
    const offers = products.filter((p) => p.offer);
    for (let i = 0; i < offers.length; i += 4) {
      await Promise.all(
        offers.slice(i, i + 4).map(async (p) => {
          try {
            const pricing = (await productData(p.productId)).pricing || {};
            if (pricing.regularPrice > (pricing.price ?? 0)) p.regularPriceEur = eur(pricing.regularPrice);
            if (pricing.discount?.rate) p.discountPercent = pricing.discount.rate;
          } catch {
            // Normalpreis ist ein Zusatz – Suche nicht deswegen scheitern lassen
          }
        })
      );
    }
    return products;
  }

  function lastPage(root) {
    let max = 1;
    for (const el of root.querySelectorAll(".plr-pagination-item")) {
      const n = parseInt((el.getAttribute("aria-label") || "").replace(/\D/g, ""), 10);
      if (n > max) max = n;
    }
    return max;
  }

  const TILE_SELECTOR = 'ul.plrProductGrid > li > div[id^="plr-"][class*="product-tile"]';

  async function search({ query, sort = "unit_price", limit = 15, pages = 3, onlyOffers = false }) {
    // Bei Preissortierung REWE vorsortieren lassen, damit günstige Produkte schon auf den
    // ersten Seiten liegen (nach Relevanz landen z.B. ja!-Produkte oft erst auf Seite 2+).
    const sorting = sort === "relevance" ? "" : "&sorting=PRICE_ASC";
    const url = (p) =>
      `/shop/productList?search=${encodeURIComponent(query)}${sorting}${p > 1 ? `&page=${p}` : ""}`;
    const first = parse(await getHtml(url(1)));
    const total = lastPage(first);
    const more = [];
    for (let p = 2; p <= Math.min(total, pages); p++) more.push(getHtml(url(p)).then(parse));
    const roots = [first, ...(await Promise.all(more))];

    const seen = new Set();
    let products = [];
    for (const root of roots) {
      for (const tile of root.querySelectorAll(TILE_SELECTOR)) {
        const p = parseTile(tile);
        if (seen.has(p.productId)) continue;
        seen.add(p.productId);
        products.push(p);
      }
    }

    if (products.length && !products.some((p) => p.priceEur != null)) {
      throw new Error(
        `REWE zeigt keine Preise an – kein Markt aktiv oder Sitzung abgelaufen: ${loginHint}`
      );
    }

    if (onlyOffers) products = products.filter((p) => p.offer);
    const cmp = (key) => (a, b) => (a[key] == null ? (b[key] == null ? 0 : 1) : b[key] == null ? -1 : a[key] - b[key]);
    if (sort === "unit_price") products.sort(cmp("unitPriceEur"));
    else if (sort === "price") products.sort(cmp("priceEur"));

    return {
      query,
      pagesScanned: roots.length,
      pagesTotal: total,
      productsFound: products.length,
      products: await withOfferDetails(products.slice(0, limit)),
    };
  }

  // ---------- Produkt ----------

  async function product({ productId }) {
    const data = await productData(productId);
    if (!data.listingId) throw new Error(`Produkt ${productId} ist im gewählten Markt nicht verfügbar`);
    return {
      productId: data.productId,
      title: data.productName,
      listingId: data.listingId,
      marketCode: data.marketCode,
      serviceType: data.storeServiceType,
      url: `https://www.rewe.de/shop/p/${data.slug || "x"}/${data.productId}`,
    };
  }

  // ---------- Warenkorb ----------

  async function basketState() {
    const html = await getHtml("/shop/");
    const id = html.match(/window\.ReweBasket\.id\s*=\s*'([^']*)'/)?.[1] || null;
    return { id };
  }

  async function basketRequest(path, method, body) {
    const res = await shopFetch(path, { method, headers: BASKET_HEADERS, body });
    if (!res.ok) {
      let detail = res.body.slice(0, 300);
      try {
        const j = JSON.parse(res.body);
        detail = j.message || j.violations?.[0]?.message || detail;
      } catch {}
      throw new Error(`REWE-Warenkorb: HTTP ${res.status} ${detail}`);
    }
    return res.body ? parseJson(res, "Warenkorb") : null;
  }

  // Aufbau laut REWE (basket-v2): Summen unter summary, Mindestbestellwert unter
  // serviceConfiguration, Pfand je Artikel unter product.listing.totalRefundPrice.
  function summarizeBasket(b) {
    const s = b.summary || {};
    const items = (b.lineItems || []).map((li) => ({
      productId: li.product?.productId,
      title: li.product?.title,
      quantity: li.quantity,
      unitPriceEur: eur(li.price),
      totalPriceEur: eur(li.totalPrice),
    }));
    const deposit = (b.lineItems || []).reduce(
      (sum, li) => sum + (li.product?.listing?.totalRefundPrice || 0) * (li.quantity || 0),
      0
    );
    const subtotal = s.articlePrice;
    const serviceFee =
      typeof s.totalPrice === "number" && typeof s.totalPriceExclServiceFee === "number"
        ? s.totalPrice - s.totalPriceExclServiceFee
        : 0;
    // Gesamt = Warenwert + Pfand + Servicegebühr (REWE weist das Pfand nicht in totalPrice aus)
    const total = (subtotal ?? 0) + deposit + serviceFee;
    const minimum = b.serviceConfiguration?.minimumOrderAmount;
    const fees = s.fees || {};
    return {
      itemCount: s.totalArticleQuantity ?? items.reduce((n, i) => n + (i.quantity || 0), 0),
      subtotalEur: eur(subtotal),
      depositEur: eur(deposit),
      serviceFeeEur: eur(serviceFee),
      totalEur: eur(total),
      minimumOrderValueEur: eur(minimum ?? 0),
      missingToMinimumEur: eur(Math.max(0, (minimum ?? 0) - (subtotal ?? 0))),
      // Vorab reservierte Beträge (z.B. Transportbox, Ersatzartikel) – keine Kosten, nur Kartenreservierung
      reservedFeesEur: Object.keys(fees).length
        ? Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, eur(v)]))
        : undefined,
      reservationTotalEur: eur(s.reservationTotal) ?? undefined,
      freePackingFromEur: eur(b.staggerings?.nextStaggering?.articlePriceThreshold) ?? undefined,
      timeSlot: b.timeSlotInformation?.timeSlotText,
      items,
    };
  }

  async function rawBasket() {
    const { id } = await basketState();
    if (!id) return null;
    return basketRequest(`/shop/api/baskets/${id}?includeTimeslot=false`, "GET");
  }

  async function cart() {
    const b = await rawBasket();
    if (!b) return { items: [], note: `Kein Warenkorb gefunden – ${loginHint}` };
    return summarizeBasket(b);
  }

  async function setQuantity({ productId, quantity }) {
    const p = await product({ productId });
    let b;
    if (quantity <= 0) {
      const { id } = await basketState();
      if (!id) throw new Error("Kein Warenkorb vorhanden");
      b = await basketRequest(`/shop/api/baskets/${id}/listings/${p.listingId}`, "DELETE");
    } else {
      b = await basketRequest(`/shop/api/baskets/listings/${p.listingId}`, "POST", { quantity, includeTimeslot: false });
    }
    const basket = b?.lineItems ? summarizeBasket(b) : await cart();
    return { productId: p.productId, title: p.title, quantity, cart: basket };
  }

  async function addToCart({ productId, quantity = 1 }) {
    const b = await rawBasket();
    const line = (b?.lineItems || []).find((li) => String(li.product?.productId) === String(productId));
    return setQuantity({ productId, quantity: (line?.quantity || 0) + quantity });
  }

  // ---------- Bestellungen ----------

  async function rawHistory() {
    const data = await getJson("/shop/api/orders", "REWE-Bestellungen");
    const list = Array.isArray(data) ? data : data?.orders || Object.values(data || {}).find(Array.isArray) || [];
    return [...list].sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)));
  }

  function historyEntry(o) {
    const sub = o.subOrders?.[0] || {};
    return {
      orderId: o.orderId,
      orderDate: isoDate(o.orderDate),
      pickupTime: isoDate(sub.handoverTime),
      status: o.status,
      totalEur: eur(sub.bonValue),
      itemCount: sub.lineitemCount,
      previewTitles: sub.lineItemTitles,
    };
  }

  async function orderHistory({ limit = 10, offset = 0 }) {
    const list = await rawHistory();
    return { total: list.length, offset, orders: list.slice(offset, offset + limit).map(historyEntry) };
  }

  function orderItem(li) {
    const weight = li.volumeCode === "KGG";
    const actual = typeof li.actualAmount === "number" ? li.actualAmount : null;
    return {
      productId: li.productId,
      title: li.title,
      category: li.category?.name ?? null,
      quantity: li.quantity,
      deliveredQuantity: actual == null ? null : weight ? (actual > 0 ? li.quantity : 0) : actual,
      deliveredWeightG: weight ? actual : null,
      unitPriceEur: eur(li.price),
      totalPriceEur: eur(typeof li.actualTotalPrice === "number" ? li.actualTotalPrice : li.totalPrice),
    };
  }

  async function order({ orderId }, historyCache) {
    const data = await getJson(`/shop/api/orders/${encodeURIComponent(orderId)}`, "REWE-Bestellung");
    const subs = data.subOrders || [];
    const sub = subs[0] || {};
    let bonValue = sub.bonValue;
    let handover = sub.handoverTime;
    if (bonValue == null || handover == null) {
      const h = (historyCache || (await rawHistory())).find((o) => o.orderId === orderId)?.subOrders?.[0];
      bonValue ??= h?.bonValue;
      handover ??= h?.handoverTime;
    }
    const items = subs
      .flatMap((s) => s.lineItems || [])
      .filter((li) => li.lineItemType === "PRODUCT")
      .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))
      .map(orderItem);
    return {
      orderId: data.orderId ?? orderId,
      orderDate: isoDate(data.orderDate),
      pickupTime: isoDate(handover),
      status: data.status,
      totalEur: eur(bonValue),
      itemCount: items.length,
      items,
    };
  }

  async function frequentProducts({ orders = 10, limit = 30 }) {
    const history = await rawHistory();
    const recent = history.slice(0, orders);
    // Höchstens 4 Bestellungen gleichzeitig laden
    const details = [];
    for (let i = 0; i < recent.length; i += 4) {
      details.push(...(await Promise.all(recent.slice(i, i + 4).map((o) => order({ orderId: o.orderId }, history)))));
    }
    const byId = new Map();
    for (const o of details) {
      const seenInOrder = new Set();
      for (const it of o.items) {
        const p = byId.get(it.productId) || {
          productId: it.productId,
          title: it.title,
          category: it.category,
          orderCount: 0,
          totalQuantity: 0,
          lastOrdered: null,
          lastUnitPriceEur: null,
        };
        if (!seenInOrder.has(it.productId)) {
          p.orderCount++;
          seenInOrder.add(it.productId);
        }
        p.totalQuantity += it.quantity || 0;
        if (!p.lastOrdered || (o.orderDate && o.orderDate > p.lastOrdered)) {
          p.lastOrdered = o.orderDate;
          p.lastUnitPriceEur = it.unitPriceEur;
          p.title = it.title;
          p.category = it.category; // REWE benennt Kategorien gelegentlich um → neueste Bezeichnung
        }
        byId.set(it.productId, p);
      }
    }
    const products = [...byId.values()].sort(
      (a, b) => b.orderCount - a.orderCount || String(b.lastOrdered).localeCompare(String(a.lastOrdered))
    );
    return { ordersAnalyzed: details.length, products: products.slice(0, limit) };
  }

  // ---------- Abholzeitfenster ----------

  // REWE liefert hier nur buchbare Fenster: {id, startTime, endTime (UTC), selected, serviceFee, labels}.
  // Eine Bestellfrist (cutoffTime) ist in dieser Schnittstelle nicht enthalten.
  async function pickupSlots({ days = 3 }) {
    const data = await getJson("/shop/api/timeslots/pickup/checkout", "REWE-Abholzeiten");
    const list = Array.isArray(data) ? data : [];
    // Ganze Kalendertage (Berliner Zeit): heute + die nächsten `days` Tage
    const lastDay = isoDate(Date.now() + days * 24 * 3600 * 1000).slice(0, 10);
    const slots = list
      .map((s) => ({
        start: isoDate(s.startTime),
        end: isoDate(s.endTime),
        available: true,
        feeEur: eur(s.serviceFee),
        selected: s.selected || undefined,
        labels: s.labels?.length ? s.labels : undefined,
      }))
      .filter((s) => s.start && s.start.slice(0, 10) <= lastDay);
    return { days, untilDate: lastDay, note: "REWE nennt keine Bestellfrist; die Liste enthält nur buchbare Fenster.", slots };
  }

  return { search, product, cart, addToCart, setQuantity, orderHistory, order, frequentProducts, pickupSlots, shopFetch };
}
