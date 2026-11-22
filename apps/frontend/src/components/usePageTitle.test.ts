import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePageTitle } from './usePageTitle';

describe('usePageTitle', () => {
  it('suffixes the title, falls back to the app name, and restores it on unmount', () => {
    const { rerender, unmount } = renderHook(({ title }) => usePageTitle(title), {
      initialProps: { title: 'Board' as string | null },
    });
    expect(document.title).toBe('Board · Agent Board');

    rerender({ title: null });
    expect(document.title).toBe('Agent Board');

    rerender({ title: '' });
    expect(document.title).toBe('Agent Board');

    rerender({ title: 'Backlog' });
    unmount();
    expect(document.title).toBe('Agent Board');
  });
});
