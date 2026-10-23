// Theme application: mirrors the per-user setting onto the document root.
// The CSS in `style.css` keys off `data-theme`; `auto` deliberately leaves
// the attribute unset so the system preference applies.

import type { Theme } from './stores/settings'

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'auto') {
    root.removeAttribute('data-theme')
    return
  }
  root.setAttribute('data-theme', theme)
}
