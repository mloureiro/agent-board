import type { FeedLastRun, MachineFeed } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { feedStatus } from './feedStatus';

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-23T12:00:00.000Z');

const lastRun = (startedAgoMs: number, overrides: Partial<FeedLastRun> = {}): FeedLastRun => ({
  startedAt: new Date(NOW - startedAgoMs).toISOString(),
  at: new Date(NOW - startedAgoMs + 1000).toISOString(),
  ok: true,
  listed: 0,
  created: 0,
  requeued: 0,
  rescheduled: 0,
  closed: 0,
  failed: 0,
  tasks: [],
  ...overrides,
});

const feed = (overrides: Partial<MachineFeed> = {}): MachineFeed => ({
  id: '0123456789abcdef',
  name: 'reviews',
  everyMs: 10 * MINUTE,
  paused: false,
  runAsked: false,
  history: [],
  ...overrides,
});

describe('feedStatus', () => {
  it('says a feed that could not be read is not read, with the reason', () => {
    expect(
      feedStatus(feed({ problem: 'config unreadable', paused: true, last: lastRun(0, { invalid: true }) }), NOW),
    ).toEqual({
      label: 'Not read',
      color: 'red',
      detail: 'config unreadable',
    });
  });

  it('says an invalid run is invalid, with its reason, before a pause', () => {
    const status = feedStatus(
      feed({ paused: true, last: lastRun(0, { ok: false, invalid: true, error: 'the pin moved' }) }),
      NOW,
    );
    expect(status).toEqual({ label: 'Invalid', color: 'red', detail: 'the pin moved' });
  });

  it('says a paused feed is paused even when it is long overdue', () => {
    expect(feedStatus(feed({ paused: true, last: lastRun(10 * 60 * MINUTE) }), NOW)?.label).toBe('Paused');
  });

  it('says a run asked for before overdue', () => {
    expect(feedStatus(feed({ runAsked: true, last: lastRun(10 * 60 * MINUTE) }), NOW)?.label).toBe('Run asked for…');
  });

  describe('overdue', () => {
    const everyTen = 10 * MINUTE + 5 * MINUTE;
    it('is not overdue at the margin edge and is a millisecond past it', () => {
      expect(feedStatus(feed({ last: lastRun(everyTen) }), NOW)).toBeUndefined();
      expect(feedStatus(feed({ last: lastRun(everyTen + 1) }), NOW)?.label).toBe('Overdue');
    });

    it('keeps a margin of two minutes for a short timer', () => {
      const short = { everyMs: MINUTE };
      expect(feedStatus(feed({ ...short, last: lastRun(3 * MINUTE) }), NOW)).toBeUndefined();
      expect(feedStatus(feed({ ...short, last: lastRun(3 * MINUTE + 1) }), NOW)?.label).toBe('Overdue');
    });

    it('is not overdue before the feed ever ran', () => {
      expect(feedStatus(feed(), NOW)).toBeUndefined();
    });

    it('wins over a failed last run', () => {
      expect(feedStatus(feed({ last: lastRun(60 * MINUTE, { ok: false, error: 'boom' }) }), NOW)?.label).toBe(
        'Overdue',
      );
    });
  });

  it('says a failed last run failed, with its error', () => {
    expect(feedStatus(feed({ last: lastRun(MINUTE, { ok: false, error: 'exit 2' }) }), NOW)).toEqual({
      label: 'Failed',
      color: 'red',
      detail: 'exit 2',
    });
  });

  it('shows nothing for a healthy feed', () => {
    expect(feedStatus(feed({ last: lastRun(MINUTE) }), NOW)).toBeUndefined();
  });
});
