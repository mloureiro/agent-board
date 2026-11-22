/**
 * A run's transcript on its way to the board: a backlog held to a count and a byte budget, sent in batches in upload passes
 * that each spend a bounded number of calls and a bounded time, so a board that is slow, down or refusing cannot hold the
 * run back or make the worker's memory grow without end.
 */
import { MAX_BATCH_EVENTS } from '@agent-board/shared';
import type { RunEvent } from '@agent-board/shared';
import { isPermanentRefusal } from '../backend/backend.mts';
import { errorText } from '../output/text.mts';

// Events waiting for the board past this many, or past this many bytes of JSON, lose their oldest tool outputs first and then their
// oldest events, with a note in the transcript: the board is down, the run goes on.
const MAX_PENDING_EVENTS = 20_000;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
// What one upload pass may spend on the board: calls, counting the halving of a refused batch, and time. What is left goes
// with the next pass.
const MAX_UPLOAD_CALLS = 24;
const MAX_UPLOAD_MS = 60_000;
// Half the server's body limit.
const BATCH_MAX_BYTES = 8 * 1024 * 1024;

// Events never change once the condenser made them (an emptied output is a new event), so each is serialised once.
const sizes = new WeakMap<RunEvent, number>();

// The size of one event as it would be sent.
export function eventBytes(event: RunEvent): number {
  let size = sizes.get(event);
  if (size === undefined) {
    size = Buffer.byteLength(JSON.stringify(event));
    sizes.set(event, size);
  }
  return size;
}

const bytesOf = (events: RunEvent[]): number => events.reduce((sum, event) => sum + eventBytes(event), 0);

/**
 * A transcript backlog held to a count and a size: past either, the oldest tool outputs go first (the event stays, its output
 * empties), then, when that is not enough, the oldest events. Says how many of each it dropped, so the transcript can note it.
 */
export function boundBacklog(
  events: RunEvent[],
  { maxEvents, maxBytes }: { maxEvents: number; maxBytes: number },
): { events: RunEvent[]; droppedOutputs: number; droppedEvents: number } {
  let kept = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
  let droppedEvents = events.length - kept.length;
  let droppedOutputs = 0;
  let total = bytesOf(kept);
  if (total > maxBytes) {
    kept = kept.map((event) => {
      if (total <= maxBytes || event.kind !== 'tool_result' || event.output === '') return event;
      const emptied = { ...event, output: '' };
      total -= eventBytes(event) - eventBytes(emptied);
      droppedOutputs += 1;
      return emptied;
    });
  }
  if (total > maxBytes) {
    let first = 0;
    while (first < kept.length && total > maxBytes) {
      total -= eventBytes(kept[first]!);
      first += 1;
    }
    droppedEvents += first;
    kept = kept.slice(first);
  }
  return { events: kept, droppedOutputs, droppedEvents };
}

// Events as the board takes them: batches of at most `maxEvents` events and about `maxBytes` of JSON, so a backlog
// stays under the server's limits. One event larger than `maxBytes` goes alone.
export function splitBatches(
  events: RunEvent[],
  { maxEvents = MAX_BATCH_EVENTS, maxBytes = BATCH_MAX_BYTES }: { maxEvents?: number; maxBytes?: number } = {},
): RunEvent[][] {
  const batches: RunEvent[][] = [];
  let bytes = 0;
  for (const event of events) {
    const size = eventBytes(event);
    const last = batches.at(-1);
    if (last === undefined || last.length >= maxEvents || bytes + size > maxBytes) {
      batches.push([event]);
      bytes = size;
    } else {
      last.push(event);
      bytes += size;
    }
  }
  return batches;
}

export interface TranscriptUploaderOptions {
  // Sends one batch to the board.
  post: (events: RunEvent[]) => Promise<void>;
  now: () => Date;
  // A line in the run's log.
  log: (text: string) => void;
  // A note event at the transcript's next position, for what the backlog had to drop.
  note: (text: string) => RunEvent;
  // The backlog's budget: past either, it is trimmed to 90% of both.
  maxEvents?: number | undefined;
  maxBytes?: number | undefined;
  // What one upload pass may spend.
  maxCalls?: number | undefined;
  maxMs?: number | undefined;
}

