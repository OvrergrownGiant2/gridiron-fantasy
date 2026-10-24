/** 'system' leaves data-theme unset so prefers-color-scheme (and any host theme) decides. */
export function applyTheme(theme: 'system' | 'light' | 'dark' | undefined) {
  const root = document.documentElement;
  if (!theme || theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
