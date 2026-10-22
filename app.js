const APP_VERSION = '0.1.3';

const API = 'https://generativelanguage.googleapis.com/v1beta';
// Preferred models, best first. When one is busy the next is tried automatically.
const TEXT_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const TTS_MODELS  = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
const VOICES = { male: 'Charon', female: 'Kore' };
const MAX_REC_SECONDS = 30;

// ---------- storage (never throws) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k)    { try { localStorage.removeItem(k); } catch {} },
};

const DEFAULT_SETTINGS = {
  voice: 'male',          // male | female
  speed: 'slow',          // slow | normal
  correct: 'each',        // each = show corrections after every sentence | end = only in the summary
  showTranslit: true,     // show partner transliteration immediately
  showTranslation: false, // show Hebrew translation immediately (otherwise tap to reveal)
};

const state = {
  key: store.get('ap_key', ''),
  settings: { ...DEFAULT_SETTINGS, ...store.get('ap_settings', {}) },
  models: store.get('ap_models', null), // { text, tts }
  scenario: null,
  history: [],     // [{ role: 'learner'|'partner', arabic, translit, hebrew }]
  lastHint: null,
  busy: false,
};

// ---------- DOM helpers ----------
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.hidden = s.id !== screenId);
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, ms);
}

// ---------- audio context (one, unlocked on a user tap — required on iPhone) ----------
let ctx;
function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ---------- Gemini ----------
async function callGemini(model, body) {
  const r = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': state.key },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

async function pickModels() {
  const r = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': state.key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  const names = new Set((j.models || []).map((m) => m.name.replace(/^models\//, '')));
  const textList = TEXT_MODELS.filter((m) => names.has(m));
  if (!textList.length) textList.push([...names].find((n) => /^gemini-.*flash$/.test(n)) || TEXT_MODELS[0]);
  const ttsList = TTS_MODELS.filter((m) => names.has(m));
  if (!ttsList.length) { const t = [...names].find((n) => /tts/.test(n)); if (t) ttsList.push(t); }
  state.models = { text: textList[0], tts: ttsList[0] || null, textList, ttsList };
  store.set('ap_models', state.models);
}

// Models to try, in order. The model that last worked goes first (until the page is reloaded).
const lastGood = { text: null, tts: null };
function modelList(kind) {
  const m = state.models || {};
  const base = kind === 'text'
    ? (m.textList || [m.text, ...TEXT_MODELS])
    : (m.ttsList || [m.tts, ...TTS_MODELS]);
  return [...new Set([lastGood[kind], ...base].filter(Boolean))];
}

// Busy / quota / server errors: worth trying another model or waiting a moment.
function isTransient(e) {
  return [429, 500, 502, 503, 504].includes(e.status)
    || e instanceof TypeError // network hiccup
    || /high demand|overloaded|unavailable|try again/i.test(e.message || '');
}
function isUnusableModel(e) {
  return e.status === 404 || (e.status === 400 && /not found|not supported|unsupported/i.test(e.message || ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Try each model in turn; if all are busy, wait and go round once more.
async function withFallback(kind, fn, onRetry) {
  const list = modelList(kind);
  let lastErr;
  for (let round = 0; round < 2; round++) {
    if (round > 0) { onRetry?.(); await sleep(2500); }
    for (const model of list) {
      try {
        const out = await fn(model);
        lastGood[kind] = model;
        return out;
      } catch (e) {
        lastErr = e;
        if (isUnusableModel(e)) continue;
        if (!isTransient(e)) throw e;
        console.warn(`${model} busy (${e.status}): trying next`, e.message);
        onRetry?.();
      }
    }
  }
  throw lastErr;
}

function thinkingConfigFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };
}

// Text/JSON call; falls back across models when one is busy, drops thinkingConfig if a model rejects it.
async function askJSON(parts, schema) {
  const j = await withFallback('text', async (model) => {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt(state.settings) }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.7,
        thinkingConfig: thinkingConfigFor(model),
      },
    };
    try {
      return await callGemini(model, body);
    } catch (e) {
      if (e.status === 400 && /think/i.test(e.message)) {
        delete body.generationConfig.thinkingConfig;
        return await callGemini(model, body);
      }
      throw e;
    }
  }, () => state.busy && setBusy(true, 'השרת עמוס, מנסה שוב…'));
  const text = (j.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error('התשובה מהמודל הגיעה ריקה');
  return JSON.parse(text);
}

