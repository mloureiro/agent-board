import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Changes } from './changes';

describe('Changes', () => {
  let changes: Changes;
  const heard = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    heard.mockReset();
    changes = new Changes(100);
    changes.subscribe('jascha', heard);
  });

  afterEach(() => {
    changes.close();
    vi.useRealTimers();
  });

  it('gives one event for a burst, the window after its last call', () => {
    changes.notify('jascha');
    vi.advanceTimersByTime(60);
    changes.notify('jascha');
    vi.advanceTimersByTime(60);
    changes.notify('jascha');
    vi.advanceTimersByTime(99);
    expect(heard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(heard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('gives one event per call when the calls are further apart than the window', () => {
    changes.notify('jascha');
    vi.advanceTimersByTime(100);
    changes.notify('jascha');
    vi.advanceTimersByTime(100);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("debounces each owner on its own, and tells only that owner's listeners", () => {
    const carol = vi.fn();
    changes.subscribe('carol', carol);
    changes.notify('jascha');
    vi.advanceTimersByTime(60);
    changes.notify('carol');
    vi.advanceTimersByTime(40);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(carol).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(carol).toHaveBeenCalledTimes(1);
  });

  it('drops a pending event on close', () => {
    changes.notify('jascha');
    changes.close();
    vi.advanceTimersByTime(1000);
    expect(heard).not.toHaveBeenCalled();
  });

  describe('the view topic', () => {
    const viewed = vi.fn();

    beforeEach(() => {
      viewed.mockReset();
      changes.subscribeViews('jascha', viewed);
    });

    it('is separate from the dispatch topic, in both directions', () => {
      changes.notifyViews('jascha');
      vi.advanceTimersByTime(100);
      expect(viewed).toHaveBeenCalledTimes(1);
      expect(heard).not.toHaveBeenCalled();
      changes.notify('jascha');
      vi.advanceTimersByTime(100);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(viewed).toHaveBeenCalledTimes(1);
    });

    it('drops a pending event on close and on the end of the owner’s streams, and stops listening when told to', () => {
      changes.notifyViews('jascha');
      changes.close();
      vi.advanceTimersByTime(1000);
      changes.notifyViews('jascha');
      changes.endStreams('jascha');
      vi.advanceTimersByTime(1000);
      expect(viewed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(changes.viewListenerCount('jascha')).toBe(1);
      changes.subscribeViews('jascha', () => undefined)();
      expect(changes.viewListenerCount('jascha')).toBe(1);
    });
  });
});
