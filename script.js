'use strict';
const DEFAULT_BROKER='wss://broker.emqx.io:8084/mqtt';
const DEFAULT_ROOT='hidroponik/demo01';
const RELAYS=[
  {name:'Pompa pH Up',gpio:27},{name:'Pompa pH Down',gpio:33},{name:'Pompa Nutrisi A',gpio:19},
  {name:'Exhaust Fan',gpio:13},{name:'Pompa Nutrisi B',gpio:14},{name:'Pompa Air Bersih',gpio:25}
];
const $=id=>document.getElementById(id);let client=null,latest=null,root=DEFAULT_ROOT,ackTimers=new Map(),toastTimer=null;
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),4000)}
function setBadge(id,text,state){const el=$(id);el.textContent=text;el.className='badge '+state}
function fmt(v,d=2,suffix=''){return Number.isFinite(Number(v))&&v!==null&&v!==''?Number(v).toFixed(d)+suffix:'—'}
function connect(){
  const url=$('brokerUrl').value.trim();root=$('rootTopic').value.trim().replace(/\/+$/,'');
  if(!url||!root){toast('Broker dan root topic wajib diisi.');return}
  if(client){try{client.end(true)}catch(e){}client=null}
  setBadge('brokerBadge','Broker menghubungkan…','warn');setBadge('deviceBadge','ESP32 menunggu…','warn');
  client=mqtt.connect(url,{clientId:'hidro-web-'+Math.random().toString(16).slice(2,10),clean:true,connectTimeout:12000,reconnectPeriod:3000,keepalive:30,resubscribe:true});
  client.on('connect',()=>{setBadge('brokerBadge','Broker terhubung','ok');client.subscribe([root+'/sensor',root+'/ack',root+'/availability']);toast('Broker MQTT terhubung.');});
  client.on('reconnect',()=>setBadge('brokerBadge','Menyambungkan ulang…','warn'));
  client.on('offline',()=>setBadge('brokerBadge','Broker offline','err'));
  client.on('error',e=>{console.error(e);setBadge('brokerBadge','Broker bermasalah','err')});
  client.on('message',(topic,payload)=>{let d;try{d=JSON.parse(payload.toString())}catch(e){return}
    if(topic===root+'/sensor'){latest=d;setBadge('deviceBadge','ESP32 online','ok');updateUI(d)}
    if(topic===root+'/availability'){setBadge('deviceBadge',d.deviceOnline?'ESP32 online':'ESP32 offline',d.deviceOnline?'ok':'err')}
    if(topic===root+'/ack')handleAck(d);
  });
}
function send(command){if(!client||!client.connected){toast('Dashboard belum terhubung ke broker MQTT.');return false}
  const commandId='web-'+Date.now()+'-'+Math.random().toString(16).slice(2,6);command.commandId=commandId;
  client.publish(root+'/command',JSON.stringify(command),{qos:1},err=>{if(err)toast('Gagal publish: '+err.message)});
  const timer=setTimeout(()=>{ackTimers.delete(commandId);toast('Tidak ada ACK dari ESP32. Periksa topic MQTT, firmware, dan Serial Monitor.')},8000);
  ackTimers.set(commandId,timer);return true;
}
function handleAck(d){const id=d.commandId;if(id&&ackTimers.has(id)){clearTimeout(ackTimers.get(id));ackTimers.delete(id)}
  if(d.ok===false)toast('Perintah gagal: '+(d.error||'ditolak'));
  else if(d.ok===true)toast('Berhasil: '+(d.message||'perintah diproses ESP32'));
  if(latest&&Array.isArray(latest.relays))renderRelays(latest.relays,latest.autoMode);
}
function renderRelays(states,isAuto){const make=(manual)=>RELAYS.map((r,i)=>`<article class="relay card"><span class="led ${states[i]?'on':''}"></span><div class="relay-info"><strong>${r.name}</strong><small>GPIO${r.gpio} · ${states[i]?'ON':'OFF'}</small></div>${manual?`<button class="${states[i]?'secondary':'primary'} relay-toggle" data-ch="${i}" data-state="${states[i]?0:1}" ${isAuto?'disabled':''}>${states[i]?'OFF':'ON'}</button>`:''}</article>`).join('');
  $('monitorRelays').innerHTML=make(false);$('controlRelays').innerHTML=make(true);
  document.querySelectorAll('.relay-toggle').forEach(b=>b.addEventListener('click',()=>send({cmd:'relay',ch:Number(b.dataset.ch),state:Number(b.dataset.state)})));
}
function updateUI(d){
  $('phValue').textContent=fmt(d.ph,2,' pH');$('phVolt').textContent='Tegangan '+fmt(d.phVoltage,3,' V');$('tdsValue').textContent=fmt(d.tdsPpm,0,' ppm');$('tdsVolt').textContent='Tegangan '+fmt(d.tdsVoltage,3,' V');
  $('waterValue').textContent=fmt(d.ds18b20C,2,' °C');$('airValue').textContent=fmt(d.dhtTempC,2,' °C');$('humidityValue').textContent=fmt(d.humidity,1,' %RH');$('adsStatus').textContent=d.adsReady?'OK':'Tidak terdeteksi';
  $('calPhCurrent').textContent=fmt(d.ph,2,' pH');$('calTdsCurrent').textContent=fmt(d.tdsPpm,0,' ppm');$('calWaterCurrent').textContent=fmt(d.ds18b20C,2,' °C');$('calAirCurrent').textContent=fmt(d.dhtTempC,2,' °C');$('calHumCurrent').textContent=fmt(d.humidity,1,' %RH');
  $('modeValue').textContent=d.autoMode?'OTOMATIS':'MANUAL';$('onlineValue').textContent='Terhubung';$('sheetsValue').textContent=(d.settings?.logIntervalSec===15?'15 detik':'1 jam');$('updated').textContent='Diperbarui '+new Date().toLocaleTimeString('id-ID');
  $('autoBtn').disabled=!!d.autoMode;$('manualBtn').disabled=!d.autoMode;
  if(d.settings){for(const k of ['phLow','phHigh','tdsLow','tdsHigh','humidityHigh','humidityLow'])if($(k)&&d.settings[k]!=null)$(k).value=d.settings[k];if($('airTempOn'))$('airTempOn').value=d.settings.exhaustTemp??30;if($('sheetsInterval'))$('sheetsInterval').value=String(d.settings.logIntervalSec??3600)}
  if(Array.isArray(d.relays))renderRelays(d.relays,d.autoMode);
}
$('connectBtn').addEventListener('click',connect);
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id==='page-'+b.dataset.page))}));
$('calPhBtn').addEventListener('click',()=>{const v=$('phReference').value;if(v===''||!Number.isFinite(Number(v))||Number(v)<0||Number(v)>14){toast('Masukkan nilai pH pembanding 0–14.');return}if(!Number.isFinite(Number(latest?.phVoltage))||Number(latest.phVoltage)<0){toast('Tegangan sensor pH belum valid.');return}send({cmd:'cal_ph',reference:Number(v)})});
$('calTdsBtn').addEventListener('click',()=>{const v=Number($('tdsReference').value);if(!(v>0)||!Number.isFinite(Number(latest?.tdsPpm))||latest.tdsPpm<=0){toast('Nilai TDS pembanding atau pembacaan sensor tidak valid.');return}send({cmd:'cal_tds',reference:v})});
document.querySelectorAll('.offset-btn').forEach(b=>b.addEventListener('click',()=>{const input=$(b.dataset.input),v=Number(input.value);if(input.value===''||!Number.isFinite(v)){toast('Masukkan nilai alat pembanding.');return}send({cmd:'cal_offset',sensor:b.dataset.sensor,reference:v})}));
$('resetCalibration').addEventListener('click',()=>{if(confirm('Reset seluruh kalibrasi sensor?'))send({cmd:'reset_cal'})});
$('settingsForm').addEventListener('submit',e=>{e.preventDefault();const v={phLow:Number($('phLow').value),phHigh:Number($('phHigh').value),tdsLow:Number($('tdsLow').value),tdsHigh:Number($('tdsHigh').value),humidityHigh:Number($('humidityHigh').value),humidityLow:Number($('humidityLow').value),exhaustTemp:Number($('airTempOn').value)};if(v.phHigh<=v.phLow||v.tdsHigh<=v.tdsLow||v.humidityHigh<=v.humidityLow){toast('Batas atas harus lebih besar dari batas bawah.');return}send({cmd:'settings',...v});const sec=Number($('sheetsInterval').value);if(sec===15||sec===3600)send({cmd:'log_interval',seconds:sec})});
$('autoBtn').addEventListener('click',()=>send({cmd:'mode',mode:'auto'}));$('manualBtn').addEventListener('click',()=>send({cmd:'mode',mode:'manual'}));$('allOff').addEventListener('click',()=>send({cmd:'alloff'}));$('quickOff').addEventListener('click',()=>send({cmd:'alloff'}));
connect();
