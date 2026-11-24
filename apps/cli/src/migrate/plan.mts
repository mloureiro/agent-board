import { compareVersions } from '@agent-board/shared';
import { MIGRATION_BASELINE } from './steps.mts';
import type { MigrationStep } from './steps.mts';

// The steps with from < since <= to, in since order; steps of one version keep their registry order.
export function planSteps(registry: readonly MigrationStep[], from: string, to: string): MigrationStep[] {
  return registry
    .filter((step) => compareVersions(step.since, from) > 0 && compareVersions(step.since, to) <= 0)
    .sort((a, b) => compareVersions(a.since, b.since));
}

// The version whose steps are applied. A machine with a web.json and no marker predates the marker, so it is at the
// baseline; one without a web.json has nothing to migrate. A binary older than the marker is a downgrade and plans nothing.
export function fromVersion(marker: string | undefined, hasWebConfig: boolean, to: string): string {
  if (marker !== undefined) return compareVersions(marker, to) > 0 ? to : marker;
  if (!hasWebConfig) return to;
  return compareVersions(MIGRATION_BASELINE, to) > 0 ? to : MIGRATION_BASELINE;
}
