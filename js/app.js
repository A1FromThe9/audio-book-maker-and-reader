import * as store from './store.js';
import { extractPdf } from './extract.js';
import { SpeechEngine, ttsSupported, loadVoices, pickNarrationVoices } from './tts.js';
import { icon } from './icons.js';

const view = document.getElementById('view');
const fileInput = document.getElementById('file-input');

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const WPM = 155; // rough spoken-word pace at 1x, used for all duration estimates

function formatDuration(mins) {
  const m = Math.max(1, Math.round(mins));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function formatTimeLeft(mins) {
  if (mins < 1) return 'Less than a minute left';
  return `~${formatDuration(mins)} left`;
}

const settings = {
  get rate() { return parseFloat(localStorage.getItem('abr-rate')) || 1; },
  set rate(v) { localStorage.setItem('abr-rate', String(v)); },
  get voiceURI() { return localStorage.getItem('abr-voice') || ''; },
  set voiceURI(v) { localStorage.setItem('abr-voice', v); },
};

// ---------- tiny DOM helper ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// ---------- routing ----------

let cleanupFns = [];
function onCleanup(fn) { cleanupFns.push(fn); }
function runCleanup() {
  for (const fn of cleanupFns.splice(0)) {
    try { fn(); } catch { /* view teardown must not block routing */ }
  }
}

function route() {
  runCleanup();
  window.scrollTo(0, 0);
  const m = (location.hash || '').match(/^#\/book\/(.+)$/);
  if (m) renderReader(decodeURIComponent(m[1]));
  else renderLibrary();
}

window.addEventListener('hashchange', route);

// ---------- library ----------

async function renderLibrary() {
  document.title = 'Audiobook Reader';
  const books = await store.listBooks();
  view.className = 'view';
  view.innerHTML = '';

  view.append(
    el('h1', {}, 'Audiobooks'),
    el('button', { class: 'upload-card', onclick: () => fileInput.click() },
      el('span', { class: 'upload-icon', html: icon('upload', 26) }),
      el('span', { class: 'upload-text' },
        el('strong', {}, 'Add a PDF'),
        el('span', {}, 'Turn any PDF into a read-along audiobook'),
      ),
    ),
  );

  if (!books.length) {
    view.append(el('div', { class: 'empty' },
      el('div', { class: 'empty-icon', html: icon('book', 34) }),
      el('p', {}, 'Your library is empty.'),
      el('p', { class: 'dim' }, 'Add a PDF above — the text is extracted on your device, then read aloud with the words highlighted as you listen.'),
    ));
    return;
  }

  const list = el('div', { class: 'book-list' });
  for (const b of books) {
    const pct = b.numSentences > 1
      ? Math.round(((b.progress?.sentenceIndex || 0) / (b.numSentences - 1)) * 100)
      : 0;
    const dur = formatDuration((b.numWords || 0) / WPM);
    list.append(
      el('div', { class: 'book-card', onclick: () => { location.hash = `#/book/${encodeURIComponent(b.id)}`; } },
        el('div', { class: 'book-cover', html: icon('book', 22) }),
        el('div', { class: 'book-meta' },
          el('div', { class: 'book-title' }, b.title),
          el('div', { class: 'book-sub' }, `~${dur} · ${pct}%`),
          el('div', { class: 'book-bar' }, el('div', { class: 'book-bar-fill', style: `width:${pct}%` })),
        ),
        el('button', {
          class: 'icon-btn danger', 'aria-label': 'Delete book', html: icon('trash', 18),
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete “${b.title}”?`)) return;
            await store.deleteBook(b.id);
            renderLibrary();
          },
        }),
      ),
    );
  }
  view.append(list);
}

// ---------- upload / extraction ----------

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
  fileInput.value = '';
});

async function handleFile(file) {
  const status = el('div', { class: 'overlay-status' }, 'Opening PDF…');
  const overlay = el('div', { class: 'overlay' },
    el('div', { class: 'overlay-card' },
      el('div', { class: 'spinner' }),
      status,
    ),
  );
  document.body.append(overlay);
  try {
    const { title, paragraphs } = await extractPdf(file, (p, n) => {
      status.textContent = `Reading page ${p} of ${n}…`;
    });
    const flat = paragraphs.flat();
    const meta = {
      id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      title,
      addedAt: Date.now(),
      numSentences: flat.length,
      numWords: flat.join(' ').split(/\s+/).filter(Boolean).length,
      progress: { sentenceIndex: 0, updatedAt: Date.now() },
    };
    await store.addBook(meta, paragraphs, file);
    location.hash = `#/book/${encodeURIComponent(meta.id)}`;
  } catch (err) {
    alert(err?.code === 'no-text'
      ? 'No text could be extracted from this PDF — it looks like a scanned document. Scanned PDFs (OCR) aren\'t supported yet.'
      : `Couldn't read that PDF. ${err?.message || err}`);
  } finally {
    overlay.remove();
  }
}

// ---------- reader ----------

async function renderReader(id) {
  const meta = await store.getBook(id);
  if (!meta) { location.hash = '#/'; return; }
  const paragraphs = (await store.getText(id)) || [];
  document.title = meta.title;

  view.className = 'view reader-mode';
  view.innerHTML = '';

  // --- book content: one span per sentence ---
  const flat = [];
  const sentenceEls = [];
  const content = el('article', { class: 'book-text' });
  for (const para of paragraphs) {
    const p = el('p', { class: 'para' });
    for (const s of para) {
      const idx = flat.length;
      const span = el('span', { class: 's', dataset: { i: idx } }, s);
      p.append(span, ' ');
      flat.push(s);
      sentenceEls.push(span);
    }
    content.append(p);
  }

  // Prefix sums of word counts, so "time left" from any sentence is a lookup,
  // not a re-scan. Granularity is per-sentence, not per-word.
  const wordsBefore = new Array(flat.length);
  let totalWords = 0;
  for (let i = 0; i < flat.length; i++) {
    wordsBefore[i] = totalWords;
    totalWords += flat[i].split(/\s+/).filter(Boolean).length;
  }
  function updateTimeLeft(i) {
    const remaining = totalWords - wordsBefore[i];
    timeLeftEl.textContent = formatTimeLeft(remaining / (WPM * engine.rate));
    timeLeftEl.title = `Sentence ${i + 1} of ${flat.length}`;
  }

  // --- speech engine + sync ---
  let follow = true;
  let saveTimer = 0;

  const engine = new SpeechEngine({
    onSentence: (i) => {
      highlightSentence(i);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => store.saveProgress(id, i), 400);
    },
    onWord: highlightWord,
    onState: (playing) => {
      playBtn.innerHTML = icon(playing ? 'pause' : 'play', 30);
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      if (playing) acquireWakeLock();
      else releaseWakeLock();
    },
    onFinish: () => store.saveProgress(id, flat.length - 1),
  });
  engine.rate = settings.rate;
  engine.load(flat, meta.progress?.sentenceIndex || 0);
  onCleanup(() => { engine.stop(); clearTimeout(saveTimer); releaseWakeLock(); });

  function highlightSentence(i) {
    const prev = content.querySelector('.s.active');
    if (prev) {
      prev.classList.remove('active');
      prev.textContent = flat[prev.dataset.i];
    }
    const span = sentenceEls[i];
    if (!span) return;
    span.classList.add('active');
    if (follow) scrollToSpan(span);
    progressFill.style.width = `${flat.length > 1 ? (i / (flat.length - 1)) * 100 : 100}%`;
    updateTimeLeft(i);
  }

  function highlightWord(i, charIndex, charLength) {
    const span = sentenceEls[i];
    if (!span || !span.classList.contains('active')) return;
    const text = flat[i];
    let end = charIndex + charLength;
    if (!charLength) {
      const m = text.slice(charIndex).match(/^\s*\S+/);
      if (!m) return;
      end = charIndex + m[0].length;
    }
    if (end <= charIndex || charIndex >= text.length) return;
    span.textContent = '';
    span.append(
      text.slice(0, charIndex),
      el('span', { class: 'word' }, text.slice(charIndex, end)),
      text.slice(end),
    );
  }

  function scrollToSpan(span, smooth = true) {
    span.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }

  // Tap a sentence to move playback there.
  content.addEventListener('click', (e) => {
    const span = e.target.closest('.s');
    if (!span) return;
    follow = true;
    followChip.classList.add('hidden');
    engine.seek(parseInt(span.dataset.i, 10));
  });

  // Manual scrolling turns follow mode off until the chip is tapped.
  const followChip = el('button', {
    class: 'follow-chip hidden',
    onclick: () => {
      follow = true;
      followChip.classList.add('hidden');
      const cur = sentenceEls[engine.index];
      if (cur) scrollToSpan(cur);
    },
  }, 'Back to current sentence');
  const unfollow = () => {
    if (!follow || !engine.playing) return;
    follow = false;
    followChip.classList.remove('hidden');
  };
  window.addEventListener('wheel', unfollow, { passive: true });
  window.addEventListener('touchmove', unfollow, { passive: true });
  onCleanup(() => {
    window.removeEventListener('wheel', unfollow);
    window.removeEventListener('touchmove', unfollow);
  });

  // --- top bar ---
  const top = el('header', { class: 'reader-top' },
    el('button', {
      class: 'icon-btn', 'aria-label': 'Back to library', html: icon('back', 22),
      onclick: () => { location.hash = '#/'; },
    }),
    el('div', { class: 'reader-title' }, meta.title),
  );

  // --- player bar ---
  const progressFill = el('div', { class: 'player-bar-fill' });
  const timeLeftEl = el('span', { class: 'player-count' }, '');
  const playBtn = el('button', {
    class: 'play-btn', 'aria-label': 'Play', html: icon('play', 30),
    onclick: () => engine.toggle(),
  });
  const rateBtn = el('button', {
    class: 'pill-btn', 'aria-label': 'Playback speed',
    onclick: () => {
      const next = RATES[(RATES.indexOf(engine.rate) + 1) % RATES.length] || 1;
      engine.setRate(next);
      settings.rate = next;
      rateBtn.textContent = `${next}×`;
      updateTimeLeft(engine.index);
    },
  }, `${engine.rate}×`);
  const voiceSelect = el('select', {
    class: 'voice-select', 'aria-label': 'Voice',
    onchange: () => {
      const v = voices.find((v) => v.voiceURI === voiceSelect.value);
      if (v) { engine.setVoice(v); settings.voiceURI = v.voiceURI; }
    },
  });

  const player = el('div', { class: 'player' },
    el('div', { class: 'player-bar' }, progressFill),
    el('div', { class: 'player-row' },
      el('div', { class: 'player-side' }, rateBtn),
      el('div', { class: 'player-main' },
        el('button', { class: 'icon-btn', 'aria-label': 'Previous sentence', html: icon('prev', 22), onclick: () => engine.prev() }),
        playBtn,
        el('button', { class: 'icon-btn', 'aria-label': 'Next sentence', html: icon('next', 22), onclick: () => engine.next() }),
      ),
      el('div', { class: 'player-side right' }, timeLeftEl),
    ),
    el('div', { class: 'player-voice' }, voiceSelect),
  );

  view.append(top, content, followChip, player);

  // --- voices: English narration voices only, novelty/legacy ones excluded ---
  let voices = [];
  if (ttsSupported()) {
    voices = pickNarrationVoices(await loadVoices()).slice().sort((a, b) => {
      const score = (v) => (v.lang?.toLowerCase() === 'en-us' ? 0 : 1) + (v.localService ? 0 : 0.5);
      return score(a) - score(b) || a.name.localeCompare(b.name);
    });
  }
  if (!voices.length) {
    view.insertBefore(
      el('div', { class: 'banner' }, 'No text-to-speech voices are available in this browser. You can still read, but audio won\'t play.'),
      content,
    );
    playBtn.disabled = true;
    voiceSelect.disabled = true;
  } else {
    for (const v of voices) {
      voiceSelect.append(el('option', { value: v.voiceURI }, `${v.name} (${v.lang})`));
    }
    const preferred = voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0];
    voiceSelect.value = preferred.voiceURI;
    engine.voice = preferred;
  }

  // --- keyboard (desktop nicety) ---
  const onKey = (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); engine.toggle(); }
    else if (e.code === 'ArrowRight') engine.next();
    else if (e.code === 'ArrowLeft') engine.prev();
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // Restore position (highlight without speaking).
  highlightSentence(engine.index);
  const cur = sentenceEls[engine.index];
  if (cur) requestAnimationFrame(() => scrollToSpan(cur, false));
}

// ---------- wake lock: keep the screen on while playing ----------

let wakeLock = null;
let wakeLockWanted = false;
async function acquireWakeLock() {
  wakeLockWanted = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* denied or unsupported */ }
}
function releaseWakeLock() {
  wakeLockWanted = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
// The lock is auto-released when the tab is hidden; re-acquire on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLockWanted) acquireWakeLock();
});

route();
