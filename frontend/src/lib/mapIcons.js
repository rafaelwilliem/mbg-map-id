// mapIcons.js — glyph SVG inline (path lucide, disalin apa adanya) untuk
// marker moda transit di peta + swatch legenda. Sengaja BUKAN dependency
// runtime lucide-to-string: cukup string SVG statis, teknik yang sama dengan
// ResetViewControl di MapView.jsx (innerHTML svg mentah).
//
// Kenapa ikon, bukan sekadar warna: syarat colorblind-safe CLAUDE.md Bab 10.3 —
// moda transit dibedakan lewat BENTUK ikon (bus / kereta / trem / pin) di
// samping warna, jadi tetap terbaca bagi pengguna color vision deficiency.
//
// `stroke="currentColor"` supaya glyph mewarisi warna dari elemen induk
// (createMarker mengeset el.style.color = warna marker; legenda mengeset
// style.color di span pembungkus).

// Path lucide 24x24 (viewBox 0 0 24 24), stroke-only.
const PATHS = {
  // lucide "bus" — halte tersurvei (koridor BisKita)
  bus:
    '<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/>' +
    '<path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/>' +
    '<circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>',
  // lucide "train-front" — stasiun KRL
  train:
    '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/>' +
    '<path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/>' +
    '<path d="m8 19-2 3"/><path d="m16 19 2 3"/>',
  // lucide "tram-front" — stasiun LRT Jabodebek
  tram:
    '<rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/>' +
    '<path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h.01"/><path d="M16 15h.01"/>',
  // lucide "map-pin" — usulan halte hasil model spasial (belum disurvei)
  pin:
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/>' +
    '<circle cx="12" cy="10" r="3"/>',
}

function wrap(name, size) {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  )
}

/** SVG string untuk badge marker di peta (~14px, di dalam badge 24px). */
export function markerIconSvg(name) {
  return wrap(name, 14)
}

/** SVG string untuk swatch kecil di MapLegend (~13px). */
export function legendIconSvg(name) {
  return wrap(name, 13)
}
