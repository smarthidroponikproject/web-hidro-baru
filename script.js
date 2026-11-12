
/* =========================================================
   HIDRO CAPSTONE - DASHBOARD JAVASCRIPT
   MQTT + SENSOR + ACTUATOR + CALIBRATION
   ========================================================= */

// =========================================================
// 1. NAVIGASI MENU
// =========================================================

document.addEventListener("click", function (event) {
    const tab = event.target.closest(".tab");
    if (!tab) return;

    event.preventDefault();

    const pageName = tab.dataset.page;
    const targetPage = document.getElementById("page-" + pageName);

    if (!targetPage) {
        console.error("Halaman tidak ditemukan:", pageName);
        return;
    }

    document.querySelectorAll(".tabs .tab").forEach(function (item) {
        const active = item === tab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll(".page").forEach(function (page) {
        const active = page === targetPage;
        page.classList.toggle("active", active);
        page.style.display = active ? "block" : "none";
    });

    console.log("Menu aktif:", pageName);
}, true);


// =========================================================
// 2. KONFIGURASI MQTT
// =========================================================

const DEFAULT_BROKER = "wss://broker.emqx.io:8084/mqtt";
const DEFAULT_ROOT = "hidroponik/demo01";

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

const relayUsed = [
    true, true, false, true,
    true, true, true, false
];

const $ = id => document.getElementById(id);

let client = null;
let latest = null;
let root = DEFAULT_ROOT;
let ackTimer = null;
let toastTimer = null;
let thresholdDirty = false;
let deviceLastSeen = 0;
let deviceWatchTimer = null;


// =========================================================
// 3. UTILITAS DASHBOARD
// =========================================================

function toast(msg) {
    const e = $("toast");
    if (!e) return;

    e.textContent = msg;
    e.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        e.classList.remove("show");
    }, 3500);
}

function badge(state, label) {
    const e = $("connectionBadge");
    if (!e) return;

    e.className = "badge " +
        (state === "ok"
            ? "badge-ok"
            : state === "error"
                ? "badge-error"
                : "badge-warn");

    e.textContent = label;
}

function num(v, d = 2) {
    return v == null || !Number.isFinite(Number(v))
        ? "—"
        : Number(v).toFixed(d);
}


// =========================================================
// 4. KONEKSI MQTT
// =========================================================

function connect() {

    if (client) {
        try {
            client.end(true);
        } catch (e) {
            console.error(e);
        }
    }

    const url = $("mqttUrl").value.trim();
    const username = $("mqttUser").value.trim();
    const password = $("mqttPass").value;

    root = DEFAULT_ROOT;

    if (!url) {
        toast("Alamat broker MQTT WebSocket wajib diisi.");
        return;
    }

    badge("wait", "Menghubungkan MQTT…");

    deviceLastSeen = 0;

    if (deviceWatchTimer) {
        clearInterval(deviceWatchTimer);
    }

    deviceWatchTimer = setInterval(() => {

        if (!client || !client.connected) return;

        if (
            deviceLastSeen &&
            Date.now() - deviceLastSeen > 20000
        ) {
            badge("wait", "Broker terhubung · ESP32 tidak mengirim data");
        }

    }, 5000);


    client = mqtt.connect(url, {
        username: username || undefined,
        password: password || undefined,
        clean: true,
        connectTimeout: 10000,
        reconnectPeriod: 3000,
        clientId: "hidro-web-" +
            Math.random().toString(16).slice(2, 10)
    });


    // MQTT CONNECTED
    client.on("connect", () => {

        badge("wait", "Broker terhubung · menunggu ESP32");

        client.subscribe(root + "/sensor", { qos: 0 }, err => {
            if (err) console.error("Subscribe sensor gagal:", err);
        });

        client.subscribe(root + "/ack", { qos: 0 }, err => {
            if (err) console.error("Subscribe ACK gagal:", err);
        });

        client.publish(
            root + "/command",
            JSON.stringify({ cmd: "get_status" }),
            { qos: 0 },
            err => {
                if (err) {
                    console.error("Permintaan status gagal:", err);
                }
            }
        );

        toast("Terhubung ke broker. Meminta status ESP32…");
    });


    client.on("reconnect", () => {
        badge("wait", "Menyambung ulang…");
    });

    client.on("error", e => {
        badge("error", "Koneksi MQTT gagal");
        console.error(e);
    });

    client.on("close", () => {
        badge("error", "MQTT terputus");
    });


    // MQTT MESSAGE
    client.on("message", (topic, payload) => {

        let d;

        try {
            d = JSON.parse(payload.toString());
        } catch (e) {
            console.error("Format JSON MQTT tidak valid:", e);
            return;
        }


        // DATA SENSOR
        if (topic === root + "/sensor") {

            latest = d;
            deviceLastSeen = Date.now();

            updateUI(d);

            badge("ok", "Broker terhubung · ESP32 aktif");
        }


        // ACK ESP32
        if (topic === root + "/ack") {

            if (
                d.device_id ||
                d.message === "ESP32 terhubung MQTT" ||
                d.message === "ESP32 aktif"
            ) {
                deviceLastSeen = Date.now();
                badge("ok", "Broker terhubung · ESP32 aktif");
            }

            if (d.ok === false) {
                toast(d.error || "Perintah ditolak");
            } else if (d.message) {
                toast(d.message);
            }
        }

    });

}


