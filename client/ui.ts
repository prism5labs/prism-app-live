// Logo and portrait helpers. The logo is the Triangle/Pyramid mark
// (confirmed Nov 13, with the extra line that makes it read as a pyramid).
// Supernova portraits live at public/supernovas/<Name>.webp (the twelve 1950s
// superhero portraits; Prism is the 1950s superhero picture from the Labs
// website, swapped in Nov 15, 2026, replacing the teal crystalline figure).
// The tile below is only a fallback for a Supernova with no portrait file yet.

export const TRIANGLE_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 12 L92 88 L8 88 Z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/><path d="M28 62 L72 62" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle cx="50" cy="78" r="5" fill="currentColor"/></svg>`;

export function logoHtml(size: number): string {
  return `<span class="logo-mark" style="width:${size}px;height:${size}px;color:#F4C95D">${TRIANGLE_SVG}</span>`;
}

// Dark tile backgrounds only. The little triangle is butter (#F4C95D), so
// it needs a dark field to read against. Calendra and Proof used to land on
// a butter background, where the butter triangle vanished entirely.
const TILE_COLORS = [
  ["#0F5257", "#FFF3DC"],
  ["#D62828", "#FFF3DC"],
  ["#0A3A3E", "#F4C95D"],
  ["#2E2620", "#F4C95D"],
];

function tileSvg(name: string): string {
  const idx = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TILE_COLORS.length;
  const [bg, fg] = TILE_COLORS[idx];
  const initial = name.charAt(0);
  // The triangle gets a slightly larger ink copy behind it, so it has a dark
  // outline and pops on any background instead of washing out.
  return `<svg viewBox="0 0 100 100" role="img" aria-label="${name} portrait"><rect width="100" height="100" rx="24" fill="${bg}"/><circle cx="50" cy="50" r="34" fill="none" stroke="${fg}" stroke-width="2" opacity="0.35"/><text x="50" y="66" text-anchor="middle" font-family="Georgia, serif" font-size="44" font-weight="bold" fill="${fg}">${initial}</text><g transform="translate(79,75) scale(0.28) translate(-50,-50)" color="#2E2620">${TRIANGLE_SVG}</g><g transform="translate(79,75) scale(0.22) translate(-50,-50)" color="#F4C95D">${TRIANGLE_SVG}</g></svg>`;
}

// Portraits are served as small WebP thumbnails (public/<kind>/thumbs/,
// 480px, ~50 KB) instead of the full portraits: every display size in
// the app is 220 CSS px or less, so the thumbnails are indistinguishable
// on screen and the Store and Chat fronts load in a fraction of the time
// (speed pass, Nov 22, 2026). If a thumbnail is missing (a portrait added
// without regenerating thumbs) the img falls back to the full portrait,
// and if that is missing too, to the tile — see window.__photonImgErr.
// The full portraits themselves were 1600px PNGs of ~3.5 MB each until
// the lightweight pass (Nov 23, 2026) replaced them with 800px WebPs
// (~120 KB): still far beyond any display size, at a thirtieth of the
// bytes. The original PNGs live in the Labs' art archive, not the app.
export function portraitHtml(name: string, size: number): string {
  // Inline version for template strings; the img falls back via the
  // global handler below (window.__photonImgErr).
  const enc = encodeURIComponent(name);
  return `<span class="portrait" style="width:${size}px;height:${size}px"><img src="/supernovas/thumbs/${enc}.webp" data-full="/supernovas/${enc}.webp" alt="${name} portrait" width="${size}" height="${size}" loading="lazy" decoding="async" onerror="window.__photonImgErr(this,'${name}')"></span>`;
}

// Novas live at public/novas/<Name>.webp (the twelve 1950s pulp-poster
// portraits, Nov 19, 2026), with thumbnails alongside like the Supernovas.
// Same fallback chain as the Supernovas.
export function atomPortraitHtml(name: string, size: number): string {
  const enc = encodeURIComponent(name);
  return `<span class="portrait" style="width:${size}px;height:${size}px"><img src="/novas/thumbs/${enc}.webp" data-full="/novas/${enc}.webp" alt="${name} portrait" width="${size}" height="${size}" loading="lazy" decoding="async" onerror="window.__photonImgErr(this,'${name}')"></span>`;
}

declare global {
  interface Window {
    __photonTile: (name: string) => string;
    __photonImgErr: (img: HTMLImageElement, name: string) => void;
  }
}
window.__photonTile = (name: string) => tileSvg(name);
// First error: the thumbnail is missing — try the full-size WebP.
// Second error: no portrait at all — the tile takes its place.
window.__photonImgErr = (img: HTMLImageElement, name: string) => {
  if (!img.dataset.fb) {
    img.dataset.fb = "1";
    img.src = img.dataset.full || "";
  } else {
    img.outerHTML = tileSvg(name);
  }
};
