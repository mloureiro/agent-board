import type {
  Effort,
  NextRun,
  NoteKind,
  PrState,
  Priority,
  Status,
  TaskActor,
  TaskCreator,
  WireNoteAuthor,
} from '../contract.mts';
import type { FEED_ACTIONS } from '../machineFeeds.mts';
import type { UiPath } from './procedures.mts';
import type { UiServerFeature } from './version.mts';

/** A sealed value: an `abe1.…` envelope string the server cannot read. */
export type Envelope = string;

/** An ISO 8601 timestamp, as JSON delivers a date. */
export type IsoDate = string;

export interface UiNoteInput {
  body: Envelope;
  preview?: Envelope | null;
}

export interface UiPlace {
  machine: string;
  workdir: Envelope;
}

export interface UiTaskPr {
  id: string;
  pr: Envelope;
  state: PrState | null;
}

export interface UiTask {
  id: string;
  title: Envelope;
  input: Envelope;
  workdir: Envelope | null;
  agent?: Envelope | null;
  icon?: Envelope | null;
  labels?: Envelope | null;
  pr: Envelope | null;
  prs?: UiTaskPr[];
  prState: PrState | null;
  promptPrState?: PrState | null;
  watches?: Envelope | null;
  watchStops?: string[];
  status: Status;
  priority: Priority;
  model: string | null;
  effort: Effort | null;
  requestedLane: string | null;
  autoDone: boolean;
  closed: boolean;
  machine: string | null;
  sessionId: string | null;
  next: NextRun;
  head: string | null;
  openQuestion: boolean;
  createdBy: TaskCreator;
  movedBy?: TaskActor;
  lane: string | null;
  borrowed: boolean;
  lastActiveAt: IsoDate | null;
  runStartedAt: IsoDate | null;
  run?: string;
  paused: boolean;
  notBefore: IsoDate | null;
  scheduleId: string | null;
  held?: true;
  forkOf?: string;
  wakeAt: IsoDate | null;
  waitCheck: boolean;
  woken: boolean;
  stopRequested?: boolean;
  noteCount?: number;
  proposed: boolean;
  started: boolean;
  parentId: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface UiRunContext {
  at: IsoDate;
  runId: string;
  seq: number;
  data: Envelope;
}

export interface UiTaskListItem extends UiTask {
  lastNote: { createdAt: IsoDate; preview: Envelope | null; author: WireNoteAuthor; kind: NoteKind } | null;
  context: UiRunContext | null;
}

export interface UiThreadNote {
  id: string;
  createdAt: IsoDate;
  body: Envelope;
  preview: Envelope | null;
  author: WireNoteAuthor;
  kind: NoteKind;
  by: string | null;
  questions?: Envelope;
  answers?: Envelope;
  questionNoteId?: string;
  suggestion?: Envelope;
  pending?: boolean;
  queued?: boolean;
  deliveredAt?: IsoDate;
}

export interface UiTaskDetail {
  task: UiTask;
  thread: UiThreadNote[];
  followUps: UiTask[];
  parent: UiTask | null;
}

export interface UiScheduleAfter {
  scheduleId: string;
  delayMs: number;
}

export interface UiSchedule {
  id: string;
  title: Envelope;
  input: Envelope;
  workdir: Envelope | null;
  agent?: Envelope | null;
  icon?: Envelope | null;
  labels?: Envelope | null;
  priority: Priority;
  model: string | null;
  effort: Effort | null;
  requestedLane: string | null;
  autoDone: boolean;
  machine: string | null;
  everyMs: number | null;
  cron: string | null;
  moreCrons?: string[];
  timezone: string | null;
  after: UiScheduleAfter | null;
  maxConcurrent: number | null;
  anchorAt: IsoDate;
  nextRunAt: IsoDate | null;
  remaining: number | null;
  until: IsoDate | null;
  paused: boolean;
  ended: boolean;
  occurrenceTaskId: string | null;
  createdAt: IsoDate;
}

export type UiScheduleOutcome = 'updated' | 'started' | 'none' | 'removed' | 'created';

export type UiMachineClientStatus = 'current' | 'outdated' | 'incompatible' | 'unknown';

export interface UiMachine {
  name: string;
  createdAt: IsoDate;
  lastSeenAt: IsoDate | null;
  revokedAt: IsoDate | null;
  clientVersion: string | null;
  clientStatus: UiMachineClientStatus;
  dirs: Envelope | null;
  dirsUpdatedAt: IsoDate | null;
  usage: Envelope | null;
  usageUpdatedAt: IsoDate | null;
}

export interface UiMachineCatalog {
  name: string;
  catalog: Envelope | null;
  catalogUpdatedAt: IsoDate | null;
}

export interface UiMachineFeeds {
  name: string;
  lastSeenAt: IsoDate | null;
  feeds: Envelope | null;
  feedsUpdatedAt: IsoDate | null;
  feedRequests: string[];
}

export type UiFeedAction = (typeof FEED_ACTIONS)[number];

export interface UiPassphraseSlot {
  kind: 'passphrase';
  kdf: 'argon2id';
  m: number;
  t: number;
  p: number;
  salt: string;
  wrapped: string;
}

export interface UiRecoverySlot {
  kind: 'recovery';
  wrapped: string;
}

export type UiKeySlot = UiPassphraseSlot | UiRecoverySlot;

export interface UiKeys {
  keyId: string;
  slots: UiKeySlot[];
}

export interface UiSealedDocument {
  document: Envelope;
  version: number;
  updatedAt: IsoDate;
}

export interface UiSharedAgents {
  document: Envelope;
  version: number;
  pushedAt: IsoDate;
}

export interface UiDocumentSave {
  document: Envelope;
  version: number;
  expectedVersion: number;
}

export interface UiPasskey {
  id: string;
  name: string;
  createdAt: IsoDate;
  lastUsedAt: IsoDate | null;
}

export interface UiCredentialDescriptor {
  type: string;
  id: string;
  transports?: string[];
}

export interface UiPasskeyRequestOptions {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: UiCredentialDescriptor[];
  userVerification?: string;
  hints?: string[];
  extensions?: Record<string, unknown>;
}

export interface UiPasskeyCreationOptions {
  user: { id: string; name: string; displayName: string };
  challenge: string;
  rp: { name: string; id?: string };
  pubKeyCredParams: { type: string; alg: number }[];
  timeout?: number;
  hints?: string[];
  extensions?: Record<string, unknown>;
  excludeCredentials?: UiCredentialDescriptor[];
  authenticatorSelection?: {
    authenticatorAttachment?: string;
    userVerification?: string;
    requireResidentKey?: boolean;
    residentKey?: string;
  };
  attestation?: string;
  attestationFormats?: string[];
}

export interface UiAuthenticationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  authenticatorAttachment?: 'platform' | 'cross-platform';
  clientExtensionResults?: Record<string, unknown>;
}