// ---------- speech output ----------
const audioCache = new Map(); // key -> AudioBuffer
let currentSource = null;
let currentBtn = null;
let playToken = 0; // bumped on every stop, so a TTS fetch that finishes late doesn't start playing

function markBtn(btn, on) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.icon) btn.dataset.icon = btn.textContent;
    if (btn.classList.contains('icon-btn')) btn.textContent = '⏹';
    btn.classList.add('playing');
  } else {
    if (btn.dataset.icon && btn.classList.contains('icon-btn')) btn.textContent = btn.dataset.icon;
    btn.classList.remove('loading', 'playing');
  }
}

function stopPlayback() {
  playToken++;
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  window.speechSynthesis?.cancel();
  markBtn(currentBtn, false);
  currentBtn = null;
}

function pcmToBuffer(b64, rate) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    pcm[i] = v / 0x8000;
  }
  const len = speechEnd(pcm, rate);
  const c = audioCtx();
  const buf = c.createBuffer(1, Math.max(1, len), rate);
  const ch = buf.getChannelData(0);
  ch.set(pcm.subarray(0, len));
  // short fade-in / fade-out so the sound never starts or stops with a click
  const fadeIn = Math.min(len, Math.round(rate * 0.01)), fadeOut = Math.min(len, Math.round(rate * 0.08));
  for (let i = 0; i < fadeIn; i++) ch[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) ch[len - 1 - i] *= i / fadeOut;
  return buf;
}

// The TTS audio often ends with ~0.5 s of static/noise burst. Walk back from the end in 20 ms
// windows and drop windows that are silence or noise (very high zero-crossing rate), up to 1.2 s.
function speechEnd(pcm, rate) {
  const win = Math.round(rate * 0.02);
  const windows = Math.floor(pcm.length / win);
  if (windows < 10) return pcm.length;
  const rms = new Float32Array(windows), zcr = new Float32Array(windows);
  let peak = 0;
  for (let w = 0; w < windows; w++) {
    let sum = 0, cross = 0;
    for (let i = w * win; i < (w + 1) * win; i++) {
      sum += pcm[i] * pcm[i];
      if (i > w * win && (pcm[i] >= 0) !== (pcm[i - 1] >= 0)) cross++;
    }
    rms[w] = Math.sqrt(sum / win);
    zcr[w] = cross / win;
    if (rms[w] > peak) peak = rms[w];
  }
  const maxTrim = Math.round(1.2 / 0.02);
  let w = windows - 1;
  while (w > windows - 1 - maxTrim && w > 0) {
    const silent = rms[w] < peak * 0.04;
    const noisy = zcr[w] > 0.3;
    if (!silent && !noisy) break;
    w--;
  }
  // keep ~60 ms after the last speech window so word endings aren't cut
  return Math.min(pcm.length, (w + 1) * win + Math.round(rate * 0.06));
}

async function ttsBuffer(arabic, slow) {
  const cacheKey = `${state.settings.voice}|${slow}|${arabic}`;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
  // Send ONLY the Arabic text: the TTS model reads any instruction text aloud.
  // Slow mode = an Arabic comma between words, which makes the voice pause after each word.
  const text = slow ? arabic.trim().split(/\s+/).join('، ') : arabic;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[state.settings.voice] } } },
    },
  };
  const j = await withFallback('tts', (model) => callGemini(model, body));
  const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error('no audio');
  const rate = +(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] || 24000);
  const buf = pcmToBuffer(part.inlineData.data, rate);
  audioCache.set(cacheKey, buf);
  return buf;
}

