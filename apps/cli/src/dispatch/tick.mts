// The time limits of one dispatch tick and the names of the locks the timed runs hold. The units and agents `board setup`
// writes, the listener and the tick itself read them from here; bin/dispatch and bin/intake are shell and spell the lock names out.

// A tick is stopped after this long: the dispatch unit's TimeoutStartSec, the listener's limit and the tick's own backstop.
export const TICK_LIMIT_S = 110;
// A migration step starts only within this long of the tick's start; a step still running is aborted at the second mark.
export const MIGRATION_START_WINDOW_S = TICK_LIMIT_S - 50;
export const MIGRATION_ABORT_AT_S = TICK_LIMIT_S - 15;
// After the stop, how long a tick gets before it is killed.
export const TICK_GRACE_S = 10;
// How long stopping the listener may take: it waits for the running tick, which takes the limit and the grace at most.
export const LISTEN_STOP_TIMEOUT_S = TICK_LIMIT_S + TICK_GRACE_S + 10;

// The file name of a timed run's lock, in the runtime directory (`%t`) on Linux and the run directory on macOS.
export const lockFileName = (name: 'dispatch' | 'intake'): string => `agent-board-${name}.lock`;
