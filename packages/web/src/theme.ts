import { appearanceCss, appearanceFonts, type Appearance } from '@gridiron/core';

/** 'system' leaves data-theme unset so prefers-color-scheme (and any host theme) decides. */
export function applyTheme(theme: 'system' | 'light' | 'dark' | undefined) {
  const root = document.documentElement;
  if (!theme || theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Which palette is showing right now. */
export function currentMode(): 'light' | 'dark' {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const CACHE = 'gridiron.appearance';

/** Applies a personal appearance to the whole page (null = stock look) and remembers it on this device. */
export function applyAppearance(a: Appearance | null | undefined, opts: { remember?: boolean } = {}) {
  let style = document.getElementById('gridiron-appearance') as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = 'gridiron-appearance'; document.head.appendChild(style); }
  style.textContent = appearanceCss(a);
  const fams = appearanceFonts(a);
  let link = document.getElementById('gridiron-fonts') as HTMLLinkElement | null;
  if (fams.length) {
    const href = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f}`).join('&')}&display=swap`;
    if (!link) { link = document.createElement('link'); link.id = 'gridiron-fonts'; link.rel = 'stylesheet'; document.head.appendChild(link); }
    if (link.href !== href) link.href = href;
  } else link?.remove();
  if (opts.remember !== false) {
    try { a && Object.keys(a).length ? localStorage.setItem(CACHE, JSON.stringify(a)) : localStorage.removeItem(CACHE); } catch { /* storage blocked */ }
  }
}

/** Re-applies the last appearance used on this device before the account loads (no flash of default colors). */
export function applyCachedAppearance() {
  try { const raw = localStorage.getItem(CACHE); if (raw) applyAppearance(JSON.parse(raw), { remember: false }); } catch { /* ignore */ }
}
