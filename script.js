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
let client=null, latest=null, root=DEFAULT_ROOT, ackTimer=null, toastTimer=null, thresholdDirty=false;
function toast(msg){const e=$("toast");e.textContent=msg;e.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove("show"),3500)}
function badge(state,label){const e=$("connectionBadge");e.className="badge "+(state==="ok"?"badge-ok":state==="error"?"badge-error":"badge-warn");e.textContent=label}
function num(v,d=2){return v==null||!Number.isFinite(Number(v))?"—":Number(v).toFixed(d)}
function connect(){
 if(client){try{client.end(true)}catch(e){}}
 const url=$("mqttUrl").value.trim(), username=$("mqttUser").value.trim(), password=$("mqttPass").value;
 root=DEFAULT_ROOT;
 if(!url){toast("Alamat broker MQTT WebSocket wajib diisi.");return}
 badge("wait","Menghubungkan MQTT…");
 client=mqtt.connect(url,{username:username||undefined,password:password||undefined,clean:true,connectTimeout:10000,reconnectPeriod:3000,clientId:"hidro-web-"+Math.random().toString(16).slice(2,10)});
 client.on("connect",()=>{badge("ok","Broker MQTT terhubung");client.subscribe(root+"/sensor");client.subscribe(root+"/ack");client.publish(root+"/command",JSON.stringify({cmd:"get_status"}));toast("Terhubung ke broker. Menunggu data ESP32…")});
 client.on("reconnect",()=>badge("wait","Menyambung ulang…"));
 client.on("error",e=>{badge("error","Koneksi MQTT gagal");console.error(e)});
 client.on("close",()=>badge("error","MQTT terputus"));
 client.on("message",(t,p)=>{
  let d;try{d=JSON.parse(p.toString())}catch(e){return}
  if(t===root+"/sensor"){latest=d;updateUI(d)}
  if(t===root+"/ack"){if(d.ok===false)toast(d.error||"Perintah ditolak");else if(d.message)toast(d.message)}
 });
}
function send(obj){if(!client||!client.connected){toast("Dashboard belum terhubung ke broker MQTT.");return false}client.publish(root+"/command",JSON.stringify(obj));return true}
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
 $("calCurrentTds").textContent=`${num(d.tdsPpm,0)} ppm`;$("calCurrentPh").textContent=`${num(d.phVoltage,3)} V`;$("lastUpdated").textContent=`Diperbarui ${new Date().toLocaleTimeString("id-ID")}`;
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
$("calibrateTds").addEventListener("click",()=>{let standard=Number($("tdsStandard").value);if(standard>0)send({cmd:"cal_tds",standard});else toast("Nilai standar tidak valid")});
$("phPoint").addEventListener("change",()=>$("phBuffer").value=$("phPoint").value==="low"?"4.00":"6.86");
$("calibratePh").addEventListener("click",()=>{let buffer=Number($("phBuffer").value);if(buffer<0||buffer>14){toast("Buffer harus 0–14");return}send({cmd:"cal_ph",point:$("phPoint").value,buffer})});
$("resetCalibration").addEventListener("click",()=>{if(confirm("Reset kalibrasi pH dan TDS?"))send({cmd:"reset_cal"})});
document.querySelectorAll(".pump-test").forEach(b=>b.addEventListener("click",()=>pumpTest(b.dataset.pump)));
document.querySelectorAll(".pump-save").forEach(b=>b.addEventListener("click",()=>pumpCal(b.dataset.pump)));
document.querySelectorAll(".pump-dose").forEach(b=>b.addEventListener("click",()=>pumpDose(b.dataset.pump)));
$("autoModeBtn").addEventListener("click",()=>send({cmd:"mode",mode:"auto"}));$("manualModeBtn").addEventListener("click",()=>send({cmd:"mode",mode:"manual"}));
$("allOff").addEventListener("click",()=>send({cmd:"alloff"}));$("quickAllOff").addEventListener("click",()=>send({cmd:"alloff"}));
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===t));document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${t.dataset.page}`))}));
$("mqttUrl").value=localStorage.getItem("hidroMqttUrl")||DEFAULT_BROKER;$("mqttUser").value=localStorage.getItem("hidroMqttUser")||"";
window.addEventListener("beforeunload",()=>{if(client)client.end(true)});
