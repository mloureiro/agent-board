/**
 * The title rules a user set in the browser: one sealed document per user, which the server cannot read and every machine's CLI can. A save is
 * compare-and-set on the clear version, so two tabs saving at once cannot overwrite each other unseen.
 */
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { titleRules } from '../db/schema';
import { AppError } from './errors';

export interface StoredTitleRules {
  version: number;
  document: string;
  updatedAt: Date;
}

/** The sealed document with its version and when it was saved, or null when the user saved none. */
export async function getTitleRules(db: DbOrTx): Promise<StoredTitleRules | null> {
  const [row] = await db
    .select({ version: titleRules.version, document: titleRules.document, updatedAt: titleRules.updatedAt })
    .from(titleRules);
  return row ?? null;
}

/**
 * Stores the next version of the document while the stored one is still `expectedVersion` (0: none is stored); a conflict
 * when another save came first. The input check has seen that `version` is `expectedVersion + 1`.
 */
export async function setTitleRules(
  db: DbOrTx,
  { document, version, expectedVersion }: { document: string; version: number; expectedVersion: number },
): Promise<void> {
  const written =
    expectedVersion === 0
      ? await db
          .insert(titleRules)
          .values({ version, document })
          .onConflictDoNothing()
          .returning({ version: titleRules.version })
      : await db
          .update(titleRules)
          .set({ version, document, updatedAt: sql`now()` })
          .where(eq(titleRules.version, expectedVersion))
          .returning({ version: titleRules.version });
  if (written.length === 0) {
    const current = await getTitleRules(db);
    throw new AppError(
      'CONFLICT',
      `the board holds version ${current?.version ?? 'none'} of the title rules, not ${expectedVersion === 0 ? 'none' : expectedVersion}; reload them`,
    );
  }
}
