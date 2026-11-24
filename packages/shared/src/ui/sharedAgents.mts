import { agentHash, grantFlags, isStringList, type GrantFlags, type SharedAgentEntry } from '../index.mts';

const LISTS = ['tools', 'allowedTools', 'disallowedTools', 'env', 'mcpServers'] as const;
type ListKey = (typeof LISTS)[number];
const TEXTS = ['description', 'prompt', 'model', 'version', 'source'] as const;
type TextKey = (typeof TEXTS)[number];

export type SharedAgentView = Record<ListKey, string[]> &
  Record<TextKey, string | null> & {
    name: string;
    // `agentHash` of the definition, as the machines report it for the agent they run.
    hash: string;
    flags: GrantFlags;
    // Keys whose value is not of the shape an agent file takes; a machine refuses the definition with them.
    problems: string[];
    // The definition as pushed, as indented JSON.
    definition: string;
  };

/** One definition of the document, read for display. A key of the wrong shape is shown empty and named in `problems`. */
export async function viewSharedAgent(name: string, entry: SharedAgentEntry): Promise<SharedAgentView> {
  const problems: string[] = [];
  const list = (key: ListKey): string[] => {
    const value = entry[key] ?? [];
    if (isStringList(value)) return value;
    problems.push(`${key} is not a list of strings`);
    return [];
  };
  const text = (key: TextKey): string | null => {
    const value = entry[key];
    if (value === undefined || typeof value === 'string') return value ?? null;
    problems.push(`${key} is not text`);
    return null;
  };
  const lists = Object.fromEntries(LISTS.map((key) => [key, list(key)])) as Record<ListKey, string[]>;
  const texts = Object.fromEntries(TEXTS.map((key) => [key, text(key)])) as Record<TextKey, string | null>;
  if (texts.description === null || texts.description.trim() === '') problems.push('description is missing');
  if (lists.tools.length === 0) problems.push('tools is empty');
  return {
    name,
    ...lists,
    ...texts,
    hash: await agentHash(entry),
    flags: grantFlags(lists),
    problems,
    definition: JSON.stringify(entry, null, 2),
  };
}

/** The document's definitions, by name. */
export function viewSharedAgents(agents: Record<string, SharedAgentEntry>): Promise<SharedAgentView[]> {
  return Promise.all(
    Object.keys(agents)
      .sort()
      .map((name) => viewSharedAgent(name, agents[name] ?? {})),
  );
}
