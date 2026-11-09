import React, {useEffect, useId, useRef, useState} from 'react';
import type {AppLanguage, OverlaySettings} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {OverlayContent} from './overlay-content';
import {overlayExample, overlayPreviewSize, type ExampleCruiseState} from './overlay-settings-preview-model';
import {overlayView} from './overlay-view';
import {getOverlayLayoutText, getStrings} from './strings';
import './renderer.css';

export function OverlaySettingsPreview({settings, language, scale, cruise = 'active'}: {
  settings: OverlaySettings; language: AppLanguage; scale: number; cruise?: ExampleCruiseState;
}) {
  const strings = getStrings(language), frame = useRef<HTMLDivElement>(null);
  const id = useId(), headingId = `${id}-heading`, cruiseId = `${id}-cruise`, exampleId = `${id}-example`;
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);});
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const view = overlayView(overlayExample(settings, language, cruise)), size = overlayPreviewSize(settings, scale, width);
  // The header reports the example's cruise state even when its overlay section is switched off.
  const cruiseItem = overlayView(overlayExample({...settings, sections: {...settings.sections, 'cruise-control': true}}, language, cruise))
    .items.find(item => item.id === 'cruise-control');
  return <Card size="sm" className="yu-overlay-preview-card" data-testid="overlay-preview-card" role="img" aria-labelledby={`${exampleId} ${headingId} ${cruiseId}`}>
    <CardHeader className="yu-overlay-card-heading"><CardTitle><h3 id={headingId}>{strings.overlayPreviewTitle} · {getOverlayLayoutText(settings.layout, language)}</h3></CardTitle>
      <span id={cruiseId} className="yu-overlay-cruise-badge" data-state={cruise} data-testid="overlay-preview-cruise">{strings.overlayPreviewCruise}: {[cruiseItem?.value, cruiseItem?.unit].filter(Boolean).join(' ')}</span>
    </CardHeader>
    <CardContent><div className="yu-overlay-scene yu-theme-dark" data-testid="overlay-preview-scene">
      <div ref={frame} className="yu-overlay-preview-space" data-layout={settings.layout} aria-hidden="true">
        <div className="yu-overlay-preview-bounds" data-testid="overlay-preview-bounds" style={{width: size.width, height: size.height}}>
          <div className={`overlay overlay-${settings.layout} yu-overlay-example`} data-testid="overlay-preview" data-layout={settings.layout}
            data-scale={scale} style={{width: size.cssWidth, height: size.cssHeight, transform: `scale(${size.factor})`}}>
            <OverlayContent view={view} />
          </div>
        </div>
      </div>
      <p id={exampleId} className="yu-overlay-example-caption">{strings.overlayPreviewExample}</p>
    </div></CardContent>
  </Card>;
}
