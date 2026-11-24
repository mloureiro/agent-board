/** The desktop client opens this path in the default browser, so the route and the link must keep it. */
export const HANDOFF_PATH = '/handoff/';

export const handoffUrl = (flow: string, origin: string = window.location.origin): string =>
  `${origin}${HANDOFF_PATH}${flow}`;
