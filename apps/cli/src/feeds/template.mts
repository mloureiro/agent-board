import { withoutControls } from '../watch/fence.mts';

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,39})\}/g;

export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export const VALUE_MAX = 500;

export type Rendered = { ok: true; text: string } | { ok: false; missing: string };

/** The names used as `{name}` in the text, once each, in order of first use. Any other brace is literal text. */
export function placeholders(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1] ?? ''))];
}

/** The text with every `{name}` replaced by its value, stripped of control characters and cut to 500 characters. */
export function render(text: string, values: Readonly<Record<string, string>>): Rendered {
  let missing: string | undefined;
  const rendered = text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      missing ??= name;
      return '';
    }
    return Array.from(withoutControls(value)).slice(0, VALUE_MAX).join('');
  });
  return missing === undefined ? { ok: true, text: rendered } : { ok: false, missing };
}
