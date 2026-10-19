// Brücke zwischen MCP-Server (WebSocket) und einem REWE-Tab (Content-Script api.js).
// Server-Adresse und Passwort kommen aus den Optionen der Extension.
const DEFAULT_SETTINGS = { serverUrl: "", password: "" };
const SHOP_URL = "https://www.rewe.de/shop/";

let ws = null;
let reconnectTimer = null;

// "192.168.1.10:47823", "http://…", "https://…" oder "ws://…" → ws(s)://host:port/ext
function toWsUrl(serverUrl) {
  let s = (serverUrl || "").trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = "/ext";
  u.search = "";
  return u.toString();
}

function setStatus(status) {
  chrome.storage.local.set({ connStatus: { status, at: Date.now() } });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const { serverUrl, password } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!serverUrl.trim()) {
    setStatus("Keine Server-Adresse eingetragen");
    return;
  }
  let url;
  try {
    url = toWsUrl(serverUrl);
  } catch {
    setStatus("Ungültige Server-Adresse");
    return;
  }

  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => {
    setStatus("Anmeldung…");
    socket.send(JSON.stringify({ type: "auth", password }));
  };
  socket.onclose = (e) => {
    if (ws === socket) ws = null;
    if (e.code === 4003) setStatus("Falsches Passwort");
    else if (e.code === 4001) setStatus("Passwort fehlt");
    else if (e.code === 4000) setStatus("Von anderem Browser ersetzt");
    else setStatus(`Nicht verbunden (${url})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  };
  socket.onerror = () => {}; // Server nicht erreichbar – wir versuchen es später erneut
  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "ping") return; // hält den Service Worker wach
    if (msg.type === "auth-ok") return setStatus("Verbunden");
    const { id, method, params } = msg;
    try {
      const result = await callShop(method, params);
      socket.send(JSON.stringify({ id, result }));
    } catch (e) {
      socket.send(JSON.stringify({ id, error: String(e?.message || e) }));
    }
  };
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function findOrOpenShopTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.rewe.de/shop/*", "https://www.rewe.de/shop"] });
  const ready = tabs.find((t) => t.status === "complete") || tabs[0];
  if (ready) return ready;

  const tab = await chrome.tabs.create({ url: SHOP_URL, active: false });
  await waitForLoad(tab.id);
  return tab;
}

async function callShop(method, params) {
  const tab = await findOrOpenShopTab();
  let reloaded = false;
  // Content-Script braucht nach dem Laden evtl. einen Moment
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { rkpApi: method, params: params || {} });
      if (!res) throw new Error("Keine Antwort vom REWE-Tab");
      if (!res.ok) throw new Error(res.error);
      return res.result;
    } catch (e) {
      const notReady = /Receiving end does not exist|Could not establish connection/.test(String(e?.message));
      if (!notReady) throw e;
      // Tab war schon vor dem (Neu-)Laden der Extension offen → enthält unsere Skripte nicht
      if (attempt === 2 && !reloaded) {
        reloaded = true;
        const loaded = waitForLoad(tab.id);
        await chrome.tabs.reload(tab.id);
        await loaded;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("REWE-Tab reagiert nicht. Bitte rewe.de/shop öffnen und neu laden.");
}

// Neue Einstellungen → neu verbinden
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.serverUrl || changes.password)) return;
  const old = ws;
  ws = null;
  old?.close();
  connect();
});

chrome.alarms.create("rkp-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
