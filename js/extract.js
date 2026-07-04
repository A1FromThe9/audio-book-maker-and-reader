// PDF → structured text. Runs entirely in the browser via pdf.js.
// Output: { title, paragraphs } where paragraphs is an array of arrays of
// sentence strings — the unit the speech engine and reader operate on.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).toString();

export class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function extractPdf(file, onProgress) {
  const data = await file.arrayBuffer();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data }).promise;
  } catch (err) {
    throw new ExtractError('parse', err?.message || 'Not a readable PDF');
  }

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(buildLines(content.items));
    page.cleanup();
    onProgress?.(p, doc.numPages);
  }

  let title = '';
  try {
    title = String((await doc.getMetadata())?.info?.Title || '');
  } catch {
    // metadata is optional
  }
  await doc.destroy();
  title = title.trim() || file.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';

  stripFurniture(pages);
  const paragraphs = buildParagraphs(pages);

  const totalChars = paragraphs.flat().join('').length;
  if (totalChars < 200) {
    throw new ExtractError('no-text', 'No extractable text found in this PDF');
  }
  return { title, paragraphs };
}

// Group pdf.js text items into visual lines (top-to-bottom, left-to-right).
function buildLines(items) {
  const frags = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    frags.push({ str: it.str, x, y, w: it.width || 0, h });
  }
  frags.sort((a, b) => b.y - a.y || a.x - b.x);

  const groups = [];
  for (const f of frags) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.y - f.y) < Math.max(2, f.h * 0.45)) g.frags.push(f);
    else groups.push({ y: f.y, frags: [f] });
  }

  return groups
    .map((g) => {
      g.frags.sort((a, b) => a.x - b.x);
      let text = '';
      let h = 0;
      let prev = null;
      for (const f of g.frags) {
        if (prev) {
          const gap = f.x - (prev.x + prev.w);
          if (gap > Math.max(1.5, prev.h * 0.15) && !text.endsWith(' ') && !f.str.startsWith(' ')) text += ' ';
        }
        text += f.str;
        h = Math.max(h, f.h);
        prev = f;
      }
      return { text: text.replace(/\s+/g, ' ').trim(), y: g.y, x: g.frags[0].x, h, drop: false };
    })
    .filter((l) => l.text);
}

// Mark running headers/footers and bare page numbers so they don't get read aloud.
function stripFurniture(pages) {
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const edges = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (i < 2 || i >= lines.length - 2) out.push(lines[i]);
    }
    return out;
  };

  const counts = new Map();
  for (const lines of pages) {
    for (const ln of edges(lines)) {
      const k = norm(ln.text);
      if (k && k.length < 60) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  const min = Math.max(3, Math.ceil(pages.length * 0.4));
  for (const lines of pages) {
    for (const ln of edges(lines)) {
      if ((counts.get(norm(ln.text)) || 0) >= min) ln.drop = true;
      if (/^[0-9]{1,4}$/.test(ln.text) || /^[ivxlcdm]{1,7}$/i.test(ln.text)) ln.drop = true;
    }
  }
}

// Merge lines into paragraphs using vertical gaps, indentation, and font-size
// changes; re-join words hyphenated across line breaks; then split into sentences.
function buildParagraphs(pages) {
  const paras = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      const text = cur.replace(/\s+/g, ' ').trim();
      if (text) paras.push(text);
    }
    cur = null;
  };

  for (const lines of pages) {
    const kept = lines.filter((l) => !l.drop);
    if (!kept.length) continue;

    const gaps = [];
    for (let i = 1; i < kept.length; i++) gaps.push(Math.abs(kept[i - 1].y - kept[i].y));
    gaps.sort((a, b) => a - b);
    const lineGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
    const leftX = Math.min(...kept.map((l) => l.x));

    for (let i = 0; i < kept.length; i++) {
      const ln = kept[i];
      let breakPara = false;
      if (cur === null) {
        breakPara = true;
      } else if (i === 0) {
        // Page boundary: break only if the previous page ended a sentence.
        breakPara = /[.!?]["')\]]?$/.test(cur);
      } else {
        const gap = Math.abs(kept[i - 1].y - ln.y);
        const indented = ln.x - leftX > ln.h * 1.2;
        const sizeChange = ln.h > kept[i - 1].h * 1.25 || kept[i - 1].h > ln.h * 1.25;
        breakPara = gap > lineGap * 1.55 || indented || sizeChange;
      }

      if (breakPara) {
        flush();
        cur = ln.text;
      } else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(ln.text)) {
        cur = cur.slice(0, -1) + ln.text;
      } else {
        cur += ' ' + ln.text;
      }
    }
  }
  flush();

  return paras.map(splitSentences).filter((p) => p.length);
}

export function splitSentences(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  }
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  return (parts || [text]).map((s) => s.trim()).filter(Boolean);
}
