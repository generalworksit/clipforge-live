let starting = false, pairing = false, creating;

async function waitForAppTab(id) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated);
      error ? reject(error) : resolve();
    };
    const updated = (tabId, change) => { if (tabId === id && change.status === "complete") finish(); };
    const timer = setTimeout(() => finish(Error("ClipForge did not load. Start the app and try again.")), 10000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.get(id).then(tab => { if (tab.status === "complete") finish(); }, () => finish(Error("The ClipForge tab was closed.")));
  });
}

async function pairWithApp(requestedPort) {
  if (pairing) throw Error("Connection is already in progress.");
  pairing = true;
  try {
    const stored = await chrome.storage.local.get("port");
    const port = Number(requestedPort ?? stored.port ?? 8000);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Enter a port between 1024 and 65535.");
    if ((await call("STATUS"))?.recording) throw Error("Stop capture before changing the connection.");
    const base = `http://127.0.0.1:${port}`;
    let setup;
    try {
      const response = await fetch(`${base}/api/live/setup`, {signal: AbortSignal.timeout(8000)});
      if (!response.ok) throw Error();
      setup = await response.json();
    } catch { throw Error("Start ClipForge, then click Connect app again."); }
    if (setup.port !== port) throw Error("This port is not serving ClipForge.");
    const tabs = await chrome.tabs.query({url: `${base}/*`});
    const tab = tabs.find(t => new URL(t.url).pathname === "/") || await chrome.tabs.create({url: `${base}/#/live`, active: false});
    await waitForAppTab(tab.id);
    // Only after an explicit popup action, use the app's own page context. The
    // backend still rejects foreign-origin pairing and requires a key for uploads.
    const results = await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, world: "MAIN", args: [base], func: async (origin) => {
      if (location.origin !== origin || location.pathname !== "/" || document.title !== "ClipForge") return {error: "Open ClipForge and try again."};
      const response = await fetch("/api/live/pair", {method: "POST", signal: AbortSignal.timeout(8000)});
      if (!response.ok) return {error: "ClipForge refused the connection."};
      const data = await response.json();
      return {token: data.token, port: data.port};
    }});
    const data = results[0]?.result;
    if (!data || data.error) throw Error(data?.error || "Could not connect. Reload the extension and try again.");
    if (data.port !== port || typeof data.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(data.token)) throw Error("ClipForge returned an invalid connection key.");
    const check = await fetch(`${base}/api/live/health`, {headers: {Authorization: `Bearer ${data.token}`}, signal: AbortSignal.timeout(8000)});
    if (!check.ok) throw Error("Connection could not be verified. Try again.");
    await chrome.storage.local.set({token: data.token, port});
    return {ok: true}; // never send the key in a runtime response
  } finally { pairing = false; }
}
async function offscreen() {
  if (creating) return creating;
  creating = (async () => {
  const contexts = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]});
  if (!contexts.length) await chrome.offscreen.createDocument({url: "offscreen.html", reasons: ["USER_MEDIA", "BLOBS"], justification: "Buffer the selected live stream and prepare highlight clips locally."});
  })();
  try { await creating; } finally { creating = null; }
}
async function call(type, data = {}) { await offscreen(); return chrome.runtime.sendMessage({target: "recorder", type, ...data}); }
async function checkConnection() {
  const config = await chrome.storage.local.get(["token", "port", "options"]);
  const port = Number(config.port || 8000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid ClipForge port.");
  if (!config.token) throw Error("Click Connect app in the extension first.");
  const base = `http://127.0.0.1:${port}`;
  let check;
  try { check = await fetch(`${base}/api/live/health`, {headers: {Authorization: `Bearer ${config.token}`}, signal: AbortSignal.timeout(8000)}); }
  catch { throw Error("Cannot reach ClipForge. Start the app and check the port."); }
  if (!check.ok) throw Error("Connection key was not accepted. Click Connect app again.");
  return {...config, base};
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target === "recorder") return;
  if (msg.type === "CREDENTIALS" && sender.url === chrome.runtime.getURL("offscreen.html")) {
    chrome.storage.local.get(["token", "port"]).then(respond); return true;
  }
  if (msg.type === "CAPTURE_ENDED" && sender.url === chrome.runtime.getURL("offscreen.html")) {
    (async () => {
      const {tabId} = await chrome.storage.session.get("tabId");
      if (tabId) await chrome.tabs.sendMessage(tabId, {type: "STOP_CHAT"}).catch(() => {});
      await chrome.storage.session.remove("tabId");
      await chrome.action.setBadgeText({text: ""});
      return {ok: true};
    })().then(respond, () => respond({ok: false}));
    return true;
  }
  if (msg.type === "CHAT") {
    chrome.storage.session.get("tabId").then(({tabId}) => {
      if (sender.tab?.id === tabId) return chrome.runtime.sendMessage({target: "recorder", ...msg, topFrame: sender.frameId === 0});
    }).catch(() => {}); return;
  }
  // Control messages must originate from our own extension pages, never a stream page.
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  (async () => {
    if (msg.type === "PAIR") {
      if (sender.url !== chrome.runtime.getURL("popup.html")) throw Error("Connect from the ClipForge popup.");
      return pairWithApp(msg.port);
    }
    if (msg.type === "CHECK") { await checkConnection(); return {ok: true}; }
    if (msg.type === "START") {
      if (starting) throw Error("Capture is starting. Please wait.");
      starting = true;
      try {
        if ((await call("STATUS"))?.recording) throw Error("Stop the current capture before starting another.");
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const url = new URL(tab.url);
        if (!["www.twitch.tv", "twitch.tv", "www.youtube.com", "youtube.com"].includes(url.hostname)) throw Error("Open a live Twitch or YouTube stream first.");
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files: ["content.js"]});
        const {player} = await chrome.tabs.sendMessage(tab.id, {type: "PLAYER"}, {frameId: 0});
        if (!player?.playing || !player.visible) throw Error("Play the live video at normal speed and keep the whole player visible.");
        const config = await checkConnection();
        const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tab.id});
        const result = await call("START", {streamId, player, config, title: tab.title || "Live highlight", sourceUrl: player.url});
        if (!result.ok) throw Error(result.error);
        await chrome.storage.session.set({tabId: tab.id});
        try { await chrome.tabs.sendMessage(tab.id, {type: "START_CHAT"}); }
        catch (e) { await call("STOP"); await chrome.storage.session.remove("tabId"); throw e; }
        await chrome.action.setBadgeBackgroundColor({color: "#8f762d"});
        await chrome.action.setBadgeText({text: "REC"});
        return result;
      } finally { starting = false; }
    }
    if (msg.type === "STOP") {
      const {tabId} = await chrome.storage.session.get("tabId");
      if (tabId) await chrome.tabs.sendMessage(tabId, {type: "STOP_CHAT"}).catch(() => {});
      await chrome.storage.session.remove("tabId");
    }
    if (["STATUS", "STOP", "MARK", "RETRY"].includes(msg.type)) return call(msg.type);
    throw Error("Unknown command.");
  })().then(respond, (error) => respond({ok: false, error: error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(async (id) => {
  const {tabId} = await chrome.storage.session.get("tabId");
  if (tabId === id) { await call("STOP"); await chrome.storage.session.remove("tabId"); }
});
chrome.commands.onCommand.addListener(async (name) => {
  if (name !== "save-moment") return;
  try { const s = await call("STATUS"); if (s?.recording) await call("MARK"); } catch { /* Popup reports recorder errors. */ }
});
