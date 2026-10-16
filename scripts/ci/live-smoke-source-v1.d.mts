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
  statistics(): LiveSmokeSourceV1Statistics;
}
export function startLiveSmokeSourceV1(checkout: string): Promise<LiveSmokeSourceV1>;
