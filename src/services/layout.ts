// Shared layout detection. Keep the breakpoint in sync with the CSS layout
// switch (`data-layout`) used by App.vue.

export const MOBILE_LAYOUT_QUERY = '(max-width: 720px)'

export function istMobilLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches
}

export interface MobilerScannerStartBedingungen {
  angemeldet: boolean
  bereitsGestartet: boolean
  mobil: boolean
  routeName: string | symbol | null | undefined
}

/**
 * Decides whether the one-time app-start redirect to the scanner applies.
 * Only the default dashboard entry is redirected; deep links and later
 * bottom-nav taps stay on their target.
 */
export function sollMobilenScannerStarten(o: MobilerScannerStartBedingungen): boolean {
  return o.angemeldet && !o.bereitsGestartet && o.mobil && o.routeName === 'dashboard'
}
