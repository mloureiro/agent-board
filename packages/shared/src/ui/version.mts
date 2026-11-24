import { ContractError } from '../contract.mts';

// The UI API is the tRPC surface a custom UI builds on. These numbers are independent of the machine API's.
// A change to a procedure that an older UI cannot tolerate raises UI_API_VERSION; raising MIN_UI_CLIENT refuses UIs older than it.
export const UI_API_VERSION = 1;
export const MIN_UI_CLIENT = 1;
// The lowest server a UI of this build works with, which a UI checks against `ui.version`.
export const MIN_UI_SERVER = 1;

export const UI_API_HEADER = 'x-board-ui-api';

// An additive change to the UI API appends its name here, in the same commit that makes the server do it.
export const UI_SERVER_FEATURES = [] as const;
export type UiServerFeature = (typeof UI_SERVER_FEATURES)[number];

// How a client says what is missing: "the board server does not support <label> yet".
export const UI_FEATURE_LABELS: Record<UiServerFeature, string> = {};

/** The UI API version a request header names: null when absent, a `ContractError` when it is not a positive integer. */
export function parseUiApiHeader(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? value.join(',') : value;
  if (!/^[1-9][0-9]{0,8}$/.test(text.trim())) throw new ContractError(`${UI_API_HEADER} must be a positive integer`);
  return Number(text.trim());
}
