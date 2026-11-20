import {Detector} from "./detector.mjs";

let media, output, audio, analyser, video, canvas, recorder, drawTimer, tickTimer, splitTimer, listenGain;
let detector, started = 0, segments = [], ready = [], player, playerAt = 0, sourceUrl, title, config;
let recording = false, stopping = false, uploading = false, status = {}, error = "", saved = 0;
let history = [], log = []; // last 60s of signal, and this capture's clips, for the popup
const now = () => (performance.now() - started) / 1000;
const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open("clipforge-live", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("pending", {keyPath: "id"});
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function dbAction(mode, action) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending", mode), request = action(tx.objectStore("pending"));
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error);
  });
}
const pending = () => dbAction("readonly", (s) => s.getAll());
async function upload() {
  if (uploading) return; uploading = true;
  try {
    // Read pairing on each retry, so reconnecting does not lose buffered clips.
    const credentials = await chrome.runtime.sendMessage({type: "CREDENTIALS"});
    if (!credentials?.token) return;
    while (true) {
      const [item] = await pending();
      if (!item) break;
      const form = new FormData(); form.append("metadata", JSON.stringify(item.metadata));
      item.parts.forEach((part, i) => form.append("files", part, `segment-${i}.webm`));
      const response = await fetch(`http://127.0.0.1:${Number(credentials.port || 8000)}/api/live/capture`, {
        method: "POST", headers: {Authorization: `Bearer ${credentials.token}`}, body: form, signal: AbortSignal.timeout(90000)
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.detail || `Upload failed (${response.status})`);
      await dbAction("readwrite", (store) => store.delete(item.id)); saved++; error = "";
      const entry = log.find((e) => e.id === item.id); if (entry) entry.state = "sent";
    }
  } catch (e) { error = `Clip kept for retry: ${e.message}`; }
  finally { uploading = false; if (ready.length && !error) queueSave(); }
}
async function saveReady() {
  while (ready.length && segments.length && (segments.at(-1).end >= ready[0].end || (!recording && !stopping))) {
    const clip = ready[0], chosen = segments.filter((s) => s.end > clip.start && s.start < clip.end);
    if (!chosen.length) { ready.shift(); error = "No buffered video was available for that moment."; continue; }
    const existing = await pending();
    if (existing.length >= 6) { error = "Six clips are waiting. Reconnect ClipForge and press Retry before starting again."; stop(); return; }
    const id = crypto.randomUUID();
    const metadata = {id, title: title.slice(0, 180), source_url: sourceUrl,
      reason: clip.reason, detection: clip.evidence || null, start: Math.max(chosen[0].start, clip.start), end: Math.min(chosen.at(-1).end, clip.end),
      trigger: clip.trigger, captured_at: new Date().toISOString(),
      segments: chosen.map((s) => ({start: s.start, end: s.end}))};
    await dbAction("readwrite", (store) => store.put({id, metadata, parts: chosen.map((s) => s.blob)}));
    log.unshift({id, at: Math.round(clip.trigger ?? clip.start), reason: clip.reason, length: Math.round(metadata.end - metadata.start), state: "waiting"});
    log.length = Math.min(log.length, 6);
    ready.shift();
    upload();
  }
  const earliest = Math.min(now() - 150, detector?.active?.start ?? Infinity, ...ready.map((r) => r.start));
  segments = segments.filter((s) => s.end >= earliest);
  if (segments.reduce((sum, s) => sum + s.blob.size, 0) > 180 * 1024 * 1024) { error = "Capture stopped at the buffer memory limit. Send pending clips, then restart."; await stop(); }
}
let saveChain = Promise.resolve();
function queueSave() { saveChain = saveChain.then(saveReady).catch((e) => { error = `Could not retain clip: ${e.message}`; stop(); }); }
function beginSegment() {
  const start = now(), parts = [];
  const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  const current = new MediaRecorder(output, {mimeType, videoBitsPerSecond: 4500000, audioBitsPerSecond: 128000});
  recorder = current;
  let finished;
  current.finished = new Promise((resolve) => { finished = resolve; });
  current.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
  current.onerror = () => { error = "Recording failed. Stop and restart capture."; stop(); };
  current.onstop = () => {
    const end = current.endedAt || now();
    if (parts.length && end > start) segments.push({start, end, blob: new Blob(parts, {type: mimeType})});
    if (recording) beginSegment();
    queueSave();
    finished();
  };
  current.start();
  splitTimer = setTimeout(() => { if (current.state === "recording") { current.endedAt = now(); current.stop(); } }, 4000);
}
async function start(message) {
  if (recording || stopping) throw Error("A capture is already running or stopping.");
  await saveChain;
  if (ready.length) throw Error("Retry pending clips before starting another capture.");
  if ((await pending()).length >= 6) throw Error("Retry the six pending clips before capturing more.");
  ({player, sourceUrl, title, config} = message); detector = new Detector(config.options);
  segments = []; ready = []; error = ""; status = {}; history = []; log = []; recorder = null; started = performance.now(); playerAt = now();
  try {
    media = await navigator.mediaDevices.getUserMedia({audio: {mandatory: {chromeMediaSource: "tab", chromeMediaSourceId: message.streamId}},
      video: {mandatory: {chromeMediaSource: "tab", chromeMediaSourceId: message.streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30}}});
    audio = new AudioContext(); const node = audio.createMediaStreamSource(media);
    listenGain = audio.createGain();listenGain.gain.value=config.options?.listen===false?0:1;
    node.connect(listenGain);listenGain.connect(audio.destination);
    analyser = audio.createAnalyser(); analyser.fftSize = 1024; node.connect(analyser);
    video = document.createElement("video"); video.muted = true; video.srcObject = media; await video.play();
    canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = Math.round(1280 / player.aspect / 2) * 2;
    canvas.height = Math.min(1920, Math.max(240, canvas.height));
    const ctx = canvas.getContext("2d", {alpha: false});
    const draw = () => {
      if (!player?.visible || !player.playing) return;
      const sx = player.x * video.videoWidth, sy = player.y * video.videoHeight, sw = player.w * video.videoWidth, sh = player.h * video.videoHeight;
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Preserve the player's aspect ratio, including any source letterboxing.
      const scale = Math.min(canvas.width / sw, canvas.height / sh), w = sw * scale, h = sh * scale;
      ctx.drawImage(video, sx, sy, sw, sh, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    };
    draw(); drawTimer = setInterval(draw, 1000 / 30);
    output = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...media.getAudioTracks()]);
    recording = true; status = detector.tick(0); beginSegment();
    const samples = new Float32Array(analyser.fftSize);
    tickTimer = setInterval(() => {
      const at = now();
      if (at - playerAt > 5 || !player?.playing || !player.visible) {
        error = "Capture stopped: keep the live player playing, fully visible, and chat open. Restart after restoring it."; stop(); return;
      }
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
      status = detector.tick(at, rms);status.audioLevel=rms;
      history.push({s: status.score || 0, a: detector.active ? 1 : 0}); if (history.length > 60) history.shift();
      if (status.clip) { ready.push(status.clip); queueSave(); }
    }, 1000);
    media.getVideoTracks()[0].onended = () => { error = "The captured tab ended."; stop(); };
    return {ok: true};
  } catch (e) { await stop(); throw e; }
}
async function stop() {
  if (stopping) return;
  stopping = true;
  const wasRecording = recording; recording = false;
  clearTimeout(splitTimer); clearInterval(tickTimer); clearInterval(drawTimer);
  if (wasRecording && detector?.active) ready.push(detector.flush(now()));
  if (recorder?.state === "recording") { recorder.endedAt = now(); recorder.stop(); }
  await recorder?.finished;
  output?.getTracks().forEach((track) => track.stop()); media?.getTracks().forEach((track) => track.stop());
  await audio?.close().catch(() => {}); video?.pause();
  if (wasRecording) await chrome.runtime.sendMessage({type: "CAPTURE_ENDED"}).catch(() => {});
  stopping = false;
  if (wasRecording) queueSave();
  return {ok: true};
}
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.target !== "recorder") return;
  (async () => {
    if (msg.type === "START") return start(msg);
    if (msg.type === "STOP") return stop();
    if (msg.type === "LISTEN") {
      if (typeof msg.enabled !== "boolean") throw Error("Invalid listening setting.");
      if (listenGain && audio?.state !== "closed") listenGain.gain.value=msg.enabled?1:0;
      return {ok:true};
    }
    if (msg.type === "CHAT" && recording) {
      if (msg.player && msg.topFrame) {
        if (msg.player.url !== sourceUrl) { error = "Stream page changed. Start a new capture for this video."; await stop(); return; }
        player = msg.player; playerAt = now();
      }
      detector.add(now(), Array.isArray(msg.messages) ? msg.messages : []);
    }
    if (msg.type === "MARK") {
      if (!recording) throw Error("Start capture first.");
      detector.trigger(now(), "Manual highlight"); return {ok: true};
    }
    if (msg.type === "RETRY") { await upload(); queueSave(); return {ok: true}; }
    if (msg.type === "STATUS") {
      await saveChain; // Do not report an empty queue while a clip is moving into IndexedDB.
      return {recording, stopping, elapsed: recording ? Math.floor(now()) : 0, pending: (await pending()).length + ready.length,
        saved, error, rate: status.rate || 0, warmed: !!status.warmed, active: !!detector?.active, buffered: segments.length ? Math.round(segments.at(-1).end - segments[0].start) : 0,
        score: status.score || 0, unique: status.unique || 0, share: status.share || 0, candidate: !!status.candidate,
        warmupRemaining: status.warmupRemaining || 0, cooldownRemaining: status.cooldownRemaining || 0,
        tailRemaining: detector?.active ? Math.max(0, Math.ceil(detector.options.tail - (now() - detector.active.last))) : 0,
        reason: detector?.active?.reason || "", accepted: detector?.accepted || 0,
        lastMessageAge: detector?.lastMessage == null ? null : now() - detector.lastMessage,
        listening: listenGain?.gain.value !== 0, audio_level: recording ? status.audioLevel || 0 : 0,
        history, clips: log.map(({id, ...entry}) => entry)};
    }
    return {ok: true};
  })().then(respond, (e) => respond({ok: false, error: e.message})); return true;
});
