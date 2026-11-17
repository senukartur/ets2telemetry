import React from 'react';
import {EXHAUST, GROUND, LANE, LANE_PERIOD, RIM_PX, RIM_RADIUS, SCENE_HEIGHT, SCENE_WIDTH, TREE_PERIOD, TREES, TRUCK, WHEELS, type SvgNode} from './live-placeholder-scene';

function draw(nodes: SvgNode[]): React.ReactNode[] {
  return nodes.map((node, index) => React.createElement(node.tag, {key: index, ...node.attrs}, node.children ? draw(node.children) : node.text));
}
const layer = (nodes: SvgNode[]) => <svg className="yu-ph-svg" width={SCENE_WIDTH} height={SCENE_HEIGHT} viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} focusable="false">{draw(nodes)}</svg>;

const RIM_BOX = 2 * RIM_RADIUS * RIM_PX;
const NUTS = Array.from({length: 6}, (_, i) => [Math.cos(i * Math.PI / 3) * 0.2, Math.sin(i * Math.PI / 3) * 0.2] as const);
/** One wheel rim in world units around the wheel centre; the element around it spins. */
function Rim({chrome}: {chrome: boolean}) {
  return <svg width={RIM_BOX} height={RIM_BOX} viewBox={`${-RIM_RADIUS} ${-RIM_RADIUS} ${2 * RIM_RADIUS} ${2 * RIM_RADIUS}`} focusable="false">
    <circle r={0.4} fill={chrome ? '#E2E8F0' : '#B8C3D3'} /><circle r={0.34} fill={chrome ? '#CBD5E1' : '#94A3B8'} />
    <rect x={-0.025} y={-0.34} width={0.05} height={0.14} fill="#64748B" /><rect x={-0.025} y={0.2} width={0.05} height={0.14} fill="#64748B" />
    {NUTS.map(([cx, cy]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={0.035} fill="#475569" />)}
    <circle r={0.11} fill="#64748B" /><circle r={0.05} fill={chrome ? '#F8FAFC' : '#CBD5E1'} />
  </svg>;
}

// The pattern periods the moving layers slide by, so the CSS keyframes stay in step with the scene geometry.
const STAGE_STYLE = {'--yu-ph-lane-x': `${-LANE_PERIOD[0]}px`, '--yu-ph-lane-y': `${-LANE_PERIOD[1]}px`,
  '--yu-ph-trees-x': `${-TREE_PERIOD[0]}px`, '--yu-ph-trees-y': `${-TREE_PERIOD[1]}px`} as React.CSSProperties;
const PUFF_STYLE = {left: EXHAUST[0], top: EXHAUST[1]};
const RIM_STYLE = {left: -RIM_BOX / 2, top: -RIM_BOX / 2, width: RIM_BOX, height: RIM_BOX};

/**
 * The Live page while the game sends no current data: a schematic truck driving down a road and one line of text. It
 * never shows connection details or timers, so it stays the same while a game loads, pauses or reconnects. Each moving
 * part is its own layer animated only by transform and opacity; the static parts paint once.
 */
export function LivePlaceholder({caption}: {caption: string}) {
  return <section className="yu-live-placeholder" data-testid="live.placeholder" aria-labelledby="live-placeholder-caption">
    <div className="yu-ph-stage" style={STAGE_STYLE} aria-hidden="true">
      {layer(GROUND)}
      <div className="yu-ph-layer yu-ph-lane">{layer(LANE)}</div>
      <div className="yu-ph-layer yu-ph-trees">{layer(TREES)}</div>
      <div className="yu-ph-layer yu-ph-truck">{layer(TRUCK)}
        {WHEELS.map(wheel => <div key={wheel.transform} className="yu-ph-wheel" style={{transform: wheel.transform}}><div className="yu-ph-rim" style={RIM_STYLE}><Rim chrome={wheel.chrome} /></div></div>)}
        <span className="yu-ph-puff" style={PUFF_STYLE} /><span className="yu-ph-puff yu-ph-puff-late" style={PUFF_STYLE} />
      </div>
    </div>
    <p id="live-placeholder-caption" className="yu-ph-caption" data-testid="live.placeholder.caption">{caption}</p>
  </section>;
}
