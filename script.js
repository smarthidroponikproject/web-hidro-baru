'use strict';

/*
 * Hidro_Caps MQTT Dashboard
 * Compatible with firmware Hidroponik_Automation.ino
 *
 * MQTT topics:
 *   <root>/sensor
 *   <root>/command
 *   <root>/ack
 *   <root>/availability
 */

const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const DEFAULT_ROOT = 'hidroponik/demo01';

const RELAYS = [
  { name: 'Pompa pH Up', gpio: 27 },
  { name: 'Pompa pH Down', gpio: 33 },
  { name: 'Pompa Nutrisi A', gpio: 19 },
  { name: 'Exhaust Fan', gpio: 13 },
  { name: 'Pompa Nutrisi B', gpio: 14 },
  { name: 'Pompa Air Bersih', gpio: 25 }
];

const ACK_TIMEOUT_MS = 10000;

let client = null;
let latest = null;
let root = DEFAULT_ROOT;
let ackTimers = new Map();
let pendingCommands = new Map();
let toastTimer = null;
let settingsDirty = false;

function $(id) {
  return document.getElementById(id);
}

function toast(message) {
  const el = $('toast');

  if (!el) {
    console.log('[Dashboard]', message);
    return;
  }

  el.textContent = message;
  el.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => el.classList.remove('show'),
    4000
  );
}

function setBadge(id, text, state) {
  const el = $(id);
  if (!el) return;

  el.textContent = text;
  el.className = 'badge ' + state;
}

function fmt(value, decimals = 2, suffix = '') {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    return '—';
  }

  return Number(value).toFixed(decimals) + suffix;
}

function makeCommandId() {
  return 'web-' + Date.now() + '-' +
    Math.random().toString(16).slice(2, 8);
}

/* =========================================================
   MQTT CONNECTION
========================================================= */

function connect() {
  if (typeof mqtt === 'undefined') {
    toast('Library MQTT.js belum dimuat. Periksa index.html.');
    return;
  }

  const url = $('brokerUrl')?.value.trim() || DEFAULT_BROKER;

  root = ($('rootTopic')?.value.trim() || DEFAULT_ROOT)
    .replace(/\/+$/, '');

  if (!url || !root) {
    toast('Broker dan root topic wajib diisi.');
    return;
  }

  if (client) {
    try {
      client.removeAllListeners();
      client.end(true);
    } catch (error) {
      console.warn(
        '[MQTT] Gagal menutup koneksi lama:',
        error
      );
    }

    client = null;
  }

  clearAllPendingCommands();

  setBadge(
    'brokerBadge',
    'Broker menghubungkan…',
    'warn'
  );

  setBadge(
    'deviceBadge',
    'ESP32 menunggu…',
    'warn'
  );

  client = mqtt.connect(url, {
    clientId: 'hidro-web-' +
      Math.random().toString(16).slice(2, 10),

    clean: true,
    connectTimeout: 15000,
    reconnectPeriod: 3000,
    keepalive: 30,
    resubscribe: true
  });

  client.on('connect', () => {
    setBadge(
      'brokerBadge',
      'Broker terhubung',
      'ok'
    );

    const topics = [
      root + '/sensor',
      root + '/ack',
      root + '/availability'
    ];

    client.subscribe(
      topics,
      { qos: 1 },
      (error, granted) => {
        if (error) {
          console.error(
            '[MQTT] Subscribe gagal:',
            error
          );

          setBadge(
            'brokerBadge',
            'Gagal subscribe topic',
            'err'
          );

          toast('Gagal berlangganan topic MQTT.');
          return;
        }

        console.log(
          '[MQTT] Subscribe berhasil:',
          granted
        );

        toast(
          'Broker MQTT terhubung dan topic berhasil di-subscribe.'
        );
      }
    );
  });

  client.on('reconnect', () => {
    setBadge(
      'brokerBadge',
      'Menyambungkan ulang…',
      'warn'
    );
  });

  client.on('offline', () => {
    setBadge(
      'brokerBadge',
      'Broker offline',
      'err'
    );

    setBadge(
      'deviceBadge',
      'ESP32 tidak terpantau',
      'err'
    );
  });

  client.on('close', () => {
    setBadge(
      'brokerBadge',
      'Koneksi MQTT tertutup',
      'err'
    );
  });

  client.on('error', error => {
    console.error('[MQTT] Error:', error);

    setBadge(
      'brokerBadge',
      'Broker bermasalah',
      'err'
    );
  });

  client.on('message', (topic, payload) => {
    const raw = payload.toString();

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.warn(
        '[MQTT] Payload bukan JSON:',
        topic,
        raw
      );

      return;
    }

    if (topic === root + '/sensor') {
      latest = data;

      setBadge(
        'deviceBadge',
        'ESP32 online',
        'ok'
      );

      updateUI(data);
      return;
    }

    if (topic === root + '/availability') {
      const online = data.deviceOnline === true;

      setBadge(
        'deviceBadge',
        online ? 'ESP32 online' : 'ESP32 offline',
        online ? 'ok' : 'err'
      );

      return;
    }

    if (topic === root + '/ack') {
      console.log('[MQTT] ACK diterima:', data);

      handleAck(data);
    }
  });
}
/* =========================================================
   SEND COMMAND + ACK TRACKING
========================================================= */