export interface UiRegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData?: string;
    transports?: string[];
    publicKeyAlgorithm?: number;
    publicKey?: string;
  };
  authenticatorAttachment?: 'platform' | 'cross-platform';
  clientExtensionResults?: Record<string, unknown>;
}

export type UiAuthConfig =
  | { login: false }
  | {
      login: true;
      passkeys: boolean;
      signup: boolean;
      oidc: { label: string } | null;
      saml: { label: string } | null;
    };

export type UiAccountTable =
  | 'task'
  | 'schedule'
  | 'note'
  | 'task_pr'
  | 'machine'
  | 'shared_agents'
  | 'link_rules'
  | 'title_rules'
  | 'transcript_run'
  | 'transcript_event';

export interface UiAccountSummary {
  running: number;
  tasks: number;
  schedules: number;
  machines: number;
  titleRules: number;
  notes: number;
  taskPrs: number;
  sharedAgents: number;
  linkRules: number;
  transcriptRuns: number;
  transcriptEvents: number;
}

export interface UiTranscriptRun {
  id: string;
  machine: string;
  sessionId: string | null;
  resumed: boolean;
  startedAt: IsoDate;
  lastEventAt: IsoDate;
  eventCount: number;
}

export interface UiTranscriptEvent {
  seq: number;
  at: IsoDate;
  kind: string;
  parent: string | null;
  data: Envelope;
  outputSize: number | null;
}

export interface UiRepeatEnd {
  times?: number;
  until?: IsoDate;
  maxConcurrent?: number;
}

