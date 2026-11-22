import { describe, expect, it } from 'vitest';
import { describeContext, formatTokens } from './contextUsage';

describe('formatTokens', () => {
  it.each([
    [999, '999'],
    [1_000, '1K'],
    [133_600, '133.6K'],
    [200_000, '200K'],
    [1_000_000, '1M'],
    [1_250_000, '1.25M'],
  ])('writes %i as %s', (n, text) => {
    expect(formatTokens(n)).toBe(text);
  });
});

describe('describeContext', () => {
  it.each([
    [
      'a known window',
      { used: 133_600, window: 1_000_000, threshold: null },
      { percent: 13, label: '13% used · 133.6K / 1M', marker: null },
    ],
    [
      'an unknown window',
      { used: 133_600, window: null, threshold: null },
      { percent: null, label: '133.6K used', marker: null },
    ],
    [
      'a threshold with a known window',
      { used: 100_000, window: 200_000, threshold: 80 },
      { percent: 50, label: '50% used · 100K / 200K', marker: 80 },
    ],
    [
      'a threshold with an unknown window',
      { used: 100_000, window: null, threshold: 80 },
      { percent: null, label: '100K used', marker: null },
    ],
    [
      'more used than the window',
      { used: 250_000, window: 200_000, threshold: null },
      { percent: 100, label: '125% used · 250K / 200K', marker: null },
    ],
  ])('describes %s', (_name, reading, expected) => {
    expect(describeContext(reading)).toEqual(expected);
  });
});
