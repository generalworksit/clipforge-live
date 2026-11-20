// Local heuristics: scores describe signal strength, never a probability of virality.
export const defaults = {pre: 20, tail: 12, max: 90, sensitivity: "normal", sound: false};
export function settings(input = {}) {
  const number = (key, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(input[key])) ? Number(input[key]) : defaults[key]));
  return {pre: number("pre", 5, 40), tail: number("tail", 5, 25), max: number("max", 45, 120),
    sensitivity: ["low", "normal", "high"].includes(input.sensitivity) ? input.sensitivity : "normal", sound: input.sound === true};
}
export function reaction(text) {
  return /\b(l+o+l+|lma+o+|lmfa+o+|rofl|omegalul|lulw?|kekw|kek|pog(?:gers|champ)?|monkas|wtf|holy|hype|mdr|ptdr|(?:a?ha){2,}|lo+ol|no+ way|lets? go+|w{2,})\b|😂|🤣|💀|😭|🔥|😱|хаха|ахах/iu.test(text);
}
export function nomination(text) {
  const value = String(text).toLowerCase().replace(/[’‘]/g, "'");
  // Conservative intent only: requests are audience evidence, not proof of an event.
  if (/\b(?:don't|dont|not|never|stop|no|pas|jamais)\b|(?:^|\s)не\s/iu.test(value)) return false;
  return /\b(?:clip\s+(?:that|this|it)|save\s+(?:that|this)\s+(?:clip|moment)|clippez?\s+(?:ça|ca)|fais?\s+un\s+clip)\b|(?:^|\s)(?:сделай(?:те)?\s+клип|клипни|это\s+в\s+клип)(?:\s|[!.?,]|$)/iu.test(value);
}
const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const tuning = {
  low: {authors: 6, lift: 2.5, z: 3, shift: 0.35, confirm: 3},
  normal: {authors: 4, lift: 1.8, z: 2, shift: 0.25, confirm: 2},
  high: {authors: 3, lift: 1.4, z: 1.3, shift: 0.18, confirm: 2}
};
export class Detector {
  constructor(input) {
    this.options = settings(input); this.history = []; this.messages = []; this.repeats = new Map();
    this.active = null; this.candidate = null; this.cooldown = 0; this.started = null; this.lastTick = -1;
    this.lastEnd = 0; this.level = 0.01; this.lastMessage = null; this.accepted = 0; this.lastEvidence = null;
  }
  add(at, messages) {
    const counts = new Map();
    for (const m of this.messages.filter((m) => m.at > at - 5)) counts.set(m.author, (counts.get(m.author) || 0) + 1);
    for (const m of messages.slice(0, 500)) {
      const author = String(m.author || "unknown").slice(0, 80);
      const text = String(m.text || "").slice(0, 500).trim().toLowerCase().replace(/\s+/g, " ");
      // Commands/links and repeated messages from one author should not inflate a burst.
      if (!text || /^!|https?:\/\/|www\./i.test(text) || (counts.get(author) || 0) >= 2) continue;
      const previous = this.repeats.get(author);
      if (previous?.text === text && at - previous.at < 8) continue;
      this.repeats.set(author, {text, at}); counts.set(author, (counts.get(author) || 0) + 1);
      this.messages.push({at, author, reaction: reaction(text), nomination: nomination(text)}); this.lastMessage = at; this.accepted++;
    }
    for (const [author, last] of this.repeats) if (at - last.at > 60) this.repeats.delete(author);
    while (this.repeats.size > 5000) this.repeats.delete(this.repeats.keys().next().value);
  }
  trigger(at, reason, evidence = null, onset = at) {
    if (this.active) { this.active.last = at; return; }
    this.active = {start: Math.max(this.started || 0, onset - this.options.pre, this.lastEnd - 2),
      trigger: onset, last: at, reason, evidence};
    this.candidate = null;
  }
  finish(at) {
    const clip = this.active ? {...this.active, end: Math.min(at, this.active.start + this.options.max)} : null;
    if (clip) { this.lastEnd = clip.end; this.cooldown = at + 12; }
    this.active = null; this.candidate = null;
    return clip;
  }
  tick(at, rms = 0) {
    if (this.started === null) this.started = at;
    this.messages = this.messages.filter((m) => m.at > at - 5);
    const recent = this.messages, fresh = recent.filter((m) => m.at > this.lastTick);
    const unique = new Set(recent.map((m) => m.author)).size;
    const reactionUsers = new Set(recent.filter((m) => m.reaction).map((m) => m.author)).size;
    const requestingUsers = new Set(recent.filter((m) => m.nomination).map((m) => m.author)).size;
    const requestShare = unique ? requestingUsers / unique : 0;
    const baseRequests = mean(this.history.map(x => x.requests || 0));
    const rate = recent.length / 5, share = unique ? reactionUsers / unique : 0;
    const baseline = mean(this.history.map((x) => x.rate)), baseShare = mean(this.history.filter((x) => x.share !== null).map((x) => x.share));
    const variance = mean(this.history.map((x) => (x.rate - baseline) ** 2));
    const z = (rate - baseline) / Math.max(0.35, Math.sqrt(variance), Math.sqrt(baseline / 5));
    const lift = (rate + 0.4) / (baseline + 0.4), t = tuning[this.options.sensitivity];
    const enough = unique >= t.authors && reactionUsers >= t.authors;
    const surge = enough && lift >= t.lift && z >= t.z;
    // A busy channel can react strongly without increasing its total message rate.
    const shift = enough && share >= 0.45 && share - baseShare >= t.shift;
    const volume = unique >= t.authors * 2 && rate >= 3 && lift >= t.lift + 1.5 && z >= t.z + 1;
    const requested = requestingUsers >= t.authors && requestShare >= .25 && requestShare - baseRequests >= .2;
    const chatHot = surge || shift || volume || requested;
    const soundHot = this.options.sound && rms > 0.08 && rms > this.level * 3.5;
    const warmed = at - this.started >= Math.max(20, this.options.pre);
    const signals = [surge && "chat_surge", shift && "reaction_shift", volume && !surge && "crowd_surge", soundHot && "sound_spike", requested && "viewer_requests"].filter(Boolean);
    const score = chatHot ? Math.round(35 + 20 * clamp((lift - 1) / 2) + 25 * clamp((share - baseShare) / 0.6) + 20 * clamp(unique / 12))
      : soundHot ? Math.round(55 + 25 * clamp(rms / Math.max(this.level, 0.01) / 10)) : 0;
    const evidence = {version: 2, score, unique, reactionShare: Number(share.toFixed(2)), rateLift: Number(Math.min(lift, 1000).toFixed(2)), signals};
    this.lastEvidence = evidence;
    const freshChat = new Set(fresh.map((m) => m.author)).size >= 2;
    const ongoing = fresh.some((m) => m.reaction) && enough && share >= Math.max(0.25, baseShare + 0.1);
    if (this.active) {
      // A lower continuation threshold preserves the ending; stale messages don't extend it.
      if ((freshChat && (chatHot || ongoing)) || soundHot) this.active.last = at;
      if ((freshChat || soundHot) && score > (this.active.evidence?.score || 0) && this.active.reason !== "Manual highlight") this.active.evidence = evidence;
    } else if (warmed && at >= this.cooldown && ((chatHot && freshChat) || soundHot)) {
      const type = chatHot && freshChat ? "chat" : "sound";
      if (!this.candidate || this.candidate.type !== type || at - this.candidate.last > 3) this.candidate = {type, onset: at, hits: 0, last: at};
      this.candidate.hits++; this.candidate.last = at;
      const decisive = type === "chat" && surge && reactionUsers >= 8 && unique >= 12 && share >= 0.6 && lift >= 3;
      if (decisive || this.candidate.hits >= (type === "sound" ? 2 : t.confirm)) {
        const reason = type === "sound" ? "Sound spike" : requested && !surge && !shift && !volume ? "Viewers asked for a clip" : shift && !surge ? "More viewers reacting" : volume && !surge ? "Sudden crowd activity" : "Chat reaction spike";
        this.trigger(at, reason, evidence, this.candidate.onset);
      }
    } else if (this.candidate && at - this.candidate.last > 3) this.candidate = null;
    // Learn a changed pace during long events, avoiding repeated clips of a permanently busier room.
    if (at - this.started >= 5 && (!this.active || !warmed || at - this.active.trigger > 15)) {
      this.history.push({rate, share: unique ? share : null, requests: requestShare}); if (this.history.length > 60) this.history.shift();
    }
    this.level = this.level * 0.95 + Math.max(0, rms) * 0.05;
    this.lastTick = at;
    let clip = null;
    if (this.active && (at - this.active.last >= this.options.tail || at - this.active.start >= this.options.max)) clip = this.finish(at);
    return {clip, rate, baseline, unique, reacts: reactionUsers, share, lift, score, warmed, active: this.active,
      candidate: !!this.candidate, chatHot, soundHot, signals, warmupRemaining: Math.max(0, Math.ceil(Math.max(20, this.options.pre) - (at - this.started))),
      cooldownRemaining: Math.max(0, Math.ceil(this.cooldown - at)), tailRemaining: this.active ? Math.max(0, Math.ceil(this.options.tail - (at - this.active.last))) : 0,
      lastMessageAge: this.lastMessage === null ? null : Math.max(0, at - this.lastMessage), accepted: this.accepted};
  }
  flush(at) { return this.finish(at); }
}
