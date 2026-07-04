# Audiobook Reader

Turn any PDF into a read-along audiobook — installable as a home-screen app on your phone.

- **Upload a PDF** and the text is extracted right on your device (nothing is uploaded anywhere)
- **Listen** with your device's built-in text-to-speech voices
- **Follow along**: the current sentence is highlighted and the page auto-scrolls in sync with the audio (word-level highlighting too, where the platform supports it)
- **Tap any sentence** to jump the audio there
- **Chapters**: when a PDF has them, jump straight to any chapter and see which one you're currently in
- **Speed & voice controls** (0.75×–2×), voice list limited to real English narration voices — novelty voices (Jester, Zarvox, etc.) and old low-fidelity ones are filtered out
- **Time remaining** for the rest of the book, updating live as you read and adjusting to your chosen speed
- **Library with resume**: books and your reading position are saved on your device, so you always pick up where you left off
- Works fully offline, no accounts, no server

## Run locally

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Install on your phone

1. Enable GitHub Pages for this repo (Settings → Pages → Source: GitHub Actions).
2. Open the deployed URL on your phone.
3. Tap **Share → Add to Home Screen**.

## How it works

- [pdf.js](https://mozilla.github.io/pdf.js/) (vendored in `vendor/pdfjs/`) parses the PDF in the browser. Lines are reconstructed into paragraphs, repeated headers/footers and page numbers are stripped, hyphenated line-break words are re-joined, and the text is split into sentences.
- Chapters are read from the PDF's embedded bookmarks when present; otherwise they're detected from heading-sized text (short lines in a noticeably larger font than the surrounding body text). Books with fewer than two detected chapters just don't show a chapters button.
- Playback uses the Web Speech API with **one utterance per sentence** — that's what keeps the highlighted text reliably in sync with the audio (and avoids Chrome's long-utterance cutoff bug).
- Books, extracted text, and reading positions live in IndexedDB; the app itself is cached by a service worker so everything works offline.

## Known limitations

- Voice quality is whatever your device offers — modern phones sound decent, but it's not a human narrator.
- On phones, speech may stop if the screen locks or the browser goes to the background (a Web Speech API platform limitation). While playing, the app requests a screen wake lock to keep the screen on.
- Scanned/image-only PDFs aren't supported — there's no OCR (yet).
- Complex multi-column layouts may extract in the wrong order.
