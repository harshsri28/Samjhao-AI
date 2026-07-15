/* Story Explainer — frontend logic */

const $ = (id) => document.getElementById(id);

const input = $('input');
const go = $('go');
const stopBtn = $('stopBtn');
const regenBtn = $('regenBtn');
const story = $('story');
const afterStory = $('afterStory');
const quizBtn = $('quizBtn');
const quizBox = $('quizBox');
const chatBox = $('chatBox');
const chatLog = $('chatLog');
const chatQ = $('chatQ');
const chatSend = $('chatSend');
const fileInput = $('fileInput');
const fileChip = $('fileChip');

// Everything about the story currently on screen (what history entries are made of)
let current = null; // {id, title, sourceInput, content, source, truncated, story, language, length, audience, chat, ts}
let uploadedDoc = null; // {content, title, truncated, source} from /api/prepare-file
let controller = null; // AbortController for the in-flight stream

// ---------- Option pills (language / length / audience) ----------
const opts = { language: 'english', length: 'normal', audience: 'adult' };
document.querySelectorAll('.pills').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    opts[group.dataset.group] = btn.dataset.value;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// ---------- Theme ----------
const themeToggle = $('themeToggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
}
applyTheme(
  localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
);
themeToggle.addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
);

// ---------- Markdown rendering (tiny, HTML-escaped first, offline) ----------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inlineMd(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}
function renderMarkdown(text) {
  const lines = escapeHtml(text).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^[-*]\s+(.*)/);
    const ol = line.match(/^\d+[.)]\s+(.*)/);
    if (!line) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
    } else if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        flushList();
        list = want;
        out.push(`<${want}>`);
      }
      out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

// ---------- Text-to-speech (browser built-in, free, offline) ----------
const speakToggle = $('speakToggle');
const stopVoice = $('stopVoice');
const synth = window.speechSynthesis;
let voices = [];
function loadVoices() { voices = synth.getVoices(); }
loadVoices();
if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;

function pickVoice(lang) {
  // Hindi story -> Hindi voice; English/Hinglish -> Indian English if available
  const want = lang === 'hindi' ? ['hi'] : ['en-IN', 'en-GB', 'en-US', 'en'];
  for (const pref of want) {
    const v = voices.find((v) => v.lang.toLowerCase().startsWith(pref.toLowerCase()));
    if (v) return v;
  }
  return null;
}

function cleanForSpeech(text) {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // emojis
    .replace(/[*#_`]/g, '') // markdown marks
    .trim();
}

function browserSpeak(clean, lang) {
  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.lang = lang === 'hindi' ? 'hi-IN' : 'en-IN';
  u.rate = 0.95;
  u.onend = () => { if (!synth.pending && !synth.speaking) stopVoice.hidden = true; };
  synth.speak(u);
  stopVoice.hidden = false;
}

// Neural voices from the server (/api/tts, Edge TTS) — natural Hindi/Hinglish/Indian-English.
// Audio for each sentence is fetched as soon as the sentence completes, and played in order.
// If the server voice fails (e.g. offline), we fall back to the browser voice for the rest.
let ttsQueue = []; // [{text, audio: Promise<Blob|null>}]
let ttsBusy = false;
let ttsFallback = false;
let ttsGen = 0; // bumped by stopSpeaking() so stale awaits know to bail
let playerResolve = null;
const player = new Audio();

function fetchTtsAudio(text, lang) {
  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: lang }),
  })
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b && b.size > 0 ? b : null))
    .catch(() => null);
}

function speak(sentence, lang) {
  const clean = cleanForSpeech(sentence);
  if (!clean) return;
  stopVoice.hidden = false;
  if (ttsFallback) { browserSpeak(clean, lang); return; }
  ttsQueue.push({ text: clean, lang, audio: fetchTtsAudio(clean, lang) });
  pumpTts();
}

