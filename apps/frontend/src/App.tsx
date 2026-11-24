import { Badge, Center, Loader, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { HANDOFF_PATH } from './auth/handoffPath';
import { HandoffApproval } from './auth/HandoffApproval';
import { LoginPage } from './auth/LoginPage';
import { RedirectReturn } from './auth/RedirectReturn';
import { AccountDeletedProvider } from './components/AccountDeletedProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LinkRulesProvider } from './components/LinkRulesProvider';
import { KeyGate } from './crypto/KeyGate';
import { removeDrafts } from './lib/drafts';
import { subscribeToSession } from './lib/session';
import { errorMessage, POLL_MS, useTRPC } from './lib/trpc';
import { isUnauthorized } from './lib/unauthorized';
import { BacklogPage, BoardPage } from './pages/BoardPage';
import { ClosedPage } from './pages/ClosedPage';
import { AgentsPage } from './pages/AgentsPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { FeedsPage } from './pages/FeedsPage';
import { AccountSettings } from './pages/settings/AccountSettings';
import { EncryptionSettings } from './pages/settings/EncryptionSettings';
import { LinksSettings } from './pages/settings/LinksSettings';
import { TitlesSettings } from './pages/settings/TitlesSettings';
import { MachinesSettings } from './pages/settings/MachinesSettings';
import { NotificationsSettings } from './pages/settings/NotificationsSettings';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { TaskPage } from './pages/TaskPage';

function SignedInApp() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // While the board does not answer, keep asking, so the banner below goes away on its own once it is back. A refusal to a
  // user nobody has signed in is not that: asking again every few seconds would change nothing.
  const me = useQuery({
    ...trpc.me.queryOptions(),
    refetchInterval: (query) =>
      query.state.status === 'error' && !isUnauthorized(query.state.error) ? POLL_MS : false,
  });
  const signedOut = isUnauthorized(me.error);
  useEffect(() => {
    if (signedOut) {
      removeDrafts();
      modals.closeAll();
    }
  }, [signedOut]);
  // Another tab signing in or out changes what this one is allowed to see.
  useEffect(() => subscribeToSession(() => void queryClient.resetQueries()), [queryClient]);

  if (me.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  // Before the stale answer below: a session that ended while the app was open leaves the last good answer in place.
  if (signedOut) return <LoginPage />;
  // Only a sign-in that never answered stops here. A failed background refetch keeps the last good answer, so the
  // unlocked keys and whatever is being typed survive a backend restart.
  if (me.data === undefined) {
    return (
      <Center h="100vh">
        <Text c="red">No access: {errorMessage(me.error)}</Text>
      </Center>
    );
  }
  return (
    <>
      {me.error && (
        <Badge
          color="red"
          variant="filled"
          pos="fixed"
          bottom={16}
          left="50%"
          style={{ zIndex: 1000, transform: 'translateX(-50%)' }}
        >
          Board unreachable, retrying
        </Badge>
      )}
      <KeyGate me={me.data}>
        {/* Inside the gate, so that a crash anywhere in the app still offers Lock. */}
        <ErrorBoundary what="the board">
          <LinkRulesProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<BoardPage />} />
                <Route path="backlog" element={<BacklogPage />} />
                <Route path="t/:id" element={<TaskPage />} />
                <Route path="schedules" element={<SchedulesPage />} />
                <Route path="closed" element={<ClosedPage />} />
                <Route path="settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="/settings/machines" replace />} />
                  <Route path="machines" element={<MachinesSettings />} />
                  <Route path="notifications" element={<NotificationsSettings />} />
                  <Route path="encryption" element={<EncryptionSettings />} />
                  <Route path="feeds" element={<FeedsPage />} />
                  <Route path="agents" element={<AgentsPage />} />
                  <Route path="links" element={<LinksSettings />} />
                  <Route path="titles" element={<TitlesSettings />} />
                  <Route path="account" element={<AccountSettings />} />
                  <Route path="*" element={<Navigate to="/settings/machines" replace />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </LinkRulesProvider>
        </ErrorBoundary>
      </KeyGate>
    </>
  );
}

/** The way back from an identity provider is a page of its own: nobody is signed in yet when it finishes the sign-in. */
export function App() {
  return (
    <AccountDeletedProvider>
      <Routes>
        <Route path="login/oidc" element={<RedirectReturn method="oidc" />} />
        <Route path="login/saml" element={<RedirectReturn method="saml" />} />
        <Route path={`${HANDOFF_PATH.slice(1)}:flow`} element={<HandoffApproval />} />
        <Route path="*" element={<SignedInApp />} />
      </Routes>
    </AccountDeletedProvider>
  );
}
