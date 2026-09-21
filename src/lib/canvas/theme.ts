/**
 * Colours the canvas draws with, resolved from the app's CSS custom properties.
 *
 * Only plain resolved colours are stored: translucency is applied at draw time
 * with `globalAlpha`, since `color-mix()` in `fillStyle` is not reliably
 * supported across the browsers this has to run in.
 */
export interface CanvasTheme {
  background: string;
  card: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  muted: string;
  primary: string;
}

const FALLBACK: CanvasTheme = {
  background: '#ffffff',
  card: '#ffffff',
  border: '#e4e4e7',
  foreground: '#18181b',
  mutedForeground: '#71717a',
  muted: '#f4f4f5',
  primary: '#3b82f6',
};

/**
 * Reads the live theme tokens off `element`. Going through `getComputedStyle`
 * means dark mode, and any future theme, works without the canvas knowing
 * anything about it.
 */
export function readCanvasTheme(element: Element): CanvasTheme {
  if (typeof getComputedStyle !== 'function') return FALLBACK;

  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;

  return {
    background: token('--color-background', FALLBACK.background),
    card: token('--color-card', FALLBACK.card),
    border: token('--color-border', FALLBACK.border),
    foreground: token('--color-foreground', FALLBACK.foreground),
    mutedForeground: token('--color-muted-foreground', FALLBACK.mutedForeground),
    muted: token('--color-muted', FALLBACK.muted),
    primary: token('--color-primary', FALLBACK.primary),
  };
}

export { FALLBACK as fallbackCanvasTheme };
