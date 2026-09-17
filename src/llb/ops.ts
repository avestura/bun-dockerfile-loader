/**
 * TypeScript mirrors of `solver/pb/ops.proto`, with encoders that reproduce
 * Go's deterministic proto3 output byte for byte.
 */
import { Writer } from "./protobuf.ts";

// --- Enums ------------------------------------------------------------------

export const NetMode = { UNSET: 0, HOST: 1, NONE: 2 } as const;
export type NetMode = (typeof NetMode)[keyof typeof NetMode];

export const SecurityMode = { SANDBOX: 0, INSECURE: 1 } as const;
export type SecurityMode = (typeof SecurityMode)[keyof typeof SecurityMode];

export const MountType = { BIND: 0, SECRET: 1, SSH: 2, CACHE: 3, TMPFS: 4 } as const;
export type MountType = (typeof MountType)[keyof typeof MountType];

export const MountContentCache = { DEFAULT: 0, ON: 1, OFF: 2 } as const;
export type MountContentCache = (typeof MountContentCache)[keyof typeof MountContentCache];

export const CacheSharingOpt = { SHARED: 0, PRIVATE: 1, LOCKED: 2 } as const;
export type CacheSharingOpt = (typeof CacheSharingOpt)[keyof typeof CacheSharingOpt];

/** Sentinels from `solver/pb/const.go`. */
export const SKIP_OUTPUT = -1;
export const EMPTY_INPUT = -1;
export const ROOT_MOUNT = "/";

// --- Messages ---------------------------------------------------------------

export interface Platform {
  Architecture: string;
  OS: string;
  Variant?: string;
  OSVersion?: string;
  OSFeatures?: string[];
}

export interface Input {
  digest: string;
  index: number;
}

export interface HostIP {
  Host: string;
  IP: string;
}

export interface Ulimit {
  Name: string;
  Soft: number;
  Hard: number;
}

export interface ProxyEnv {
  http_proxy?: string;
  https_proxy?: string;
  ftp_proxy?: string;
  no_proxy?: string;
  all_proxy?: string;
}

export interface Meta {
  args: string[];
  env: string[];
  cwd: string;
  user?: string;
  proxy_env?: ProxyEnv;
  extraHosts?: HostIP[];
  hostname?: string;
  ulimit?: Ulimit[];
  cgroupParent?: string;
  removeMountStubsRecursive?: boolean;
  validExitCodes?: number[];
}

export interface TmpfsOpt {
  size: number;
}

export interface CacheOpt {
  ID: string;
  sharing: CacheSharingOpt;
}

export interface SecretOpt {
  ID: string;
  uid?: number;
  gid?: number;
  mode?: number;
  optional?: boolean;
}

export interface SSHOpt {
  ID: string;
  uid?: number;
  gid?: number;
  mode?: number;
  optional?: boolean;
}

export interface Mount {
  input: number;
  selector?: string;
  dest: string;
  output: number;
  readonly?: boolean;
  mountType: MountType;
  TmpfsOpt?: TmpfsOpt;
  cacheOpt?: CacheOpt;
  secretOpt?: SecretOpt;
  SSHOpt?: SSHOpt;
  resultID?: string;
  contentCache?: MountContentCache;
}

export interface SecretEnv {
  ID: string;
  name: string;
  optional?: boolean;
}

export interface CDIDevice {
  name: string;
  optional?: boolean;
}

export interface ExecOp {
  meta: Meta;
  mounts: Mount[];
  network?: NetMode;
  security?: SecurityMode;
  secretenv?: SecretEnv[];
  cdiDevices?: CDIDevice[];
}

export interface SourceOp {
  identifier: string;
  attrs?: Record<string, string>;
}

export interface UserOpt {
  byName?: { name: string; input: number };
  byID?: number;
}

export interface ChownOpt {
  user?: UserOpt;
  group?: UserOpt;
}

export interface FileActionCopy {
  src: string;
  dest: string;
  owner?: ChownOpt;
  mode?: number;
  followSymlink?: boolean;
  dirCopyContents?: boolean;
  attemptUnpackDockerCompatibility?: boolean;
  createDestPath?: boolean;
  allowWildcard?: boolean;
  allowEmptyWildcard?: boolean;
  timestamp?: number;
  include_patterns?: string[];
  exclude_patterns?: string[];
  alwaysReplaceExistingDestPaths?: boolean;
  modeStr?: string;
  required_paths?: string[];
}

export interface FileActionMkFile {
  path: string;
  mode: number;
  data?: Uint8Array;
  owner?: ChownOpt;
  timestamp?: number;
}

export interface FileActionMkDir {
  path: string;
  mode: number;
  makeParents?: boolean;
  owner?: ChownOpt;
  timestamp?: number;
}

export interface FileActionRm {
  path: string;
  allowNotFound?: boolean;
  allowWildcard?: boolean;
}