// =========================================================
// 5. KIRIM PERINTAH KE ESP32
// =========================================================

function send(obj) {

    if (!client || !client.connected) {
        toast("Dashboard belum terhubung ke broker MQTT.");
        return false;
    }

    client.publish(
        root + "/command",
        JSON.stringify(obj)
    );

    return true;
}


// =========================================================
// 6. STATUS DAN KONTROL RELAY
// =========================================================

function renderRelays(targetId, states, manual) {

    const target = $(targetId);

    if (!target) return;

    if (!Array.isArray(states)) {
        target.innerHTML =
            '<p class="muted">Status relay menunggu data MQTT.</p>';
        return;
    }

    target.innerHTML = states
        .map((on, i) => ({ on, i }))
        .filter(x => relayUsed[x.i])
        .map(({ on, i }) => `

            <article class="relay-card">

                <span class="relay-led ${on ? "on" : ""}"></span>

                <div class="relay-info">
                    <strong>${relayNames[i]}</strong>
                    <small>Status: ${on ? "ON" : "OFF"}</small>
                </div>

                ${manual ? `
                    <div class="relay-actions">

                        <button
                            class="btn ${on ? "btn-off" : "btn-on"}"
                            data-ch="${i}"
                            data-state="${on ? 0 : 1}"
                            ${latest?.autoMode ? "disabled" : ""}>
                            ${on ? "OFF" : "ON"}
                        </button>

                    </div>
                ` : ""}

            </article>

        `).join("");


    target.querySelectorAll("button[data-ch]").forEach(button => {

        button.addEventListener("click", () => {

            send({
                cmd: "relay",
                ch: Number(button.dataset.ch),
                state: Number(button.dataset.state)
            });

        });

    });

}


// =========================================================
// 7. PENGATURAN THRESHOLD
// =========================================================

function fillSettings(s) {

    if (!s || thresholdDirty) return;

    [
        "phLow",
        "phHigh",
        "tdsLow",
        "tdsHigh",
        "humidityHigh",
        "humidityLow",
        "exhaustTemp"
    ].forEach(k => {

        if ($(k) && s[k] != null) {
            $(k).value = s[k];
        }

    });

}


// =========================================================
// 8. UPDATE DATA SENSOR DASHBOARD
// =========================================================

function updateUI(d) {

    $("phValue").textContent = num(d.ph);

    $("phVoltage").textContent =
        `Tegangan: ${num(d.phVoltage, 3)} V`;

    $("phRaw").textContent =
        `ADC: ${d.phRaw ?? "—"}`;


    $("dsValue").textContent =
        `${num(d.ds18b20C)} °C`;

    $("dhtValue").textContent =
        `${num(d.dhtTempC)} °C`;

    $("humidityValue").textContent =
        `Kelembapan ${num(d.humidity, 1)} %RH`;


    $("tdsValue").textContent =
        `${num(d.tdsPpm, 0)} ppm`;

    $("tdsVoltage").textContent =
        `Tegangan: ${num(d.tdsVoltage, 4)} V`;

    $("tdsRaw").textContent =
        `ADC ADS1115: ${d.tdsRaw ?? "—"} · ${
            d.adsReady
                ? "ADS1115 OK"
                : "ADS1115 tidak terdeteksi"
        }`;


    $("calCurrentTds").textContent =
        `${num(d.tdsPpm, 0)} ppm`;

    $("calCurrentPh").textContent =
        `${num(d.phVoltage, 3)} V`;


    $("lastUpdated").textContent =
        `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`;


    $("modeStatus").textContent =
        d.autoMode ? "Otomatis" : "Manual";

    $("autoStatus").textContent =
        d.autoStatus || "—";


    $("autoModeBtn").disabled = !!d.autoMode;
    $("manualModeBtn").disabled = !d.autoMode;


    renderRelays("monitorRelayGrid", d.relays, false);
    renderRelays("controlRelayGrid", d.relays, true);

    fillSettings(d.settings);


    const rates = d.settings?.pumpRates || {};

    ["phup", "phdown", "nutra", "nutrb"].forEach(k => {

        const e = $("rate-" + k);

        if (e) {
            e.textContent = Number(rates[k]) > 0
                ? `${Number(rates[k]).toFixed(3)} mL/detik · ${
                    (Number(rates[k]) * 60).toFixed(1)
                } mL/menit`
                : "Belum dikalibrasi";
        }

    });

}


// =========================================================
// 9. KALIBRASI POMPA
// =========================================================

function pumpTest(p) {

    let s = Number($("seconds-" + p).value);

    if (!(s >= 1 && s <= 30)) {
        toast("Durasi harus 1–30 detik.");
        return;
    }

    send({
        cmd: "pump_test",
        pump: p,
        seconds: s
    });

}


