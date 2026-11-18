import {useEffect,useRef,useState} from 'react';
import {initialQualificationState,type QualificationGame,type QualificationState,type QualificationBridge} from '../../../../packages/contracts/src/qualification';
export function useQualification(game:QualificationGame,enabled:boolean,bridge:QualificationBridge=window.desktop){
  const [state,setState]=useState<QualificationState>(()=>initialQualificationState(game));
  const lifetime=useRef(0);
  useEffect(()=>{
    lifetime.current++;setState(initialQualificationState(game));if(!enabled)return;let active=true,revision=0;
    const off=bridge.subscribeQualification(value=>{if(active&&value.game===game){revision++;setState(value);}}),at=revision;
    void bridge.getQualification(game).then(value=>{if(active&&at===revision)setState(value);},()=>{if(active&&at===revision)setState({...initialQualificationState(game),availability:'disconnected'});});
    return ()=>{lifetime.current++;active=false;off();};
  },[game,enabled,bridge]);
  const refresh=()=>{const at=lifetime.current;if(enabled)void bridge.refreshQualification(game).then(value=>{if(at===lifetime.current)setState(value);},()=>undefined);};
  return {state,refresh};
}
