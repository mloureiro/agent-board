import { ACTION_NAME, INTEGRATION_NAME, INTEGRATION_REF, MARKETPLACE_NAME } from '@agent-board/shared';

export const NAME_RULE = '1 to 40 lowercase letters, digits or dashes, starting with a letter or digit';

export const isMarketplaceName = (name: string): boolean => MARKETPLACE_NAME.test(name);
export const isIntegrationName = (name: string): boolean => INTEGRATION_NAME.test(name);
export const isActionName = (name: string): boolean => ACTION_NAME.test(name);

export interface IntegrationRef {
  marketplace: string;
  integration: string;
}

/** Splits `<marketplace>:<integration>`; undefined unless both halves are valid names. */
export function parseIntegrationRef(ref: string): IntegrationRef | undefined {
  if (!INTEGRATION_REF.test(ref)) return undefined;
  const [marketplace = '', integration = ''] = ref.split(':');
  return { marketplace, integration };
}
