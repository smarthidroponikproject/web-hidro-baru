/*
  Dashboard Hidro Capstone
  Untuk pengujian lokal, API default ESP32 adalah http://192.168.4.1
  Catatan: GitHub Pages menggunakan HTTPS, sedangkan ESP32 memakai HTTP.
  Browser modern dapat memblokir permintaan silang tersebut sebagai mixed content.
*/

const DEFAULT_API_BASE = "http://192.168.4.1";
const relayLabels = [
  "Relay U11 IN1", "Relay U11 IN2", "Relay U11 IN3", "Relay U11 IN4",
  "Relay U12 IN1", "Relay U12 IN2", "Relay U12 IN3", "Relay U12 IN4"
];

let apiBase = localStorage.getItem("hidroApiBase") || DEFAULT_API_BASE;
let pollTimer = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

function normalizeBase(value) {
  return value.trim().replace(/\/+$/, "");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setConnection(state, text) {
  const badge = $("connectionBadge");
  badge.className = "badge " + (state === "ok" ? "badge-ok" : state === "error" ? "badge-error" : "badge-warn");
  badge.textContent = text;
}

function displayValue(value, suffix = "") {
  return value === null || value === undefined || Number.isNaN(Number(value))
    ? "Error" : `${value}${suffix}`;
}

function renderRelays(states) {
  const grid = $("relayGrid");
  if (!Array.isArray(states)) {
    grid.innerHTML = '<p class="muted">Status relay tidak tersedia.</p>';
    return;
  }

  grid.innerHTML = states.map((isOn, index) => {
    const on = Boolean(isOn);
    return `
      <article class="relay-card">
        <span class="relay-led ${on ? "is-on" : ""}"></span>
        <div class="relay-info">
          <strong>${relayLabels[index]}</strong>
          <small>Status: ${on ? "ON" : "OFF"} · GPIO ${[27, 33, 18, 19, 13, 14, 25, 26][index]}</small>
        </div>
        <div class="relay-actions">
          <button class="button ${on ? "button-off" : "button-on"}" data-relay="${index}" data-state="${on ? 0 : 1}">
            ${on ? "OFF" : "ON"}
          </button>
        </div>
      </article>`;
  }).join("");

  grid.querySelectorAll("button[data-relay]").forEach((button) => {
    button.addEventListener("click", () => setRelay(
      Number(button.dataset.relay),
      Number(button.dataset.state)
    ));
  });
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    ...options
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function refreshData() {
  try {
    const response = await apiFetch("/api/data");
    const data = await response.json();

    $("phVoltage").innerHTML = `${displayValue(data.phVoltage)} <span>V</span>`;
    $("phRaw").textContent = `ADC: ${displayValue(data.phRaw)}`;
    $("ds18b20").innerHTML = `${displayValue(data.ds18b20C)} <span>°C</span>`;
    $("dhtTemp").innerHTML = `${displayValue(data.dhtTempC)} <span>°C</span>`;
    $("humidity").textContent = `Kelembapan: ${displayValue(data.humidity)} %RH`;
    $("tdsVoltage").innerHTML = `${displayValue(data.tdsVoltage)} <span>V</span>`;
    $("tdsRaw").textContent = `ADC: ${displayValue(data.tdsRaw)}`;
    $("adsStatus").textContent = `ADS1115: ${data.adsReady ? "terdeteksi" : "tidak terdeteksi"}`;
    $("lastUpdated").textContent = `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`;
    renderRelays(data.relays);
    setConnection("ok", "ESP32 terhubung");
  } catch (error) {
    setConnection("error", "Tidak terhubung");
    $("lastUpdated").textContent = "Gagal mengambil data dari ESP32";
    console.error("API ESP32 tidak dapat diakses:", error);
  }
}

async function setRelay(channel, state) {
  try {
    await apiFetch(`/api/relay?ch=${encodeURIComponent(channel)}&state=${encodeURIComponent(state)}`);
    showToast(`${relayLabels[channel]} ${state ? "ON" : "OFF"}`);
    await refreshData();
  } catch (error) {
    showToast("Perintah relay gagal. Periksa koneksi ke ESP32.");
    console.error(error);
  }
}

async function allRelaysOff() {
  try {
    await apiFetch("/api/alloff");
    showToast("Perintah semua relay OFF dikirim.");
    await refreshData();
  } catch (error) {
    showToast("Gagal mematikan relay. Periksa koneksi ke ESP32.");
    console.error(error);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  refreshData();
  pollTimer = setInterval(refreshData, 2500);
}

$("apiBase").value = apiBase;
$("saveApi").addEventListener("click", () => {
  const value = normalizeBase($("apiBase").value);
  if (!/^https?:\/\/.+/i.test(value)) {
    showToast("Masukkan alamat lengkap, misalnya http://192.168.4.1");
    return;
  }
  apiBase = value;
  localStorage.setItem("hidroApiBase", apiBase);
  startPolling();
  showToast("Alamat API diperbarui.");
});
$("allOff").addEventListener("click", allRelaysOff);

startPolling();