async function pumpTts() {
  if (ttsBusy) return;
  const item = ttsQueue.shift();
  if (!item) {
    if (!synth.speaking && !synth.pending && !player.src) stopVoice.hidden = true;
    return;
  }
  ttsBusy = true;
  const gen = ttsGen;
  const blob = await item.audio;
  if (gen === ttsGen) {
    if (blob) {
      const url = URL.createObjectURL(blob);
      await new Promise((resolve) => {
        playerResolve = resolve;
        player.src = url;
        player.onended = resolve;
        player.onerror = resolve;
        player.play().catch(resolve);
      });
      playerResolve = null;
      player.removeAttribute('src');
      URL.revokeObjectURL(url);
    } else {
      // server voice unavailable — switch to the browser voice from here on
      ttsFallback = true;
      browserSpeak(item.text, item.lang);
      for (const rest of ttsQueue.splice(0)) browserSpeak(rest.text, rest.lang);
    }
  }
  ttsBusy = false;
  pumpTts();
}

function stopSpeaking() {
  ttsGen++;
  ttsQueue = [];
  synth.cancel();
  player.pause();
  player.removeAttribute('src');
  if (playerResolve) { playerResolve(); playerResolve = null; }
  stopVoice.hidden = true;
}
stopVoice.addEventListener('click', stopSpeaking);

// Feed streamed text in; speak each sentence as soon as it completes.
let speechBuffer = '';
function feedSpeech(chunk, lang) {
  if (!speakToggle.checked) return;
  speechBuffer += chunk;
  // sentence ends: . ! ? … or Hindi danda । or blank line
  let m;
  while ((m = speechBuffer.match(/^[\s\S]*?(?:[.!?…।]+["')]?\s|\n\n)/))) {
    speak(m[0], lang);
    speechBuffer = speechBuffer.slice(m[0].length);
  }
}
function flushSpeech(lang) {
  if (speakToggle.checked && speechBuffer.trim()) speak(speechBuffer, lang);
  speechBuffer = '';
}

// ---------- File upload ----------
$('uploadBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileChip.hidden = false;
  fileChip.querySelector('.chip-name').textContent = `⏳ ${file.name}`;
  try {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/prepare-file', { method: 'POST', body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Upload failed (${resp.status})`);
    uploadedDoc = data;
    fileChip.querySelector('.chip-name').textContent = file.name;
  } catch (err) {
    clearFile();
    showError('⚠️ ' + err.message);
  }
});
function clearFile() {
  uploadedDoc = null;
  fileInput.value = '';
  fileChip.hidden = true;
}
$('fileClear').addEventListener('click', clearFile);

// ---------- Streaming helper ----------
async function streamInto(url, body, onChunk) {
  controller = new AbortController();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Server error (${resp.status})`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    onChunk(chunk, full);
  }
  return full;
}

function showError(msg) {
  story.classList.add('visible', 'error');
  story.textContent = msg;
}

function setStreaming(on) {
  go.disabled = on;
  stopBtn.hidden = !on;
  if (on) {
    regenBtn.hidden = true;
    afterStory.hidden = true;
    quizBox.hidden = true;
    quizBox.innerHTML = '';
    chatBox.hidden = true;
  }
}

stopBtn.addEventListener('click', () => {
  if (controller) controller.abort();
  stopSpeaking();
});

// ---------- Explain flow ----------
go.addEventListener('click', explain);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) explain();
});
regenBtn.addEventListener('click', () => { if (current) tellStory(current); });

async function explain() {
  const text = input.value.trim();
  if (!text && !uploadedDoc) { input.focus(); return; }

  setStreaming(true);
  stopSpeaking();
  speechBuffer = '';
  story.classList.add('visible');
  story.classList.remove('error');
  story.textContent = 'Reading and thinking... 🤔';

  try {
    let prepared = uploadedDoc;
    if (!prepared) {
      const resp = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `Server error (${resp.status})`);
      prepared = data;
    }
    current = {
      id: String(Date.now()),
      title: prepared.title,
      sourceInput: uploadedDoc ? prepared.title : text,
      content: prepared.content,
      source: prepared.source,
      truncated: prepared.truncated,
      story: '',
      chat: [],
      ts: Date.now(),
    };
    await tellStory(current);
  } catch (err) {
    setStreaming(false);
    if (err.name === 'AbortError') return;
    showError('⚠️ ' + err.message);
  }
}

async function tellStory(entry) {
  setStreaming(true);
  stopSpeaking();
  speechBuffer = '';
  ttsFallback = false; // give the neural server voice another chance on each new story
  story.classList.add('visible');
  story.classList.remove('error');
  story.textContent = 'Thinking... 🤔';
  entry.language = opts.language;
  entry.length = opts.length;
  entry.audience = opts.audience;
  entry.story = '';
  entry.chat = [];
  chatLog.innerHTML = '';

  try {
    const full = await streamInto(
      '/api/explain',
      {
        content: entry.content,
        source: entry.source,
        truncated: entry.truncated,
        language: entry.language,
        length: entry.length,
        audience: entry.audience,
      },
      (chunk, soFar) => {
        story.innerHTML = renderMarkdown(soFar);
        feedSpeech(chunk, entry.language);
      }
    );
    flushSpeech(entry.language);
    if (!full.trim()) throw new Error('No story came back — check the server logs.');
    entry.story = full;
    saveToHistory(entry);
    afterStory.hidden = false;
    chatBox.hidden = false;
    regenBtn.hidden = false;
  } catch (err) {
    if (err.name === 'AbortError') {
      entry.story = story.textContent; // keep the partial story usable
      if (entry.story.trim()) {
        saveToHistory(entry);
        afterStory.hidden = false;
        chatBox.hidden = false;
        regenBtn.hidden = false;
      }
    } else {
      showError('⚠️ ' + err.message);
    }
  } finally {
    setStreaming(false);
  }
}

// ---------- Quiz ----------
quizBtn.addEventListener('click', async () => {
  if (!current) return;
  quizBtn.disabled = true;
  quizBtn.textContent = '🎯 Making your quiz...';
  try {
    const resp = await fetch('/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: current.content, story: current.story, language: current.language }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Server error (${resp.status})`);
    renderQuiz(data.questions);
  } catch (err) {
    quizBox.hidden = false;
    quizBox.innerHTML = `<div class="quiz-card">⚠️ ${escapeHtml(err.message)}</div>`;
  } finally {
    quizBtn.disabled = false;
    quizBtn.textContent = '🎯 Test me';
  }
});

