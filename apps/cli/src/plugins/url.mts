import { statSync } from 'node:fs';

const MAX_URL = 500;
const FORMS = [
  /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/,
  /^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/,
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/,
];

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function isBlankOrControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return /\s/.test(char) || code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Why `url` may not reach `git clone`, or undefined when it may. */
export function checkInstallUrl(url: string): string | undefined {
  if (url === '') return 'the install URL is empty';
  if (url.length > MAX_URL) return `the install URL is longer than ${MAX_URL} characters`;
  if (url.startsWith('-')) return 'the install URL must not start with a dash';
  if (Array.from(url).some(isBlankOrControl))
    return 'the install URL must not contain whitespace or control characters';
  if (url.startsWith('/')) return isDirectory(url) ? undefined : 'a local install path must be an existing directory';
  if (FORMS.some((form) => form.test(url))) return undefined;
  return 'the install URL must be https://host/path, ssh://user@host/path, user@host:path or an absolute path to a local repository';
}