function speakWithBrowser(arabic, slow) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(arabic);
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /^ar[-_](PS|JO|SY|LB|IL)/i.test(x.lang)) || voices.find((x) => /^ar/i.test(x.lang));
    if (v) u.voice = v;
    u.lang = v?.lang || 'ar';
    u.rate = slow ? 0.75 : 0.95;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function speak(arabic, slow = state.settings.speed === 'slow', btn) {
  // Tapping the button that is currently playing/loading = stop.
  if (btn && btn === currentBtn) { stopPlayback(); return; }
  stopPlayback();
  if (!arabic) return;
  const token = playToken;
  currentBtn = btn || null;
  markBtn(btn, true);
  btn?.classList.add('loading');
  try {
    let buf = null;
    try {
      if (state.models?.tts) buf = await ttsBuffer(arabic, slow);
    } catch (e) {
      console.warn('Gemini TTS failed, using browser voice', e);
    }
    if (token !== playToken) return; // stopped while loading
    btn?.classList.remove('loading');
    if (buf) {
      const c = audioCtx();
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      currentSource = src;
      await new Promise((res) => { src.onended = res; src.start(); });
    } else {
      await speakWithBrowser(arabic, slow);
    }
  } finally {
    if (token === playToken) {
      markBtn(btn, false);
      currentBtn = null;
      currentSource = null;
    }
  }
}

// ---------- recording (raw PCM → 16 kHz WAV; works on Chrome, Safari, Firefox) ----------
const rec = { stream: null, src: null, proc: null, chunks: [], rate: 48000, timer: null, active: false };

async function startRecording() {
  stopPlayback();
  const c = audioCtx();
  rec.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  rec.src = c.createMediaStreamSource(rec.stream);
  rec.proc = c.createScriptProcessor(4096, 1, 1);
  rec.chunks = [];
  rec.rate = c.sampleRate;
  rec.proc.onaudioprocess = (e) => rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  rec.src.connect(rec.proc);
  rec.proc.connect(c.destination);
  rec.active = true;
  rec.timer = setTimeout(() => toggleRecording(), MAX_REC_SECONDS * 1000);
}

function stopRecording() {
  clearTimeout(rec.timer);
  rec.active = false;
  try { rec.src.disconnect(); rec.proc.disconnect(); } catch {}
  rec.stream?.getTracks().forEach((t) => t.stop());
  const total = rec.chunks.reduce((n, a) => n + a.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const a of rec.chunks) { all.set(a, o); o += a.length; }
  return { samples: all, rate: rec.rate };
}

function toWav16k(samples, rate) {
  const target = 16000;
  const ratio = rate / target;
  const n = Math.floor(samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // average the source samples that fall into this output sample (simple low-pass)
    const start = Math.floor(i * ratio), end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = start; k < end; k++) sum += samples[k];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + out.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, out.length * 2, true);
  new Int16Array(buf, 44).set(out);
  return new Uint8Array(buf);
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- conversation ----------
function historyText() {
  if (!state.history.length) return '(no messages yet)';
  return state.history.map((h) =>
    `${h.role === 'learner' ? 'Learner' : 'You'}: ${h.arabic || h.translit} (${h.hebrew})`).join('\n');
}

function scenarioText() {
  const s = state.scenario;
  return `Scenario: ${s.desc}`;
}

async function openConversation() {
  setBusy(true, 'מתחיל שיחה…');
  try {
    const res = await askJSON([{ text:
      `${scenarioText()}\n\nThis is the OPENING turn: the learner has not spoken yet. ` +
      `Set understood=true, has_mistake=false, leave heard_* and corrected_* empty, and open the conversation with a short greeting and a simple question that fits the scenario.` }],
      TURN_SCHEMA);
    addPartner(res);
  } catch (e) {
    handleError(e);
    addRetry('לא הצלחתי לפתוח את השיחה.', openConversation);
  } finally {
    setBusy(false);
  }
}

