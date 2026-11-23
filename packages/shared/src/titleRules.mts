// The title rules of the user (`titles`): one sealed document of all of them,
// `{"version":n,"rules":[{"pattern":"…","icon":"…","labels":["…"],"instruction":"…"}]}`, bound to its version. A rule that
// matches a new task's prompt gives the task an icon and labels and says how a model should write its title. The browser writes the document; the
// browser and every machine's CLI read it. The server holds nothing it can read: it can neither relabel an old document as a
// newer one (the version is in the binding) nor drop or reorder a rule (the list is inside the ciphertext).
import { ContractError, checkLabels, isEmojiIcon, isTitleRulesVersion } from './contract.mts';
import { isRecord } from './guards.mts';
import type { Binding, Opener, Sealer } from './sealing.mts';
import { sealChecked } from './sealing.mts';

export interface TitleRule {
  /** A JavaScript regular expression, tested against the whole prompt. */
  pattern: string;
  /** `i` for a case-insensitive pattern; left out otherwise. */
  flags?: 'i';
  /** The icon a matching task gets while it has none: one emoji. */
  icon?: string;
  /** The labels a matching task gets while it has none: a list `checkLabels` keeps as it is, never empty. */
  labels?: string[];
  /** How the title is to be written. A rule without one leaves the title alone. */
  instruction?: string;
}

export interface TitleRulesDocument {
  version: number;
  rules: TitleRule[];
}

export const MAX_TITLE_RULES = 50;
export const MAX_TITLE_PATTERN_CHARS = 300;
export const MAX_TITLE_INSTRUCTION_CHARS = 2000;

/** The binding of the document of version `version`: a document sealed for one version never opens as another. */
export function titleRulesBinding(version: number): Binding {
  if (!isTitleRulesVersion(version))
    throw new ContractError('the version of the title rules must be a positive integer');
  return { field: 'titles', context: `titles:v${version}` };
}

/** What is wrong with one rule, in words for the person who wrote it, or undefined when it is fine. */
export function titleRuleProblem(rule: TitleRule): string | undefined {
  if (rule.pattern === '') return 'the pattern is empty';
  if (rule.pattern.length > MAX_TITLE_PATTERN_CHARS)
    return `the pattern is longer than ${MAX_TITLE_PATTERN_CHARS} characters`;
  if (rule.flags !== undefined && rule.flags !== 'i') return 'the only flag is i';
  try {
    new RegExp(rule.pattern, rule.flags ?? '');
  } catch {
    return 'the pattern is not a valid regular expression';
  }
  if (rule.icon !== undefined && !isEmojiIcon(rule.icon)) return 'the icon must be one emoji';
  if (rule.labels !== undefined) {
    const problem = labelsProblem(rule.labels);
    if (problem !== undefined) return problem;
  }
  if (rule.instruction !== undefined) {
    if (rule.instruction.trim() === '') return 'the title instruction is empty';
    if (rule.instruction.length > MAX_TITLE_INSTRUCTION_CHARS)
      return `the title instruction is longer than ${MAX_TITLE_INSTRUCTION_CHARS} characters`;
  }
  if (rule.icon === undefined && rule.labels === undefined && rule.instruction === undefined)
    return 'the rule sets no icon, no labels and no title';
  return undefined;
}

function labelsProblem(labels: readonly string[]): string | undefined {
  if (labels.length === 0) return 'the list of labels is empty';
  let kept: string[];
  try {
    kept = checkLabels(labels);
  } catch (error) {
    return error instanceof ContractError ? error.message : 'the labels are not valid';
  }
  if (kept.length !== labels.length || kept.some((label, index) => label !== labels[index]))
    return 'the labels repeat one or have spaces around one';
  return undefined;
}

/** The document as text, the rules in their order. */
export function titleRulesJson(document: TitleRulesDocument): string {
  return JSON.stringify({
    version: document.version,
    rules: document.rules.map(({ pattern, flags, icon, labels, instruction }) => ({
      pattern,
      ...(flags === undefined ? {} : { flags }),
      ...(icon === undefined ? {} : { icon }),
      ...(labels === undefined ? {} : { labels }),
      ...(instruction === undefined ? {} : { instruction }),
    })),
  });
}

function documentProblem(document: TitleRulesDocument): string | undefined {
  if (!isTitleRulesVersion(document.version)) return 'a version that is not a positive integer';
  if (document.rules.length > MAX_TITLE_RULES) return `more than ${MAX_TITLE_RULES} rules`;
  for (const [index, rule] of document.rules.entries()) {
    const problem = titleRuleProblem(rule);
    if (problem !== undefined) return `a rule (number ${index + 1}) where ${problem}`;
  }
  return undefined;
}

/** Seals the document under its own version; refuses more rules than the board takes and a rule that does not work. */
export async function sealTitleRules(seal: Sealer, document: TitleRulesDocument): Promise<string> {
  const problem = documentProblem(document);
  if (problem !== undefined) throw new ContractError(`the title rules have ${problem}`);
  return sealChecked(seal, titleRulesBinding(document.version), titleRulesJson(document), 'the title rules');
}

function parseRule(value: unknown): TitleRule | undefined {
  if (!isRecord(value)) return undefined;
  const { pattern, flags, icon, labels, instruction } = value;
  if (typeof pattern !== 'string') return undefined;
  if (flags !== undefined && flags !== 'i') return undefined;
  if (icon !== undefined && typeof icon !== 'string') return undefined;
  if (labels !== undefined && !(Array.isArray(labels) && labels.every((label) => typeof label === 'string')))
    return undefined;
  if (instruction !== undefined && typeof instruction !== 'string') return undefined;
  const rule: TitleRule = {
    pattern,
    ...(flags === undefined ? {} : { flags }),
    ...(icon === undefined ? {} : { icon }),
    ...(labels === undefined ? {} : { labels: labels as string[] }),
    ...(instruction === undefined ? {} : { instruction }),
  };
  return titleRuleProblem(rule) === undefined ? rule : undefined;
}

/**
 * The document the board holds as version `version`, or undefined when it is unreadable: it does not open under exactly that
 * version's binding, says another version inside, or is not `{"version":n,"rules":[…]}` of rules that work.
 */
export async function openTitleRules(
  open: Opener,
  version: number,
  wire: string,
): Promise<TitleRulesDocument | undefined> {
  if (!isTitleRulesVersion(version)) return undefined;
  const text = await open(titleRulesBinding(version), wire);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || json['version'] !== version) return undefined;
  const list = json['rules'];
  if (!Array.isArray(list) || list.length > MAX_TITLE_RULES) return undefined;
  const rules = list.map(parseRule);
  return rules.every((rule) => rule !== undefined) ? { version, rules } : undefined;
}

/** The first rule whose pattern matches the prompt, with its position, or undefined when none does. */
export function matchTitleRule(
  rules: readonly TitleRule[],
  prompt: string,
): { index: number; rule: TitleRule } | undefined {
  for (const [index, rule] of rules.entries()) {
    try {
      if (new RegExp(rule.pattern, rule.flags ?? '').test(prompt)) return { index, rule };
    } catch {
      continue;
    }
  }
  return undefined;
}
