const $ = (id) => document.getElementById(id);
const reloadHint = "Reload ClipForge Live at chrome://extensions, then reopen this popup. The popup and background are out of sync.";
let workerReady=false;
async function command(type, data={}) {
  let timeout;
  try {
    const result=await Promise.race([chrome.runtime.sendMessage({target:"background",type,...data}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("The extension did not respond. Reload ClipForge Live and try again.")),45000);})]);
    if (/unknown command/i.test(result?.error||"")) throw Error(reloadHint);
    return result;
  } finally {clearTimeout(timeout);}
}
const modeText = {low: "Waits for broader, sustained reactions. Fewer clips to review.", normal: "A balance of clear reactions and smaller highlights.", high: "Includes smaller reactions. Expect more clips to review."};
let sensitivity = "normal", busy = false, initialized = false, latest = {}, actionError = "";
function notice(text) { $("notice").textContent = text; $("notice").hidden = !text; }
function showError(text) { $("error").textContent = text; $("error").hidden = !text; }
function setConn(text) {
  $("connection-state").textContent = text; $("conn-text").textContent = text === "Not paired" ? "Not connected" : text;
  $("conn").dataset.tone = text === "Connected" ? "ok" : /attention|Not/.test(text) ? "bad" : "idle";
}
function setInbox(port) { for (const id of ["inbox", "clips-open", "shorts-open"]) $(id).href = `http://127.0.0.1:${Number(port || 8000)}/#/live${id==="shorts-open"?"?tools=1":""}`; }
const clock = (sec) => `${Math.floor(sec / 60).toString().padStart(2, "0")}:${(sec % 60).toString().padStart(2, "0")}`;
let tab = null; // what the active tab is, from the background TAB check
async function connectionDetail() {
  const s=await chrome.storage.local.get("connectionCheck"),check=s.connectionCheck;
  if(check) $("connection-detail").textContent=check.phase==="connected"?`${check.detail} · ${new Date(check.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`:check.detail;
}
$("conn").onclick=()=>{$("connection").open=true;$("connection").scrollIntoView({behavior:"smooth"});};
$("reload-extension").onclick=async()=>{
  try {const s=await command("STATUS");if(!s||s.ok===false||s.recording||s.stopping)throw Error("Stop capture before reloading the extension.");chrome.runtime.reload();}
  catch(e){actionError=e.message;showError(actionError);}
};
async function checkTab() {
  if (latest.recording) return;
  try { const t = await command("TAB"); tab = t && typeof t.supported === "boolean" ? t : null; } catch { tab = null; }
  draw(latest);
}
// 60 one-second bars. Yellow while a highlight is being collected, the newest bar brighter.
function spark(history = []) {
  const slots = 60, w = 348 / slots, pad = 60 - history.length;
  let bars = "";
  for (let i = 0; i < slots; i++) {
    const p = history[i - pad], h = p ? Math.max(2, Math.round(p.s / 100 * 42)) : 2;
    const tone = !p ? "empty" : p.a ? "hot" : i === slots - 1 ? "now" : "base";
    bars += `<rect class="${tone}" x="${(i * w + 0.6).toFixed(1)}" y="${44 - h}" width="${(w - 1.6).toFixed(1)}" height="${h}" rx="1"/>`;
  }
  $("spark").innerHTML = bars;
}
function clipList(clips = []) {
  $("clips-box").hidden = !clips.length;
  $("clips").innerHTML = clips.map((c) => `<li><span class="at">${clock(Math.max(0, c.at || 0))}</span><span class="why"></span><span class="len">${Number(c.length) || 0}s</span><span class="st" data-state="${c.state === "sent" ? "sent" : "waiting"}">${c.state === "sent" ? "Sent" : "Waiting"}</span></li>`).join("");
  [...$("clips").querySelectorAll(".why")].forEach((el, i) => { el.textContent = clips[i].reason || "Highlight"; });
}
$("pair").onclick = async () => {
  if (busy) return;
  busy = true; $("pair").disabled = true; actionError = ""; showError(""); notice("");
  setConn("Pairing…"); $("pair").textContent = "Connecting…";
  try {
    if (!$("port").value || !$("port").checkValidity()) throw Error("Enter a port between 1024 and 65535.");
    const r = await command("PAIR", {port: Number($("port").value)});
    if (!r?.ok) throw Error(r?.error || "Could not pair with ClipForge.");
    const s = await chrome.storage.local.get(["token", "port"]);
    $("token").value = s.token || ""; $("port").value = s.port || 8000;
    setInbox(s.port);
    setConn("Connected"); $("connection").open = false;
    notice("Connected. Open a stream and start capture.");
  } catch(e) { setConn("Needs attention"); actionError = e.message; showError(actionError); }
  finally { busy = false; $("pair").disabled = !workerReady; $("pair").textContent = "Connect app"; await connectionDetail(); await refresh(); }
};
function mode() {
  document.querySelectorAll("[data-sensitivity]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sensitivity === sensitivity)));
  $("mode-hint").textContent = modeText[sensitivity];
  $("timing-summary").textContent = `${$("pre").value}s before · ${$("tail").value}s after`;
}
async function save() {
  const options = {sensitivity, sound: $("sound").checked, listen: !$("silent").checked};
  for (const id of ["pre", "tail", "max"]) {
    if (!$(id).value || !$(id).checkValidity()) throw Error(`Enter ${id === "pre" ? "lead-in" : id === "tail" ? "ending" : id === "max" ? "maximum" : "port"} between ${$(id).min} and ${$(id).max}.`);
    if (id !== "port") options[id] = Number($(id).value);
  }
  await chrome.storage.local.set({options});
  mode();
  $("settings-state").textContent = latest.recording ? "For next capture" : "Saved automatically";
}
function draw(s) {
  latest = s;
  $("audio-status").textContent=s.recording ? s.audio_level > .002 ? "Audio is reaching the recorder" : "No sound detected right now" : "";
  const active = s.recording && s.active;
  $("monitor").dataset.state = active ? "moment" : s.recording ? "recording" : "idle";
  $("phase").textContent = s.stopping ? "Finishing capture" : active ? "Collecting highlight" : s.recording ? "Capture running" : "Capture stopped";
  $("elapsed").textContent = clock(s.elapsed || 0);
  $("state").textContent = s.stopping ? "Finishing your clip…" : active ? "Moment detected" : !s.recording ? "Ready to capture" : !s.warmed ? "Learning this chat…" : s.candidate ? "Reaction building…" : "Watching for moments";
  $("state-hint").textContent = s.stopping ? "Keeping the ending and preparing the upload." : active ? `${s.reason || "Reaction detected"}. Saving after ${s.tailRemaining ?? 12}s of quiet.` :
    !s.recording ? tab && !tab.supported ? `${tab.reason}, then start.` : s.saved ? "Your clips are in the inbox. Start again when ready." : "Open a live stream with its chat, then start." :
    !s.warmed ? `${s.warmupRemaining ?? 20}s until automatic detection. Manual save already works.` :
    s.accepted === 0 || s.lastMessageAge > 30 ? "No recent chat messages. Check chat is open; manual save still works." :
    s.cooldownRemaining > 0 ? `Highlight saved. Automatic detection resumes in ${s.cooldownRemaining}s.` :
    s.candidate ? "Waiting for more viewers to confirm the reaction." : `${s.unique || 0} viewers in the last 5s · ${Math.round((s.share || 0)*100)}% reacting.`;
  const signal = s.recording ? s.score || 0 : 0;
  $("signal-value").textContent = s.recording ? `${signal}/100` : "—"; spark(s.history); clipList(s.clips);
  const src = tab?.supported ? tab : null;
  $("source").hidden = !src; if (src) { $("source-platform").textContent = src.platform; $("source-title").textContent = src.title || src.channel || "Live stream"; }
  $("buffered").textContent = `${s.buffered || 0}s`; $("rate").textContent = (s.rate || 0).toFixed(1); $("saved").textContent = s.saved || 0;
  $("start").hidden = !!s.recording; $("mark").hidden = !s.recording; $("stop").hidden = !s.recording && !s.stopping;
  $("start").disabled = !workerReady || busy || s.stopping || (!!tab && !tab.supported); $("mark").disabled = busy || s.stopping; $("stop").disabled = busy || s.stopping;
  $("pending").textContent = s.pending || 0; $("pending-box").hidden = !s.pending;
  $("settings-state").textContent = s.recording ? "For next capture" : "Saved automatically";
  showError(actionError || s.error || "");
}
async function refresh() {
  if (busy || !initialized) return;
  try { const s = await command("STATUS"); if (!s || s.ok === false) throw Error(s?.error || "Recorder unavailable"); draw(s); }
  catch(e) { showError(e.message); }
}
async function connect() {
  setConn("Checking…");
  const r = await command("CHECK");
  if (!r?.ok) { setConn("Needs attention"); throw Error(r?.error || "Cannot reach ClipForge."); }
  setConn("Connected");
}
for (const [id, type] of [["start","START"],["stop","STOP"],["mark","MARK"],["retry","RETRY"],["save","PAIR_KEY"],["check-connection","CHECK"]]) {
  $(id).onclick = async () => {
    if (busy) return;
    busy = true; $(id).disabled = true; actionError = ""; showError(""); notice("");
    try {
      if (["start","retry"].includes(id)) await save();
      if (id === "start" && !$("token").value.trim()) { $("connection").open = true; $("pair").focus(); throw Error("Click Connect app first."); }
      if(type==="PAIR_KEY") {
        if(!$("port").value || !$("port").checkValidity())throw Error("Enter a port between 1024 and 65535.");
        $("save").textContent="Verifying…";setConn("Checking…");
        const r=await command(type,{token:$("token").value.trim(),port:Number($("port").value)});
        if(!r?.ok)throw Error(r?.error||"Could not verify this key.");
        setInbox($("port").value);setConn("Connected");notice("Key verified. ClipForge can receive your clips.");
      }
      else if (type === "CHECK") { await connect(); notice("Connection verified. ClipForge can receive your clips."); }
      else { const r = await command(type); if (!r?.ok) throw Error(r?.error || "Command could not complete."); }
      if (id === "mark") notice("Moment marked. Keeping the lead-in and collecting the ending.");
    } catch(e) { if(["PAIR_KEY","CHECK"].includes(type))setConn("Needs attention");actionError = e.message; showError(actionError); }
    finally { busy = false; $(id).disabled = false; $("save").textContent="Verify key";await connectionDetail(); await refresh(); }
  };
}
document.querySelectorAll("[data-sensitivity]").forEach((button) => button.onclick = async () => {
  sensitivity = button.dataset.sensitivity; mode(); try { await save(); actionError = ""; } catch(e) { actionError = e.message; showError(actionError); }
});
for (const id of ["pre","tail","max","sound"]) $(id).onchange = async () => { try { await save(); actionError = ""; } catch(e) { actionError = e.message; showError(actionError); } };
$("silent").onchange=async()=>{try{await save();const r=await command("LISTEN",{enabled:!$("silent").checked});if(!r?.ok)throw Error(r?.error||"Could not change listening.");}catch(e){actionError=e.message;showError(e.message);}};
(async () => {
  try {
    const s = await chrome.storage.local.get(["token","port","options"]);
    $("token").value = s.token || ""; $("port").value = s.port || 8000;
    for (const id of ["pre","tail","max"]) if (s.options?.[id]) $(id).value = s.options[id];
    sensitivity = modeText[s.options?.sensitivity] ? s.options.sensitivity : "normal"; $("sound").checked = !!s.options?.sound; $("silent").checked=s.options?.listen===false;mode();
    setInbox(s.port); $("connection").open = !s.token; if (!s.token) setConn("Not paired");
    const keys = await chrome.commands.getAll(); const shortcut = keys.find((k) => k.name === "save-moment")?.shortcut;
    $("shortcut").textContent = shortcut || "Set shortcut in Chrome";
    initialized = true;
    try {const hello=await command("HELLO");if(!hello?.ok||hello.version!==chrome.runtime.getManifest().version)throw Error(reloadHint);workerReady=true;}
    catch(e){actionError=e.message;setConn("Reload needed");$("reload-extension").hidden=false;$("connection").open=true;}
    $("pair").disabled=$("save").disabled=$("check-connection").disabled=!workerReady;
    await connectionDetail();await checkTab(); await refresh(); setInterval(refresh, 1000); setInterval(checkTab, 3000);setInterval(()=>{if(busy)connectionDetail();},500);
    if (s.token && workerReady) try { await connect();await connectionDetail(); } catch(e) { actionError=e.message;showError(e.message); }
  } catch(e) { showError(e.message); }
})();
