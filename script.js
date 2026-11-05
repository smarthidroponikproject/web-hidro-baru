// MQTT dashboard: browser connects to broker over WebSocket; ESP32 uses MQTT/TCP.
const DEFAULT_BROKER="wss://broker.emqx.io:8084/mqtt";
const DEFAULT_ROOT="hidroponik/demo01"; // harus sama dengan ROOT_TOPIC pada firmware
const relayNames=[
"Pompa pH Up · U11 IN1 (GPIO27)","Pompa pH Down · U11 IN2 (GPIO33)",
"TIDAK DIGUNAKAN · U11 IN3 (GPIO18)","Pompa Nutrisi A · U11 IN4 (GPIO19)",
"Kipas exhaust · U12 IN1 (GPIO13)","Pompa Nutrisi B · U12 IN2 (GPIO14)",
"Relay cadangan · U12 IN3 (GPIO25)","TIDAK DIGUNAKAN · U12 IN4 (GPIO26)"];
const relayUsed=[true,true,false,true,true,true,true,false];
const $=id=>document.getElementById(id);
let client=null, latest=null, root=DEFAULT_ROOT, ackTimer=null, toastTimer=null, thresholdDirty=false, deviceHeartbeatAt=0, deviceReportedOnline=false, availabilityKnown=false;
function toast(msg){const e=$("toast");e.textContent=msg;e.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove("show"),3500)}
function badge(state,label){const e=$("connectionBadge");e.className="badge "+(state==="ok"?"badge-ok":state==="error"?"badge-error":"badge-warn");e.textContent=label}
function num(v,d=2){return v==null||!Number.isFinite(Number(v))?"—":Number(v).toFixed(d)}
function setDeviceStatus(online,label){
 const e=$("deviceBadge"); if(!e)return;
 e.className="badge "+(online?"badge-ok":"badge-error");
 e.textContent=label || (online?"Sistem: ESP32 online":"Sistem: ESP32 offline");
}
function connect(){
 if(client){try{client.end(true)}catch(e){}}
 const url=$("mqttUrl").value.trim(), username=$("mqttUser").value.trim(), password=$("mqttPass").value;
 root=DEFAULT_ROOT; latest=null;deviceHeartbeatAt=0;deviceReportedOnline=false;availabilityKnown=false;
 setDeviceStatus(false,"Sistem: menunggu ESP32");
 if(!url){toast("Alamat broker MQTT WebSocket wajib diisi.");return}
 badge("wait","Broker: menghubungkan…");
 client=mqtt.connect(url,{username:username||undefined,password:password||undefined,clean:true,connectTimeout:10000,reconnectPeriod:3000,clientId:"hidro-web-"+Math.random().toString(16).slice(2,10)});
 client.on("connect",()=>{
  badge("ok","Broker: terhubung");
  client.subscribe([root+"/sensor",root+"/ack",root+"/availability"]);
  toast("Broker tersambung. Memeriksa status ESP32…");
 });
 client.on("reconnect",()=>{badge("wait","Broker: menyambung ulang");setDeviceStatus(false,"Sistem: belum terverifikasi")});
 client.on("error",e=>{badge("error","Broker: koneksi gagal");console.error(e)});
 client.on("close",()=>{badge("error","Broker: terputus");setDeviceStatus(false,"Sistem: tidak terpantau")});
 client.on("message",(t,p)=>{
  let d;try{d=JSON.parse(p.toString())}catch(e){return}
  if(t===root+"/availability"){
    availabilityKnown=true;deviceReportedOnline=d.deviceOnline===true;
    if(!deviceReportedOnline){deviceHeartbeatAt=0;setDeviceStatus(false,"Sistem: ESP32 offline");}
    else {deviceHeartbeatAt=Date.now();setDeviceStatus(true,"Sistem: ESP32 online");}
  }
  if(t===root+"/sensor"){
    latest=d;deviceHeartbeatAt=Date.now();
    // Availability retained/LWT is the primary indicator; sensor heartbeat is a secondary check.
    if(d.deviceOnline===true){
      deviceHeartbeatAt=Date.now();
      if(!availabilityKnown || deviceReportedOnline){deviceReportedOnline=true;setDeviceStatus(true,"Sistem: ESP32 online");}
    }
    updateUI(d);
  }
  if(t===root+"/ack"){
    if(d.ok===false)toast("Kalibrasi/perintah gagal: "+(d.error||"Perintah ditolak"));
    else if(d.ok===true)toast("Berhasil: "+(d.message||"Perintah diterima ESP32"));
  }
 });
}
setInterval(()=>{
 if(!client||!client.connected){setDeviceStatus(false,"Sistem: tidak terpantau");return}
 if(deviceHeartbeatAt && Date.now()-deviceHeartbeatAt>9000){
   deviceReportedOnline=false;setDeviceStatus(false,"Sistem: heartbeat terhenti");
 }
},2000);
function send(obj){
 if(!client||!client.connected){toast("Gagal: dashboard belum terhubung ke broker MQTT.");return false}
 if(!deviceReportedOnline){toast("Gagal: ESP32 belum terdeteksi ONLINE. Periksa daya dan koneksi perangkat.");return false}
 client.publish(root+"/command",JSON.stringify(obj),{qos:1},err=>{
   if(err) toast("Gagal mengirim perintah MQTT: "+err.message);
   else toast("Perintah terkirim. Menunggu konfirmasi ESP32…");
 });
 return true;
}
function renderRelays(targetId,states,manual){
 const target=$(targetId);if(!Array.isArray(states)){target.innerHTML='<p class="muted">Status relay menunggu data MQTT.</p>';return}
 target.innerHTML=states.map((on,i)=>({on,i})).filter(x=>relayUsed[x.i]).map(({on,i})=>`<article class="relay-card"><span class="relay-led ${on?"on":""}"></span><div class="relay-info"><strong>${relayNames[i]}</strong><small>Status: ${on?"ON":"OFF"}</small></div>${manual?`<div class="relay-actions"><button class="btn ${on?"btn-off":"btn-on"}" data-ch="${i}" data-state="${on?0:1}" ${latest?.autoMode?"disabled":""}>${on?"OFF":"ON"}</button></div>`:""}</article>`).join("");
 target.querySelectorAll("button[data-ch]").forEach(b=>b.addEventListener("click",()=>send({cmd:"relay",ch:Number(b.dataset.ch),state:Number(b.dataset.state)})));
}
function fillSettings(s){if(!s||thresholdDirty)return;["phLow","phHigh","tdsLow","tdsHigh","humidityHigh","humidityLow","exhaustTemp"].forEach(k=>{if($(k)&&s[k]!=null)$(k).value=s[k]})}
function updateUI(d){
 $("phValue").textContent=num(d.ph);$("phVoltage").textContent=`Tegangan: ${num(d.phVoltage,3)} V`;$("phRaw").textContent=`ADC: ${d.phRaw??"—"}`;
 $("dsValue").textContent=`${num(d.ds18b20C)} °C`;$("dhtValue").textContent=`${num(d.dhtTempC)} °C`;$("humidityValue").textContent=`Kelembapan ${num(d.humidity,1)} %RH`;
 $("tdsValue").textContent=`${num(d.tdsPpm,0)} ppm`;$("tdsVoltage").textContent=`Tegangan: ${num(d.tdsVoltage,4)} V`;$("tdsRaw").textContent=`ADC ADS1115: ${d.tdsRaw??"—"} · ${d.adsReady?"ADS1115 OK":"ADS1115 tidak terdeteksi"}`;
 $("calCurrentTds").textContent=`${num(d.tdsPpm,0)} ppm`;$("calCurrentPh").textContent=`${num(d.phVoltage,3)} V`;
 $("calDsCurrent").textContent=`${num(d.ds18b20C)} °C`;$("calDhtTempCurrent").textContent=`${num(d.dhtTempC)} °C`;$("calHumidityCurrent").textContent=`${num(d.humidity,1)} %RH`;$("lastUpdated").textContent=`Diperbarui ${new Date().toLocaleTimeString("id-ID")}`;
 $("modeStatus").textContent=d.autoMode?"Otomatis":"Manual";$("autoStatus").textContent=d.autoStatus||"—";$("autoModeBtn").disabled=!!d.autoMode;$("manualModeBtn").disabled=!d.autoMode;
 renderRelays("monitorRelayGrid",d.relays,false);renderRelays("controlRelayGrid",d.relays,true);fillSettings(d.settings);
 const rates=d.settings?.pumpRates||{};["phup","phdown","nutra","nutrb"].forEach(k=>{const e=$("rate-"+k);if(e)e.textContent=Number(rates[k])>0?`${Number(rates[k]).toFixed(3)} mL/detik · ${(Number(rates[k])*60).toFixed(1)} mL/menit`:"Belum dikalibrasi"});
}
function pumpTest(p){let s=Number($("seconds-"+p).value);if(!(s>=1&&s<=30)){toast("Durasi harus 1–30 detik.");return}send({cmd:"pump_test",pump:p,seconds:s})}
function pumpCal(p){let s=Number($("seconds-"+p).value),v=Number($("volume-"+p).value);if(!(s>=1&&s<=30&&v>0)){toast("Isi durasi dan volume aktual.");return}send({cmd:"pump_cal",pump:p,seconds:s,volume:v})}
function pumpDose(p){let ml=Number($("dose-"+p).value);if(!(ml>0&&ml<=100)){toast("Dosis harus 0–100 mL.");return}if(confirm(`Jalankan perkiraan dosis ${ml} mL untuk ${p}?`))send({cmd:"pump_dose",pump:p,ml})}
function saveThresholds(e){e.preventDefault();let v={};["phLow","phHigh","tdsLow","tdsHigh","humidityHigh","humidityLow","exhaustTemp"].forEach(k=>v[k]=Number($(k).value));if(v.phHigh<=v.phLow||v.tdsHigh<=v.tdsLow||v.humidityHigh<=v.humidityLow){toast("Batas atas harus lebih besar dari batas bawah.");return}thresholdDirty=false;send({cmd:"settings",...v})}
$("saveMqtt").addEventListener("click",()=>{localStorage.setItem("hidroMqttUrl",$("mqttUrl").value.trim());localStorage.setItem("hidroMqttUser",$("mqttUser").value.trim());connect()});
$("settingsForm").addEventListener("input",()=>thresholdDirty=true);$("settingsForm").addEventListener("submit",saveThresholds);
$("calibrateTds").addEventListener("click",()=>{
 const raw=$("tdsStandard").value, standard=Number(raw);
 if(raw.trim()===""||!Number.isFinite(standard)||standard<=0){toast("Masukkan nilai pembanding TDS yang valid (lebih dari 0 ppm).");return}
 if(!Number.isFinite(Number(latest?.tdsPpm))||Number(latest.tdsPpm)<=0){toast("Gagal: pembacaan TDS ESP32 belum valid. Periksa sensor dan ADS1115.");return}
 send({cmd:"cal_offset",sensor:"tds",reference:standard});
});
document.querySelectorAll(".cal-offset").forEach(b=>b.addEventListener("click",()=>{
 const id={ds18b20:"refDs",dht_temp:"refDhtTemp",humidity:"refHumidity"}[b.dataset.sensor];
 const reference=Number($(id).value);
 if(!Number.isFinite(reference)||$(id).value===""){toast("Masukkan nilai dari alat pembanding.");return}
 if(!latest){toast("Belum menerima data sensor dari ESP32.");return}
 const currentKey={ds18b20:"ds18b20C",dht_temp:"dhtTempC",humidity:"humidity"}[b.dataset.sensor];
 if(!Number.isFinite(Number(latest[currentKey]))){toast("Pembacaan sensor tidak valid. Kalibrasi dibatalkan.");return}
 if(b.dataset.sensor==="humidity"&&(reference<0||reference>100)){toast("Kelembapan harus 0–100 %RH.");return}
 send({cmd:"cal_offset",sensor:b.dataset.sensor,reference});
}));
$("phPoint").addEventListener("change",()=>$("phBuffer").value=$("phPoint").value==="low"?"4.00":"6.86");
$("calibratePh").addEventListener("click",()=>{
 const raw=$("phBuffer").value, buffer=Number(raw);
 if(raw.trim()===""||!Number.isFinite(buffer)||buffer<0||buffer>14){toast("Nilai buffer pH harus berada pada rentang 0–14.");return}
 if(!Number.isFinite(Number(latest?.phVoltage))){toast("Tegangan probe pH belum valid. Periksa sensor terlebih dahulu.");return}
 send({cmd:"cal_ph",point:$("phPoint").value,buffer});
});
$("resetCalibration").addEventListener("click",()=>{if(confirm("Reset seluruh kalibrasi pH, DS18B20, DHT22 (suhu/kelembapan), dan TDS?"))send({cmd:"reset_cal"})});
document.querySelectorAll(".pump-test").forEach(b=>b.addEventListener("click",()=>pumpTest(b.dataset.pump)));
document.querySelectorAll(".pump-save").forEach(b=>b.addEventListener("click",()=>pumpCal(b.dataset.pump)));
document.querySelectorAll(".pump-dose").forEach(b=>b.addEventListener("click",()=>pumpDose(b.dataset.pump)));
$("autoModeBtn").addEventListener("click",()=>send({cmd:"mode",mode:"auto"}));$("manualModeBtn").addEventListener("click",()=>send({cmd:"mode",mode:"manual"}));
$("allOff").addEventListener("click",()=>send({cmd:"alloff"}));$("quickAllOff").addEventListener("click",()=>send({cmd:"alloff"}));
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===t));document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${t.dataset.page}`))}));
$("mqttUrl").value=localStorage.getItem("hidroMqttUrl")||DEFAULT_BROKER;$("mqttUser").value=localStorage.getItem("hidroMqttUser")||"";
window.addEventListener("beforeunload",()=>{if(client)client.end(true)});