function send(command) {
  if (!client || !client.connected) {
    toast('Dashboard belum terhubung ke broker MQTT.');
    return false;
  }

  if (
    !command ||
    typeof command !== 'object' ||
    !command.cmd
  ) {
    toast('Format perintah tidak valid.');
    return false;
  }

  const commandId = makeCommandId();

  const outgoing = {
    ...command,
    commandId
  };

  const payload = JSON.stringify(outgoing);
  const ackTopic = root + '/ack';

  // Daftarkan ID sebelum publish agar ACK yang sangat cepat
  // tetap dapat dikenali oleh dashboard.
  pendingCommands.set(
    commandId,
    outgoing.cmd
  );

  const timer = setTimeout(() => {
    ackTimers.delete(commandId);
    pendingCommands.delete(commandId);

    toast(
      'ACK tidak diterima untuk perintah "' +
      outgoing.cmd +
      '". Periksa ESP32, topic ACK, dan koneksi MQTT.'
    );

    console.error('[ACK] Timeout:', {
      commandId,
      command: outgoing.cmd,
      expectedTopic: ackTopic
    });

  }, ACK_TIMEOUT_MS);

  ackTimers.set(commandId, timer);

  console.log('[MQTT] Mengirim perintah:', {
    topic: root + '/command',
    payload
  });

  try {
    client.publish(
      root + '/command',
      payload,
      {
        qos: 1,
        retain: false
      },
      error => {
        if (error) {
          clearTimeout(ackTimers.get(commandId));

          ackTimers.delete(commandId);
          pendingCommands.delete(commandId);

          console.error(
            '[MQTT] Publish gagal:',
            error
          );

          toast(
            'Gagal mengirim perintah: ' +
            error.message
          );

          return;
        }

        console.log(
          '[MQTT] Perintah diteruskan ke broker:',
          commandId
        );
      }
    );

  } catch (error) {
    clearTimeout(timer);

    ackTimers.delete(commandId);
    pendingCommands.delete(commandId);

    console.error(
      '[MQTT] Exception saat publish:',
      error
    );

    toast(
      'Kesalahan saat publish MQTT: ' +
      error.message
    );

    return false;
  }

  return true;
}


