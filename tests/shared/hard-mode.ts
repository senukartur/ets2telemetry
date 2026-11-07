// Independent compliant fixture from the owner-approved Hard Mode settings, not generated from evaluator metadata.
export const HARD_MODE_CONFIG = `uset g_fuel_simulation "1"
uset g_hardcore_simulation "1"
uset g_police "1"
uset g_fatigue "1"
uset g_use_speed_limiter "1"
uset g_truck_stability "0.25"
uset g_trailer_stability "0.25"
uset g_simple_parking_doubles "1"
uset g_parking_difficulty "2"
uset g_bad_weather_factor "0.12"
uset g_road_events "0.30"
uset g_brake_intensity "0.75"
uset g_traffic "1.0"`;

/** Independent expected audit for a newly recorded trip with no supplied verification observations. */
export function unobservedHardModeAudit(atUtcMs: number): import('../../packages/contracts/src/hard-mode').HardModeDetailsV2 {
  const assessment: import('../../packages/contracts/src/hard-mode').HardModeAssessment = {observedUtcMs:atUtcMs,state:'unknown',source:'unknown',
    rules: ['fuel','air','police','fatigue','limiter','truck','trailer','parking','rain','events','braking','traffic'].map(id=>({
      id:id as import('../../packages/contracts/src/hard-mode').HardModeRuleId,state:'unknown',values:id==='parking'?[null,null]:[null],reason:'historical'}))};
  return {version:2,binding:null,opening:assessment,latest:structuredClone(assessment),firstLoss:null,manualDelivery:null,
    passingChecks:0,failingChecks:0,unknownChecks:0,checkpoint:null,firstDiagnostic:null,latestDiagnostic:null};
}