// A small "try again" card in the chat, so a failed turn (and its recording) isn't lost.
function addRetry(text, fn) {
  const b = el('div', 'bubble retry');
  b.append(el('div', 'label', text));
  const btn = el('button', 'text-btn strong', '↻ נסה שוב');
  btn.onclick = () => { if (state.busy || rec.active) return; b.remove(); fn(); };
  b.append(btn);
  $('#chat-log').append(b);
  scrollChat();
}

async function sendLearnerAudio(wavBytes) {
  setBusy(true, 'מקשיב…');
  try {
    const res = await askJSON([
      { text: `${scenarioText()}\n\nConversation so far:\n${historyText()}\n\n` +
              `The attached audio is the learner's next turn. Transcribe exactly what they said (with mistakes), correct if needed, and reply.` },
      { inlineData: { mimeType: 'audio/wav', data: bytesToB64(wavBytes) } },
    ], TURN_SCHEMA);
    addLearner(res);
    addPartner(res);
  } catch (e) {
    handleError(e);
    addRetry('ההקלטה שלך לא נשלחה.', () => sendLearnerAudio(wavBytes));
  } finally {
    setBusy(false);
  }
}

function addLearner(res) {
  const entry = { role: 'learner', arabic: res.heard_arabic, translit: res.heard_translit, hebrew: res.heard_hebrew };
  if (res.has_mistake && res.corrected_translit) {
    entry.correction = { arabic: res.corrected_arabic, translit: res.corrected_translit, explanation: res.explanation_hebrew };
  } else if (res.explanation_hebrew) {
    entry.note = res.explanation_hebrew; // e.g. answer to "how do I say..."
  }
  if (res.understood === false) entry.unclear = true;
  state.history.push(entry);
  renderLearner(entry);
}

function addPartner(res) {
  const entry = { role: 'partner', arabic: res.reply_arabic, translit: res.reply_translit, hebrew: res.reply_hebrew };
  state.history.push(entry);
  state.lastHint = res.hint_translit ? { translit: res.hint_translit, hebrew: res.hint_hebrew } : null;
  $('#hint-btn').disabled = !state.lastHint;
  const bubble = renderPartner(entry);
  speak(entry.arabic, undefined, bubble.querySelector('.play'));
}

