import { MIN_UI_CLIENT, UI_API_VERSION, UI_SERVER_FEATURES } from '@agent-board/shared/ui';
import { publicProcedure, router } from './trpc';

export const uiRouter = router({
  /** What a custom UI asks first: the API version, the oldest client the server accepts, and the features it has. */
  version: publicProcedure.query(() => ({
    api: UI_API_VERSION,
    minClient: MIN_UI_CLIENT,
    features: [...UI_SERVER_FEATURES],
  })),
});
