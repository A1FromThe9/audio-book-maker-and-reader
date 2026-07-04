// Speech engine built on the Web Speech API.
//
// Speaks one utterance per sentence, chained via onend. Sentence-sized
// utterances are what make reliable text sync possible (we always know which
// sentence is sounding), and they also avoid Chrome's cutoff bug on long
// utterances. Pause is implemented as cancel + remembered index because
// native pause()/resume() is broken on several platforms.

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// getVoices() is empty until voiceschanged fires on some browsers.
export function loadVoices(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve([]);
    const synth = window.speechSynthesis;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(synth.getVoices());
    };
    if (synth.getVoices().length) return finish();
    synth.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

// Novelty/sound-effect voices (Apple's "Novelty" voice category — Albert,
// Bad News, Bahh, Bells, Boing, Bubbles, Cellos, Deranged, Good News,
// Hysterical, Jester, Organ, Pipe Organ, Trinoids, Whisper, Wobble, Zarvox)
// plus old low-fidelity default voices (Fred, Ralph, Kathy, Junior, Princess)
// that ship alongside the good ones on macOS/iOS. None of these are
// pleasant for long-form narration, so they're filtered out of the picker.
const EXCLUDED_VOICE_NAMES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
  'deranged', 'good news', 'hysterical', 'jester', 'organ', 'pipe organ',
  'trinoids', 'whisper', 'wobble', 'zarvox',
  'fred', 'ralph', 'kathy', 'junior', 'princess',
]);

export function isNarrationVoice(voice) {
  if (!voice.lang || !voice.lang.toLowerCase().startsWith('en')) return false;
  const base = voice.name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  return !EXCLUDED_VOICE_NAMES.has(base);
}

// English narration voices only, with the low-quality/novelty ones removed;
// falls back to the full list if a device happens to have nothing else.
export function pickNarrationVoices(all) {
  const filtered = all.filter(isNarrationVoice);
  return filtered.length ? filtered : all;
}

export class SpeechEngine {
  constructor({ onSentence, onWord, onState, onFinish } = {}) {
    this.sentences = [];
    this.index = 0;
    this.rate = 1;
    this.voice = null;
    this.playing = false;
    this.onSentence = onSentence;
    this.onWord = onWord;
    this.onState = onState;
    this.onFinish = onFinish;
    // Generation counter: bumped on every cancel so stale utterance events
    // (which still fire after cancel on some platforms) are ignored.
    this._gen = 0;
    this._utt = null;
  }

  load(sentences, index = 0) {
    this.stop();
    this.sentences = sentences;
    this.index = this._clamp(index);
  }

  play(from = this.index) {
    if (!this.sentences.length || !ttsSupported()) return;
    this._cancel();
    this.index = this._clamp(from);
    this.playing = true;
    this.onState?.(true);
    this._speak();
  }

  pause() {
    if (!this.playing) return;
    this._cancel();
    this.playing = false;
    this.onState?.(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop() {
    this._cancel();
    this.playing = false;
  }

  seek(i) {
    i = this._clamp(i);
    if (this.playing) {
      this.play(i);
    } else {
      this.index = i;
      this.onSentence?.(i);
    }
  }

  next() { this.seek(this.index + 1); }
  prev() { this.seek(this.index - 1); }

  setRate(r) {
    this.rate = r;
    if (this.playing) this.play(this.index);
  }

  setVoice(v) {
    this.voice = v;
    if (this.playing) this.play(this.index);
  }

  _clamp(i) {
    return Math.max(0, Math.min(i, Math.max(0, this.sentences.length - 1)));
  }

  _cancel() {
    this._gen++;
    try { window.speechSynthesis.cancel(); } catch { /* not supported */ }
  }

  _speak() {
    const gen = this._gen;
    const i = this.index;
    const u = new SpeechSynthesisUtterance(this.sentences[i]);
    this._utt = u; // hold a reference: Chrome GCs live utterances and drops their events
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    }
    u.rate = this.rate;

    this.onSentence?.(i);

    u.onboundary = (e) => {
      if (gen !== this._gen || e.name !== 'word') return;
      this.onWord?.(i, e.charIndex, e.charLength || 0);
    };
    const advance = () => {
      if (gen !== this._gen) return;
      if (this.index < this.sentences.length - 1) {
        this.index++;
        this._speak();
      } else {
        this.playing = false;
        this.onState?.(false);
        this.onFinish?.();
      }
    };
    u.onend = advance;
    u.onerror = (e) => {
      if (gen !== this._gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      advance();
    };
    window.speechSynthesis.speak(u);
  }
}
