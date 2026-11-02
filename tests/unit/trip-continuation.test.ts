import {describe, expect, it} from 'vitest';
import {compatibleContinuation, continuationFingerprint, learnContinuationConstraints, matchContinuation} from '../../packages/telemetry-core/src/trips/continuation';
import {job, otherJob} from '../shared/trip-messages';
import {ETS2_A,r,Script,run,sessionInput} from '../shared/trip-messages';
import {initialTripState,normalizeV1State,dueAttach,stepTrip,type TripInput} from '../../packages/telemetry-core/src';

describe('REG-003/004/008 continuation evidence', () => {
  it('retains learned optional evidence through unavailable members and rejects later conflicts',()=>{
    const absent=job({plannedDistance:{available:false,reason:'not-observed',unit:'m'}});
    const known=learnContinuationConstraints({},job({plannedDistance:{available:true,value:100,unit:'m'}}))!;
    expect(learnContinuationConstraints(learnContinuationConstraints(known,absent)!,job({plannedDistance:{available:true,value:200,unit:'m'}}))).toBeNull();
    expect(learnContinuationConstraints(learnContinuationConstraints({},absent)!,job({plannedDistance:{available:true,value:100,unit:'m'}}))).toEqual(known);
  });
  it('continues a localized offer and cargo pickup without changing stream identity', () => {
    const a = job(), b = job({cargo: {available: true, value: 'Localized cargo'}, cargoLoaded: {available: true, value: false}});
    expect(compatibleContinuation(a, b)).toBe(true);
    expect(continuationFingerprint(a)).toBe(continuationFingerprint(b));
  });
  it('requires every mandatory canonical signal, including exact money and deadline', () => {
    expect(continuationFingerprint(job({cargoId: {available: false, reason: 'not-observed'}}))).toBeNull();
    expect(compatibleContinuation(job(), otherJob())).toBe(false);
    expect(compatibleContinuation(job(), job({plannedDistance: {available: true, value: 123, unit: 'm'}}))).toBe(false);
  });
  it('vetoes absent/different profile, different game, ambiguity and observed terminal outcomes', () => {
    const a = {profile: 'verified-profile-a', game: 'ets2', job: job(), eligible: true};
    expect(matchContinuation([a], 'ets2', a.profile, job())).toBe(a);
    for (const profile of [null, 'other']) expect(matchContinuation([a], 'ets2', profile, job())).toBeNull();
    expect(matchContinuation([a], 'ats', a.profile, job())).toBeNull();
    expect(matchContinuation([a, {...a}], 'ets2', a.profile, job())).toBeNull();
    expect(matchContinuation([{...a, eligible: false}], 'ets2', a.profile, job())).toBeNull();
  });
  it('closes the old recording before attaching an identical job on a newly verified profile',()=>{
    const script=new Script(ETS2_A),initial=run(initialTripState(),[sessionInput(script.welcome()),script.event(r.jobConfigured())]);
    const checkpoint=script.checkpoint(job()),hydrated=run(initial.state,[{kind:'checkpoint',message:checkpoint}]);
    const read=(scope:string,ns:string):TripInput=>({kind:'reading',currentJob:job(),profileScope:scope,sample:{source:checkpoint.source,
      capture:{...checkpoint.capture,monotonicNs:ns},state:normalizeV1State(checkpoint.data.state,checkpoint.data.status)}});
    const before=run(hydrated.state,[read('a'.repeat(64),'1000000000000')]);
    const changed=run(before.state,[read('b'.repeat(64),'1001000000000')]);
    expect(dueAttach(changed.state)).toMatchObject({pluginSessionId:ETS2_A,nextEventSeq:'2',profileChange:true});
    const attached=stepTrip(changed.state,{kind:'attach',receivedUtcMs:2000});expect(attached.ok).toBe(true);
    if(attached.ok)expect(attached.effects).toContainEqual(expect.objectContaining({kind:'trip.close',outcome:'none',closeReason:'different-job'}));
  });
});