// ---------- rendering ----------
function scrollChat() {
  const log = $('#chat-log');
  requestAnimationFrame(() => log.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
}

function renderPartner(entry) {
  const b = el('div', 'bubble partner');
  const tr = el('div', 'translit', entry.translit);
  if (!state.settings.showTranslit) {
    tr.classList.add('hidden-text');
    tr.title = 'הקש כדי לראות';
    tr.onclick = () => tr.classList.remove('hidden-text');
  }
  b.append(tr);

  const heb = el('div', 'hebrew', entry.hebrew);
  if (!state.settings.showTranslation) heb.hidden = true;
  b.append(heb);

  const actions = el('div', 'actions');
  const play = el('button', 'icon-btn play', '🔊');
  play.title = 'השמע שוב';
  play.onclick = () => speak(entry.arabic, undefined, play);
  const slow = el('button', 'icon-btn', '🐢');
  slow.title = 'השמע לאט';
  slow.onclick = () => speak(entry.arabic, true, slow);
  actions.append(play, slow);
  if (!state.settings.showTranslation) {
    const t = el('button', 'text-btn', 'תרגום');
    t.onclick = () => { heb.hidden = !heb.hidden; };
    actions.append(t);
  }
  b.append(actions);
  $('#chat-log').append(b);
  scrollChat();
  return b;
}

function renderLearner(entry) {
  const b = el('div', 'bubble learner');
  b.append(el('div', 'label', entry.unclear ? 'לא הצלחתי לשמוע טוב. שמעתי:' : 'אמרת:'));
  b.append(el('div', 'translit', entry.translit || '…'));
  if (entry.hebrew) b.append(el('div', 'hebrew', entry.hebrew));
  if (entry.correction && state.settings.correct === 'each') {
    const c = el('div', 'correction');
    c.append(el('div', 'label', 'עדיף לומר:'));
    const row = el('div', 'row');
    row.append(el('span', 'translit', entry.correction.translit));
    const p = el('button', 'icon-btn', '🔊');
    p.onclick = () => speak(entry.correction.arabic, true, p);
    row.append(p);
    c.append(row);
    if (entry.correction.explanation) c.append(el('div', 'explain', entry.correction.explanation));
    b.append(c);
  } else if (entry.correction) {
    b.append(el('div', 'saved-note', '✎ יש הערה — תופיע בסיכום'));
  }
  if (entry.note) b.append(el('div', 'note', entry.note));
  $('#chat-log').append(b);
  scrollChat();
}

function setBusy(busy, label) {
  state.busy = busy;
  const status = $('#status');
  status.textContent = busy ? label : '';
  status.classList.toggle('active', busy);
  $('#mic').disabled = busy;
}

function handleError(e) {
  console.error(e);
  let msg = e.message || String(e);
  if (e.status === 400 && /API key/i.test(msg)) msg = 'המפתח לא תקין. בדוק אותו בהגדרות.';
  else if (e.status === 429) msg = 'הגעת למכסה החינמית לרגע הזה. חכה דקה ונסה שוב.';
  else if (isTransient(e)) msg = 'השרתים של גוגל עמוסים כרגע (ניסיתי כמה מודלים). נסה שוב בעוד רגע.';
  else if (e.status === 403) msg = 'אין הרשאה למפתח הזה. בדוק אותו בהגדרות.';
  else if (e.name === 'NotAllowedError') msg = 'צריך לאשר גישה למיקרופון (בסמל המנעול ליד הכתובת).';
  toast('שגיאה: ' + msg, 7000);
}

// ---------- summary ----------
async function finishConversation() {
  if (rec.active) stopRecording();
  stopPlayback();
  const learnerTurns = state.history.filter((h) => h.role === 'learner');
  if (!learnerTurns.length) { show('home'); return; }
  show('summary');
  const box = $('#summary-body');
  box.replaceChildren(el('div', 'status active', 'מכין סיכום…'));
  try {
    const res = await askJSON([{ text:
      `${scenarioText()}\n\nFull conversation:\n${historyText()}\n\n` +
      `Corrections already noted during the conversation:\n` +
      (learnerTurns.filter((h) => h.correction).map((h) => `- said "${h.translit}" → "${h.correction.translit}"`).join('\n') || '(none)') +
      `\n\nWrite a short summary for the learner in Hebrew: the main mistakes (max 6, most important first, merge duplicates), ` +
      `useful new words that appeared (max 8), and one tip.` }], SUMMARY_SCHEMA);
    renderSummary(res);
  } catch (e) {
    box.replaceChildren(el('p', null, 'לא הצלחתי להכין סיכום.'));
    handleError(e);
  }
}

function renderSummary(res) {
  const box = $('#summary-body');
  box.replaceChildren();
  box.append(el('p', 'summary-text', res.summary_hebrew));
  if (res.mistakes?.length) {
    box.append(el('h3', null, 'מה לתקן'));
    for (const m of res.mistakes) {
      const card = el('div', 'card');
      card.append(el('div', 'wrong', m.said_translit));
      const row = el('div', 'row');
      row.append(el('span', 'translit', '← ' + m.correct_translit));
      const p = el('button', 'icon-btn', '🔊');
      p.onclick = () => speak(m.correct_arabic, true, p);
      row.append(p);
      card.append(row, el('div', 'explain', m.explanation_hebrew));
      box.append(card);
    }
  } else {
    box.append(el('p', null, 'לא היו טעויות משמעותיות — כל הכבוד! 👏'));
  }
  if (res.new_words?.length) {
    box.append(el('h3', null, 'מילים מהשיחה'));
    const list = el('div', 'words');
    for (const w of res.new_words) {
      const item = el('button', 'word');
      item.append(el('span', 'translit', w.translit), el('span', 'hebrew', w.hebrew));
      item.onclick = () => speak(w.arabic, true, item);
      list.append(item);
    }
    box.append(list);
  }
  if (res.tip_hebrew) box.append(el('p', 'tip', '💡 ' + res.tip_hebrew));
}

// ---------- screens & wiring ----------
function renderScenarios() {
  const grid = $('#scenarios');
  grid.replaceChildren();
  for (const s of SCENARIOS) {
    const b = el('button', 'scenario');
    b.append(el('span', 'icon', s.icon), el('span', 'title', s.title));
    b.onclick = () => startScenario(s);
    grid.append(b);
  }
}

function startScenario(s) {
  audioCtx(); // unlock audio on this tap
  state.scenario = s;
  state.history = [];
  state.lastHint = null;
  $('#chat-title').textContent = `${s.icon} ${s.title}`;
  $('#chat-log').replaceChildren();
  $('#hint-box').hidden = true;
  show('chat');
  openConversation();
}

async function toggleRecording() {
  const mic = $('#mic');
  if (rec.active) {
    mic.classList.remove('recording');
    $('#mic-label').textContent = 'לחץ ודבר';
    const { samples, rate } = stopRecording();
    if (samples.length < rate * 0.4) { toast('ההקלטה קצרה מדי — לחץ, דבר, ולחץ שוב לסיום.'); return; }
    $('#hint-box').hidden = true;
    await sendLearnerAudio(toWav16k(samples, rate));
    return;
  }
  if (state.busy) return;
  try {
    await startRecording();
    mic.classList.add('recording');
    $('#mic-label').textContent = 'מקליט… לחץ לסיום';
  } catch (e) {
    handleError(e);
  }
}

function loadSettingsForm() {
  const f = $('#settings-form');
  f.key.value = state.key;
  f.voice.value = state.settings.voice;
  f.speed.value = state.settings.speed;
  f.correct.value = state.settings.correct;
  f.showTranslit.checked = state.settings.showTranslit;
  f.showTranslation.checked = state.settings.showTranslation;
  $('#model-info').textContent = state.models
    ? `מודל שיחה: ${state.models.text} · מודל קול: ${state.models.tts || 'קול הדפדפן'}`
    : '';
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = $('#settings-form');
  const newKey = f.key.value.trim();
  state.settings = {
    voice: f.voice.value,
    speed: f.speed.value,
    correct: f.correct.value,
    showTranslit: f.showTranslit.checked,
    showTranslation: f.showTranslation.checked,
  };
  store.set('ap_settings', state.settings);
  audioCache.clear();
  if (!newKey) { toast('צריך להדביק מפתח'); return; }
  if (newKey !== state.key || !state.models) {
    state.key = newKey;
    store.set('ap_key', newKey);
    const btn = $('#save-btn');
    btn.disabled = true;
    btn.textContent = 'בודק את המפתח…';
    try {
      await pickModels();
    } catch (e) {
      store.del('ap_models');
      state.models = null;
      handleError(e);
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = 'שמור';
    }
  }
  loadSettingsForm();
  toast('נשמר ✓', 2000);
  show('home');
}

function init() {
  $('#version').textContent = 'גרסה ' + APP_VERSION;
  renderScenarios();
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#open-settings').onclick = () => { loadSettingsForm(); show('settings'); };
  $('#close-settings').onclick = () => show(state.key && state.models ? 'home' : 'settings');
  $('#mic').onclick = toggleRecording;
  $('#hint-btn').onclick = () => {
    if (!state.lastHint) return;
    const h = $('#hint-box');
    h.replaceChildren(el('div', 'translit', state.lastHint.translit), el('div', 'hebrew', state.lastHint.hebrew));
    h.hidden = !h.hidden;
  };
  $('#finish-btn').onclick = finishConversation;
  $('#back-btn').onclick = () => { stopPlayback(); if (rec.active) stopRecording(); show('home'); };
  $('#summary-home').onclick = () => show('home');
  speechSynthesis?.getVoices?.(); // warm up voice list

  if (!navigator.mediaDevices?.getUserMedia) {
    toast('הדפדפן הזה לא תומך בהקלטה. נסה Chrome או Safari מעודכן.', 10000);
  }
  if (state.key && state.models) show('home');
  else { loadSettingsForm(); show('settings'); }
}

init();
