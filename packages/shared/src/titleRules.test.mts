import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSealed } from './contract.mts';
import { deriveKeys, generateDataKey, open, seal } from './crypto.mts';
import type { Opener, Sealer } from './sealing.mts';
import {
  matchTitleRule,
  openTitleRules,
  sealTitleRules,
  titleRuleProblem,
  type TitleRule,
  type TitleRulesDocument,
} from './titleRules.mts';

const keys = await deriveKeys(generateDataKey(), 'jascha');
const sealer: Sealer = (binding, text) => seal(keys, binding.field, binding.context, text);
const opener: Opener = async (binding, value) => {
  try {
    return await open(keys, binding.field, binding.context, value);
  } catch {
    return undefined;
  }
};

const REVIEW: TitleRule = {
  pattern: '^/pj-\\w+:review .*/pull/(\\d+)',
  icon: '🔎',
  instruction: 'Write "Review PR <number>: <title of the PR>".',
};

test('titleRuleProblem names what is wrong with a rule and accepts a rule that works', () => {
  const problems: [TitleRule, RegExp][] = [
    [{ pattern: '', icon: '🔎' }, /empty/],
    [{ pattern: 'a'.repeat(301), icon: '🔎' }, /300/],
    [{ pattern: 'a', flags: 'g' as 'i', icon: '🔎' }, /flag/],
    [{ pattern: '(', icon: '🔎' }, /regular expression/],
    [{ pattern: 'a', icon: 'ab' }, /emoji/],
    [{ pattern: 'a', instruction: 'x'.repeat(2001) }, /2000/],
    [{ pattern: 'a', instruction: ' \n ' }, /empty/],
    [{ pattern: 'a' }, /no icon, no labels and no title/],
    [{ pattern: 'a', labels: [] }, /empty/],
    [{ pattern: 'a', labels: ['-x'] }, /not a label/],
    [{ pattern: 'a', labels: ['bug', 'Bug'] }, /repeat/],
    [{ pattern: 'a', labels: [' bug'] }, /spaces/],
    [{ pattern: 'a', labels: Array.from({ length: 17 }, (_, index) => `l${index}`) }, /16/],
  ];
  for (const [rule, problem] of problems) assert.match(titleRuleProblem(rule) ?? '', problem, JSON.stringify(rule));
  assert.equal(titleRuleProblem({ pattern: 'a', icon: '🔎' }), undefined);
  assert.equal(titleRuleProblem({ pattern: 'a', flags: 'i', instruction: 'Line one\nline two' }), undefined);
  assert.equal(titleRuleProblem({ pattern: 'a', labels: ['review', 'pr: 8'] }), undefined);
});

test('the document is sealed under its version and opens only as that version', async () => {
  const document: TitleRulesDocument = {
    version: 2,
    rules: [
      REVIEW,
      { pattern: 'x', flags: 'i', icon: '🚀', labels: ['ship'] },
      { pattern: 'y', labels: ['bug', 'ui'] },
    ],
  };
  const wire = await sealTitleRules(sealer, document);
  assert.doesNotThrow(() => parseSealed(wire, 'titles', 'titles'));
  assert.deepEqual(await openTitleRules(opener, 2, wire), document);
  assert.equal(await openTitleRules(opener, 3, wire), undefined, 'relabelled as a newer version');
  assert.equal(await openTitleRules(opener, 0, wire), undefined);
});

test('a document that says another version inside or holds one bad rule is unreadable', async () => {
  const sealJson = (version: number, json: unknown) =>
    sealer({ field: 'titles', context: `titles:v${version}` }, JSON.stringify(json));
  assert.equal(await openTitleRules(opener, 2, await sealJson(2, { version: 3, rules: [REVIEW] })), undefined);
  assert.equal(
    await openTitleRules(opener, 2, await sealJson(2, { version: 2, rules: [REVIEW, { pattern: '(', icon: '🔎' }] })),
    undefined,
  );
  assert.equal(
    await openTitleRules(opener, 2, await sealJson(2, { version: 2, rules: [{ pattern: 'a', labels: 'bug' }] })),
    undefined,
  );
  await assert.rejects(sealTitleRules(sealer, { version: 1, rules: [{ pattern: 'a' }] }), /number 1/);
});

test('the first matching rule wins, case is ignored only with the i flag, and no match is undefined', () => {
  const later: TitleRule = { pattern: 'review', icon: '🚀' };
  assert.deepEqual(matchTitleRule([REVIEW, later], '/pj-cosuno:review https://github.com/cosuno/cosuno/pull/8'), {
    index: 0,
    rule: REVIEW,
  });
  assert.equal(matchTitleRule([REVIEW], '/m:task-execute ab-1'), undefined);
  assert.equal(matchTitleRule([{ pattern: 'REVIEW', icon: '🚀' }], 'a review'), undefined);
  assert.equal(matchTitleRule([{ pattern: 'REVIEW', flags: 'i', icon: '🚀' }], 'a review')?.index, 0);
});
