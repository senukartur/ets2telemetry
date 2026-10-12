import path from 'node:path';
import type {SourceSelection} from '../../../packages/contracts/src';
import {validateCaptureGrant} from './capture-activation';
import {CaptureSession, NativeCaptureClient, type CaptureSessionOptions} from './capture-session';
import type {CaptureManifest} from './capture-writer';
import type {BrokerConfiguration} from './native-pipe-client';
import {dataPaths} from './paths';

export interface CaptureSessionLike {readonly captureSessionId: string; readonly done: Promise<CaptureManifest | undefined>; start(): Promise<void>; stop(): Promise<CaptureManifest | undefined>}
export interface CaptureControllerOptions {
  log: (event: string, detail?: unknown) => void;
  localAppData: string | undefined;
  /** Code/platform identity for the manifest; resolved once per capture. */
  identity: (broker: BrokerConfiguration) => Promise<{code: Record<string, string | null>; platform: Record<string, string | number | null>}>;
  createSession?: (options: CaptureSessionOptions) => CaptureSessionLike;
}
/**
 * Service-side owner of the one opt-in capture interval per service lifetime. It never throws into
 * source selection, never feeds live state and has no history or acknowledgement path.
 */
export class CaptureController {
  private session?: Promise<CaptureSessionLike | undefined>;
  constructor(private readonly options: CaptureControllerOptions) {}
  /** Returns true when this grant started the capture; every rejection is logged instead of thrown. */
  offer(rawGrant: unknown, selection: SourceSelection, broker: BrokerConfiguration | undefined): boolean {
    try {
      const grant = validateCaptureGrant(rawGrant), localAppData = this.options.localAppData;
      if (this.session) throw new Error('Capture already used for this service lifetime');
      if (!broker || (selection !== 'ets2' && selection !== 'ats') || !localAppData || !path.isAbsolute(localAppData)) throw new Error('Capture prerequisites unavailable');
      const game = selection, create = this.options.createSession ?? (options => new CaptureSession(options));
      this.session = (async () => {
        const identity = await this.options.identity(broker);
        const session = create({root: dataPaths(localAppData).captures, game, connect: () => new NativeCaptureClient(broker, game), context: {
          activation: {mechanism: 'environment', deadlineMs: grant.deadlineMs, operatorLabel: grant.operatorLabel}, displays: grant.displays, ...identity}});
        await session.start(); this.options.log('CAPTURE_STARTED', {captureSessionId: session.captureSessionId});
        void session.done.then(manifest => this.options.log('CAPTURE_CLOSED', {status: manifest?.status ?? null, reason: manifest?.stop.reason ?? null, manifestWriteError: manifest?.manifestWriteError ?? null}),
          error => this.options.log('CAPTURE_FAILED', String(error)));
        return session;
      })().catch(error => { this.options.log('CAPTURE_FAILED', String(error)); return undefined; });
      return true;
    } catch (error) { this.options.log('CAPTURE_REJECTED', String(error)); return false; }
  }
  /** Bounded by the writer's close; never rejects. */
  async stop(): Promise<void> {
    try { const session = await this.session; await session?.stop(); }
    catch (error) { this.options.log('CAPTURE_STOP_FAILED', String(error)); }
  }
}
