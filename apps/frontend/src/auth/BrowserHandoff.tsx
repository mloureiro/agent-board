import { Anchor, Button, CopyButton, Group, Loader, Stack, Text } from '@mantine/core';
import { IconCheck, IconCopy, IconExternalLink } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRawTRPCClient } from '../lib/trpc';
import { failureMessage } from './failure';
import { handoffUrl } from './handoffPath';
import { challengeOf, newVerifier } from './redirectFlow';
import { useCompleteSignIn } from './useCompleteSignIn';

const CHECK_MS = 2_000;

type Phase =
  | { kind: 'starting' }
  | { kind: 'signing-in' }
  | { kind: 'waiting'; flow: string; code: string }
  | { kind: 'failed'; message: string };

interface Props {
  onCancel: () => void;
}

/**
 * Signs this window in through another browser: shows a code and a link, and checks every few seconds whether the
 * approval happened there. The window never navigates, so the verifier lives in memory only.
 */
export function BrowserHandoff({ onCancel }: Props) {
  const client = useRawTRPCClient();
  const completeSignIn = useCompleteSignIn();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const verifier = useRef<string | null>(null);
  const checkNow = useRef<() => void>(() => undefined);
  const mounted = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' });
    try {
      const secret = newVerifier();
      const { flow, code } = await client.auth.handoff.start.mutate({ challenge: await challengeOf(secret) });
      if (!mounted.current) return;
      verifier.current = secret;
      setPhase({ kind: 'waiting', flow, code });
    } catch (err) {
      if (mounted.current) setPhase({ kind: 'failed', message: failureMessage(err) });
    }
  }, [client]);

  useEffect(() => {
    // A strict-mode remount runs this again, and a second start would leave a second flow behind.
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  const flow = phase.kind === 'waiting' ? phase.flow : null;
  useEffect(() => {
    const secret = verifier.current;
    if (flow === null || secret === null) return;
    let stopped = false;
    let inFlight = false;
    const stop = () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
      checkNow.current = () => undefined;
    };
    const check = () => {
      if (stopped || inFlight) return;
      inFlight = true;
      client.auth.handoff.finish
        .mutate({ flow, verifier: secret })
        .then(async (result) => {
          if (stopped || result.status !== 'signed-in') return;
          stop();
          setPhase({ kind: 'signing-in' });
          await completeSignIn();
        })
        .catch((err: unknown) => {
          if (stopped) return;
          stop();
          setPhase({ kind: 'failed', message: failureMessage(err) });
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    const timer = window.setInterval(check, CHECK_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    checkNow.current = check;
    return stop;
  }, [client, flow, completeSignIn]);

  if (phase.kind === 'failed') {
    return (
      <Stack gap="xs">
        <Text c="red" size="sm" role="alert">
          {phase.message}
        </Text>
        <Group gap="xs">
          <Button variant="default" onClick={() => void start()}>
            Start again
          </Button>
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    );
  }

  if (phase.kind === 'starting' || phase.kind === 'signing-in') {
    return (
      <Group gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {phase.kind === 'starting' ? 'Starting the sign-in.' : 'Signing you in.'}
        </Text>
      </Group>
    );
  }

  const url = handoffUrl(phase.flow);
  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Text size="sm" c="dimmed">
          Your code
        </Text>
        <Text size="xl" fw={700} ff="monospace" data-testid="handoff-code">
          {phase.code}
        </Text>
      </Stack>
      <Text size="sm">Open this page in your browser, sign in there and check that it shows the same code.</Text>
      <Button component="a" href={url} target="_blank" rel="noopener" leftSection={<IconExternalLink size={16} />}>
        Open in your browser
      </Button>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Anchor component="span" size="xs" c="dimmed" style={{ wordBreak: 'break-all', userSelect: 'all' }}>
          {url}
        </Anchor>
        <CopyButton value={url}>
          {({ copied, copy }) => (
            <Button
              size="compact-xs"
              style={{ flexShrink: 0 }}
              variant="default"
              leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Waiting for approval…
        </Text>
      </Group>
      <Group gap="xs">
        <Button variant="default" onClick={() => checkNow.current()}>
          Check now
        </Button>
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}
