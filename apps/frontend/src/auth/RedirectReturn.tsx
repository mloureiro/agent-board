import { Center, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconLogin } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { usePageTitle } from '../components/usePageTitle';
import { useRawTRPCClient } from '../lib/trpc';
import { failureMessage } from './failure';
import { LoginPage } from './LoginPage';
import { takeVerifier, type RedirectMethod } from './redirectFlow';
import { useCompleteSignIn } from './useCompleteSignIn';

interface Props {
  method: RedirectMethod;
}

const MISSING_VERIFIER = 'This sign-in did not start in this browser tab, or it has been used already. Start again.';
const MAX_DETAIL = 200;

/** What the board's SAML consumer reports by `error=<code>`: its own fixed set, so the parameter is never shown as it came. */
const SAML_ERRORS: Record<string, string> = {
  failed: 'The sign-in was refused. Start again.',
  no_user: 'The identity provider sent no usable user name.',
};
const SAML_ERROR_FALLBACK = 'The sign-in failed. Start again.';

function samlRefusal(params: URLSearchParams): string | null {
  const code = params.get('error');
  if (code === null) return null;
  return Object.hasOwn(SAML_ERRORS, code) ? (SAML_ERRORS[code] ?? SAML_ERROR_FALLBACK) : SAML_ERROR_FALLBACK;
}

/** What the identity provider says went wrong, from its `error` and `error_description`: text for the user, cut to a sane length. */
function refusal(params: URLSearchParams): string | null {
  const code = params.get('error');
  if (code === null) return null;
  const detail = params.get('error_description') ?? code;
  return `The sign-in was refused: ${detail.slice(0, MAX_DETAIL)}`;
}

/**
 * Where the identity provider sends the browser back to, at /login/oidc or /login/saml: finishes the flow with the verifier
 * this tab kept and signs in. Whatever goes wrong ends on the sign-in page with the reason.
 */
export function RedirectReturn({ method }: Props) {
  const client = useRawTRPCClient();
  const completeSignIn = useCompleteSignIn();
  const [failure, setFailure] = useState<string | null>(null);
  usePageTitle(failure === null ? 'Signing in' : 'Sign in');
  // A strict-mode remount runs the effect again, and the query it reads is gone by then.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    // First: the code and the state are single-use secrets that do not belong in the address bar or the history.
    window.history.replaceState(window.history.state, '', window.location.pathname);
    const verifier = takeVerifier(method);
    const finish = async (): Promise<void> => {
      const refused = method === 'oidc' ? refusal(params) : samlRefusal(params);
      if (refused !== null) throw new Error(refused);
      if (verifier === null) throw new Error(MISSING_VERIFIER);
      if (method === 'oidc') {
        const code = params.get('code');
        const state = params.get('state');
        if (code === null || state === null) throw new Error('The sign-in answer is incomplete. Start again.');
        const iss = params.get('iss');
        await client.auth.oidc.finish.mutate({ code, state, verifier, ...(iss === null ? {} : { iss }) });
        return;
      }
      const flow = params.get('flow');
      if (flow === null) throw new Error('The sign-in answer is incomplete. Start again.');
      await client.auth.saml.finish.mutate({ flow, verifier });
    };
    finish()
      .then(completeSignIn)
      .catch((err: unknown) => setFailure(failureMessage(err)));
  }, [client, completeSignIn, method]);

  if (failure !== null) return <LoginPage failure={failure} />;
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack>
          <Group gap="xs">
            <IconLogin size={22} />
            <Title order={3}>Signing you in</Title>
          </Group>
          <Group gap="xs">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Waiting for the board.
            </Text>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}
