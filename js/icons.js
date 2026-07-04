// Inline SVG icon set (stroke-based, inherits currentColor).

const PATHS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  prev: '<path d="M17 6l-7 6 7 6z" fill="currentColor" stroke="none"/><rect x="6" y="6" width="2.4" height="12" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M7 6l7 6-7 6z" fill="currentColor" stroke="none"/><rect x="15.6" y="6" width="2.4" height="12" rx="1" fill="currentColor" stroke="none"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  upload: '<path d="M12 15V4.5"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
  trash: '<path d="M5 7h14"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v16H6.5A1.5 1.5 0 0 0 5 20.5z"/><path d="M5 19a2 2 0 0 1 2-2h12"/>',
  waves: '<path d="M4 10v4"/><path d="M8 7.5v9"/><path d="M12 5v14"/><path d="M16 7.5v9"/><path d="M20 10v4"/>',
  list: '<path d="M8 6h11"/><path d="M8 12h11"/><path d="M8 18h11"/><circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
};

export function icon(name, size = 24) {
  const body = PATHS[name] || '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
