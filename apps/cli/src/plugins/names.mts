export const MARKETPLACE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const INTEGRATION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const NAME_RULE = '1 to 40 lowercase letters, digits or dashes, starting with a letter or digit';

export const isMarketplaceName = (name: string): boolean => MARKETPLACE_NAME.test(name);
export const isIntegrationName = (name: string): boolean => INTEGRATION_NAME.test(name);

export interface IntegrationRef {
  marketplace: string;
  integration: string;
}

/** Splits `<marketplace>:<integration>`; undefined unless both halves are valid names. */
export function parseIntegrationRef(ref: string): IntegrationRef | undefined {
  const parts = ref.split(':');
  const [marketplace, integration] = parts;
  if (parts.length !== 2 || marketplace === undefined || integration === undefined) return undefined;
  return isMarketplaceName(marketplace) && isIntegrationName(integration) ? { marketplace, integration } : undefined;
}