export interface TranscriptUploader {
  // Queues events, trimming the backlog when it is over its budget.
  add: (events: RunEvent[]) => void;
  // Starts an upload pass unless one is in flight, and returns the pass in flight.
  start: () => Promise<void>;
  // The end of the run: what is in flight, then what is left, then once more what a pass left over, each bounded like any other.
  flush: () => Promise<void>;
}

export function createTranscriptUploader(options: TranscriptUploaderOptions): TranscriptUploader {
  const {
    post,
    now,
    log,
    note,
    maxEvents = MAX_PENDING_EVENTS,
    maxBytes = MAX_PENDING_BYTES,
    maxCalls = MAX_UPLOAD_CALLS,
    maxMs = MAX_UPLOAD_MS,
  } = options;
  let pending: RunEvent[] = [];
  let pendingBytes = 0;

  // Holds the backlog to its count and byte budget, and says in the transcript what it had to drop.
  const keepBounded = (): void => {
    if (pending.length <= maxEvents && pendingBytes <= maxBytes) return;
    // Trimmed to 90% so that the next lines do not trim again, and note again, at once.
    const bounded = boundBacklog(pending, {
      maxEvents: Math.floor(maxEvents * 0.9),
      maxBytes: Math.floor(maxBytes * 0.9),
    });
    pending = bounded.events;
    if (bounded.droppedOutputs > 0 || bounded.droppedEvents > 0) {
      const parts = [
        ...(bounded.droppedOutputs > 0 ? [`${bounded.droppedOutputs} tool outputs`] : []),
        ...(bounded.droppedEvents > 0 ? [`${bounded.droppedEvents} events`] : []),
      ];
      pending.push(
        note(
          `${parts.join(' and ')} of this run were dropped from the transcript: the board could not take them in time.`,
        ),
      );
      log(`transcript backlog over its budget: dropped ${parts.join(' and ')}`);
    }
    pendingBytes = bytesOf(pending);
  };

  // Sends `events`; returns the ones to try again later (all, or none). A batch the board refuses for good is halved until the
  // event it cannot take is alone and dropped, so one bad event never holds the transcript back. `spend` says whether this pass
  // may make another call.
  const sendEvents = async (events: RunEvent[], spend: () => boolean): Promise<RunEvent[]> => {
    if (!spend()) return events;
    try {
      await post(events);
      return [];
    } catch (error) {
      const reason = errorText(error);
      if (!isPermanentRefusal(error)) {
        log(`transcript upload failed: ${reason}`);
        return events;
      }
      if (events.length === 1) {
        log(`transcript event ${events[0]?.seq} was refused and dropped: ${reason}`);
        return [];
      }
      const middle = Math.ceil(events.length / 2);
      const firstBack = await sendEvents(events.slice(0, middle), spend);
      if (firstBack.length > 0) return [...firstBack, ...events.slice(middle)];
      return sendEvents(events.slice(middle), spend);
    }
  };

  const upload = async (): Promise<void> => {
    const batches = splitBatches(pending);
    pending = [];
    pendingBytes = 0;
    const passStarted = now().getTime();
    let calls = 0;
    const spend = (): boolean => {
      if (calls >= maxCalls || now().getTime() - passStarted > maxMs) return false;
      calls += 1;
      return true;
    };
    for (const [index, events] of batches.entries()) {
      const back = await sendEvents(events, spend);
      if (back.length > 0) {
        // What could not go out, and the batches after it, go again with the next pass, ahead of what came in meanwhile.
        pending = [...back, ...batches.slice(index + 1).flat(), ...pending];
        pendingBytes = bytesOf(pending);
        keepBounded();
        return;
      }
    }
  };

  // One upload at a time. A tick that finds one in flight leaves what has come in since to the next pass.
  let uploading: Promise<void> | undefined;
  const start = (): Promise<void> => {
    uploading ??= upload()
      .catch((error: unknown) => {
        log(`transcript upload failed: ${errorText(error)}`);
      })
      .finally(() => {
        uploading = undefined;
      });
    return uploading;
  };

  return {
    add: (events) => {
      pending.push(...events);
      pendingBytes += bytesOf(events);
      keepBounded();
    },
    start,
    flush: async () => {
      await uploading;
      await start();
      if (pending.length > 0) await start();
    },
  };
}
