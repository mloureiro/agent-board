import type { CatalogModel, CatalogSkill, MachineCatalog } from '@agent-board/shared';
import type { OpenedCatalog } from '@agent-board/shared/ui';
import { isWithin } from './workingDirectories';

/** How many matches the completion list shows. */
export const MAX_SHOWN_SKILLS = 8;

const byName = (a: CatalogSkill, b: CatalogSkill): number => a.name.localeCompare(b.name);

function uniqueByName(skills: readonly CatalogSkill[]): CatalogSkill[] {
  const seen = new Set<string>();
  return skills.filter(({ name }) => !seen.has(name) && seen.add(name)).sort(byName);
}

/** The listed directory of a catalogue that is `workdir` or contains it; the longest, when several do. */
function coveringDirectory(dirs: MachineCatalog['dirs'], workdir: string): string | undefined {
  return Object.keys(dirs)
    .filter((path) => isWithin(workdir, path))
    .sort((a, b) => b.length - a.length)[0];
}

function skillsOfMachine(machine: OpenedCatalog, workdir: string | null | undefined): CatalogSkill[] {
  if (machine.catalog === null) return [];
  const { skills, dirs } = machine.catalog;
  if (workdir === null || workdir === undefined) return [...skills, ...Object.values(dirs).flat()];
  const covering = coveringDirectory(dirs, workdir);
  return [...skills, ...(covering === undefined ? [] : (dirs[covering] ?? []))];
}

/**
 * The skills the prompt field offers after a `/`. For a known machine: what every directory of it has, plus what the
 * directory holding `workdir` has (all its directories' when there is no `workdir`). With no machine chosen, the union over
 * every machine with a catalogue. Advice only: a name that is not in the list still runs.
 */
export function skillsFor(
  machines: readonly OpenedCatalog[],
  where: { machine: string | null | undefined; workdir: string | null | undefined },
): CatalogSkill[] {
  const chosen = where.machine === null || where.machine === undefined ? undefined : where.machine;
  const among = chosen === undefined ? machines : machines.filter(({ name }) => name === chosen);
  return uniqueByName(
    among.flatMap((machine) => skillsOfMachine(machine, chosen === undefined ? undefined : where.workdir)),
  );
}

/**
 * The models the Model field offers: the chosen machine's, or with none chosen every machine's, by value. Empty when no
 * readable catalogue has any, and the caller then shows the static aliases.
 */
export function modelsFor(machines: readonly OpenedCatalog[], machine: string | null | undefined): CatalogModel[] {
  const among = machine === null || machine === undefined ? machines : machines.filter(({ name }) => name === machine);
  const seen = new Set<string>();
  return among
    .flatMap(({ catalog }) => catalog?.models ?? [])
    .filter(({ value }) => !seen.has(value) && seen.add(value));
}

/**
 * The lane names the Lane field offers: the chosen machine's, or with none chosen every machine's, each once in the order they
 * were published. Empty when no readable catalogue has any.
 */
export function lanesFor(machines: readonly OpenedCatalog[], machine: string | null | undefined): string[] {
  const among = machine === null || machine === undefined ? machines : machines.filter(({ name }) => name === machine);
  return [...new Set(among.flatMap(({ catalog }) => catalog?.lanes ?? []))];
}

export interface SkillCompletion {
  /** What was typed after the `/`, up to the caret. */
  query: string;
  /** Where the first token ends: what an accepted name replaces. */
  tokenEnd: number;
}

/** Completion is on while the caret sits inside the first token of a text that starts with `/`. */
export function skillCompletion(text: string, caret: number): SkillCompletion | undefined {
  if (!text.startsWith('/') || caret < 1 || caret > text.length) return undefined;
  const query = text.slice(1, caret);
  if (/\s/.test(query)) return undefined;
  const rest = text.slice(caret).search(/\s/);
  return { query, tokenEnd: rest === -1 ? text.length : caret + rest };
}

const afterPlugin = (name: string): string => name.slice(name.indexOf(':') + 1);

/** Case-insensitive: names starting with the query, then those whose part after `plugin:` does, then those containing it. */
export function matchSkills(skills: readonly CatalogSkill[], query: string): CatalogSkill[] {
  const wanted = query.toLowerCase();
  const rank = ({ name }: CatalogSkill): number => {
    const lower = name.toLowerCase();
    if (lower.startsWith(wanted)) return 0;
    if (afterPlugin(lower).startsWith(wanted)) return 1;
    return lower.includes(wanted) ? 2 : 3;
  };
  return skills
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter(({ rank: found }) => found < 3)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_SHOWN_SKILLS)
    .map(({ skill }) => skill);
}

/** The text with its first token (up to `tokenEnd`) replaced by `/<name> `, and where the caret goes. */
export function acceptSkill(text: string, tokenEnd: number, name: string): { text: string; caret: number } {
  const rest = text.slice(tokenEnd);
  const inserted = `/${name} `;
  return { text: inserted + (rest.startsWith(' ') ? rest.slice(1) : rest), caret: inserted.length };
}