export interface FileActionSymlink {
  oldpath: string;
  newpath: string;
  owner?: ChownOpt;
  timestamp?: number;
}

export interface FileAction {
  input: number;
  secondaryInput: number;
  output: number;
  copy?: FileActionCopy;
  mkfile?: FileActionMkFile;
  mkdir?: FileActionMkDir;
  rm?: FileActionRm;
  symlink?: FileActionSymlink;
}

export interface FileOp {
  actions: FileAction[];
}

export interface MergeOp {
  inputs: { input: number }[];
}

export interface DiffOp {
  lower?: { input: number };
  upper?: { input: number };
}

export interface WorkerConstraints {
  filter?: string[];
}

export interface Op {
  inputs: Input[];
  exec?: ExecOp;
  source?: SourceOp;
  file?: FileOp;
  merge?: MergeOp;
  diff?: DiffOp;
  platform?: Platform;
  constraints?: WorkerConstraints;
}

export interface ExportCache {
  Value: boolean;
}

export interface ProgressGroup {
  id: string;
  name?: string;
  weak?: boolean;
}

export interface LinuxResources {
  memory?: number;
  memorySwap?: number;
  cpuShares?: number;
  cpuPeriod?: number;
  cpuQuota?: number;
  cpusetCpus?: string;
  cpusetMems?: string;
}

export interface OpMetadata {
  ignore_cache?: boolean;
  description?: Record<string, string>;
  export_cache?: ExportCache;
  caps?: Record<string, boolean>;
  progress_group?: ProgressGroup;
  linux_resources?: LinuxResources;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  sourceIndex: number;
  ranges: Range[];
}

export interface Locations {
  locations: Location[];
}

export interface SourceInfo {
  filename: string;
  data?: Uint8Array;
  definition?: Definition;
  language?: string;
}

export interface Source {
  locations: Record<string, Locations>;
  infos: SourceInfo[];
}

export interface Definition {
  def: Uint8Array[];
  metadata: Record<string, OpMetadata>;
  Source?: Source;
}

// --- Encoders ---------------------------------------------------------------

export function encodePlatform(w: Writer, p: Platform) {
  w.stringField(1, p.Architecture);
  w.stringField(2, p.OS);
  w.stringField(3, p.Variant ?? "");
  w.stringField(4, p.OSVersion ?? "");
  w.repeatedString(5, p.OSFeatures ?? []);
}

export function encodeInput(w: Writer, i: Input) {
  w.stringField(1, i.digest);
  w.varintField(2, i.index);
}

function encodeProxyEnv(w: Writer, p: ProxyEnv) {
  w.stringField(1, p.http_proxy ?? "");
  w.stringField(2, p.https_proxy ?? "");
  w.stringField(3, p.ftp_proxy ?? "");
  w.stringField(4, p.no_proxy ?? "");
  w.stringField(5, p.all_proxy ?? "");
}

export function encodeMeta(w: Writer, m: Meta) {
  w.repeatedString(1, m.args);
  w.repeatedString(2, m.env);
  w.stringField(3, m.cwd);
  w.stringField(4, m.user ?? "");
  if (m.proxy_env) w.messageField(5, (sub) => encodeProxyEnv(sub, m.proxy_env!));
  w.repeatedMessage(6, m.extraHosts ?? [], (sub, h) => {
    sub.stringField(1, h.Host);
    sub.stringField(2, h.IP);
  });
  w.stringField(7, m.hostname ?? "");
  w.repeatedMessage(9, m.ulimit ?? [], (sub, u) => {
    sub.stringField(1, u.Name);
    sub.varintField(2, u.Soft);
    sub.varintField(3, u.Hard);
  });
  w.stringField(10, m.cgroupParent ?? "");
  w.boolField(11, m.removeMountStubsRecursive ?? false);
  w.repeatedVarint(12, m.validExitCodes ?? []);
}

export function encodeMount(w: Writer, m: Mount) {
  w.varintField(1, m.input);
  w.stringField(2, m.selector ?? "");
  w.stringField(3, m.dest);
  w.varintField(4, m.output);
  w.boolField(5, m.readonly ?? false);
  w.varintField(6, m.mountType);
  if (m.TmpfsOpt) w.messageField(19, (sub) => sub.varintField(1, m.TmpfsOpt!.size));
  if (m.cacheOpt) {
    w.messageField(20, (sub) => {
      sub.stringField(1, m.cacheOpt!.ID);
      sub.varintField(2, m.cacheOpt!.sharing);
    });
  }
  if (m.secretOpt) {
    w.messageField(21, (sub) => {
      sub.stringField(1, m.secretOpt!.ID);
      sub.varintField(2, m.secretOpt!.uid ?? 0);
      sub.varintField(3, m.secretOpt!.gid ?? 0);
      sub.varintField(4, m.secretOpt!.mode ?? 0);
      sub.boolField(5, m.secretOpt!.optional ?? false);
    });
  }
  if (m.SSHOpt) {
    w.messageField(22, (sub) => {
      sub.stringField(1, m.SSHOpt!.ID);
      sub.varintField(2, m.SSHOpt!.uid ?? 0);
      sub.varintField(3, m.SSHOpt!.gid ?? 0);
      sub.varintField(4, m.SSHOpt!.mode ?? 0);
      sub.boolField(5, m.SSHOpt!.optional ?? false);
    });
  }
  w.stringField(23, m.resultID ?? "");
  w.varintField(24, m.contentCache ?? 0);
}

