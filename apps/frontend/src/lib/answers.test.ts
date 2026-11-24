import type { Question } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { answerTo, openQuestionOf } from './answers';
import type { ThreadNote } from '@agent-board/shared/ui';

const ask = (header: string): Question[] => [
  {
    header,
    question: `${header}?`,
    multiSelect: false,
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
  },
];

const note = (overrides: Partial<ThreadNote>): ThreadNote => ({
  id: 'n',
  text: '',
  createdAt: '2026-11-14T10:00:00.000Z',
  author: 'agent',
  kind: 'comment',
  by: null,
  unreadable: false,
  ...overrides,
});

describe('which answer is shown with a question', () => {
  const first = note({ id: 'q1', kind: 'question', questions: ask('Scope') });
  const second = note({ id: 'q2', kind: 'question', questions: ask('Cleanup') });
  const answer = (id: string, filedUnder: string, questions: Question[]) =>
    note({
      id,
      author: 'user',
      kind: 'answer',
      questionNoteId: filedUnder,
      questions,
      answers: [{ selected: ['Yes'] }],
    });

  it('is the one filed under it whose own questions are the ones asked', () => {
    const mine = answer('a1', 'q1', ask('Scope'));
    expect(answerTo([first, second, mine], first)).toBe(mine);
    expect(answerTo([first, second, mine], second)).toBeUndefined();
  });

  it('is none when the server filed an answer to another question under it', () => {
    const repointed = answer('a2', 'q1', ask('Cleanup'));
    expect(answerTo([first, second, repointed], first)).toBeUndefined();
  });

  it('is none for an answer that could not be opened', () => {
    const broken = { ...answer('a3', 'q1', ask('Scope')), unreadable: true };
    expect(answerTo([first, broken], first)).toBeUndefined();
  });
});

describe('which question the task waits on', () => {
  const first = note({ id: 'q1', kind: 'question', questions: ask('Scope') });
  const second = note({ id: 'q2', kind: 'question', questions: ask('Cleanup') });
  const comment = note({ id: 'c1' });

  it('is the last question note while the task has an open question', () => {
    expect(openQuestionOf({ openQuestion: true }, [first, comment, second, comment])).toBe(second);
  });

  it('is none once the task has no open question', () => {
    expect(openQuestionOf({ openQuestion: false }, [first, second])).toBeUndefined();
  });

  it('is none when the thread holds no question', () => {
    expect(openQuestionOf({ openQuestion: true }, [comment])).toBeUndefined();
  });
});
