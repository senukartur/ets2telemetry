export interface LiveSmokeSourceV1Statistics {
  connections: number; frames: number; probes: number; activeClients: number; held: boolean; stopped: boolean;
  origin: 'synthetic'; history: false;
  identity: {game: 'ets2' | 'ats'; pluginSessionId: string; processInstanceId: string; processId: number; windowsSessionId: number; origin: 'synthetic'; clockId: string};
}
export interface LiveSmokeSourceV1 {
  endpoint: string;
  stop(): Promise<void>;
  /** Stops sending snapshots on the open connection until `resume`. */
  hold(): void;
  resume(): void;
  /** ET-050b: the v1 truck's model id for the following state messages; undefined restores the fixture's own id. */
  setTruckId(id: string | undefined): void;
  /** ET-052: the next mandatory break of the following state messages, a wire measure of unit min; undefined restores 95 minutes. */
  setBreak(measure: {available: true; value: number; unit: 'min'} | {available: false; reason: string; unit: 'min'} | undefined): void;
  statistics(): LiveSmokeSourceV1Statistics;
}
export function startLiveSmokeSourceV1(checkout: string): Promise<LiveSmokeSourceV1>;
