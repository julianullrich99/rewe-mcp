// Gemeinsame Teile für server.js (stdio) und http-server.js (Netzwerk):
// WebSocket-Brücke zur Chrome-Extension und die MCP-Tool-Definitionen.
import { timingSafeEqual, createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createShop } from "./shop.js";

export const log = (...a) => console.error("[rewe-mcp]", ...a); // stdout gehört bei stdio dem MCP-Protokoll

const TIMEOUT_MS = 90_000;
const AUTH_TIMEOUT_MS = 5_000;

// Passwortvergleich in konstanter Zeit
export function checkPassword(given, expected) {
  const h = (s) => createHash("sha256").update(String(s ?? "")).digest();
  return timingSafeEqual(h(given), h(expected));
}

/**
 * Hängt einen WebSocket-Endpunkt /ext an einen HTTP-Server.
 * Ist ein Passwort gesetzt, muss die Extension als erste Nachricht {type:"auth", password} senden.
 */
export function createBridge(httpServer, { password } = {}) {
  let extension = null;
  let nextId = 1;
  const pending = new Map();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://x").pathname;
    const origin = req.headers.origin || "";
    if (path !== "/ext" || !origin.startsWith("chrome-extension://")) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  function accept(socket) {
    if (extension && extension !== socket) extension.close(4000, "ersetzt durch neue Verbindung");
    extension = socket;
    socket.send(JSON.stringify({ type: "auth-ok" }));
    log("Extension verbunden");
  }

  wss.on("connection", (socket) => {
    let authed = !password;
    if (authed) accept(socket);
    const authTimer = authed
      ? null
      : setTimeout(() => socket.close(4001, "Anmeldung fehlt"), AUTH_TIMEOUT_MS);

    socket.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "auth") {
        if (authed) return;
        if (checkPassword(msg.password, password)) {
          authed = true;
          clearTimeout(authTimer);
          accept(socket);
        } else {
          log("Extension mit falschem Passwort abgewiesen");
          socket.close(4003, "Falsches Passwort");
        }
        return;
      }
      if (!authed) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (extension === socket) {
        extension = null;
        log("Extension getrennt");
      }
    });
  });

  // Hält den Service Worker der Extension wach
  setInterval(() => extension?.send(JSON.stringify({ type: "ping" })), 20_000).unref();

  function callExtension(method, params) {
    if (!extension || extension.readyState !== 1) {
      return Promise.reject(
        new Error(
          "Chrome-Extension ist nicht verbunden. Ist Chrome offen, die Extension 'REWE Kilopreis-Sortierung' aktiv " +
            "und in ihren Optionen die richtige Server-Adresse samt Passwort eingetragen? " +
            "(Verbindung kann nach dem Start bis zu 30 Sekunden dauern.)"
        )
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Zeitüberschreitung bei der Anfrage an den REWE-Tab"));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      extension.send(JSON.stringify({ id, method, params }));
    });
  }

  return { callExtension, isConnected: () => !!extension };
}

const MAX_QUANTITY = 50;

