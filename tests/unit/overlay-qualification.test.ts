import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {OverlayContent} from '../../apps/desktop/src/overlay-content';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {staleOverlay} from '../../apps/desktop/src/overlay-sections';
import {sanitizeOverlayQualification} from '../../apps/desktop/src/overlay-qualification';
import type {OverlayPresentation} from '../../packages/contracts/src';
const base:OverlayPresentation={source:'ETS2',origin:'game',status:'connected',speed:'0',fuel:'0',speedUnit:'km/h',fuelUnit:'L',freshness:'current',layout:'strip',paused:false,sections:[],editing:false,hardMode:{state:'active'}};
it.each(['strip','card','cluster','hud'] as const)('REG-009/016 renders independent icon-only Medal cues in %s without controls',layout=>{
  for(const language of ['en','ru'] as const)for(const qualification of ['pass','fail','neutral'] as const){
    const html=renderToStaticMarkup(React.createElement(OverlayContent,{view:overlayView({...base,layout,language,qualification})}));
    expect(html).toContain('lucide-medal');expect(html).toContain(`data-state="${qualification}" role="img"`);expect(html).toContain(language==='ru'?'Предварительная квалификация':'Provisional qualification');expect(html).not.toMatch(/<(?:button|input)|tabindex=/);expect(html).toContain('overlay-hard-mode');
  }
});
it('REG-010/016 retires quiet positive cues and rejects malformed indicators',()=>{
  expect(staleOverlay({...base,qualification:'pass'}).qualification).toBe('neutral');expect(overlayView(base).qualification).toBeUndefined();
  for(const value of [null,{},'accepted',true,1])expect(sanitizeOverlayQualification(value)).toBe('neutral');
});
