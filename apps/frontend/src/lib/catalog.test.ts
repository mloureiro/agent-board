import type { CatalogSkill, MachineCatalog } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { acceptSkill, lanesFor, matchSkills, modelsFor, skillCompletion, skillsFor } from './catalog';
import type { OpenedCatalog } from '@agent-board/shared/ui';

const skill = (name: string, description?: string): CatalogSkill => ({
  name,
  ...(description === undefined ? {} : { description }),
});
const names = (skills: readonly CatalogSkill[]): string[] => skills.map(({ name }) => name);

const machine = (name: string, catalog: Partial<MachineCatalog> | null): OpenedCatalog => ({
  name,
  catalog: catalog === null ? null : { models: [], skills: [], dirs: {}, ...catalog },
});

const laptop = machine('laptop', {
  skills: [skill('review'), skill('lint')],
  dirs: {
    '/work/app': [skill('deploy')],
    '/work/app/packages/web': [skill('storybook')],
    '/work/other': [skill('sweep')],
  },
});
const desktop = machine('desktop', {
  skills: [skill('review', 'second'), skill('audit')],
  dirs: { '/srv': [skill('cron')] },
});
const silent = machine('silent', null);

describe('lanesFor', () => {
  const withLanes = (name: string, lanes: string[]) => machine(name, { lanes });

  it('offers the lanes of every machine once, in the order they were published, or those of the chosen machine', () => {
    const machines = [withLanes('laptop', ['general', 'reviews']), withLanes('desktop', ['general', 'docs']), silent];
    expect(lanesFor(machines, undefined)).toEqual(['general', 'reviews', 'docs']);
    expect(lanesFor(machines, null)).toEqual(['general', 'reviews', 'docs']);
    expect(lanesFor(machines, 'desktop')).toEqual(['general', 'docs']);
    expect(lanesFor(machines, 'nowhere')).toEqual([]);
    expect(lanesFor([laptop], undefined)).toEqual([]);
  });
});

describe('skillsFor', () => {
  it('offers a machine its common skills and those of the directory that is the workdir', () => {
    expect(names(skillsFor([laptop, desktop], { machine: 'laptop', workdir: '/work/app' }))).toEqual([
      'deploy',
      'lint',
      'review',
    ]);
  });

  it('finds the listed directory above a worktree, and takes the longest of several', () => {
    expect(names(skillsFor([laptop], { machine: 'laptop', workdir: '/work/app/.claude/worktrees/x' }))).toEqual([
      'deploy',
      'lint',
      'review',
    ]);
    expect(names(skillsFor([laptop], { machine: 'laptop', workdir: '/work/app/packages/web/src' }))).toEqual([
      'lint',
      'review',
      'storybook',
    ]);
  });

  it('matches whole path segments and offers only the common skills for an unlisted directory', () => {
    expect(names(skillsFor([laptop], { machine: 'laptop', workdir: '/work/application' }))).toEqual(['lint', 'review']);
  });

  it('adds every directory of the machine when there is a machine but no directory', () => {
    expect(names(skillsFor([laptop, desktop], { machine: 'laptop', workdir: null }))).toEqual([
      'deploy',
      'lint',
      'review',
      'storybook',
      'sweep',
    ]);
  });

  it('is the union over the machines with a catalogue when no machine is chosen', () => {
    const all = ['audit', 'cron', 'deploy', 'lint', 'review', 'storybook', 'sweep'];
    expect(names(skillsFor([laptop, desktop, silent], { machine: null, workdir: null }))).toEqual(all);
    expect(names(skillsFor([laptop, desktop, silent], { machine: undefined, workdir: '/work/app' }))).toEqual(all);
  });

  it('keeps the first description of a name', () => {
    const found = skillsFor(
      [machine('a', { skills: [skill('x', 'one')] }), machine('b', { skills: [skill('x', 'two')] })],
      {
        machine: null,
        workdir: null,
      },
    );
    expect(found).toEqual([skill('x', 'one')]);
  });

  it('offers nothing for a machine without a readable catalogue or one that is not listed', () => {
    expect(skillsFor([laptop, silent], { machine: 'silent', workdir: null })).toEqual([]);
    expect(skillsFor([laptop], { machine: 'gone', workdir: null })).toEqual([]);
    expect(skillsFor([], { machine: null, workdir: null })).toEqual([]);
  });
});

