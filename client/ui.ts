// Logo and portrait helpers. The logo is the Triangle/Pyramid mark
// (confirmed Nov 13, with the extra line that makes it read as a pyramid).
// Photon portraits live at public/photons/<Name>.png (the twelve 1950s
// superhero portraits, plus the teal crystalline Prism). The tile below is
// only a fallback for a Photon with no portrait file yet.

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

// Returns an element: the real portrait PNG if it exists, else the tile.
export function portraitEl(name: string, size: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "portrait";
  wrap.style.width = size + "px";
  wrap.style.height = size + "px";
  const img = document.createElement("img");
  img.src = `/photons/${encodeURIComponent(name)}.png`;
  img.alt = `${name} portrait`;
  img.width = size;
  img.height = size;
  img.addEventListener("error", () => {
    wrap.innerHTML = tileSvg(name);
  });
  wrap.appendChild(img);
  return wrap;
}

export function portraitHtml(name: string, size: number): string {
  // Inline version for template strings; the img falls back to the tile via
  // a global handler defined in main.ts (window.__photonTile).
  return `<span class="portrait" style="width:${size}px;height:${size}px"><img src="/photons/${encodeURIComponent(
    name,
  )}.png" alt="${name} portrait" width="${size}" height="${size}" onerror="this.outerHTML=window.__photonTile('${name}')"></span>`;
}

declare global {
  interface Window {
    __photonTile: (name: string) => string;
  }
}
window.__photonTile = (name: string) => tileSvg(name);
