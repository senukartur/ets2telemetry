import React, {Fragment, useEffect, useMemo, useState} from 'react';
import type {OverlayPresentation} from '../../../packages/contracts/src';
import {SectionIcon, TagIcon} from './overlay-icons';
import {overlayView, type OverlayItem, type OverlayTag, type OverlayView} from './overlay-view';
import './renderer.css';

// Display-only overlay (ET-008, layouts ET-012a). It renders main's formatted projection and holds no source, window,
// file or settings authority. Every layout has its own minimal CSS in renderer.css; no Tailwind or shadcn styles. The edit
// mode (ET-012b) only adds an outline and a drag region; it shows no hint text and has no controls.

/** Ring geometry of the cluster's RPM gauge in SVG user units. */
const RING_RADIUS = 52, RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function Value({item}: {item: OverlayItem}) {
  return <span className="overlay-value-group">
    <strong className="overlay-value" data-testid={item.testId}>{item.value}</strong>
    {item.unit ? <span className="overlay-unit" data-testid={`${item.testId}-unit`}>{item.unit}</span> : null}
    {item.detail ? <span className="overlay-detail" data-testid={item.detailTestId}>{item.detail}</span> : null}
    {item.caption ? <span className="overlay-caption">{item.caption}</span> : null}
  </span>;
}
function Tags({tags}: {tags: OverlayTag[]}) {
  return <>{tags.map(tag => <span key={tag.id} className={`overlay-tag overlay-tag-${tag.id}`} data-testid={tag.testId}><TagIcon id={tag.id} />{tag.text}</span>)}</>;
}

/**
 * One 38 px row: tags, then the groups' items with icons. The first item of each later group draws a thin divider
 * before itself, so an item that does not fit drops onto the clipped second line together with its divider.
 */
function Strip({view}: {view: OverlayView}) {
  return <div className="overlay-surface overlay-strip-row">
    <Tags tags={view.tags} />
    {view.groups.map((group, index) => <Fragment key={group.id}>
      {group.items.map((item, position) => <span key={item.id} className={index > 0 && position === 0 ? 'overlay-item overlay-group-start' : 'overlay-item'}
        data-testid={`overlay-section-${item.id}`} aria-label={item.short}>
        <SectionIcon id={item.id} /><Value item={item} />
      </span>)}
    </Fragment>)}
  </div>;
}

/** Header with the game and tags, then one labelled row per section. */
function CardLayout({view}: {view: OverlayView}) {
  return <div className="overlay-surface overlay-card-body">
    <header className="overlay-card-header"><span className="overlay-source">{view.source}</span><Tags tags={view.tags} /></header>
    <dl className="overlay-rows">
      {view.items.map(item => <div key={item.id} className="overlay-row" data-testid={`overlay-section-${item.id}`}>
        <dt><SectionIcon id={item.id} size={14} />{item.label}</dt><dd><Value item={item} /></dd>
      </div>)}
    </dl>
  </div>;
}

/** A round speed gauge with the RPM ring and a gear badge, and the remaining sections in a side panel. */
function Cluster({view}: {view: OverlayView}) {
  const gauge = view.gauge, ring = gauge?.rpm?.ring ?? 0;
  return <div className="overlay-cluster-body">
    {gauge ? <div className="overlay-gauge">
      <svg className="overlay-ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <circle className="overlay-ring-track" cx="60" cy="60" r={RING_RADIUS} />
        {/* No arc without a current reading or at 0 rpm: a round line cap would otherwise draw a dot. */}
        {ring > 0 ? <circle className="overlay-ring-value" cx="60" cy="60" r={RING_RADIUS} transform="rotate(-90 60 60)"
          strokeDasharray={`${ring * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`} /> : null}
      </svg>
      <div className="overlay-gauge-centre">
        {gauge.speed ? <div className="overlay-gauge-speed" data-testid="overlay-section-speed"><Value item={gauge.speed} /></div> : null}
        {gauge.gear ? <div className="overlay-gauge-gear" data-testid="overlay-section-gear" aria-label={gauge.gear.short}><Value item={gauge.gear} /></div> : null}
        {gauge.rpm ? <div className="overlay-gauge-rpm" data-testid="overlay-section-rpm" aria-label={gauge.rpm.short}><Value item={gauge.rpm} /></div> : null}
      </div>
    </div> : null}
    <div className="overlay-surface overlay-panel">
      <div className="overlay-panel-tags"><span className="overlay-source">{view.source}</span><Tags tags={view.tags} /></div>
      {view.panel.map(item => <div key={item.id} className="overlay-panel-row" data-testid={`overlay-section-${item.id}`}>
        <span className="overlay-label"><SectionIcon id={item.id} size={14} />{item.short}</span><Value item={item} />
      </div>)}
    </div>
  </div>;
}

/** Shadowed text lines without a background. */
function Hud({view}: {view: OverlayView}) {
  return <div className="overlay-hud-lines">
    {view.tags.length ? <div className="overlay-hud-tags"><Tags tags={view.tags} /></div> : null}
    {view.items.map(item => <div key={item.id} className="overlay-hud-line" data-testid={`overlay-section-${item.id}`}>
      <SectionIcon id={item.id} size={14} /><span className="overlay-label">{item.short}</span><Value item={item} />
    </div>)}
  </div>;
}

export default function Overlay() {
  const [live, setLive] = useState<OverlayPresentation>();
  useEffect(() => window.overlay.subscribeOverlay(setLive), []);
  const view = useMemo(() => overlayView(live), [live]);
  // While editing (ET-012b) the whole root is a native drag region; main alone makes the window movable and interactive.
  return <main data-testid="overlay-root" className={`overlay overlay-${view.layout}${view.dim ? ' is-dim' : ''}${view.editing ? ' is-editing' : ''}`} aria-label="Telemetry overlay"
    data-layout={view.layout} data-source={view.source} data-origin={view.origin} data-status={view.status} data-freshness={view.freshness}
    data-paused={String(view.paused)} data-editing={String(view.editing)}>
    {view.layout === 'card' ? <CardLayout view={view} /> : view.layout === 'cluster' ? <Cluster view={view} /> : view.layout === 'hud' ? <Hud view={view} /> : <Strip view={view} />}
  </main>;
}
