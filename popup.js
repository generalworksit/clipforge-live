const $ = (id) => document.getElementById(id);
const command = (type) => chrome.runtime.sendMessage({type});
const modeText = {low: "Waits for broader, sustained reactions. Fewer clips to review.", normal: "A balance of clear reactions and smaller highlights.", high: "Includes smaller reactions. Expect more clips to review."};
let sensitivity = "normal", busy = false, initialized = false, latest = {}, actionError = "";
function notice(text) { $("notice").textContent = text; $("notice").hidden = !text; }
function showError(text) { $("error").textContent = text; $("error").hidden = !text; }
function setConn(text) {
  $("connection-state").textContent = text; $("conn-text").textContent = text === "Not paired" ? "Not connected" : text;
  $("conn").dataset.tone = text === "Connected" ? "ok" : /attention|Not/.test(text) ? "bad" : "idle";
}
function setInbox(port) { for (const id of ["inbox", "clips-open"]) $(id).href = `http://127.0.0.1:${Number(port || 8000)}/#/live`; }
const clock = (sec) => `${Math.floor(sec / 60).toString().padStart(2, "0")}:${(sec % 60).toString().padStart(2, "0")}`;
let tab = null; // what the active tab is, from the background TAB check
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
    const r = await chrome.runtime.sendMessage({type: "PAIR", port: Number($("port").value)});
    if (!r?.ok) throw Error(r?.error || "Could not pair with ClipForge.");
    const s = await chrome.storage.local.get(["token", "port"]);
    $("token").value = s.token || ""; $("port").value = s.port || 8000;
    setInbox(s.port);
    setConn("Connected"); $("connection").open = false;
    notice("Connected. Open a stream and start capture.");
  } catch(e) { setConn("Needs attention"); actionError = e.message; showError(actionError); }
  finally { busy = false; $("pair").disabled = false; $("pair").textContent = "Connect app"; await refresh(); }
};
function mode() {
  document.querySelectorAll("[data-sensitivity]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sensitivity === sensitivity)));
  $("mode-hint").textContent = modeText[sensitivity];
  $("timing-summary").textContent = `${$("pre").value}s before · ${$("tail").value}s after`;
}
async function save() {
  const options = {sensitivity, sound: $("sound").checked};
  for (const id of ["pre", "tail", "max", "port"]) {
    if (!$(id).value || !$(id).checkValidity()) throw Error(`Enter ${id === "pre" ? "lead-in" : id === "tail" ? "ending" : id === "max" ? "maximum" : "port"} between ${$(id).min} and ${$(id).max}.`);
    if (id !== "port") options[id] = Number($(id).value);
  }
  const port = Number($("port").value);
  await chrome.storage.local.set({token: $("token").value.trim(), port, options});
  setInbox(port); mode();
  $("settings-state").textContent = latest.recording ? "For next capture" : "Saved automatically";
}
function draw(s) {
  latest = s;
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
  $("start").disabled = busy || s.stopping || (!!tab && !tab.supported); $("mark").disabled = busy || s.stopping; $("stop").disabled = busy || s.stopping;
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
for (const [id, type] of [["start","START"],["stop","STOP"],["mark","MARK"],["retry","RETRY"],["save","CHECK"]]) {
  $(id).onclick = async () => {
    if (busy) return;
    busy = true; $(id).disabled = true; actionError = ""; showError(""); notice("");
    try {
      if (["start","save","retry"].includes(id)) await save();
      if (id === "start" && !$("token").value.trim()) { $("connection").open = true; $("pair").focus(); throw Error("Click Connect app first."); }
      if (type === "CHECK") { await connect(); $("connection").open = false; notice("Connected. Open a stream and start capture."); }
      else { const r = await command(type); if (!r?.ok) throw Error(r?.error || "Command could not complete."); }
      if (id === "mark") notice("Moment marked. Keeping the lead-in and collecting the ending.");
    } catch(e) { actionError = e.message; showError(actionError); }
    finally { busy = false; $(id).disabled = false; await refresh(); }
  };
}
document.querySelectorAll("[data-sensitivity]").forEach((button) => button.onclick = async () => {
  sensitivity = button.dataset.sensitivity; mode(); try { await save(); actionError = ""; } catch(e) { actionError = e.message; showError(actionError); }
});
for (const id of ["pre","tail","max","sound"]) $(id).onchange = async () => { try { await save(); actionError = ""; } catch(e) { actionError = e.message; showError(actionError); } };
(async () => {
  try {
    const s = await chrome.storage.local.get(["token","port","options"]);
    $("token").value = s.token || ""; $("port").value = s.port || 8000;
    for (const id of ["pre","tail","max"]) if (s.options?.[id]) $(id).value = s.options[id];
    sensitivity = modeText[s.options?.sensitivity] ? s.options.sensitivity : "normal"; $("sound").checked = !!s.options?.sound; mode();
    setInbox(s.port); $("connection").open = !s.token; if (!s.token) setConn("Not paired");
    const keys = await chrome.commands.getAll(); const shortcut = keys.find((k) => k.name === "save-moment")?.shortcut;
    $("shortcut").textContent = shortcut || "Set shortcut in Chrome";
    initialized = true; await checkTab(); await refresh(); setInterval(refresh, 1000); setInterval(checkTab, 3000);
    if (s.token) try { await connect(); } catch(e) { showError(e.message); }
  } catch(e) { showError(e.message); }
})();
