import { withoutControls } from '../watch/fence.mts';
import type { Resolved } from '../plugins/resolve.mts';
import { check, describe, parseDescription } from './integration.mts';
import type { Run } from './integration.mts';
import { validate as validateOptions } from './schema.mts';
import { placeholders } from './template.mts';

export interface FeedBinding {
  integration: string;
  action: string;
  options: unknown;
  prompts: { new: string; update: string };
  dir: string;
}

export interface ValidateDeps {
  resolve: (ref: string) => Resolved;
  run: Run;
}

export type Validated = { ok: true; program: string; fields: string[] } | { ok: false; reason: string };

export const REASON_LIMIT = 300;
export const ITEM_BASE_FIELDS = ['key', 'title', 'version'] as const;

const refuse = (reason: string): Validated => ({
  ok: false,
  reason: Array.from(withoutControls(reason).replaceAll('\n', ' ')).slice(0, REASON_LIMIT).join(''),
});

/**
 * Whether a feed may run, in the order that costs least first: the integration resolves to its pinned program, describes the
 * action, accepts the options and the placeholders of both prompts, and `check` agrees. The first failure is the reason; on
 * success the program is the very path that was validated.
 */
export async function validateFeed(feed: FeedBinding, deps: ValidateDeps): Promise<Validated> {
  const resolved = deps.resolve(feed.integration);
  if ('problem' in resolved) return refuse(resolved.problem);
  const { program } = resolved;
  const described = await describe(program, feed.dir, deps.run);
  if (!described.ok) return refuse(`${feed.integration} ${described.reason}`);
  const description = parseDescription(described.stdout, feed.integration);
  if (typeof description === 'string') return refuse(description);
  const declared = Object.hasOwn(description.actions, feed.action) ? description.actions[feed.action] : undefined;
  if (declared === undefined) {
    const known = Object.keys(description.actions);
    return refuse(
      `${feed.integration} has no action ${feed.action} (${known.length === 0 ? 'it has none' : `it has: ${known.join(', ')}`})`,
    );
  }
  const problem = validateOptions(declared.options, feed.options);
  if (problem !== undefined) return refuse(problem);
  const provided = [...new Set([...ITEM_BASE_FIELDS, ...declared.fields])];
  for (const [name, text] of [
    ['prompts.new', feed.prompts.new],
    ['prompts.update', feed.prompts.update],
  ] as const) {
    const unknown = placeholders(text).find((used) => !provided.includes(used));
    if (unknown !== undefined)
      return refuse(
        `${name} uses {${unknown}}, which ${feed.integration} ${feed.action} does not provide (it provides ${provided.join(', ')})`,
      );
  }
  const checked = await check(program, feed.action, feed.options, feed.dir, deps.run);
  if (!checked.ok) return refuse(`${feed.integration} ${checked.reason}`);
  return { ok: true, program, fields: declared.fields };
}