function pumpCal(p) {

    let s = Number($("seconds-" + p).value);
    let v = Number($("volume-" + p).value);

    if (!(s >= 1 && s <= 30 && v > 0)) {
        toast("Isi durasi dan volume aktual.");
        return;
    }

    send({
        cmd: "pump_cal",
        pump: p,
        seconds: s,
        volume: v
    });

}


function pumpDose(p) {

    let ml = Number($("dose-" + p).value);

    if (!(ml > 0 && ml <= 100)) {
        toast("Dosis harus 0–100 mL.");
        return;
    }

    if (confirm(`Jalankan perkiraan dosis ${ml} mL untuk ${p}?`)) {

        send({
            cmd: "pump_dose",
            pump: p,
            ml: ml
        });

    }

}


// =========================================================
// 10. SIMPAN THRESHOLD
// =========================================================

function saveThresholds(e) {

    e.preventDefault();

    let v = {};

    [
        "phLow",
        "phHigh",
        "tdsLow",
        "tdsHigh",
        "humidityHigh",
        "humidityLow",
        "exhaustTemp"
    ].forEach(k => {
        v[k] = Number($(k).value);
    });


    if (
        v.phHigh <= v.phLow ||
        v.tdsHigh <= v.tdsLow ||
        v.humidityHigh <= v.humidityLow
    ) {
        toast("Batas atas harus lebih besar dari batas bawah.");
        return;
    }

    thresholdDirty = false;

    send({
        cmd: "settings",
        ...v
    });

}


// =========================================================
// 11. EVENT LISTENER MQTT
// =========================================================

$("saveMqtt").addEventListener("click", () => {

    localStorage.setItem(
        "hidroMqttUrl",
        $("mqttUrl").value.trim()
    );

    localStorage.setItem(
        "hidroMqttUser",
        $("mqttUser").value.trim()
    );

    connect();

});


// =========================================================
// 12. EVENT LISTENER SETTINGS
// =========================================================

$("settingsForm").addEventListener("input", () => {
    thresholdDirty = true;
});

$("settingsForm").addEventListener(
    "submit",
    saveThresholds
);


// =========================================================
// 13. KALIBRASI TDS
// =========================================================

$("calibrateTds").addEventListener("click", () => {

    let standard = Number($("tdsStandard").value);

    if (standard > 0) {

        send({
            cmd: "cal_tds",
            standard: standard
        });

    } else {

        toast("Nilai standar tidak valid");

    }

});


// =========================================================
// 14. KALIBRASI PH
// =========================================================

$("phPoint").addEventListener("change", () => {

    $("phBuffer").value =
        $("phPoint").value === "low"
            ? "4.00"
            : "6.86";

});


$("calibratePh").addEventListener("click", () => {

    let buffer = Number($("phBuffer").value);

    if (buffer < 0 || buffer > 14) {
        toast("Buffer harus 0–14");
        return;
    }

    send({
        cmd: "cal_ph",
        point: $("phPoint").value,
        buffer: buffer
    });

});


$("resetCalibration").addEventListener("click", () => {

    if (confirm("Reset kalibrasi pH dan TDS?")) {
        send({ cmd: "reset_cal" });
    }

});


// =========================================================
// 15. EVENT LISTENER POMPA
// =========================================================

document.querySelectorAll(".pump-test").forEach(button => {

    button.addEventListener("click", () => {
        pumpTest(button.dataset.pump);
    });

});


document.querySelectorAll(".pump-save").forEach(button => {

    button.addEventListener("click", () => {
        pumpCal(button.dataset.pump);
    });

});


document.querySelectorAll(".pump-dose").forEach(button => {

    button.addEventListener("click", () => {
        pumpDose(button.dataset.pump);
    });

});


// =========================================================
// 16. MODE OTOMATIS DAN MANUAL
// =========================================================

$("autoModeBtn").addEventListener("click", () => {

    send({
        cmd: "mode",
        mode: "auto"
    });

});


$("manualModeBtn").addEventListener("click", () => {

    send({
        cmd: "mode",
        mode: "manual"
    });

});


// =========================================================
// 17. MATIKAN SEMUA RELAY
// =========================================================

$("allOff").addEventListener("click", () => {
    send({ cmd: "alloff" });
});


$("quickAllOff").addEventListener("click", () => {
    send({ cmd: "alloff" });
});


// =========================================================
// 18. INISIALISASI MQTT
// =========================================================

$("mqttUrl").value =
    localStorage.getItem("hidroMqttUrl") || DEFAULT_BROKER;

$("mqttUser").value =
    localStorage.getItem("hidroMqttUser") || "";


// =========================================================
// 19. MEMBERSIHKAN KONEKSI SAAT HALAMAN DITUTUP
// =========================================================

window.addEventListener("beforeunload", () => {

    if (deviceWatchTimer) {
        clearInterval(deviceWatchTimer);
    }

    if (client) {
        client.end(true);
    }

});


// =========================================================
// 20. SELESAI
// =========================================================

console.log("Hidro Capstone Dashboard berhasil diinisialisasi.");
