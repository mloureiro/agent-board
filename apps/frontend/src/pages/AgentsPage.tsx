import { Alert, Badge, Code, Group, List, Paper, Spoiler, Stack, Table, Text, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { QueryStatus } from '../components/QueryStatus';
import { ago, stamp } from '../lib/time';
import { POLL_MS, useTRPC } from '../lib/trpc';
import { agentOnMachine, machineAgents, shortHash, type AgentOnMachine, type MachineAgents } from '../lib/sharedAgents';
import type { SharedAgentView } from '@agent-board/shared/ui';

/** The warnings `board agents push` prints before it asks, in the same words. */
function flagLines(agent: SharedAgentView): string[] {
  const { broad, secrets, emptyDenyList, deadTools } = agent.flags;
  return [
    ...broad.map(({ rule, reason }) => `allow rule ${rule}: ${reason}`),
    ...(emptyDenyList ? ['the deny list is empty: nothing is denied beyond what the allow rules leave out'] : []),
    ...secrets.map((variable) => `env ${variable} looks like a secret: the run gets its value`),
    ...(deadTools.length > 0 ? [`allowedTools has rules for ${deadTools.join(', ')}, which tools leaves out`] : []),
  ];
}

function Rules({
  label,
  rules,
  flag,
}: {
  label: string;
  rules: string[];
  flag?: (rule: string) => string | undefined;
}) {
  return (
    <div>
      <Text size="sm" fw={500}>
        {label} ({rules.length}){rules.length === 0 ? ': none' : ''}
      </Text>
      {rules.length > 0 && (
        <List size="sm" spacing={2} listStyleType="none">
          {rules.map((rule) => {
            const why = flag?.(rule);
            return (
              <List.Item key={rule}>
                <Code c={why === undefined ? undefined : 'orange'}>{rule}</Code>
                {why !== undefined && (
                  <Text span size="xs" c="orange">
                    {' '}
                    broad: {why}
                  </Text>
                )}
              </List.Item>
            );
          })}
        </List>
      )}
    </div>
  );
}

const STATE_TEXT: Record<AgentOnMachine['kind'], string> = {
  same: 'runs this definition',
  other: 'runs another definition',
  missing: 'does not have it',
  silent: 'does not report its agents (CLI older than shared agents)',
};

const STATE_COLOR: Record<AgentOnMachine['kind'], string> = {
  same: 'teal',
  other: 'orange',
  missing: 'orange',
  silent: 'dimmed',
};

function MachinesOfAgent({ agent, machines }: { agent: SharedAgentView; machines: MachineAgents[] }) {
  if (machines.length === 0)
    return (
      <Text size="sm" c="dimmed">
        No machine has sent a catalogue yet.
      </Text>
    );
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Machine</Table.Th>
          <Table.Th>Runs</Table.Th>
          <Table.Th>Hash</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {machines.map((machine) => {
          const state = agentOnMachine(machine, agent);
          return (
            <Table.Tr key={machine.machine}>
              <Table.Td>
                <Text size="sm">{machine.machine}</Text>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Text size="sm" c={STATE_COLOR[state.kind]}>
                    {STATE_TEXT[state.kind]}
                  </Text>
                  {machine.replaced.includes(agent.name) && (
                    <Badge size="xs" variant="light" color="gray">
                      replaced a local definition
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                {state.kind === 'same' && <Code>{shortHash(agent.hash)}</Code>}
                {state.kind === 'other' && <Code c="orange">{shortHash(state.hash)}</Code>}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

function Agent({ agent, machines }: { agent: SharedAgentView; machines: MachineAgents[] }) {
  const flags = flagLines(agent);
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <div>
          <Group gap="xs">
            <Title order={5}>{agent.name}</Title>
            {agent.version !== null && <Badge variant="light">{agent.version}</Badge>}
            <Code>{shortHash(agent.hash)}</Code>
          </Group>
          <Text size="sm">{agent.description}</Text>
          {agent.source !== null && (
            <Text size="xs" c="dimmed">
              source: {agent.source}
            </Text>
          )}
        </div>
        {agent.problems.length > 0 && (
          <Alert color="red" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
            Machines refuse this definition: {agent.problems.join('; ')}.
          </Alert>
        )}
        {flags.length > 0 && (
          <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
            <List size="sm" spacing={2}>
              {flags.map((line) => (
                <List.Item key={line}>{line}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Text size="sm">
          <Text span fw={500}>
            model:
          </Text>{' '}
          {agent.model ?? 'the task’s or the machine’s'}
        </Text>
        <Rules label="tools" rules={agent.tools} />
        <Rules
          label="allowedTools"
          rules={agent.allowedTools}
          flag={(rule) => agent.flags.broad.find((broad) => broad.rule === rule)?.reason}
        />
        <Rules label="disallowedTools" rules={agent.disallowedTools} />
        <Rules
          label="env, copied from the working directory's settings"
          rules={agent.env}
          flag={(variable) => (agent.flags.secrets.includes(variable) ? 'looks like a secret' : undefined)}
        />
        <Rules label="mcpServers, from the working directory's .mcp.json" rules={agent.mcpServers} />
        {agent.prompt !== null && (
          <div>
            <Text size="sm" fw={500}>
              prompt
            </Text>
            <Spoiler maxHeight={160} showLabel="Show all" hideLabel="Show less">
              <Code block style={{ whiteSpace: 'pre-wrap' }}>
                {agent.prompt}
              </Code>
            </Spoiler>
          </div>
        )}
        <div>
          <Text size="sm" fw={500}>
            Definition as pushed
          </Text>
          <Spoiler maxHeight={0} showLabel="Show" hideLabel="Hide">
            <Code block>{agent.definition}</Code>
          </Spoiler>
        </div>
        <div>
          <Text size="sm" fw={500}>
            Machines
          </Text>
          <MachinesOfAgent agent={agent} machines={machines} />
        </div>
      </Stack>
    </Paper>
  );
}

function versionText(machine: MachineAgents, board: number): { text: string; color?: string } {
  if (!machine.reports) return { text: 'not reported', color: 'dimmed' };
  if (machine.version === null) return { text: 'none applied', color: 'orange' };
  if (machine.version < board) return { text: `v${machine.version}, behind`, color: 'orange' };
  return { text: `v${machine.version}` };
}

function MachineVersions({ machines, board }: { machines: MachineAgents[]; board: number }) {
  if (machines.length === 0) return null;
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Title order={5}>Machines</Title>
        <Text size="sm" c="dimmed">
          The version each machine applied last, from its catalogue. A machine applies a new version on its next tick.
        </Text>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Machine</Table.Th>
              <Table.Th>Applied</Table.Th>
              <Table.Th>Replaced a local definition</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {machines.map((machine) => {
              const version = versionText(machine, board);
              return (
                <Table.Tr key={machine.machine}>
                  <Table.Td>
                    <Text size="sm">{machine.machine}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={version.color}>
                      {version.text}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={machine.replaced.length === 0 ? 'dimmed' : undefined}>
                      {machine.replaced.length === 0 ? 'none' : machine.replaced.join(', ')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Stack>
    </Paper>
  );
}

/** The agent definitions on the board, read only: `board agents push` and `board agents rm --board` change them. */
export function AgentsPage() {
  const trpc = useTRPC();
  const shared = useQuery({ ...trpc.agents.shared.queryOptions(), refetchInterval: POLL_MS });
  const catalogs = useQuery({ ...trpc.machines.catalogs.queryOptions(), refetchInterval: POLL_MS });
  const machines = machineAgents(catalogs.data ?? []);
  const board = shared.data;

  return (
    <Stack>
      <div>
        <Title order={5}>Agents</Title>
        <Text size="sm" c="dimmed">
          The agent definitions on the board. Every machine of yours applies them by itself. This page only shows them:
          change them with <Code>board agents push</Code> and <Code>board agents rm --board</Code>.
        </Text>
      </div>
      <QueryStatus query={shared} what="agents" />
      <QueryStatus query={catalogs} what="machine catalogues" />
      {board === null && (
        <Text size="sm" c="dimmed">
          No agent is on the board yet.
        </Text>
      )}
      {board && (
        <>
          <Text size="sm">
            Version {board.version}, pushed{' '}
            {board.pushedAt === '' ? 'at an unknown time' : `${stamp(board.pushedAt)} (${ago(board.pushedAt)})`}
            {board.agents === null ? '' : `, ${board.agents.length} ${board.agents.length === 1 ? 'agent' : 'agents'}`}.
          </Text>
          {board.agents === null && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              The definitions do not open under this version with your key. Machines do not apply them either.
            </Alert>
          )}
          <MachineVersions machines={machines} board={board.version} />
          {board.agents?.map((agent) => (
            <Agent key={agent.name} agent={agent} machines={machines} />
          ))}
        </>
      )}
    </Stack>
  );
}
