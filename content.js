(() => {
  if (globalThis.__clipforgeLive) return;
  globalThis.__clipforgeLive = true;
  const selector = location.hostname.includes("twitch.tv") ? '[data-a-target="chat-line-message"]' : 'yt-live-chat-text-message-renderer';
  let enabled = false, observer, timer, batch = [], seen = new WeakSet();
  const salt = Math.random().toString(36);
  function hash(text) { let n = 2166136261; for (const c of salt + text) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return String(n >>> 0); }
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => stop());
  function scan(node) {
    if (!(node instanceof Element)) node = node.parentElement;
    if (!node) return;
    const ancestor = node.closest(selector);
    const lines = [...(ancestor ? [ancestor] : []), ...node.querySelectorAll(selector)];
    for (const line of lines) {
      if (seen.has(line)) continue;
      const user = line.querySelector('[data-a-target="chat-message-username"], #author-name');
      const message = line.querySelector('[data-a-target="chat-line-message-body"], #message') || line;
      const text = (message.textContent + " " + [...message.querySelectorAll('img[alt]')].map((img) => img.alt).join(" ")).slice(0, 500);
      if (!user?.textContent?.trim() || !text.trim()) continue;
      seen.add(line);
      if (batch.length < 500) batch.push({author: hash(user?.textContent || "unknown"), text});
    }
  }
  function player() {
    const videos = [...document.querySelectorAll("video")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const video = videos[0], r = video?.getBoundingClientRect();
    if (!r || r.width < 100 || r.height < 60) return null;
    const visible = r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2;
    return {x: Math.max(0, r.x) / innerWidth, y: Math.max(0, r.y) / innerHeight, w: Math.min(r.width, innerWidth) / innerWidth, h: Math.min(r.height, innerHeight) / innerHeight,
      visible, playing: !video.paused && !video.ended && video.readyState >= 2 && video.playbackRate === 1,
      aspect: video.videoWidth / video.videoHeight || r.width / r.height, url: location.origin + location.pathname + location.search};
  }
  function stop() { enabled = false; observer?.disconnect(); clearInterval(timer); batch = []; }
  function start() {
    stop(); enabled = true; seen = new WeakSet();
    document.querySelectorAll(selector).forEach((line) => seen.add(line)); // ignore chat history already on screen
    observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(scan)));
    observer.observe(document.documentElement, {childList: true, subtree: true});
    timer = setInterval(() => { if (enabled) send({type: "CHAT", messages: batch.splice(0), player: window === top ? player() : null}); }, 1000);
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "START_CHAT") { start(); respond({ok: true, player: window === top ? player() : null}); }
    if (message.type === "STOP_CHAT") { stop(); respond({ok: true}); }
    if (message.type === "PLAYER") respond({player: player()});
  });
})();