export function registerTools(server, callExtension, { loginStatus } = {}) {
  const shop = createShop(callExtension, { loginUrl: loginStatus?.loginUrl });
  const run = async (fn, args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Fehler: ${e.message}` }], isError: true };
    }
  };

  server.registerTool(
    "rewe_search_products",
    {
      title: "REWE-Produkte suchen",
      description:
        "Sucht Produkte im REWE Onlineshop (Markt aus der Chrome-Sitzung des Nutzers). " +
        "Pro Produkt: productId, title, priceEur, regularPriceEur (nur bei Angeboten), offer, grammage, " +
        "unitPriceEur/unitBase (Grundpreis €/kg bzw. €/l), available (im Markt bestellbar). " +
        "Standardmäßig nach dem günstigsten Grundpreis sortiert.",
      inputSchema: {
        query: z.string().min(1).describe("Suchbegriff, z.B. 'Spaghetti' oder 'Vollmilch'"),
        sort: z
          .enum(["unit_price", "price", "relevance"])
          .default("unit_price")
          .describe("unit_price = günstigster €/kg zuerst, price = günstigster Stückpreis, relevance = REWE-Reihenfolge"),
        limit: z.number().int().min(1).max(50).default(15).describe("Max. Anzahl zurückgegebener Produkte"),
        pages: z.number().int().min(1).max(15).default(3).describe("Wie viele Ergebnisseiten (à ~40 Produkte) durchsucht werden"),
        onlyOffers: z.boolean().default(false).describe("Nur Angebote zurückgeben"),
      },
    },
    (args) => run(shop.search, args)
  );

  server.registerTool(
    "rewe_get_product",
    {
      title: "REWE-Produktdetails",
      description: "Prüft ein Produkt anhand der productId (Titel, ob im gewählten Markt gelistet).",
      inputSchema: { productId: z.string().describe("productId aus rewe_search_products") },
    },
    (args) => run(shop.product, args)
  );

  server.registerTool(
    "rewe_get_cart",
    {
      title: "REWE-Warenkorb anzeigen",
      description:
        "Aktueller Warenkorb: Artikel sowie subtotalEur (Warenwert), depositEur (Pfand), serviceFeeEur, totalEur, " +
        "minimumOrderValueEur und missingToMinimumEur (0 = Mindestbestellwert erreicht).",
      inputSchema: {},
    },
    () => run(shop.cart, {})
  );

  server.registerTool(
    "rewe_add_to_cart",
    {
      title: "In den REWE-Warenkorb legen",
      description: "Legt ein Produkt in den Warenkorb (erhöht die vorhandene Menge). Es wird nichts bestellt oder bezahlt.",
      inputSchema: {
        productId: z.string().describe("productId aus rewe_search_products"),
        quantity: z.number().int().min(1).max(MAX_QUANTITY).default(1).describe("Wie viele Stück hinzufügen"),
      },
    },
    (args) => run(shop.addToCart, args)
  );

  server.registerTool(
    "rewe_set_cart_quantity",
    {
      title: "Menge im REWE-Warenkorb setzen",
      description: "Setzt die Menge eines Produkts im Warenkorb auf einen festen Wert. 0 entfernt das Produkt.",
      inputSchema: {
        productId: z.string().describe("productId des Produkts"),
        quantity: z.number().int().min(0).max(MAX_QUANTITY).describe("Neue Menge (0 = entfernen)"),
      },
    },
    (args) => run(shop.setQuantity, args)
  );

  server.registerTool(
    "rewe_get_order_history",
    {
      title: "REWE-Bestellhistorie",
      description:
        "Bisherige Online-Bestellungen, neueste zuerst: orderId, orderDate, pickupTime, status, totalEur, itemCount, previewTitles.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe("Wie viele Bestellungen zurückgeben"),
        offset: z.number().int().min(0).default(0).describe("Wie viele Bestellungen überspringen (zum Blättern)"),
      },
    },
    (args) => run(shop.orderHistory, args)
  );

  server.registerTool(
    "rewe_get_order",
    {
      title: "REWE-Bestellung im Detail",
      description:
        "Alle Produkte einer Bestellung mit quantity (bestellt), deliveredQuantity (geliefert; 0 = nicht geliefert), " +
        "deliveredWeightG (bei Gewichtsware), unitPriceEur und totalPriceEur.",
      inputSchema: { orderId: z.string().describe("Bestell-ID aus rewe_get_order_history, z.B. B-ABC-DEF-GHI") },
    },
    (args) => run(shop.order, args)
  );

  server.registerTool(
    "rewe_get_frequent_products",
    {
      title: "Häufig gekaufte REWE-Produkte",
      description:
        "Wertet die letzten Bestellungen aus und listet Produkte nach Häufigkeit (orderCount, totalQuantity, lastOrdered, " +
        "lastUnitPriceEur). Ideal für 'das Übliche nachkaufen'. Auch nicht gelieferte Positionen zählen.",
      inputSchema: {
        orders: z.number().int().min(1).max(30).default(10).describe("Wie viele der letzten Bestellungen auswerten"),
        limit: z.number().int().min(1).max(100).default(30).describe("Max. Anzahl Produkte"),
      },
    },
    (args) => run(shop.frequentProducts, args)
  );

  server.registerTool(
    "rewe_get_pickup_slots",
    {
      title: "REWE-Abholzeitfenster",
      description: "Freie Abholzeitfenster im gewählten Markt (nur lesend, keine Buchung): start, end, cutoffTime, available, feeEur.",
      inputSchema: { days: z.number().int().min(1).max(14).default(3).describe("Für wie viele Tage ab heute") },
    },
    (args) => run(shop.pickupSlots, args)
  );

  if (loginStatus) {
    server.registerTool(
      "rewe_login_status",
      {
        title: "REWE-Anmeldestatus",
        description:
          "Prüft, ob der Server bei REWE angemeldet ist. Falls nicht, muss sich der Nutzer einmal im Server-Browser " +
          "anmelden (Link in loginUrl, inkl. E-Mail-Code). Danach hält der Server die Anmeldung aktiv.",
        inputSchema: {},
      },
      () =>
        run(async () => {
          await loginStatus.checkNow?.();
          const { mode, loggedIn, lastCheck, since, loginUrl, error } = loginStatus;
          if (mode === "login")
            return {
              loggedIn: false,
              loginUrl,
              todo: "Im Chrome unter loginUrl bei REWE anmelden (Cloudflare-Prüfung, E-Mail-Code) und danach das Chrome-Fenster schließen.",
            };
          return { loggedIn, since, lastCheck, loginUrl: loggedIn ? undefined : loginUrl, error };
        }, {})
    );
  }
}

/**
 * Hält die REWE-Anmeldung aktiv: REWEs Zugangs-Token (Cookie "rstp") gilt nur 10 Minuten und wird
 * beim Seitenaufruf über die Login-Sitzung erneuert. Diese verfällt bei Inaktivität – deshalb
 * regelmäßig die Shop-Startseite laden und dabei den Anmeldestatus protokollieren.
 */
export function startKeepAlive(bridge, { intervalMin = 4 } = {}) {
  const status = { loggedIn: null, lastCheck: null, since: null, changes: [] };

  async function check() {
    if (!bridge.isConnected()) return;
    try {
      const res = await bridge.callExtension("fetch", { path: "/shop/", headers: { accept: "text/html" } });
      const uuid = res.body.match(/window\.ReweBasket\.customerUuid\s*=\s*'([^']*)'/)?.[1];
      const loggedIn = !!uuid;
      const now = new Date().toISOString();
      if (loggedIn !== status.loggedIn) {
        status.changes = [...status.changes, { at: now, loggedIn }].slice(-20);
        status.since = now;
        log(`REWE-Anmeldung: ${loggedIn ? "aktiv" : "NICHT angemeldet"}`);
      }
      status.loggedIn = loggedIn;
      status.lastCheck = now;
    } catch (e) {
      log("Keepalive-Fehler:", e.message);
    }
  }

  status.checkNow = check;
  setTimeout(check, 15_000);
  setInterval(check, intervalMin * 60_000);
  return status;
}