export type UiCreateWhen =
  | 'now'
  | 'backlog'
  | 'hold'
  | { at: IsoDate }
  | (UiRepeatEnd & { every: number; at?: IsoDate })
  | (UiRepeatEnd & { cron: string; timezone: string; moreCrons?: string[]; at?: IsoDate })
  | (UiRepeatEnd & { after: { scheduleId: string; delayMs?: number } });

export type UiScheduleRepeat =
  { everyMs: number } | { cron: string; timezone: string; moreCrons?: string[] } | { after: UiScheduleAfter };

export interface UiTaskCreate {
  id: string;
  title: Envelope;
  input: Envelope;
  priority?: Priority;
  model?: string;
  effort?: Effort;
  lane?: string;
  autoDone?: boolean;
  parentId?: string;
  when?: UiCreateWhen;
  place?: UiPlace;
  agent?: Envelope;
  icon?: Envelope;
  labels?: Envelope;
}

export interface UiTaskConfigure {
  id: string;
  priority?: Priority;
  model?: string | null;
  effort?: Effort | null;
  lane?: string | null;
  autoDone?: boolean;
  icon?: Envelope | null;
  labels?: Envelope | null;
  place?: UiPlace | null;
  title?: Envelope;
}

export interface UiScheduleUpdate {
  id: string;
  title: Envelope;
  input: Envelope;
  agent?: Envelope;
  place: UiPlace | null;
  priority: Priority;
  model: string | null;
  effort?: Effort | null;
  lane?: string | null;
  icon?: Envelope | null;
  labels?: Envelope | null;
  autoDone: boolean;
  repeat: UiScheduleRepeat;
  at?: IsoDate;
  runsLeft: number | null;
  until: IsoDate | null;
  maxConcurrent: number | null;
}

export interface UiInputs {
  'account.delete': { username: string };
  'account.export': { table: UiAccountTable; cursor?: string | null };
  'account.import': { keyId: string; table: UiAccountTable; rows: unknown[] };
  'account.summary': void;
  'agents.shared': void;
  'auth.config': void;
  'auth.logout': void;
  'auth.oidc.finish': { code: string; state: string; verifier: string; iss?: string };
  'auth.oidc.start': { challenge: string };
  'auth.passkey.login': { flow: string; response: UiAuthenticationResponse };
  'auth.passkey.loginOptions': void;
  'auth.passkey.signup': { flow: string; response: UiRegistrationResponse; name?: string };
  'auth.passkey.signupOptions': { username: string; signupToken: string };
  'auth.saml.finish': { flow: string; verifier: string };
  'auth.saml.start': { challenge: string };
  'feeds.list': void;
  'feeds.request': { machine: string; action: UiFeedAction; id: string };
  'keys.get': void;
  'keys.replaceSlots': { keyId: string; slots: UiKeySlot[] };
  'keys.setup': { keyId: string; slots: UiKeySlot[] };
  'links.get': void;
  'links.set': UiDocumentSave;
  'machines.advertisedCli': void;
  'machines.catalogs': void;
  'machines.issue': { name: string };
  'machines.list': void;
  'machines.revoke': { name: string };
  me: void;
  'passkeys.list': void;
  'passkeys.register': { flow: string; response: UiRegistrationResponse; name: string };
  'passkeys.registerOptions': void;
  'passkeys.remove': { id: string };
  'passkeys.rename': { id: string; name: string };
  revision: void;
  'schedules.list': void;
  'schedules.remove': { id: string };
  'schedules.setPaused': { id: string; paused: boolean };
  'schedules.update': UiScheduleUpdate;
  'tasks.answer': { id: string; questionNoteId: string; answers: Envelope; message: UiNoteInput };
  'tasks.applyPolish': { id: string; polishId: string; title: Envelope; input: Envelope; previous: UiNoteInput };
  'tasks.configure': UiTaskConfigure;
  'tasks.create': UiTaskCreate;
  'tasks.dismissQuestion': { id: string; questionNoteId: string };
  'tasks.done': { id: string };
  'tasks.edit': { id: string; title: Envelope; input: Envelope; previous: UiNoteInput };
  'tasks.fork': { id: string; parentId: string; title: Envelope; input: Envelope; workdir: Envelope; agent?: Envelope };
  'tasks.get': { id: string };
  'tasks.list': { closed?: boolean } | void;
  'tasks.move': { id: string; status: Status; beforeId?: string; afterId?: string; startInput?: Envelope };
  'tasks.removePr': { id: string; prId: string };
  'tasks.reply': { id: string; message: UiNoteInput; resume: boolean };
  'tasks.rerun': { id: string };
  'tasks.send': { id: string; message: UiNoteInput };
  'tasks.setClosed': { id: string; closed: boolean };
  'tasks.setNotBefore': { id: string; notBefore: IsoDate | null };
  'tasks.setPriority': { id: string; priority: Priority };
  'tasks.stop': { id: string; message?: UiNoteInput };
  'tasks.stopWatch': { id: string; watchId: string };
  'tasks.takeBack': { id: string };
  'tasks.wakeNow': { id: string };
  'titleRules.get': void;
  'titleRules.set': UiDocumentSave;
  'transcript.context': { id: string };
  'transcript.events': { runId: string; afterSeq?: number };
  'transcript.output': { runId: string; seq: number };
  'transcript.runs': { id: string };
  'ui.version': void;
}

