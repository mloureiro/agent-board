import type { ContextReading } from './opening';

const trimZeros = (value: string): string => value.replace(/\.?0+$/, '');

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const thousands = Math.round((n / 1000) * 10) / 10;
  if (thousands < 1000) return `${trimZeros(thousands.toFixed(1))}K`;
  return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
}

export function describeContext({ used, window, threshold }: Pick<ContextReading, 'used' | 'window' | 'threshold'>): {
  percent: number | null;
  label: string;
  marker: number | null;
} {
  if (window === null || window <= 0) return { percent: null, label: `${formatTokens(used)} used`, marker: null };
  const percent = Math.min(100, Math.round((used / window) * 100));
  const shown = Math.round((used / window) * 100);
  return {
    percent,
    label: `${shown}% used · ${formatTokens(used)} / ${formatTokens(window)}`,
    marker: threshold,
  };
}
