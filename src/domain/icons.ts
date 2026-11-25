/**
 * Central icon map (Feather/Lucide style, 24x24 stroke icons).
 *
 * All menus (desktop top-nav, mobile bottom-nav, settings quick-links)
 * consume this single source of truth so a rename of a symbol in one
 * place is visible everywhere. Keys are the semantic name of the entry,
 * values are the inner SVG markup (paths, rects, circles).
 *
 * The AppIcon component renders every entry inside a
 * `<svg stroke="currentColor" fill="none" stroke-width="2"
 * viewBox="0 0 24 24">` wrapper, so icons inherit the surrounding text
 * colour and stay theme-aware.
 */
export const ICONS: Record<string, string> = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
    '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
    '<rect x="14" y="14" width="7" height="7" rx="1"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1"/>',

  artikel: '<path d="M3 4h18v16H3z"/>' + '<path d="M3 12h18"/>' + '<path d="M12 4v16"/>',

  standorte:
    '<path d="M12 22c-4 0-6-2-6-4a6 6 0 0 1 12 0c0-2 2-4 6-4z"/>' +
    '<path d="M12 12a4 4 0 1 0 8 0l0 6l-8 0l0-6z"/>',

  buchungen: '<path d="M4 7h13l4 4h-4L14 4H7V10l-3-3l3 3"/>',

  mindestbestand:
    '<path d="M4 20h16"/>' +
    '<path d="M7 20v-6"/>' +
    '<path d="M12 20v-10"/>' +
    '<path d="M17 20v-14"/>',

  inventur:
    '<path d="M9 2h6v3H9V2z"/>' + '<path d="M4 7h16v14H4z"/>' + '<path d="M8 12h8M8 16h8"/>',

  akkutausch:
    '<rect x="2" y="8" width="18" height="10" rx="2"/>' +
    '<path d="M22 11v4"/>' +
    '<path d="M6 11v4M11 11v4M16 11v4"/>',

  scan:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/>',

  stammdaten:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/>' +
    '<path d="M3 5v6c0 2 0 4 0 6"/>' +
    '<path d="M21 5v6c0 2 0 4 0 6"/>' +
    '<path d="M6 11a10 6 0 0 1 2 2"/>' +
    '<path d="M6 15a10 6 0 0 1 2 2"/>',

  daten: '<rect x="3" y="3" width="18" height="4" rx="1"/>' + '<path d="M5 9v12h14V9"/>',

  tools:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',

  administration: '<path d="M12 2l9 0v9l-9 9l-9-9l0-9z"/>' + '<path d="M7 11l4 4l4-4l-4-4"/>',

  account: '<circle cx="12" cy="8" r="4"/>' + '<path d="M6 21a8 8 0 0 1 12 0"/>',

  info:
    '<circle cx="12" cy="12" r="9"/>' + '<path d="M12 8v8"/>' + '<circle cx="12" cy="6" r="1"/>',

  notifications:
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-1-1-2 4l-3 0c-1 1-1 1-2 2"/>' +
    '<path d="M6 18l12 0"/>' +
    '<path d="M10 22h4"/>',

  etiketten: '<rect x="4" y="6" width="16" height="12" rx="1"/>' + '<path d="M4 12h16"/>',
}