function renderQuiz(questions) {
  quizBox.hidden = false;
  quizBox.innerHTML = '';
  let answered = 0;
  let score = 0;
  const scoreLine = document.createElement('div');
  scoreLine.id = 'quizScore';

  questions.forEach((q, qi) => {
    const card = document.createElement('div');
    card.className = 'quiz-card';
    const qEl = document.createElement('div');
    qEl.className = 'quiz-q';
    qEl.textContent = `${qi + 1}. ${q.q}`;
    card.appendChild(qEl);
    const buttons = [];
    q.options.forEach((opt, oi) => {
      const b = document.createElement('button');
      b.className = 'quiz-opt';
      b.textContent = opt;
      b.addEventListener('click', () => {
        buttons.forEach((x) => (x.disabled = true));
        buttons[q.answer_index].classList.add('correct');
        if (oi === q.answer_index) score++;
        else b.classList.add('wrong');
        if (++answered === questions.length) {
          scoreLine.textContent =
            score === questions.length
              ? `🏆 ${score}/${questions.length} — perfect, you got the story!`
              : `📖 You scored ${score}/${questions.length} — read the story once more!`;
        }
      });
      buttons.push(b);
      card.appendChild(b);
    });
    quizBox.appendChild(card);
  });
  quizBox.appendChild(scoreLine);
}

// ---------- Follow-up chat ----------
chatSend.addEventListener('click', askFollowup);
chatQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') askFollowup(); });

function addBubble(cls, text) {
  const b = document.createElement('div');
  b.className = `bubble ${cls}`;
  b.textContent = text;
  chatLog.appendChild(b);
  b.scrollIntoView({ block: 'nearest' });
  return b;
}

