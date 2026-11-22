import { useEffect } from 'react';

const APP_TITLE = 'Agent Board';

/** The suffix is exact: the desktop client strips ` · Agent Board` to show the page name alone. */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);
}
