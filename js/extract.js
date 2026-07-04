// PDF → structured text. Runs entirely in the browser via pdf.js.
// Output: { title, paragraphs, chapters } where paragraphs is an array of
// arrays of sentence strings — the unit the speech engine and reader operate
// on — and chapters is [{ title, paraIndex }], resolved from the PDF's
// embedded bookmarks when present, or detected from heading-sized text
// otherwise. chapters is [] when nothing reliable was found.

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
  const outlineEntries = await resolveOutline(doc);
  await doc.destroy();
  title = title.trim() || file.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';

  stripFurniture(pages);
  const { paragraphs, meta } = buildParagraphs(pages);

  const totalChars = paragraphs.flat().join('').length;
  if (totalChars < 200) {
    throw new ExtractError('no-text', 'No extractable text found in this PDF');
  }

  let chapters = mapOutlineToParagraphs(outlineEntries, meta.map((m) => m.page));
  if (!chapters.length) chapters = detectHeadingChapters(paragraphs, meta);

  return { title, paragraphs, chapters };
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
// changes; re-join words hyphenated across line breaks; then split into
// sentences. Also tracks, per paragraph, the font height that started it and
// the PDF page it began on — used for chapter-heading detection and for
// mapping the PDF's embedded outline (bookmarks) to a paragraph index.
function buildParagraphs(pages) {
  const paras = [];
  const rawMeta = [];
  let cur = null;
  let curHeight = 0;
  let curPage = 0;
  const flush = () => {
    if (cur) {
      const text = cur.replace(/\s+/g, ' ').trim();
      if (text) {
        paras.push(text);
        rawMeta.push({ height: curHeight, page: curPage });
      }
    }
    cur = null;
  };

  pages.forEach((lines, pageIdx) => {
    const kept = lines.filter((l) => !l.drop);
    if (!kept.length) return;

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
        curHeight = ln.h;
        curPage = pageIdx;
      } else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(ln.text)) {
        cur = cur.slice(0, -1) + ln.text;
      } else {
        cur += ' ' + ln.text;
      }
    }
  });
  flush();

  const paragraphs = [];
  const meta = [];
  for (let i = 0; i < paras.length; i++) {
    const sentences = splitSentences(paras[i]);
    if (sentences.length) {
      paragraphs.push(sentences);
      meta.push(rawMeta[i]);
    }
  }
  return { paragraphs, meta };
}

// Heading-based chapter fallback for PDFs without a usable embedded outline:
// a paragraph is a heading candidate when its font is meaningfully bigger
// than the document's typical body text and it's short (a title, not prose).
function detectHeadingChapters(paragraphs, meta) {
  if (paragraphs.length < 4) return [];
  const heights = meta.map((m) => m.height).slice().sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];

  const chapters = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const wordCount = paragraphs[i].join(' ').split(/\s+/).filter(Boolean).length;
    const isBig = meta[i].height > median * 1.25;
    const isShort = paragraphs[i].length <= 2 && wordCount <= 12;
    if (isBig && isShort) chapters.push({ title: paragraphs[i].join(' ').trim(), paraIndex: i });
  }
  // Too many "headings" (e.g. a document that's bold/large throughout) means
  // the signal isn't reliable — a real chapter list is usually a small
  // fraction of the paragraph count.
  if (chapters.length > 60 || chapters.length > paragraphs.length * 0.15) return [];
  return chapters.length >= 2 ? chapters : [];
}

// Resolve the PDF's embedded outline (bookmarks) to page numbers while the
// document is still open — getPageIndex/getDestination need a live doc.
// Returns [] if the PDF has no outline, or none of its entries resolve.
async function resolveOutline(doc) {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!outline || !outline.length) return [];

  // Some PDFs wrap the whole real outline under one root node (e.g. a single
  // "Contents" bookmark containing every chapter as a child) — descend into
  // it so the real chapters are what gets flattened below.
  let items = outline;
  if (items.length === 1 && items[0].items?.length) items = items[0].items;

  const flat = [];
  const walk = (list) => {
    for (const it of list) {
      flat.push(it);
      if (it.items?.length) walk(it.items);
    }
  };
  walk(items);

  const entries = [];
  for (const item of flat) {
    const title = (item.title || '').trim();
    if (!title) continue;
    const pageIndex = await resolveDestPage(doc, item.dest);
    if (pageIndex != null) entries.push({ title, pageIndex });
  }
  return entries;
}

async function resolveDestPage(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit[0]) return null;
    return await doc.getPageIndex(explicit[0]);
  } catch {
    return null;
  }
}

// Map resolved outline entries (by PDF page number) onto paragraph indices,
// using each paragraph's starting page. Requires at least 2 chapters to be
// worth showing — a single entry (or none) isn't a useful chapter list.
function mapOutlineToParagraphs(entries, pageStarts) {
  const chapters = [];
  const seen = new Set();
  for (const { title, pageIndex } of entries.slice().sort((a, b) => a.pageIndex - b.pageIndex)) {
    let paraIndex = pageStarts.findIndex((p) => p >= pageIndex);
    if (paraIndex === -1) paraIndex = pageStarts.length - 1;
    if (seen.has(paraIndex)) continue;
    seen.add(paraIndex);
    chapters.push({ title, paraIndex });
  }
  return chapters.length >= 2 ? chapters : [];
}

export function splitSentences(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  }
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  return (parts || [text]).map((s) => s.trim()).filter(Boolean);
}