export function encodeExecOp(w: Writer, e: ExecOp) {
  w.messageField(1, (sub) => encodeMeta(sub, e.meta));
  w.repeatedMessage(2, e.mounts, encodeMount);
  w.varintField(3, e.network ?? 0);
  w.varintField(4, e.security ?? 0);
  w.repeatedMessage(5, e.secretenv ?? [], (sub, s) => {
    sub.stringField(1, s.ID);
    sub.stringField(2, s.name);
    sub.boolField(3, s.optional ?? false);
  });
  w.repeatedMessage(6, e.cdiDevices ?? [], (sub, d) => {
    sub.stringField(1, d.name);
    sub.boolField(2, d.optional ?? false);
  });
}

export function encodeSourceOp(w: Writer, s: SourceOp) {
  w.stringField(1, s.identifier);
  w.mapField(2, s.attrs ?? {}, (sub, v) => sub.stringField(2, v, { always: true }));
}

function encodeUserOpt(w: Writer, u: UserOpt) {
  if (u.byName) {
    w.messageField(1, (sub) => {
      sub.stringField(1, u.byName!.name);
      sub.varintField(2, u.byName!.input);
    });
  } else if (u.byID !== undefined) {
    w.varintField(2, u.byID);
  }
}

function encodeChownOpt(w: Writer, c: ChownOpt) {
  if (c.user) w.messageField(1, (sub) => encodeUserOpt(sub, c.user!));
  if (c.group) w.messageField(2, (sub) => encodeUserOpt(sub, c.group!));
}

export function encodeFileAction(w: Writer, a: FileAction) {
  w.varintField(1, a.input);
  w.varintField(2, a.secondaryInput);
  w.varintField(3, a.output);
  if (a.copy) {
    const c = a.copy;
    w.messageField(4, (sub) => {
      sub.stringField(1, c.src);
      sub.stringField(2, c.dest);
      if (c.owner) sub.messageField(3, (s2) => encodeChownOpt(s2, c.owner!));
      sub.varintField(4, c.mode ?? 0);
      sub.boolField(5, c.followSymlink ?? false);
      sub.boolField(6, c.dirCopyContents ?? false);
      sub.boolField(7, c.attemptUnpackDockerCompatibility ?? false);
      sub.boolField(8, c.createDestPath ?? false);
      sub.boolField(9, c.allowWildcard ?? false);
      sub.boolField(10, c.allowEmptyWildcard ?? false);
      sub.varintField(11, c.timestamp ?? 0);
      sub.repeatedString(12, c.include_patterns ?? []);
      sub.repeatedString(13, c.exclude_patterns ?? []);
      sub.boolField(14, c.alwaysReplaceExistingDestPaths ?? false);
      sub.stringField(15, c.modeStr ?? "");
      sub.repeatedString(16, c.required_paths ?? []);
    });
  } else if (a.mkfile) {
    const f = a.mkfile;
    w.messageField(5, (sub) => {
      sub.stringField(1, f.path);
      sub.varintField(2, f.mode);
      sub.bytesField(3, f.data ?? new Uint8Array());
      if (f.owner) sub.messageField(4, (s2) => encodeChownOpt(s2, f.owner!));
      sub.varintField(5, f.timestamp ?? 0);
    });
  } else if (a.mkdir) {
    const d = a.mkdir;
    w.messageField(6, (sub) => {
      sub.stringField(1, d.path);
      sub.varintField(2, d.mode);
      sub.boolField(3, d.makeParents ?? false);
      if (d.owner) sub.messageField(4, (s2) => encodeChownOpt(s2, d.owner!));
      sub.varintField(5, d.timestamp ?? 0);
    });
  } else if (a.rm) {
    const r = a.rm;
    w.messageField(7, (sub) => {
      sub.stringField(1, r.path);
      sub.boolField(2, r.allowNotFound ?? false);
      sub.boolField(3, r.allowWildcard ?? false);
    });
  } else if (a.symlink) {
    const s = a.symlink;
    w.messageField(8, (sub) => {
      sub.stringField(1, s.oldpath);
      sub.stringField(2, s.newpath);
      if (s.owner) sub.messageField(3, (s2) => encodeChownOpt(s2, s.owner!));
      sub.varintField(4, s.timestamp ?? 0);
    });
  }
}

