const DEFAULT_API = "http://192.168.4.1";
const relayNames = [
  "Pompa pH Up · U11 IN1 (GPIO27)",
  "Pompa pH Down · U11 IN2 (GPIO33)",
  "TIDAK DIGUNAKAN · U11 IN3 (GPIO18)",
  "Pompa Nutrisi A · U11 IN4 (GPIO19)",
  "Kipas exhaust · U12 IN1 (GPIO13)",
  "Pompa Nutrisi B · U12 IN2 (GPIO14)",
  "Relay cadangan · U12 IN3 (GPIO25)",
  "TIDAK DIGUNAKAN · U12 IN4 (GPIO26)"
];
const relayUsed = [true, true, false, true, true, true, true, false];
let apiBase = localStorage.getItem("hidroApiBase") || DEFAULT_API;
let latest = null;
let pollTimer = null;
let toastTimer = null;
let thresholdDirty = false;
const $ = (id) => document.getElementById(id);
const num = (v, digits=2) => v == null || !Number.isFinite(Number(v)) ? "Error" : Number(v).toFixed(digits);

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function setBadge(state, label) {
  const el = $("connectionBadge");
  el.className = "badge " + (state === "ok" ? "badge-ok" : state === "error" ? "badge-error" : "badge-warn");
  el.textContent = label;
}
function baseUrl() { return apiBase.replace(/\/+$/, ""); }
async function request(path) {
  const response = await fetch(baseUrl() + path, {cache:"no-store"});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function renderRelays(targetId, states, manual) {
  const target = $(targetId);
  if (!Array.isArray(states)) { target.innerHTML = '<p class="muted">Status relay tidak tersedia.</p>'; return; }
  target.innerHTML = states.map((on, i) => ({on, i})).filter(item => relayUsed[item.i]).map(({on, i}) => `
    <article class="relay-card">
      <span class="relay-led ${on ? "on" : ""}"></span>
      <div class="relay-info"><strong>${relayNames[i]}</strong><small>Status: ${on ? "ON" : "OFF"}</small></div>
      ${manual ? `<div class="relay-actions"><button class="btn ${on ? "btn-off" : "btn-on"}" data-ch="${i}" data-state="${on ? 0 : 1}" ${latest?.autoMode ? "disabled" : ""}>${on ? "OFF" : "ON"}</button></div>` : ""}
    </article>`).join("");
  target.querySelectorAll("button[data-ch]").forEach(b => b.addEventListener("click", () => relay(Number(b.dataset.ch), Number(b.dataset.state))));
}
function fillSettings(s) {
  if (!s || thresholdDirty) return;
  const map = {phLow:"phLow",phHigh:"phHigh",tdsLow:"tdsLow",tdsHigh:"tdsHigh",humidityHigh:"humidityHigh",humidityLow:"humidityLow",exhaustTemp:"exhaustTemp"};
  Object.entries(map).forEach(([key,id]) => { if ($(id) && s[key] != null) $(id).value = s[key]; });
}
function updateUI(d) {
  latest = d;
  $("phValue").textContent = num(d.ph,2);
  $("phVoltage").textContent = `Tegangan: ${num(d.phVoltage,3)} V`;
  $("phRaw").textContent = `ADC: ${d.phRaw ?? "—"}`;
  $("dsValue").textContent = `${num(d.ds18b20C,2)} °C`;
  $("dhtValue").textContent = `${num(d.dhtTempC,2)} °C`;
  $("humidityValue").textContent = `Kelembapan ${num(d.humidity,1)} %RH`;
  $("tdsValue").textContent = `${num(d.tdsPpm,0)} ppm`;
  $("tdsVoltage").textContent = `Tegangan: ${num(d.tdsVoltage,4)} V`;
  $("tdsRaw").textContent = `ADC ADS1115: ${d.tdsRaw ?? "—"} · ${d.adsReady ? "ADS1115 OK" : "ADS1115 tidak terdeteksi"}`;
  $("calCurrentTds").textContent = `${num(d.tdsPpm,0)} ppm`;
  $("calCurrentPh").textContent = `${num(d.phVoltage,3)} V`;
  $("lastUpdated").textContent = `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`;
  $("modeStatus").textContent = d.autoMode ? "Otomatis" : "Manual";
  $("autoStatus").textContent = d.autoStatus || "—";
  $("autoModeBtn").disabled = !!d.autoMode;
  $("manualModeBtn").disabled = !d.autoMode;
  renderRelays("monitorRelayGrid",d.relays,false);
  renderRelays("controlRelayGrid",d.relays,true);
  if (d.settings) fillSettings(d.settings);
  const rates = d.settings?.pumpRates || {};
  ["phup","phdown","nutra","nutrb"].forEach(key => {
    const el = $("rate-"+key);
    if (el) el.textContent = Number(rates[key]) > 0 ? `${Number(rates[key]).toFixed(3)} mL/detik · ${(Number(rates[key])*60).toFixed(1)} mL/menit` : "Belum dikalibrasi";
  });
}
async function refresh() {
  try {
    const d = await request("/api/data");
    updateUI(d); setBadge("ok","ESP32 terhubung");
  } catch (e) {
    setBadge("error","Tidak terhubung");
    $("lastUpdated").textContent = "Gagal mengambil data";
    console.error(e);
  }
}
async function relay(ch,state) {
  try { await request(`/api/relay?ch=${ch}&state=${state}`); toast(`${relayNames[ch]} ${state ? "ON" : "OFF"}`); await refresh(); }
  catch(e) { toast(e.message || "Perintah relay gagal"); }
}
async function setMode(mode) {
  try { await request(`/api/mode?mode=${mode}`); toast(`Mode ${mode === "auto" ? "otomatis" : "manual"} diaktifkan`); await refresh(); }
  catch(e) { toast(e.message || "Gagal mengubah mode"); }
}
async function allOff() {
  try { await request("/api/alloff"); toast("Semua relay dimatikan"); await refresh(); }
  catch(e) { toast(e.message || "Gagal mematikan relay"); }
}
function readFormValues() {
  const keys = ["phLow","phHigh","tdsLow","tdsHigh","humidityHigh","humidityLow","exhaustTemp"];
  const params = new URLSearchParams();
  keys.forEach(k => params.set(k, $(k).value));
  return params;
}
async function saveThresholds(event) {
  event.preventDefault();
  const values = Object.fromEntries(readFormValues().entries());
  if (Number(values.phHigh) <= Number(values.phLow) ||
      Number(values.tdsHigh) <= Number(values.tdsLow) ||
      Number(values.humidityHigh) <= Number(values.humidityLow)) {
    toast("Pastikan batas atas lebih besar daripada batas bawah."); return;
  }
  try {
    const p = readFormValues();
    const response = await fetch(baseUrl()+"/api/settings?"+p.toString(), {method:"POST",cache:"no-store"});
    const d = await response.json();
    if (!response.ok) throw new Error(d.error || "Gagal menyimpan");
    thresholdDirty = false;
    toast("Pengaturan threshold disimpan di ESP32"); await refresh();
  } catch(e) { toast(e.message || "Gagal menyimpan threshold"); }
}
async function calibrateTds() {
  const standard = Number($("tdsStandard").value);
  if (!(standard > 0)) { toast("Masukkan standar TDS dalam ppm."); return; }
  try {
    const d = await request(`/api/cal/tds?standard=${encodeURIComponent(standard)}`);
    toast(`Kalibrasi TDS tersimpan. Faktor: ${d.factor}`);
    await refresh();
  } catch(e) { toast(e.message || "Kalibrasi TDS gagal"); }
}
async function calibratePh() {
  const buffer = Number($("phBuffer").value);
  if (buffer < 0 || buffer > 14) { toast("Nilai buffer pH harus 0–14."); return; }
  try {
    const point = $("phPoint").value;
    const d = await request(`/api/cal/ph?buffer=${encodeURIComponent(buffer)}&point=${encodeURIComponent(point)}`);
    if (d.warning) toast(d.warning);
    else toast(`Titik ${point === "low" ? "rendah" : "tinggi"} pH ${d.buffer} tersimpan pada ${d.voltage} V. Pembacaan sekarang: ${d.phNow ?? "—"}`);
    await refresh();
  } catch(e) { toast(e.message || "Kalibrasi pH gagal"); }
}
async function resetCalibration() {
  if (!confirm("Reset faktor TDS dan titik kalibrasi pH ke nilai awal?")) return;
  try { await request("/api/cal/reset"); toast("Parameter kalibrasi direset"); await refresh(); }
  catch(e) { toast(e.message || "Reset gagal"); }
}
async function pumpTest(pump) {
  const seconds = Number($("seconds-"+pump).value);
  if (!(seconds >= 1 && seconds <= 30)) { toast("Durasi uji harus 1–30 detik."); return; }
  try {
    const d = await request(`/api/pump/test?pump=${pump}&seconds=${seconds}`);
    toast(`${pump}: pompa berjalan ${d.seconds} detik dan berhenti otomatis.`);
  } catch(e) { toast(e.message || "Uji pompa gagal"); }
}
async function savePumpCalibration(pump) {
  const seconds = Number($("seconds-"+pump).value);
  const volume = Number($("volume-"+pump).value);
  if (!(seconds >= 1 && seconds <= 30) || !(volume > 0)) { toast("Isi durasi uji dan volume aktual dalam mL."); return; }
  try {
    const d = await request(`/api/pump/calibrate?pump=${pump}&seconds=${seconds}&volume=${volume}`);
    toast(`Kalibrasi tersimpan: ${d.rateMlSec.toFixed(3)} mL/detik (${d.rateMlMin.toFixed(1)} mL/menit).`);
    await refresh();
  } catch(e) { toast(e.message || "Simpan kalibrasi gagal"); }
}
async function runPumpDose(pump) {
  const ml = Number($("dose-"+pump).value);
  if (!(ml > 0 && ml <= 100)) { toast("Volume dosis harus antara 0 dan 100 mL."); return; }
  if (!confirm(`Jalankan dosis perkiraan ${ml} mL untuk ${pump}? Pastikan selang mengarah ke wadah/reservoir yang benar.`)) return;
  try {
    const d = await request(`/api/pump/dose?pump=${pump}&ml=${ml}`);
    toast(`Dosis ${d.volumeMl} mL diperkirakan berjalan ${d.seconds} detik.`);
    await refresh();
  } catch(e) { toast(e.message || "Dosis pompa gagal"); }
}
function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active",t===tab));
    document.querySelectorAll(".page").forEach(p => p.classList.toggle("active",p.id===`page-${tab.dataset.page}`));
  }));
}
$("apiBase").value = apiBase;
$("saveApi").addEventListener("click", () => {
  const v = $("apiBase").value.trim().replace(/\/+$/,"");
  if (!/^https?:\/\/.+/i.test(v)) { toast("Alamat API harus diawali http:// atau https://"); return; }
  apiBase = v; localStorage.setItem("hidroApiBase",apiBase); toast("Alamat API diperbarui"); refresh();
});
$("settingsForm").addEventListener("input", () => { thresholdDirty = true; });
$("settingsForm").addEventListener("submit",saveThresholds);
$("calibrateTds").addEventListener("click",calibrateTds);
$("phPoint").addEventListener("change", () => {
  $("phBuffer").value = $("phPoint").value === "low" ? "4.00" : "6.86";
});
$("calibratePh").addEventListener("click",calibratePh);
$("resetCalibration").addEventListener("click",resetCalibration);
document.querySelectorAll(".pump-test").forEach(b => b.addEventListener("click", () => pumpTest(b.dataset.pump)));
document.querySelectorAll(".pump-save").forEach(b => b.addEventListener("click", () => savePumpCalibration(b.dataset.pump)));
document.querySelectorAll(".pump-dose").forEach(b => b.addEventListener("click", () => runPumpDose(b.dataset.pump)));
$("autoModeBtn").addEventListener("click",()=>setMode("auto"));
$("manualModeBtn").addEventListener("click",()=>setMode("manual"));
$("allOff").addEventListener("click",allOff);
$("quickAllOff").addEventListener("click",allOff);
setupTabs();
refresh();
pollTimer = setInterval(refresh,2500);