async function askFollowup() {
  const question = chatQ.value.trim();
  if (!question || !current) return;
  chatQ.value = '';
  chatSend.disabled = true;
  addBubble('q', question);
  const aBubble = addBubble('a', '...');
  stopSpeaking(); // don't talk over the story while answering
  speechBuffer = '';
  try {
    const full = await streamInto(
      '/api/followup',
      {
        content: current.content,
        story: current.story,
        chat: current.chat,
        question,
        language: current.language,
      },
      (chunk, soFar) => {
        aBubble.textContent = soFar;
        aBubble.scrollIntoView({ block: 'nearest' });
        feedSpeech(chunk, current.language);
      }
    );
    flushSpeech(current.language);
    current.chat.push({ q: question, a: full });
    saveToHistory(current);
  } catch (err) {
    if (err.name !== 'AbortError') aBubble.textContent = '⚠️ ' + err.message;
  } finally {
    chatSend.disabled = false;
    chatQ.focus();
  }
}

// ---------- History (localStorage) ----------
const HISTORY_KEY = 'storyHistory';
const HISTORY_MAX = 20;
const historyDrawer = $('historyDrawer');
const drawerOverlay = $('drawerOverlay');

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}
function saveToHistory(entry) {
  let items = loadHistory().filter((e) => e.id !== entry.id);
  items.unshift(entry);
  items = items.slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); }
  catch { /* storage full — history just won't grow */ }
  renderHistory();
}
function deleteFromHistory(id) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(loadHistory().filter((e) => e.id !== id)));
  renderHistory();
}

const LANG_BADGE = { english: 'EN', hindi: 'हिं', hinglish: 'HING' };
function renderHistory() {
  const list = $('historyList');
  const items = loadHistory();
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="hist-empty">No stories yet — explain something first! 📖</div>';
    return;
  }
  for (const e of items) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const main = document.createElement('div');
    main.className = 'hist-main';
    const t = document.createElement('div');
    t.className = 'hist-title';
    t.textContent = e.title || '(untitled)';
    const m = document.createElement('div');
    m.className = 'hist-meta';
    m.textContent = `${LANG_BADGE[e.language] || ''} · ${new Date(e.ts).toLocaleString()}`;
    main.append(t, m);
    const del = document.createElement('button');
    del.className = 'hist-del';
    del.textContent = '🗑';
    del.title = 'Delete';
    del.addEventListener('click', (ev) => { ev.stopPropagation(); deleteFromHistory(e.id); });
    row.append(main, del);
    row.addEventListener('click', () => { openHistoryEntry(e); toggleDrawer(false); });
    list.appendChild(row);
  }
}

function openHistoryEntry(e) {
  if (controller) controller.abort();
  stopSpeaking();
  current = e;
  input.value = e.sourceInput || '';
  clearFile();
  // restore the pills to how the story was made
  for (const [group, value] of [['language', e.language], ['length', e.length], ['audience', e.audience]]) {
    if (!value) continue;
    opts[group] = value;
    const pills = document.querySelector(`.pills[data-group="${group}"]`);
    pills.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
  }
  story.classList.add('visible');
  story.classList.remove('error');
  story.innerHTML = renderMarkdown(e.story || '');
  afterStory.hidden = false;
  regenBtn.hidden = false;
  quizBox.hidden = true;
  quizBox.innerHTML = '';
  chatBox.hidden = false;
  chatLog.innerHTML = '';
  for (const turn of e.chat || []) {
    addBubble('q', turn.q);
    addBubble('a', turn.a);
  }
}

function toggleDrawer(open) {
  historyDrawer.classList.toggle('open', open);
  drawerOverlay.classList.toggle('open', open);
}
$('historyBtn').addEventListener('click', () => { renderHistory(); toggleDrawer(true); });
$('drawerClose').addEventListener('click', () => toggleDrawer(false));
drawerOverlay.addEventListener('click', () => toggleDrawer(false));
$('clearHistory').addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

renderHistory();
