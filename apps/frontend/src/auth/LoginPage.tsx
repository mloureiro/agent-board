import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconExternalLink, IconKey, IconLogin } from '@tabler/icons-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useRawTRPCClient } from '../lib/trpc';
import { challengeOf, followableUrl, keepVerifier, newVerifier, type RedirectMethod } from './redirectFlow';
import { rememberReturnPath } from './returnPath';
import { failureMessage } from './failure';
import { BrowserHandoff } from './BrowserHandoff';
import { useAttempt } from './useAttempt';
import { useAuthConfig } from './useAuthConfig';
import { useCompleteSignIn } from './useCompleteSignIn';
import { authenticateWithPasskey, createPasskey } from './webauthn';

const MAX_PASSKEY_NAME = 60;

interface Props {
  /** Why the sign-in that brought the user here failed, when one did. */
  failure?: string;
}

function SignupForm({ supported }: { supported: boolean }) {
  const client = useRawTRPCClient();
  const completeSignIn = useCompleteSignIn();
  const { busy, error, note, run } = useAttempt();
  const [username, setUsername] = useState('');
  const [signupToken, setSignupToken] = useState('');
  const [name, setName] = useState('');
  const ready = supported && username.trim() !== '' && signupToken !== '';
  const submit = async () => {
    if (!ready) return;
    await run(async () => {
      const { flow, options } = await client.auth.passkey.signupOptions.mutate({
        username: username.trim(),
        signupToken,
      });
      const response = await createPasskey(options);
      const trimmed = name.trim();
      await client.auth.passkey.signup.mutate({
        flow,
        response,
        ...(trimmed === '' ? {} : { name: trimmed }),
      });
      await completeSignIn();
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack gap="xs">
        <Title order={5}>Create an account</Title>
        <TextInput
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
          autoComplete="username webauthn"
          data-autofocus
        />
        <PasswordInput
          label="Sign-up token"
          description="From whoever runs this board."
          value={signupToken}
          onChange={(event) => setSignupToken(event.currentTarget.value)}
          autoComplete="off"
        />
        <TextInput
          label="Passkey name"
          description="Optional. Helps you tell your passkeys apart."
          maxLength={MAX_PASSKEY_NAME}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          autoComplete="off"
        />
        {error && (
          <Text c="red" size="sm" role="alert">
            {error}
          </Text>
        )}
        {note && (
          <Text c="dimmed" size="sm">
            {note}
          </Text>
        )}
        <Button type="submit" variant="default" disabled={!ready} loading={busy}>
          Create account
        </Button>
      </Stack>
    </form>
  );
}

/** What a user sees when nobody is signed in: one button per way the board offers, and sign-up when it is open. */
export function LoginPage({ failure }: Props) {
  const client = useRawTRPCClient();
  const config = useAuthConfig();
  const completeSignIn = useCompleteSignIn();
  const { pathname, search, hash } = useLocation();
  const { busy, error, note, run } = useAttempt();
  const [signingUp, setSigningUp] = useState(false);
  const [viaBrowser, setViaBrowser] = useState(false);
  const supported = browserSupportsWebAuthn();

  useEffect(() => rememberReturnPath(`${pathname}${search}${hash}`), [pathname, search, hash]);

  const withPasskey = () =>
    run(async () => {
      const { flow, options } = await client.auth.passkey.loginOptions.mutate();
      const response = await authenticateWithPasskey(options);
      await client.auth.passkey.login.mutate({ flow, response });
      await completeSignIn();
    });

  // The browser leaves for the identity provider and comes back at /login/<method>, where RedirectReturn finishes the flow.
  const withRedirect = (method: RedirectMethod) =>
    run(async () => {
      const verifier = newVerifier();
      const challenge = await challengeOf(verifier);
      const { url } = await client.auth[method].start.mutate({ challenge });
      const target = followableUrl(url);
      if (target === null) throw new Error('The board sent a sign-in address the browser will not open.');
      keepVerifier(method, verifier);
      window.location.assign(target);
    });

  const offer = config.data?.login === true ? config.data : null;
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack>
          <Group gap="xs">
            <IconLogin size={22} />
            <Title order={3}>Sign in to Agent Board</Title>
          </Group>
          {config.isLoading && <Loader size="sm" />}
          {config.error && (
            <>
              <Text c="red">Could not load the sign-in options: {failureMessage(config.error)}</Text>
              <Button variant="default" onClick={() => void config.refetch()}>
                Try again
              </Button>
            </>
          )}
          {config.data?.login === false && <Text c="red">This board has no sign-in set up.</Text>}
          {failure && (
            <Text c="red" size="sm" role="alert">
              {failure}
            </Text>
          )}
          {error && (
            <Text c="red" size="sm" role="alert">
              {error}
            </Text>
          )}
          {note && (
            <Text c="dimmed" size="sm">
              {note}
            </Text>
          )}
          {offer && viaBrowser && <BrowserHandoff onCancel={() => setViaBrowser(false)} />}
          {offer && !viaBrowser && (
            <Stack gap="xs">
              {offer.passkeys && (
                <>
                  <Button
                    leftSection={<IconKey size={16} />}
                    disabled={!supported || busy}
                    onClick={() => void withPasskey()}
                  >
                    Sign in with a passkey
                  </Button>
                  {!supported && (
                    <Text size="sm" c="dimmed">
                      This browser does not support passkeys.
                    </Text>
                  )}
                </>
              )}
              {offer.oidc && (
                <Button variant="default" disabled={busy} onClick={() => void withRedirect('oidc')}>
                  {offer.oidc.label}
                </Button>
              )}
              {offer.saml && (
                <Button variant="default" disabled={busy} onClick={() => void withRedirect('saml')}>
                  {offer.saml.label}
                </Button>
              )}
              <Button
                variant="default"
                leftSection={<IconExternalLink size={16} />}
                disabled={busy}
                onClick={() => setViaBrowser(true)}
              >
                Sign in with your browser
              </Button>
            </Stack>
          )}
          {offer?.signup && !viaBrowser && (
            <>
              {signingUp ? (
                <SignupForm supported={supported} />
              ) : (
                <Anchor component="button" type="button" size="sm" onClick={() => setSigningUp(true)}>
                  Create an account
                </Anchor>
              )}
            </>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