function handleAck(data) {
  if (!data || typeof data !== 'object') {
    console.warn(
      '[ACK] Payload ACK kosong/tidak valid.'
    );

    return;
  }

  const commandId = data.commandId;

  if (!commandId) {
    console.warn(
      '[ACK] ACK tidak memiliki commandId:',
      data
    );

    toast(
      'ACK diterima, tetapi commandId tidak ditemukan.'
    );

    return;
  }

  const commandType = pendingCommands.get(commandId);

  if (ackTimers.has(commandId)) {
    clearTimeout(ackTimers.get(commandId));
    ackTimers.delete(commandId);
  }

  if (pendingCommands.has(commandId)) {
    pendingCommands.delete(commandId);
  }

  if (data.ok === true) {
    toast(
      'Berhasil: ' +
      (data.message || 'Perintah diproses ESP32.')
    );

    if (commandType === 'settings') {
      settingsDirty = false;
    }

  } else if (data.ok === false) {
    toast(
      'Perintah ditolak: ' +
      (
        data.error ||
        data.message ||
        'Alasan tidak diketahui.'
      )
    );

  } else {
    toast(
      'ACK diterima, tetapi status respons tidak dikenali.'
    );

    console.warn(
      '[ACK] Format status tidak dikenal:',
      data
    );
  }

  if (
    latest &&
    Array.isArray(latest.relays)
  ) {
    renderRelays(
      latest.relays,
      latest.autoMode
    );
  }
}


function clearAllPendingCommands() {
  for (const timer of ackTimers.values()) {
    clearTimeout(timer);
  }

  ackTimers.clear();
  pendingCommands.clear();
}
/* =========================================================
   RELAY DISPLAY
========================================================= */

function renderRelays(states, isAuto) {
  if (!Array.isArray(states)) return;

  const makeCards = manual => {
    return RELAYS.map((relay, index) => {
      const isOn =
        states[index] === true ||
        Number(states[index]) === 1;

      return `
        <article class="relay card">

          <span class="led ${isOn ? 'on' : ''}"></span>

          <div class="relay-info">
            <strong>${relay.name}</strong>

            <small>
              GPIO${relay.gpio} ·
              ${isOn ? 'ON' : 'OFF'}
            </small>
          </div>

          ${manual ? `
            <button
              class="${isOn ? 'secondary' : 'primary'} relay-toggle"
              data-ch="${index}"
              data-state="${isOn ? 0 : 1}"
              ${isAuto ? 'disabled' : ''}
            >
              ${isOn ? 'OFF' : 'ON'}
            </button>
          ` : ''}

        </article>
      `;

    }).join('');
  };

  const monitor = $('monitorRelays');
  const controls = $('controlRelays');

  if (monitor) {
    monitor.innerHTML = makeCards(false);
  }

  if (controls) {
    controls.innerHTML = makeCards(true);
  }

  document.querySelectorAll('.relay-toggle')
    .forEach(button => {

      button.addEventListener('click', () => {
        send({
          cmd: 'relay',
          ch: Number(button.dataset.ch),
          state: Number(button.dataset.state)
        });
      });

    });
}


/* =========================================================
   SENSOR DASHBOARD
   Field names follow publishSensorData() in ESP32 firmware.
========================================================= */

