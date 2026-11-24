import type { ListedTask } from '@agent-board/shared/ui';

export const DESKTOP_NOTIFICATIONS_PREFERENCE_KEY = 'agent-board.desktopNotifications';
const PREFERENCE_EVENT = 'agent-board:desktop-notifications';

export type NotifiableTask = Pick<ListedTask, 'id' | 'status' | 'closed'>;

const needsMe = (task: NotifiableTask): boolean => task.status === 'needs-me' && !task.closed;

export const idsNeedingMe = (tasks: readonly NotifiableTask[]): Set<string> =>
  new Set(tasks.filter(needsMe).map(({ id }) => id));

/** The tasks that entered Needs me since `previous`; `null` is the first load, which reports none. */
export function newlyNeedingMe<T extends NotifiableTask>(
  previous: ReadonlySet<string> | null,
  tasks: readonly T[],
): T[] {
  if (previous === null) return [];
  return tasks.filter((task) => needsMe(task) && !previous.has(task.id));
}

export const isNotificationSupported = (): boolean => typeof Notification !== 'undefined';

const TASK_PATH = /^\/t\/[A-Za-z0-9_-]+$/;
const OPEN_MESSAGE = 'agent-board:open';

let worker: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the service worker that shows notifications; mobile browsers refuse `new Notification()`. `null` without one. */
export function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  worker ??= (async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      return await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
  })();
  return worker;
}

/** Forgets the memoized registration, so a test can start over. */
export function resetNotificationWorkerForTests(): void {
  worker = null;
}

interface ShownNotification {
  body: string;
  tag?: string;
  /** The board path a click opens. */
  path?: string;
  /** Called with `path` on a click when no worker shows the notification. */
  open?: (path: string) => void;
}

export async function showNotification(title: string, { body, tag, path, open }: ShownNotification): Promise<void> {
  const registration = await notificationWorker();
  if (registration) {
    await registration.showNotification(title, { body, tag, icon: '/favicon.svg', data: { path } });
    return;
  }
  const notification = new Notification(title, { body, tag, icon: '/favicon.svg' });
  notification.onclick = () => {
    window.focus();
    if (path !== undefined) open?.(path);
    notification.close();
  };
}

/** Calls `open` with the path of a notification the service worker saw clicked. */
export function subscribeToNotificationClicks(open: (path: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const { serviceWorker } = navigator;
  const listener = ({ data }: MessageEvent<unknown>) => {
    if (typeof data !== 'object' || data === null) return;
    const { type, path } = data as { type?: unknown; path?: unknown };
    if (type === OPEN_MESSAGE && typeof path === 'string' && TASK_PATH.test(path)) open(path);
  };
  serviceWorker.addEventListener('message', listener);
  return () => serviceWorker.removeEventListener('message', listener);
}

export const readDesktopNotificationsPreference = (): boolean => {
  try {
    return localStorage.getItem(DESKTOP_NOTIFICATIONS_PREFERENCE_KEY) === 'on';
  } catch {
    return false;
  }
};

export function writeDesktopNotificationsPreference(on: boolean): void {
  try {
    if (on) localStorage.setItem(DESKTOP_NOTIFICATIONS_PREFERENCE_KEY, 'on');
    else localStorage.removeItem(DESKTOP_NOTIFICATIONS_PREFERENCE_KEY);
  } catch {
    // Storage is blocked: the preference only lasts until the page closes, which the subscribers below still see.
  }
  window.dispatchEvent(new Event(PREFERENCE_EVENT));
}

/** Calls `listener` when the preference changes here or in another tab. */
export function subscribeToDesktopNotificationsPreference(listener: () => void): () => void {
  window.addEventListener(PREFERENCE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(PREFERENCE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}