export interface UiOutputs {
  'account.delete': void;
  'account.export': { next: string | null; rows: Record<string, unknown>[] };
  'account.import': { inserted: number; existing: number; invalid: number; orphaned: number };
  'account.summary': UiAccountSummary;
  'agents.shared': UiSharedAgents | null;
  'auth.config': UiAuthConfig;
  'auth.logout': void;
  'auth.oidc.finish': { ok: true };
  'auth.oidc.start': { url: string };
  'auth.passkey.login': { ok: true };
  'auth.passkey.loginOptions': { options: UiPasskeyRequestOptions; flow: string };
  'auth.passkey.signup': { ok: true };
  'auth.passkey.signupOptions': { options: UiPasskeyCreationOptions; flow: string };
  'auth.saml.finish': { ok: true };
  'auth.saml.start': { url: string };
  'feeds.list': UiMachineFeeds[];
  'feeds.request': void;
  'keys.get': UiKeys | null;
  'keys.replaceSlots': void;
  'keys.setup': void;
  'links.get': UiSealedDocument | null;
  'links.set': void;
  'machines.advertisedCli': string | null;
  'machines.catalogs': UiMachineCatalog[];
  'machines.issue': { token: string };
  'machines.list': UiMachine[];
  'machines.revoke': void;
  me: { username: string; keyId: string | null };
  'passkeys.list': UiPasskey[];
  'passkeys.register': void;
  'passkeys.registerOptions': { options: UiPasskeyCreationOptions; flow: string };
  'passkeys.remove': void;
  'passkeys.rename': void;
  revision: string | null;
  'schedules.list': UiSchedule[];
  'schedules.remove': void;
  'schedules.setPaused': UiSchedule;
  'schedules.update': { schedule: UiSchedule; pending: UiScheduleOutcome };
  'tasks.answer': UiTask;
  'tasks.applyPolish': UiTask;
  'tasks.configure': UiTask;
  'tasks.create': UiTask | null;
  'tasks.dismissQuestion': UiTask;
  'tasks.done': UiTask;
  'tasks.edit': UiTask;
  'tasks.fork': UiTask;
  'tasks.get': UiTaskDetail;
  'tasks.list': UiTaskListItem[];
  'tasks.move': UiTask;
  'tasks.removePr': UiTask;
  'tasks.reply': UiTask;
  'tasks.rerun': UiTask;
  'tasks.send': UiTask;
  'tasks.setClosed': UiTask;
  'tasks.setNotBefore': UiTask;
  'tasks.setPriority': UiTask;
  'tasks.stop': UiTask;
  'tasks.stopWatch': UiTask;
  'tasks.takeBack': UiTask;
  'tasks.wakeNow': UiTask;
  'titleRules.get': UiSealedDocument | null;
  'titleRules.set': void;
  'transcript.context': UiRunContext | null;
  'transcript.events': UiTranscriptEvent[];
  'transcript.output': Envelope | null;
  'transcript.runs': UiTranscriptRun[];
  'ui.version': { api: number; minClient: number; features: UiServerFeature[] };
}

export type UiInput<P extends UiPath> = UiInputs[P];
export type UiOutput<P extends UiPath> = UiOutputs[P];