function updateUI(data) {
  const put = (id, value) => {
    const element = $(id);

    if (element) {
      element.textContent = value;
    }
  };

  put(
    'phValue',
    fmt(data.ph, 2, ' pH')
  );

  put(
    'phVolt',
    'Tegangan ' + fmt(data.phVoltage, 3, ' V')
  );

  put(
    'tdsValue',
    fmt(data.tdsPpm, 0, ' ppm')
  );

  put(
    'tdsVolt',
    'Tegangan ' + fmt(data.tdsVoltage, 3, ' V')
  );

  put(
    'waterValue',
    fmt(data.ds18b20C, 2, ' °C')
  );

  put(
    'airValue',
    fmt(data.dhtTempC, 2, ' °C')
  );

  put(
    'humidityValue',
    fmt(data.humidity, 1, ' %RH')
  );

  put(
    'adsStatus',
    data.adsReady ? 'OK' : 'Tidak terdeteksi'
  );

  put(
    'calPhCurrent',
    fmt(data.ph, 2, ' pH')
  );

  put(
    'calTdsCurrent',
    fmt(data.tdsPpm, 0, ' ppm')
  );

  put(
    'calWaterCurrent',
    fmt(data.ds18b20C, 2, ' °C')
  );

  put(
    'calAirCurrent',
    fmt(data.dhtTempC, 2, ' °C')
  );

  put(
    'calHumCurrent',
    fmt(data.humidity, 1, ' %RH')
  );

  put(
    'modeValue',
    data.autoMode ? 'OTOMATIS' : 'MANUAL'
  );

  put(
    'onlineValue',
    'Terhubung'
  );

  const interval = data.settings?.logIntervalSec;

  put(
    'sheetsValue',
    interval === 15
      ? '15 detik'
      : interval === 3600
        ? '1 jam'
        : 'Tidak diketahui'
  );

  put(
    'updated',
    'Diperbarui ' +
    new Date().toLocaleTimeString('id-ID')
  );

  const autoButton = $('autoBtn');
  const manualButton = $('manualBtn');

  if (autoButton) {
    autoButton.disabled = !!data.autoMode;
  }

  if (manualButton) {
    manualButton.disabled = !data.autoMode;
  }

  // Jangan timpa input ketika pengguna sedang mengedit threshold.
  if (data.settings && !settingsDirty) {
    const fields = [
      'phLow',
      'phHigh',
      'tdsLow',
      'tdsHigh',
      'humidityHigh',
      'humidityLow'
    ];

    fields.forEach(key => {
      const element = $(key);

      if (
        element &&
        data.settings[key] !== undefined &&
        data.settings[key] !== null
      ) {
        element.value = data.settings[key];
      }
    });

    const airTemp = $('airTempOn');

    if (
      airTemp &&
      data.settings.exhaustTemp != null
    ) {
      airTemp.value = data.settings.exhaustTemp;
    }

    const intervalInput = $('sheetsInterval');

    if (
      intervalInput &&
      data.settings.logIntervalSec != null
    ) {
      intervalInput.value =
        String(data.settings.logIntervalSec);
    }
  }

  if (Array.isArray(data.relays)) {
    renderRelays(
      data.relays,
      data.autoMode
    );
  }
}
/* =========================================================
   EVENT LISTENERS
========================================================= */