describe('modelsFor', () => {
  const opus = { value: 'opus-9', label: 'Opus 9' };
  const haiku = { value: 'haiku-9', label: 'Haiku 9' };
  const machines = [
    machine('a', { models: [opus] }),
    machine('b', { models: [{ value: 'opus-9', label: 'Other' }, haiku] }),
    silent,
  ];

  it('is the chosen machine own list', () => {
    expect(modelsFor(machines, 'b')).toEqual([{ value: 'opus-9', label: 'Other' }, haiku]);
  });

  it('is the union by value without a machine, first label and order winning', () => {
    expect(modelsFor(machines, undefined)).toEqual([opus, haiku]);
    expect(modelsFor(machines, null)).toEqual([opus, haiku]);
  });

  it('is empty when the machine has no catalogue, so the caller falls back to the aliases', () => {
    expect(modelsFor(machines, 'silent')).toEqual([]);
    expect(modelsFor([silent], undefined)).toEqual([]);
  });
});

describe('skillCompletion', () => {
  it('is on inside the first token of a text that starts with a slash', () => {
    expect(skillCompletion('/re', 3)).toEqual({ query: 're', tokenEnd: 3 });
    expect(skillCompletion('/review-pr 17', 3)).toEqual({ query: 're', tokenEnd: 10 });
    expect(skillCompletion('/', 1)).toEqual({ query: '', tokenEnd: 1 });
    expect(skillCompletion('/review\nmore', 7)).toEqual({ query: 'review', tokenEnd: 7 });
  });

  it('is off when the slash is not at the start, or the caret is before it or past the first token', () => {
    expect(skillCompletion('see /re', 7)).toBeUndefined();
    expect(skillCompletion(' /re', 4)).toBeUndefined();
    expect(skillCompletion('/re', 0)).toBeUndefined();
    expect(skillCompletion('/review 17', 9)).toBeUndefined();
    expect(skillCompletion('/review\nx', 9)).toBeUndefined();
    expect(skillCompletion('', 0)).toBeUndefined();
  });
});

describe('matchSkills', () => {
  const skills = ['review', 'pr-review', 'plugin:review-pr', 'x:reviewer', 'unrelated'].map((name) => skill(name));

  it('orders by prefix, then by the part after the plugin prefix, then by containment, ignoring case', () => {
    expect(names(matchSkills(skills, 'REVIEW'))).toEqual(['review', 'plugin:review-pr', 'x:reviewer', 'pr-review']);
  });

  it('shows at most 8 and everything for an empty query', () => {
    const many = Array.from({ length: 12 }, (_, i) => skill(`s${String(i).padStart(2, '0')}`));
    expect(matchSkills(many, '')).toHaveLength(8);
    expect(names(matchSkills(many, 's1'))).toEqual(['s10', 's11']);
  });

  it('finds nothing for a name that is not there', () => {
    expect(matchSkills(skills, 'zzz')).toEqual([]);
  });
});

describe('acceptSkill', () => {
  it('replaces the first token and puts the caret after the space', () => {
    expect(acceptSkill('/re', 3, 'review')).toEqual({ text: '/review ', caret: 8 });
  });

  it('keeps the rest of the text and does not double the space', () => {
    expect(acceptSkill('/re 17', 3, 'review')).toEqual({ text: '/review 17', caret: 8 });
    expect(acceptSkill('/re\nmore', 3, 'review')).toEqual({ text: '/review \nmore', caret: 8 });
  });
});
