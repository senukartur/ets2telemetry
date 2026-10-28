import path from 'node:path';
import type {ChannelIdentity} from '../channel';
import {ISOLATION_VARIABLES} from '../plugin-setup/mode';
import type {UninstallRoots} from '../uninstall/roots';
import {GITHUB_ORIGINS, type FeedOrigins} from './update-feed';
import {UPDATE_PUBLIC_KEYS, type UpdatePublicKey} from './update-keys';
import {isRawPublicKey} from './update-manifest';

// Whether this launch checks for updates, and against which feed and keys (ET-055 UP6, UP7, UP19). A pure decision from
// the packaged flag, the uninstall roots derived from the running executable (ET-018 U3) and the launch environment:
//
// | Launch | Result |
// | --- | --- |
// | Unpackaged | unsupported (`unpackaged`) |
// | Packaged without a Squirrel install layout (portable, refused roots) | unsupported (`not-installed`) |
// | Production install with an isolation variable (profile, diagnostic, live smoke or source override) | unsupported (`isolated`) |
// | Production install otherwise | GitHub, the compiled keys of this build's channel |
// | Test-root install (U3 marker and test file) with an isolated profile inside the test root, a loopback feed origin and a test key | that origin, only that key |
// | Test-root install otherwise | unsupported (`isolated`) |
//
// The loopback origin and the test key are read only in the test-root mode; a production or staging install ignores the
// variables, so no environment can point a real installation at another feed or key.

/** Test-root mode only: `http://127.0.0.1:<port>`, which then serves both the web and the REST paths of the feed. */
export const TEST_FEED_ORIGIN_VARIABLE = 'ETS2TELEMETRY_UPDATE_TEST_FEED';
/** Test-root mode only: the base64 raw Ed25519 public key that alone verifies manifests, as key id `test`. */
export const TEST_PUBLIC_KEY_VARIABLE = 'ETS2TELEMETRY_UPDATE_TEST_PUBLIC_KEY';
export const TEST_KEY_ID = 'test';
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

export interface UpdateContext {
  /** Squirrel's install root, holding Update.exe. */
  readonly installRoot: string;
  /** The data root beside it; the download goes to its `updates` folder. */
  readonly dataRoot: string;
  /** The running executable's file name, for `Update.exe --processStartAndWait`. */
  readonly executableName: string;
  readonly origins: FeedOrigins;
  readonly keys: readonly UpdatePublicKey[];
  readonly mode: 'production' | 'test-root';
}
export type UpdateUnsupported = 'unpackaged' | 'not-installed' | 'isolated';
export type UpdateContextResult = {readonly ok: true; readonly context: UpdateContext} | {readonly ok: false; readonly reason: UpdateUnsupported};

const set = (value: string | undefined): value is string => typeof value === 'string' && value !== '';
const normal = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();

export interface UpdateContextInput {
  readonly packaged: boolean;
  readonly roots: UninstallRoots;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly identity: ChannelIdentity;
}

/** See the table in the file comment. */
export function resolveUpdateContext(input: UpdateContextInput): UpdateContextResult {
  if (!input.packaged) return {ok: false, reason: 'unpackaged'};
  const {roots, env} = input;
  if (!roots.ok) return {ok: false, reason: 'not-installed'};
  const common = {installRoot: roots.installRoot, dataRoot: roots.dataRoot, executableName: path.win32.basename(input.executable)};
  if (roots.mode === 'production') {
    if (ISOLATION_VARIABLES.some(name => set(env[name]))) return {ok: false, reason: 'isolated'};
    return {ok: true, context: {...common, origins: GITHUB_ORIGINS, keys: UPDATE_PUBLIC_KEYS[input.identity.channel], mode: 'production'}};
  }
  const profile = env.ETS2TELEMETRY_PROFILE_DIR, origin = env[TEST_FEED_ORIGIN_VARIABLE], key = env[TEST_PUBLIC_KEY_VARIABLE];
  const inside = set(profile) && path.win32.isAbsolute(profile) && normal(profile).startsWith(`${normal(roots.testRoot)}\\`);
  const port = set(origin) ? LOOPBACK_ORIGIN.exec(origin)?.[1] : undefined;
  if (!inside || port === undefined || Number(port) < 1 || Number(port) > 65535 || !isRawPublicKey(key)) return {ok: false, reason: 'isolated'};
  return {ok: true, context: {...common, origins: {web: origin!, api: origin!}, keys: [{keyId: TEST_KEY_ID, publicKey: key}], mode: 'test-root'}};
}
