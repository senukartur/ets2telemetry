import {initialDashboardUploadStatus, isDashboardToken, type DashboardUploadBridge, type DashboardUploadError, type DashboardUploadStatus} from '../../../../packages/contracts/src/dashboard-upload';

export type UploadUiPhase = 'idle' | 'verifying' | 'confirming' | 'cancelling' | 'cancel-failed' | 'disconnecting';
export interface UploadUiState {status: DashboardUploadStatus | null; phase: UploadUiPhase; error: DashboardUploadError | 'INVALID_TOKEN' | null; abandoned: boolean}
/** Dashboard-lifetime coordinator. No token is retained in its state or exposed to subscribers. */
export class DashboardUploadUiController {
  #state: UploadUiState = {status: null, phase: 'idle', error: null, abandoned: false};
  #listeners = new Set<() => void>();
  #unsubscribe: (() => void) | undefined;
  #revision = 0; #operation = 0; #lifetime = 0; #active = false;
  #cancelId: string | undefined;
  constructor(private readonly bridge: DashboardUploadBridge) {}
  getSnapshot = (): UploadUiState => this.#state;
  subscribe = (listener: () => void) => {this.#listeners.add(listener); return () => {this.#listeners.delete(listener);};};
  #set(change: Partial<UploadUiState>) {this.#state = {...this.#state, ...change}; for (const listener of this.#listeners) listener();}
  start() {
    if (this.#unsubscribe) return;
    const lifetime = ++this.#lifetime;
    this.#unsubscribe = this.bridge.subscribeDashboardUpload(status => {
      if (lifetime !== this.#lifetime) return;
      this.#revision++;
      if (this.#state.phase === 'cancel-failed' && !status.candidateId && ['connected', 'paused', 'disconnected', 'unavailable'].includes(status.state)) {
        this.#cancelId = undefined; this.#set({status, phase: 'idle', abandoned: false, error: null});
      } else this.#set({status});
    });
    const revision = this.#revision;
    void this.bridge.getDashboardUploadContext().then(status => {
      if (lifetime === this.#lifetime && revision === this.#revision) this.#set({status});
    }, () => {if (lifetime === this.#lifetime && revision === this.#revision) this.#set({error: 'RETIRED'});});
  }
  stop() {this.#unsubscribe?.(); this.#unsubscribe = undefined; this.#lifetime++; this.#operation++;}
  setAccountActive(active: boolean) {
    this.#active = active;
    if (active) return;
    if (this.#state.phase === 'verifying') this.#set({abandoned: true});
    else if (this.#state.phase === 'idle' && this.#state.status?.candidateId) void this.cancel();
  }
  async verify(token: string): Promise<boolean> {
    if (this.#state.phase !== 'idle' || this.#state.status?.candidateId || !this.#state.status?.origin || !['disconnected', 'connected', 'paused'].includes(this.#state.status.state)) return false;
    if (!isDashboardToken(token)) {this.#set({error: 'INVALID_TOKEN'}); return false;}
    const operation = ++this.#operation, revision = ++this.#revision;
    this.#set({phase: 'verifying', error: null, abandoned: !this.#active});
    try {
      const status = await this.bridge.verifyDashboardUploadToken(token);
      if (operation !== this.#operation) return true;
      if (revision === this.#revision) this.#set({status});
      if (status.candidateId && (this.#state.abandoned || !this.#active)) {
        await this.#cancelCandidate(status.candidateId, operation);
      } else this.#set({phase: 'idle', error: revision === this.#revision ? status.error : null, abandoned: false});
    } catch {if (operation === this.#operation) this.#set({phase: 'idle', error: revision === this.#revision ? 'RETIRED' : null, abandoned: false});}
    return true;
  }
  async #cancelCandidate(candidateId: string, operation: number) {
    this.#cancelId = candidateId;
    const revision = ++this.#revision;
    this.#set({phase: 'cancelling', error: null, abandoned: true});
    try {
      const status = await this.bridge.cancelDashboardUpload(candidateId);
      if (operation !== this.#operation) return;
      if (revision === this.#revision) this.#set({status});
      if (!status.candidateId) this.#cancelId = undefined;
      this.#set({phase: status.candidateId ? 'cancel-failed' : 'idle', error: revision === this.#revision ? status.error : null, abandoned: !!status.candidateId});
    } catch {if (operation === this.#operation) this.#set({phase: 'cancel-failed', error: 'RETIRED'});}
  }
  async cancel() {
    if (this.#state.phase === 'verifying') {this.#set({abandoned: true}); return;}
    if (!['idle', 'cancel-failed'].includes(this.#state.phase)) return;
    const id = this.#cancelId ?? this.#state.status?.candidateId;
    if (id) await this.#cancelCandidate(id, ++this.#operation);
  }
  async confirm() {
    const id = this.#state.status?.candidateId;
    if (!id || this.#state.phase !== 'idle' || this.#state.abandoned) return;
    await this.#action('confirming', () => this.bridge.confirmDashboardUpload(id));
  }
  async disconnect() {
    if (this.#state.phase !== 'idle' || this.#state.status?.candidateId || !this.#state.status?.owner) return;
    await this.#action('disconnecting', () => this.bridge.disconnectDashboardUpload());
  }
  async #action(phase: UploadUiPhase, call: () => Promise<DashboardUploadStatus>) {
    const operation = ++this.#operation, revision = ++this.#revision;
    this.#set({phase, error: null});
    try {
      const status = await call();
      if (operation !== this.#operation) return;
      if (revision === this.#revision) this.#set({status});
      this.#set({phase: 'idle', error: revision === this.#revision ? status.error : null});
    } catch {if (operation === this.#operation) this.#set({phase: 'idle', error: revision === this.#revision ? 'RETIRED' : null});}
  }
}

export const unavailableUploadUi = (): UploadUiState => ({status: initialDashboardUploadStatus(null), phase: 'idle', error: null, abandoned: false});
