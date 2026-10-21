import React, {Fragment, useEffect, useMemo, useState} from 'react';
import type {OverlayPresentation} from '../../../packages/contracts/src';
import {SectionIcon, TagIcon} from './overlay-icons';
import {STRIP_ITEM_MAX_WIDTH_CSS, STRIP_TAG_MAX_WIDTH_CSS} from './overlay-strip';
import {overlayView, overlayCardParts, type OverlayItem, type OverlayTag, type OverlayView} from './overlay-view';
import {latencyBits, MARKER_CELL, MARKER_HEIGHT} from './latency-marker';
import './renderer.css';

// Display-only overlay (ET-008, layouts ET-012a). It renders main's formatted projection and holds no source, window,
// file or settings authority. Every layout has its own minimal CSS in renderer.css; no Tailwind or shadcn styles. The edit
// mode (ET-012b) only adds an outline and a drag region; it shows no hint text and has no controls.

/** Ring geometry of the cluster's RPM gauge in SVG user units. */
const RING_RADIUS = 40, RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function Value({item}: {item: OverlayItem}) {
  return <span className="overlay-value-group">
    <strong className="overlay-value" data-testid={item.testId}>{item.value}</strong>
    {item.unit ? <span className="overlay-unit" data-testid={`${item.testId}-unit`}>{item.unit}</span> : null}
    {item.detail ? <span className="overlay-detail" data-testid={item.detailTestId}>{item.detail}</span> : null}
    {item.caption ? <span className="overlay-caption">{item.caption}</span> : null}
  </span>;
}
/** `maxWidth` (strip only) caps each tag at the width the strip reserves for it. */
function Tags({tags, maxWidth}: {tags: OverlayTag[]; maxWidth?: number}) {
  return <>{tags.map(tag => <span key={tag.id} className={`overlay-tag overlay-tag-${tag.id}`} data-testid={tag.testId}
    style={maxWidth === undefined ? undefined : {maxWidth}}><TagIcon id={tag.id} />{tag.text}</span>)}</>;
}

/**
 * 38 px rows (ET-012c): tags, then the groups' items with icons, wrapped whole onto as many rows as the window reserves
 * for the enabled sections. The first item of each later group draws a thin divider before itself, so an item that
 * starts a row keeps its divider. Every item is capped at the maximum width main reserved for it (overlay-strip.ts); a
 * longer value ends in an ellipsis, so every enabled section stays inside the window.
 */
function Strip({view}: {view: OverlayView}) {
  return <div className="overlay-surface overlay-strip-row">
    <Tags tags={view.tags} maxWidth={STRIP_TAG_MAX_WIDTH_CSS} />
    {view.groups.map((group, index) => <Fragment key={group.id}>
      {group.items.map((item, position) => <span key={item.id} className={index > 0 && position === 0 ? 'overlay-item overlay-group-start' : 'overlay-item'}
        data-testid={`overlay-section-${item.id}`} aria-label={item.short} style={{maxWidth: STRIP_ITEM_MAX_WIDTH_CSS[item.id]}}>
        <SectionIcon id={item.id} /><Value item={item} />
      </span>)}
    </Fragment>)}
  </div>;
}

/**
 * Header with the game and tags, then one labelled row per section. Every row and the header have a fixed height
 * (ET-012d), and main reserves the window's height for the enabled sections (overlay-rows.ts), so every section stays
 * inside the window; a longer value ends in an ellipsis.
 */
function CardLayout({view}: {view: OverlayView}) {
  const parts = overlayCardParts(view);
  return <div className="overlay-surface overlay-card-body">
    <header className="overlay-card-header"><span className="overlay-source">{view.source}</span><Tags tags={view.tags} /></header>
    {parts.hero.length ? <div className="overlay-card-hero" data-count={parts.hero.length} data-speed={String(parts.hero.some(item => item.id === 'speed'))} data-testid="overlay-card-hero" style={{height: parts.heroHeight}}>
      {parts.hero.map(item => <div className={`overlay-card-${item.id}`} key={item.id} data-testid={`overlay-section-${item.id}`} aria-label={item.label}><Value item={item} /></div>)}
    </div> : null}
    <dl className="overlay-rows">
      {parts.rows.map(item => <div key={item.id} className="overlay-row" data-testid={`overlay-section-${item.id}`}>
        <dt><SectionIcon id={item.id} size={14} />{item.label}</dt><dd><Value item={item} /></dd>
      </div>)}
    </dl>
  </div>;
}

/**
 * A round speed gauge with the RPM ring and a gear badge, and the remaining sections in a side panel of fixed-height
 * rows that takes its content height (ET-012d); main reserves the window's height for the panel's rows.
 */
function Cluster({view}: {view: OverlayView}) {
  const gauge = view.gauge, ring = gauge?.rpm?.ring ?? 0;
  return <div className="overlay-cluster-body">
    {gauge ? <div className="overlay-gauge">
      <svg className="overlay-ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        {gauge.speed ? <circle className="overlay-ring-track overlay-speed-track" data-testid="overlay-speed-track" cx="60" cy="60" r="52" /> : null}
        {gauge.rpm ? <circle className="overlay-ring-track overlay-rpm-track" cx="60" cy="60" r={RING_RADIUS} /> : null}
        {/* No arc without a current reading or at 0 rpm: a round line cap would otherwise draw a dot. */}
        {ring > 0 ? <circle className="overlay-ring-value" data-testid="overlay-rpm-arc" cx="60" cy="60" r={RING_RADIUS} transform="rotate(-90 60 60)"
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

/**
 * Shadowed text lines without a background, each of a fixed height (ET-012d). The tag row's height is reserved even
 * while no tag shows, so a tag that appears never pushes a line out of the window.
 */
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
    {live?.diagnosticFrame !== undefined ? <div aria-hidden="true" data-testid="latency-marker" style={{position: 'fixed', left: 0, top: 0,
      width: MARKER_CELL * 32, height: MARKER_HEIGHT, display: 'flex', opacity: 1, pointerEvents: 'none', zIndex: 2147483647}}>
      {latencyBits(live.diagnosticFrame).map((bit, index) => <span key={index} style={{display: 'block', flex: 'none', width: MARKER_CELL,
        height: MARKER_HEIGHT, background: bit ? '#fff' : '#000'}} />)}
    </div> : null}
    {view.layout === 'card' ? <CardLayout view={view} /> : view.layout === 'cluster' ? <Cluster view={view} /> : view.layout === 'hud' ? <Hud view={view} /> : <Strip view={view} />}
  </main>;
}
