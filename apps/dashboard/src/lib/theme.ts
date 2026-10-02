/**
 * Light, dark or system theme. The choice is a per-browser convenience kept in localStorage; the
 * resolved theme is the data-theme attribute on <html>, which the CSS tokens follow.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'octo-theme';

/** Runs in <head> before first paint; must not throw (storage can be blocked). */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}');var d=c==='dark'||((!c||c==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}})()`;

export function readThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts for this page only
  }
  document.documentElement.setAttribute('data-theme', resolveTheme(choice));
}
