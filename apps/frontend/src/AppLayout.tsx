import { ActionIcon, AppShell, Box, Button, Group, Menu, Text, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconArchive,
  IconLayoutKanban,
  IconDots,
  IconInbox,
  IconLock,
  IconLogout,
  IconMoon,
  IconPlus,
  IconPlugConnected,
  IconRepeat,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSignOut } from './auth/useSignOut';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useLock } from './crypto/KeyContext';
import { NewTaskModal } from './components/NewTaskModal';
import { useDesktopNotifications } from './components/useDesktopNotifications';

/** Backlog has a nav entry only on a phone, where the board leaves it out. */
const NAV = [
  { to: '/', label: 'Board', icon: IconLayoutKanban },
  { to: '/backlog', label: 'Backlog', icon: IconInbox, phoneOnly: true },
  { to: '/schedules', label: 'Schedules', icon: IconRepeat },
  { to: '/sources', label: 'Sources', icon: IconPlugConnected },
  { to: '/closed', label: 'Closed', icon: IconArchive },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function AppLayout() {
  const [creating, setCreating] = useState(false);
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const lock = useLock();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = (to: string) =>
    to === '/' ? pathname === '/' || pathname.startsWith('/t/') : pathname.startsWith(to);
  const themeLabel = colorScheme === 'dark' ? 'Light mode' : 'Dark mode';
  useHotkeys([['c', () => setCreating(true)]]);
  useDesktopNotifications();

  return (
    <AppShell header={{ height: 56 }} padding={{ base: 'xs', sm: 'md' }}>
      <AppShell.Header>
        <Group h="100%" px={{ base: 8, sm: 'md' }} justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" className="header-group">
            <Group
              gap={8}
              wrap="nowrap"
              mr={{ base: 0, sm: 10 }}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate('/')}
            >
              <img src="/favicon.svg" alt="" width={24} height={24} />
              <Text fw={700} visibleFrom="xs">
                Agent Board
              </Text>
            </Group>
            <Group gap={4} wrap="nowrap">
              {NAV.map((item) => (
                <Button
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  end
                  hiddenFrom={item.phoneOnly ? 'sm' : undefined}
                  variant={active(item.to) ? 'light' : 'subtle'}
                  size="compact-sm"
                  aria-label={item.label}
                  classNames={{ root: 'header-button', section: 'header-button-section' }}
                  leftSection={<item.icon size={16} />}
                  styles={{ root: { fontWeight: 500 } }}
                >
                  <Text span size="sm" visibleFrom="sm">
                    {item.label}
                  </Text>
                </Button>
              ))}
            </Group>
          </Group>
          <Group gap="xs" wrap="nowrap" className="header-group">
            <Group gap="xs" wrap="nowrap" visibleFrom="sm">
              <Tooltip label={themeLabel}>
                <ActionIcon variant="default" size="lg" onClick={toggleColorScheme} aria-label="Toggle color scheme">
                  {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
                </ActionIcon>
              </Tooltip>
              {lock && (
                <Tooltip label="Lock">
                  <ActionIcon variant="default" size="lg" onClick={() => void lock()} aria-label="Lock">
                    <IconLock size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              {signOut && (
                <Tooltip label="Sign out">
                  <ActionIcon variant="default" size="lg" onClick={() => void signOut()} aria-label="Sign out">
                    <IconLogout size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="default" size="lg" hiddenFrom="sm" aria-label="More">
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  leftSection={colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
                  onClick={toggleColorScheme}
                >
                  {themeLabel}
                </Menu.Item>
                {lock && (
                  <Menu.Item leftSection={<IconLock size={16} />} onClick={() => void lock()}>
                    Lock
                  </Menu.Item>
                )}
                {signOut && (
                  <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>
                    Sign out
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
            <Tooltip label="New task (c)">
              <Button
                aria-label="New task"
                classNames={{ root: 'header-button', section: 'header-button-section' }}
                leftSection={<IconPlus size={16} />}
                onClick={() => setCreating(true)}
              >
                <Box component="span" visibleFrom="sm">
                  New task
                </Box>
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        {/* A page that throws keeps the header; going to another page tries again. */}
        <ErrorBoundary what="this page" resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </AppShell.Main>
      <NewTaskModal opened={creating} onClose={() => setCreating(false)} />
    </AppShell>
  );
}
