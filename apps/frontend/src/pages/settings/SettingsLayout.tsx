import { Button, Group, NavLink as MantineNavLink, ScrollArea, Stack, Title } from '@mantine/core';
import { IconBell, IconKey, IconLink, IconRobot, IconServer, IconUser } from '@tabler/icons-react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { usePageTitle } from '../../components/usePageTitle';
import { Revision } from './Revision';

const SUBPAGES = [
  { to: '/settings/machines', label: 'Machines', icon: IconServer },
  { to: '/settings/agents', label: 'Agents', icon: IconRobot },
  { to: '/settings/links', label: 'Links', icon: IconLink },
  { to: '/settings/notifications', label: 'Notifications', icon: IconBell },
  { to: '/settings/encryption', label: 'Encryption', icon: IconKey },
  { to: '/settings/account', label: 'Account', icon: IconUser },
];

/** The settings subpages: a column beside the content, a scrollable row above it on a phone. */
export function SettingsLayout() {
  usePageTitle('Settings');
  const { pathname } = useLocation();
  return (
    <Stack maw={1000} mx="auto">
      <Title order={3}>Settings</Title>
      <Group align="flex-start" wrap="nowrap" gap="lg">
        <Stack
          gap={2}
          w={200}
          visibleFrom="sm"
          component="nav"
          aria-label="Settings sections"
          style={{ flexShrink: 0 }}
        >
          {SUBPAGES.map(({ to, label, icon: Icon }) => (
            <MantineNavLink
              key={to}
              component={Link}
              to={to}
              active={pathname === to}
              label={label}
              leftSection={<Icon size={16} />}
            />
          ))}
        </Stack>
        <Stack miw={0} style={{ flex: 1 }}>
          <ScrollArea hiddenFrom="sm" type="never" component="nav" aria-label="Settings sections">
            <Group gap={4} wrap="nowrap">
              {SUBPAGES.map(({ to, label, icon: Icon }) => (
                <Button
                  key={to}
                  component={Link}
                  to={to}
                  variant={pathname === to ? 'light' : 'subtle'}
                  size="compact-sm"
                  leftSection={<Icon size={16} />}
                  styles={{ root: { flexShrink: 0 } }}
                >
                  {label}
                </Button>
              ))}
            </Group>
          </ScrollArea>
          <Outlet />
        </Stack>
      </Group>
      <Revision />
    </Stack>
  );
}