function bindEvents() {

  $('connectBtn')?.addEventListener(
    'click',
    connect
  );


  /* TAB NAVIGATION */

  document.querySelectorAll('.tab')
    .forEach(button => {

      button.addEventListener('click', () => {

        document.querySelectorAll('.tab')
          .forEach(item => {
            item.classList.toggle(
              'active',
              item === button
            );
          });

        document.querySelectorAll('.page')
          .forEach(page => {

            page.classList.toggle(
              'active',
              page.id ===
              'page-' + button.dataset.page
            );

          });

      });

    });


  /* KALIBRASI pH */

  $('calPhBtn')?.addEventListener('click', () => {

    const input = $('phReference');
    const value = Number(input?.value);

    if (
      !input ||
      input.value.trim() === '' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 14
    ) {
      toast(
        'Masukkan nilai pH pembanding antara 0–14.'
      );

      return;
    }

    if (
      !Number.isFinite(Number(latest?.phVoltage)) ||
      Number(latest.phVoltage) < 0
    ) {
      toast(
        'Tegangan sensor pH belum valid.'
      );

      return;
    }

    send({
      cmd: 'cal_ph',
      reference: value
    });

  });


  /* KALIBRASI TDS */

  $('calTdsBtn')?.addEventListener('click', () => {

    const input = $('tdsReference');
    const value = Number(input?.value);

    if (
      !input ||
      input.value.trim() === '' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !Number.isFinite(Number(latest?.tdsPpm)) ||
      Number(latest.tdsPpm) <= 0
    ) {
      toast(
        'Nilai TDS pembanding atau pembacaan sensor tidak valid.'
      );

      return;
    }

    send({
      cmd: 'cal_tds',
      reference: value
    });

  });


  /* KALIBRASI OFFSET */

  document.querySelectorAll('.offset-btn')
    .forEach(button => {

      button.addEventListener('click', () => {

        const input = $(button.dataset.input);
        const value = Number(input?.value);

        if (
          !input ||
          input.value.trim() === '' ||
          !Number.isFinite(value)
        ) {
          toast(
            'Masukkan nilai alat pembanding yang valid.'
          );

          return;
        }

        send({
          cmd: 'cal_offset',
          sensor: button.dataset.sensor,
          reference: value
        });

      });

    });


  /* RESET KALIBRASI */

  $('resetCalibration')?.addEventListener('click', () => {

    if (confirm('Reset seluruh kalibrasi sensor?')) {
      send({
        cmd: 'reset_cal'
      });
    }

  });


  /* THRESHOLD INPUT */

  [
    'phLow',
    'phHigh',
    'tdsLow',
    'tdsHigh',
    'humidityHigh',
    'humidityLow',
    'airTempOn'

  ].forEach(id => {

    $(id)?.addEventListener('input', () => {
      settingsDirty = true;
    });

  });


  /* SUBMIT THRESHOLD */

  $('settingsForm')?.addEventListener('submit', event => {

    event.preventDefault();

    const ids = [
      'phLow',
      'phHigh',
      'tdsLow',
      'tdsHigh',
      'humidityHigh',
      'humidityLow',
      'airTempOn'
    ];

    if (
      ids.some(id =>
        !$(id) ||
        $(id).value.trim() === ''
      )
    ) {
      toast(
        'Semua parameter threshold wajib diisi.'
      );

      return;
    }

    const values = {

      phLow: Number($('phLow').value),

      phHigh: Number($('phHigh').value),

      tdsLow: Number($('tdsLow').value),

      tdsHigh: Number($('tdsHigh').value),

      humidityHigh: Number($('humidityHigh').value),

      humidityLow: Number($('humidityLow').value),

      exhaustTemp: Number($('airTempOn').value)

    };


    const valid =

      Object.values(values).every(Number.isFinite) &&

      values.phLow >= 0 &&

      values.phHigh <= 14 &&

      values.phHigh > values.phLow &&

      values.tdsLow >= 0 &&

      values.tdsHigh <= 10000 &&

      values.tdsHigh > values.tdsLow &&

      values.humidityLow >= 0 &&

      values.humidityHigh <= 100 &&

      values.humidityHigh > values.humidityLow &&

      values.exhaustTemp >= 0 &&

      values.exhaustTemp <= 60;


    if (!valid) {

      toast(
        'Threshold tidak valid. Periksa batas minimum dan maksimum.'
      );

      return;
    }


    const interval = Number(
      $('sheetsInterval')?.value
    );

    if (
      interval !== 15 &&
      interval !== 3600
    ) {
      toast(
        'Interval Google Sheets harus 15 atau 3600 detik.'
      );

      return;
    }


    settingsDirty = true;

    // Kirim threshold sebagai satu perintah lengkap.
    if (!send({
      cmd: 'settings',
      ...values
    })) {
      return;
    }

    // Interval dikirim terpisah karena firmware
    // memiliki command tersendiri.
    send({
      cmd: 'log_interval',
      seconds: interval
    });

  });


  /* MODE OTOMATIS */

  $('autoBtn')?.addEventListener('click', () => {

    send({
      cmd: 'mode',
      mode: 'auto'
    });

  });


  /* MODE MANUAL */

  $('manualBtn')?.addEventListener('click', () => {

    send({
      cmd: 'mode',
      mode: 'manual'
    });

  });


  /* ALL OFF */

  $('allOff')?.addEventListener('click', () => {

    send({
      cmd: 'alloff'
    });

  });


  $('quickOff')?.addEventListener('click', () => {

    send({
      cmd: 'alloff'
    });

  });

}
/* =========================================================
   START
========================================================= */

document.addEventListener('DOMContentLoaded', () => {

  // Isi nilai default jika elemen input tersedia
  // dan masih kosong.

  if (
    $('brokerUrl') &&
    !$('brokerUrl').value
  ) {
    $('brokerUrl').value = DEFAULT_BROKER;
  }

  if (
    $('rootTopic') &&
    !$('rootTopic').value
  ) {
    $('rootTopic').value = DEFAULT_ROOT;
  }

  bindEvents();

  // Koneksi otomatis hanya jika library MQTT tersedia.

  if (typeof mqtt !== 'undefined') {

    connect();

  } else {

    setBadge(
      'brokerBadge',
      'Library MQTT belum tersedia',
      'err'
    );

    console.error(
      '[MQTT] MQTT.js belum dimuat oleh index.html.'
    );

  }

});
