const $ = (id) => document.getElementById(id);
const DEFAULTS = { serverUrl: "", password: "", connStatus: null };

function showStatus(s) {
  const el = $("status");
  el.textContent = "Status: " + (s?.status || "–");
  el.className = s?.status === "Verbunden" ? "ok" : "";
}

chrome.storage.local.get(DEFAULTS, (v) => {
  $("serverUrl").value = v.serverUrl;
  $("password").value = v.password;
  showStatus(v.connStatus);
});

$("save").addEventListener("click", () => {
  chrome.storage.local.set({ serverUrl: $("serverUrl").value.trim(), password: $("password").value });
  showStatus({ status: "Verbinde…" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.connStatus) showStatus(changes.connStatus.newValue);
});