/**
 * Encodes an `Op`.
 *
 * Go's protobuf runtime sorts non-oneof fields before oneof fields "to
 * preserve compatibility with historic wire output" (`order.LegacyFieldOrder`),
 * so `platform` (10) and `constraints` (11) are written *before* the `op`
 * oneof member (2-8). Getting this wrong changes every vertex digest.
 */
export function encodeOp(w: Writer, op: Op) {
  w.repeatedMessage(1, op.inputs, encodeInput);
  if (op.platform) w.messageField(10, (sub) => encodePlatform(sub, op.platform!));
  if (op.constraints) w.messageField(11, (sub) => sub.repeatedString(1, op.constraints!.filter ?? []));

  if (op.exec) w.messageField(2, (sub) => encodeExecOp(sub, op.exec!));
  if (op.source) w.messageField(3, (sub) => encodeSourceOp(sub, op.source!));
  if (op.file) w.messageField(4, (sub) => sub.repeatedMessage(2, op.file!.actions, encodeFileAction));
  if (op.merge) {
    w.messageField(6, (sub) =>
      sub.repeatedMessage(1, op.merge!.inputs, (s2, i) => s2.varintField(1, i.input)),
    );
  }
  if (op.diff) {
    w.messageField(7, (sub) => {
      if (op.diff!.lower) sub.messageField(1, (s2) => s2.varintField(1, op.diff!.lower!.input));
      if (op.diff!.upper) sub.messageField(2, (s2) => s2.varintField(1, op.diff!.upper!.input));
    });
  }
}

export function encodeOpMetadata(w: Writer, m: OpMetadata) {
  w.boolField(1, m.ignore_cache ?? false);
  w.mapField(2, m.description ?? {}, (sub, v) => sub.stringField(2, v, { always: true }));
  if (m.export_cache) w.messageField(4, (sub) => sub.boolField(1, m.export_cache!.Value));
  w.mapField(5, m.caps ?? {}, (sub, v) => sub.boolField(2, v, { always: true }));
  if (m.progress_group) {
    w.messageField(6, (sub) => {
      sub.stringField(1, m.progress_group!.id);
      sub.stringField(2, m.progress_group!.name ?? "");
      sub.boolField(3, m.progress_group!.weak ?? false);
    });
  }
  if (m.linux_resources) {
    const r = m.linux_resources;
    w.messageField(7, (sub) => {
      sub.varintField(1, r.memory ?? 0);
      sub.varintField(2, r.memorySwap ?? 0);
      sub.varintField(3, r.cpuShares ?? 0);
      sub.varintField(4, r.cpuPeriod ?? 0);
      sub.varintField(5, r.cpuQuota ?? 0);
      sub.stringField(6, r.cpusetCpus ?? "");
      sub.stringField(7, r.cpusetMems ?? "");
    });
  }
}

function encodeSource(w: Writer, s: Source) {
  w.mapField(1, s.locations, (sub, v) => {
    sub.messageField(2, (s2) => {
      s2.repeatedMessage(1, v.locations, (s3, loc) => {
        s3.varintField(1, loc.sourceIndex);
        s3.repeatedMessage(2, loc.ranges, (s4, r) => {
          s4.messageField(1, (s5) => {
            s5.varintField(1, r.start.line);
            s5.varintField(2, r.start.character);
          });
          s4.messageField(2, (s5) => {
            s5.varintField(1, r.end.line);
            s5.varintField(2, r.end.character);
          });
        });
      });
    });
  });
  w.repeatedMessage(2, s.infos, (sub, info) => {
    sub.stringField(1, info.filename);
    sub.bytesField(2, info.data ?? new Uint8Array());
    if (info.definition) sub.messageField(3, (s2) => encodeDefinitionInto(s2, info.definition!));
    sub.stringField(4, info.language ?? "");
  });
}

function encodeDefinitionInto(w: Writer, d: Definition) {
  for (const dt of d.def) w.bytesField(1, dt, { always: true });
  w.mapField(2, d.metadata, (sub, v) => sub.messageField(2, (s2) => encodeOpMetadata(s2, v)));
  if (d.Source) w.messageField(3, (sub) => encodeSource(sub, d.Source!));
}

/** Serializes a `Definition` to the bytes `buildctl build` reads on stdin. */
export function encodeDefinition(d: Definition): Uint8Array {
  const w = new Writer();
  encodeDefinitionInto(w, d);
  return w.finish();
}

/** Serializes a single `Op`; the SHA-256 of this is the vertex digest. */
export function marshalOp(op: Op): Uint8Array {
  const w = new Writer();
  encodeOp(w, op);
  return w.finish();
}
