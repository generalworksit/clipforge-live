const $ = (id) => document.getElementById(id);
const command = (type) => chrome.runtime.sendMessage({type});
const modeText = {low: "Waits for broader, sustained reactions. Fewer clips to review.", normal: "A balance of clear reactions and smaller highlights.", high: "Includes smaller reactions. Expect more clips to review."};
let sensitivity = "normal", busy = false, initialized = false, latest = {}, actionError = "";
function notice(text) { $("notice").textContent = text; $("notice").hidden = !text; }
function showError(text) { $("error").textContent = text; $("error").hidden = !text; }
$("pair").onclick = async () => {
  if (busy) return;
  busy = true; $("pair").disabled = true; actionError = ""; showError(""); notice("");
  $("connection-state").textContent = "Pairing…"; $("pair").textContent = "Connecting…";
  try {
    if (!$("port").value || !$("port").checkValidity()) throw Error("Enter a port between 1024 and 65535.");
    const r = await chrome.runtime.sendMessage({type: "PAIR", port: Number($("port").value)});
    if (!r?.ok) throw Error(r?.error || "Could not pair with ClipForge.");
    const s = await chrome.storage.local.get(["token", "port"]);
    $("token").value = s.token || ""; $("port").value = s.port || 8000;
    $("inbox").href = `http://127.0.0.1:${Number(s.port || 8000)}/#/live`;
    $("connection-state").textContent = "Connected"; $("connection").open = false;
    notice("Connected. Open a stream and start capture.");
  } catch(e) { $("connection-state").textContent = "Needs attention"; actionError = e.message; showError(actionError); }
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
  $("inbox").href = `http://127.0.0.1:${port}/#/live`; mode();
  $("settings-state").textContent = latest.recording ? "For next capture" : "Saved automatically";
}
function draw(s) {
  latest = s;
  const active = s.recording && s.active;
  $("monitor").dataset.state = active ? "moment" : s.recording ? "recording" : "idle";
  $("phase").textContent = s.stopping ? "Finishing capture" : active ? "Collecting highlight" : s.recording ? "Capture running" : "Capture stopped";
  $("elapsed").textContent = `${Math.floor((s.elapsed || 0) / 60).toString().padStart(2,"0")}:${((s.elapsed || 0) % 60).toString().padStart(2,"0")}`;
  $("state").textContent = s.stopping ? "Finishing your clip…" : active ? "Moment detected" : !s.recording ? "Ready to capture" : !s.warmed ? "Learning this chat…" : s.candidate ? "Reaction building…" : "Watching for moments";
  $("state-hint").textContent = s.stopping ? "Keeping the ending and preparing the upload." : active ? `${s.reason || "Reaction detected"}. Saving after ${s.tailRemaining ?? 12}s of quiet.` :
    !s.recording ? s.saved ? "Your clips are in the inbox. Start again when ready." : "Open a live stream with its chat, then start." :
    !s.warmed ? `${s.warmupRemaining ?? 20}s until automatic detection. Manual save already works.` :
    s.accepted === 0 || s.lastMessageAge > 30 ? "No recent chat messages. Check chat is open; manual save still works." :
    s.cooldownRemaining > 0 ? `Highlight saved. Automatic detection resumes in ${s.cooldownRemaining}s.` :
    s.candidate ? "Waiting for more viewers to confirm the reaction." : `${s.unique || 0} viewers in the last 5s · ${Math.round((s.share || 0)*100)}% reacting.`;
  const signal = s.recording ? s.score || 0 : 0;
  $("signal").value = signal; $("signal-value").textContent = s.recording ? `${signal}/100` : "—";
  $("buffered").textContent = `${s.buffered || 0}s`; $("rate").textContent = (s.rate || 0).toFixed(1); $("saved").textContent = s.saved || 0;
  $("start").hidden = !!s.recording; $("mark").hidden = !s.recording; $("stop").hidden = !s.recording && !s.stopping;
  $("start").disabled = busy || s.stopping; $("mark").disabled = busy || s.stopping; $("stop").disabled = busy || s.stopping;
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
  $("connection-state").textContent = "Checking…";
  const r = await command("CHECK");
  if (!r?.ok) { $("connection-state").textContent = "Needs attention"; throw Error(r?.error || "Cannot reach ClipForge."); }
  $("connection-state").textContent = "Connected";
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
    $("inbox").href = `http://127.0.0.1:${Number(s.port || 8000)}/#/live`; $("connection").open = !s.token;
    const keys = await chrome.commands.getAll(); const shortcut = keys.find((k) => k.name === "save-moment")?.shortcut;
    $("shortcut").textContent = shortcut || "Set shortcut in Chrome";
    initialized = true; await refresh(); setInterval(refresh, 1000);
    if (s.token) try { await connect(); } catch(e) { showError(e.message); }
  } catch(e) { showError(e.message); }
})();
