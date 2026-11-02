// Hand-written amendments to the frozen replay expectations: a corroborated checkpoint now re-establishes tracking
// after its replayed gap closes the earlier recording. Original fixture bytes and their original raw facts stay intact.
export function continuationExpected<T extends {trips:unknown[];intervals:unknown[];view?:unknown}>(id:string,expected:T,currentSnapshots=false):T {
  const current=currentSnapshots && id==='app-absent-hydration',timers=currentSnapshots && id==='timers-truck-refuel-trip';
  if(!current && !timers && id!=='reconnect-lost-ack' && id!=='crash-before-commit')return expected;
  const next=timers?'7':current?'5':id==='reconnect-lost-ack'?'5':'4',trip=`attach@${next}`,started=timers?1_800_000_000_500:current?1_800_000_000_150:id==='reconnect-lost-ack'?1_800_000_000_060:1_800_000_000_040;
  const absent={available:false,reason:'not-observed'},missing={state:'missing',reason:'not-observed'};
  const raw={trip,jobConfigurationEventSeq:null,truckConfigurationEventSeq:null,trailerConfigurationEventSeqs:[],openedEventSeq:null,
    gameMode:{mode:'unknown',method:'none',confidence:'none'},gameModeAmbiguous:false,outcome:'open',outcomeEventSeq:null,closeReason:null,
    recordingCompleteness:'partial',startedUtcMs:started,endedUtcMs:null,observedDistanceM:absent,fuelUsedL:absent};
  const view=expected.view as {lastClosed:unknown}|undefined;
  return {...expected,trips:[...expected.trips,raw],intervals:[...expected.intervals,
    {trip,kind:'not-connected',detail:{cause:'late-attach',source:'checkpoint',nextEventSeq:next}},
    {trip,kind:'discontinuity',detail:{cause:timers?'discontinuity':'gap',continuationOf:timers?'trip@3':current?'attach@4':'trip@1',decision:'not-merged',source:'checkpoint',nextEventSeq:next}}],
    ...(view?{view:{phase:current?'awaiting-outcome':'active',untrackedJob:false,current:{trip,recordingCompleteness:'partial',observedDistanceM:missing,fuelUsedL:missing,refuelledL:0,refuels:0},lastClosed:view.lastClosed}}:{})};
}
