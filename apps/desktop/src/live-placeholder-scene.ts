/**
 * Geometry of the Live placeholder scene: a schematic isometric tractor-trailer on a road. Pure data, built once at module
 * load, so the renderer only paints it. The scene is split into layers that the page animates with transforms alone:
 * the static ground, the lane dashes and the roadside trees that slide back along the road by one pattern period, the
 * truck body with a small bob, and the wheel rims that spin in the truck's side plane. Themed parts carry a class name
 * (`ph-*`), fixed truck colours an explicit fill.
 */

export interface SvgNode {
  tag: 'g' | 'polygon' | 'rect' | 'circle' | 'line' | 'path' | 'text';
  attrs: Record<string, string | number>;
  children?: SvgNode[];
  text?: string;
}
export interface SceneWheel {
  /** CSS matrix that maps the rim box (`RIM_PX` pixels per world unit, centred on the wheel) into the side plane. */
  transform: string;
  chrome: boolean;
}
type Vec = readonly [number, number];
type Point = readonly [number, number, number];
type Faces = {top: string; side: string; front: string};

/** The stage in CSS pixels; the page centres it and crops the sides on narrow windows. */
export const SCENE_WIDTH = 960, SCENE_HEIGHT = 440;
/** Rim box resolution: pixels per world unit inside one wheel's spinning element. */
export const RIM_PX = 50;
/** Rim radius in world units; the rim element is `2 * RIM_RADIUS * RIM_PX` pixels square. */
export const RIM_RADIUS = 0.42;

const S = 18, C = Math.cos(Math.PI / 6), SN = 0.5;
const OX = 364.6, OY = 188.2;
const round = (n: number) => Math.round(n * 100) / 100;
const project = ([x, y, z]: Point): Vec => [OX + (x - y) * C * S, OY + (x + y) * SN * S - z * S];
const along = (units: number): Vec => [round(units * C * S), round(units * SN * S)];

/** One lane-dash period and one tree-row period, as screen offsets the layers slide by. */
export const LANE_PERIOD = along(4);
export const TREE_PERIOD = along(12);

const points = (list: Point[]) => list.map(p => project(p).map(round).join(',')).join(' ');
const polygon = (list: Point[], paint: string, extra: Record<string, string | number> = {}): SvgNode =>
  ({tag: 'polygon', attrs: {points: points(list), ...paintAttr(paint), ...extra}});
/** A `ph-*` paint is a themed class; anything else is a literal fill. */
const paintAttr = (paint: string): Record<string, string> => paint.startsWith('ph-') ? {className: paint} : {fill: paint};
const matrix = (origin: Point, du: Vec, dv: Vec) => {
  const [e, f] = project(origin);
  return `matrix(${[du[0], du[1], dv[0], dv[1], e, f].map(round).join(' ')})`;
};
/** Plane y = const facing the viewer: u along +x, v down (−z). */
const sidePlane = (origin: Point) => matrix(origin, [C * S, SN * S], [0, S]);
/** Plane x = const (the truck's front): u along +y, v down. */
const frontPlane = (origin: Point) => matrix(origin, [-C * S, SN * S], [0, S]);
/** Plane z = const: u along +x, v along +y. */
const topPlane = (origin: Point) => matrix(origin, [C * S, SN * S], [-C * S, SN * S]);
const group = (transform: string, children: SvgNode[]): SvgNode => ({tag: 'g', attrs: {transform}, children});
const rect = (x: number, y: number, width: number, height: number, paint: string, extra: Record<string, string | number> = {}): SvgNode =>
  ({tag: 'rect', attrs: {x: round(x), y: round(y), width: round(width), height: round(height), ...paintAttr(paint), ...extra}});
const circle = (cx: number, cy: number, r: number, paint: string): SvgNode => ({tag: 'circle', attrs: {cx: round(cx), cy: round(cy), r, ...paintAttr(paint)}});

/** The three visible faces of an axis-aligned box: the +y side, the +x front and the top. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faces: Faces, outlineClass?: string): SvgNode[] {
  // Every themed face is a class; an outline class joins it on the same element.
  const face = (list: Point[], paint: string) => polygon(list, paint, outlineClass ? {className: `${paint} ${outlineClass}`} : {});
  return [
    face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], faces.side),
    face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], faces.front),
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], faces.top)
  ];
}

const STEEL: Faces = {top: '#CBD5E1', side: '#94A3B8', front: '#7C8BA1'};
const DARK: Faces = {top: '#475569', side: '#334155', front: '#1E293B'};
const CAB: Faces = {top: '#7AA5F4', side: '#2563EB', front: '#1E4FC4'};
const TRAILER: Faces = {top: 'ph-trailer-top', side: 'ph-trailer-side', front: 'ph-trailer-front'};
const AMBER: Faces = {top: '#FCD34D', side: '#F59E0B', front: '#D97706'};
const VISOR: Faces = {top: '#1E3A8A', side: '#1E40AF', front: '#1E3A8A'};

/** The road surface, its edge lines and the truck's soft shadow; static. */
export const GROUND: SvgNode[] = [group(topPlane([0, 0, 0]), [
  rect(-40, -5, 95, 9, 'ph-road'), rect(-40, -5.3, 95, 0.3, 'ph-road-edge'), rect(-40, 4, 95, 0.3, 'ph-road-edge'),
  rect(-40, -4.68, 95, 0.16, 'ph-lane'), rect(-40, 3.52, 95, 0.16, 'ph-lane'),
  rect(-0.2, -0.1, 18.6, 3.9, 'ph-shadow-soft', {rx: 0.9}), rect(0.4, 0.25, 17.4, 3.1, 'ph-shadow', {rx: 0.5})
])];

/** The centre lane dashes over two extra periods, so sliding back by one period repeats seamlessly. */
export const LANE: SvgNode[] = [group(topPlane([0, 0, 0]),
  Array.from({length: 26}, (_, i) => rect(-40 + i * 4, -0.73, 2.2, 0.26, 'ph-lane')))];

function tree(x: number, y: number, h: number): SvgNode[] {
  const base = project([x, y, 0]), mid = project([x, y, h * 0.45]), top = project([x, y, h]), r = h * 0.38;
  const left = project([x, y - r, h * 0.45]), right = project([x + r, y, h * 0.45]), front = project([x + r * 0.7, y + r * 0.7, h * 0.45]);
  const pts = (...list: Vec[]) => list.map(p => p.map(round).join(',')).join(' ');
  return [
    {tag: 'line', attrs: {x1: round(base[0]), y1: round(base[1]), x2: round(mid[0]), y2: round(mid[1]), className: 'ph-trunk', strokeWidth: 3, strokeLinecap: 'round'}},
    {tag: 'polygon', attrs: {points: pts(top, left, front), className: 'ph-tree-light'}},
    {tag: 'polygon', attrs: {points: pts(top, front, right), className: 'ph-tree-dark'}}
  ];
}
/** Three rows of trees beyond the far road edge, repeating every tree period. */
export const TREES: SvgNode[] = Array.from({length: 9}, (_, i) => -36 + i * 12)
  .flatMap(x => [...tree(x, -8.4, 3.4), ...tree(x + 6, -11.8, 4.2), ...tree(x + 3, -14.8, 3)]);

function trailer(): SvgNode[] {
  const ribs = Array.from({length: 19}, (_, i) => rect(0.65 * (i + 1), 0.12, 0.05, 3.6, 'ph-rib'));
  const tape = Array.from({length: 25}, (_, i) => rect(0.2 + i * 0.5, 3.62, 0.5, 0.12, i % 2 ? '#FFFFFF' : '#EF4444'));
  const roof = Array.from({length: 9}, (_, i) => rect(1.3 * (i + 1), 0.05, 0.04, 2.9, 'ph-rib'));
  return [
    group(sidePlane([9.6, 2.6, 1.3]), [rect(0, 0, 0.22, 0.95, '#64748B'), rect(-0.1, 0.9, 0.42, 0.1, '#475569'), rect(0.05, 0.15, 0.12, 0.3, '#94A3B8')]),
    ...box(0, 13, 0, 3, 1.35, 5.2, TRAILER, 'ph-trailer-line'),
    group(sidePlane([0, 3, 5.2]), [...ribs, rect(0, 0, 13, 0.14, 'ph-rib'), rect(0.6, 2.85, 11.8, 0.2, '#2563EB'), rect(0.6, 3.12, 11.8, 0.07, '#93B4F5'),
      {tag: 'text', attrs: {x: 0.9, y: 2.45, fontSize: 1.05, fontWeight: 700, fill: '#1D4ED8', letterSpacing: 0.05, className: 'ph-text'}, text: 'YUKON UNION'},
      {tag: 'text', attrs: {x: 0.95, y: 1.25, fontSize: 0.42, fontWeight: 600, fill: '#64748B', letterSpacing: 0.12, className: 'ph-text'}, text: 'TELEMETRY · ETS2 · ATS'},
      ...tape]),
    group(topPlane([0, 0, 5.2]), roof),
    group(frontPlane([13, 0, 5.2]), [rect(0, 0, 0.14, 3.85, 'ph-rib'), rect(2.86, 0, 0.14, 3.85, 'ph-rib'), rect(1, 2.6, 1, 0.5, 'ph-rib', {rx: 0.08})])
  ];
}

function hoses(): SvgNode[] {
  const curve = (y0: number, y1: number, colour: string): SvgNode => {
    const [a, b, c] = [project([13, y0, 3.1]), project([13.6, y1, 2.2]), project([14.05, y0, 3])];
    return {tag: 'path', attrs: {d: `M${round(a[0])} ${round(a[1])} Q${round(b[0])} ${round(b[1])} ${round(c[0])} ${round(c[1])}`, fill: 'none', stroke: colour, strokeWidth: 1.6}};
  };
  return [curve(1.2, 1.4, '#EF4444'), curve(1.8, 1.6, '#3B82F6')];
}

function cab(): SvgNode[] {
  const X0 = 14.05, XF = 17.5, XW = 17.1, ZB = 1, ZW = 3.05, ZR = 4.5;
  const wiper = (y0: number, y1: number): SvgNode => {
    const [a, b] = [project([XF - 0.02, y0, ZW + 0.14]), project([XF - 0.1, y1, ZW + 0.5])];
    return {tag: 'line', attrs: {x1: round(a[0]), y1: round(a[1]), x2: round(b[0]), y2: round(b[1]), stroke: '#1E293B', strokeWidth: 1}};
  };
  const bars = Array.from({length: 6}, (_, i) => rect(0.62, 0.08 + i * 0.18, 1.76, 0.07, '#3B6FE0'));
  const lamp = (x: number): SvgNode[] => [rect(x, 1.2, 0.5, 0.32, '#FEF3C7', {rx: 0.06, stroke: '#94A3B8', strokeWidth: 0.04}), rect(x + 0.05 + (x > 1 ? 0.2 : 0), 1.25, 0.2, 0.22, '#FDE68A', {rx: 0.04})];
  return [
    ...box(13.68, 13.96, 2.56, 2.84, 1.3, 5.55, STEEL), ...box(13.64, 14, 2.52, 2.88, 5.55, 5.65, DARK),
    polygon([[X0, 3, ZB], [XF, 3, ZB], [XF, 3, ZW], [XW, 3, ZR], [X0, 3, ZR]], CAB.side),
    polygon([[XF, 0, ZB], [XF, 3, ZB], [XF, 3, ZW], [XF, 0, ZW]], CAB.front),
    polygon([[XF, 0, ZW], [XF, 3, ZW], [XW, 3, ZR], [XW, 0, ZR]], '#2F64D9'),
    polygon([[X0, 0, ZR], [XW, 0, ZR], [XW, 3, ZR], [X0, 3, ZR]], CAB.top),
    polygon([[XF - 0.03, 0.18, ZW + 0.1], [XF - 0.03, 2.82, ZW + 0.1], [XW + 0.03, 2.82, ZR - 0.12], [XW + 0.03, 0.18, ZR - 0.12]], '#B9CFF7'),
    polygon([[XF - 0.05, 0.9, ZW + 0.1], [XF - 0.05, 1.3, ZW + 0.1], [XW + 0.05, 0.75, ZR - 0.12], [XW + 0.05, 0.35, ZR - 0.12]], 'rgba(255,255,255,.55)'),
    polygon([[XF - 0.03, 1.46, ZW + 0.1], [XF - 0.03, 1.54, ZW + 0.1], [XW + 0.03, 1.54, ZR - 0.12], [XW + 0.03, 1.46, ZR - 0.12]], '#1E4FC4'),
    wiper(0.5, 1.2), wiper(1.9, 2.6),
    // Roof deflector, sun visor and marker lights.
    polygon([[14.1, 2.85, ZR], [16.85, 2.85, ZR], [14.35, 2.85, 5.25], [14.1, 2.85, 5.25]], '#2259D8'),
    polygon([[16.85, 0.15, ZR], [16.85, 2.85, ZR], [14.35, 2.85, 5.25], [14.35, 0.15, 5.25]], '#86AEF5'),
    polygon([[14.1, 0.15, 5.25], [14.35, 0.15, 5.25], [14.35, 2.85, 5.25], [14.1, 2.85, 5.25]], '#9DBDF7'),
    ...box(XW - 0.05, XW + 0.22, 0.05, 2.95, ZR - 0.08, ZR + 0.04, VISOR),
    ...[0.5, 1.1, 1.9, 2.5].flatMap(y => box(XW + 0.02, XW + 0.16, y - 0.09, y + 0.09, ZR + 0.04, ZR + 0.13, AMBER)),
    // Door, side window, stripe and skirt.
    group(sidePlane([X0, 3, ZR]), [
      {tag: 'path', attrs: {d: 'M1.05 0.3 H2.85 L3.0 0.45 V1.45 H1.05 Z', fill: '#B9CFF7'}},
      {tag: 'path', attrs: {d: 'M1.05 0.3 H1.6 L1.05 1.0 Z', fill: 'rgba(255,255,255,.45)'}},
      {tag: 'path', attrs: {d: 'M0.85 0.2 H3.0 V3.3 H0.85 Z', fill: 'none', stroke: '#1D4ED8', strokeWidth: 0.05}},
      rect(2.45, 1.75, 0.32, 0.08, '#DCE7FB', {rx: 0.04}), rect(0, 2, 3.45, 0.09, 'rgba(255,255,255,.85)'),
      rect(0, 3.1, 3.45, 0.4, '#1D4ED8'), rect(3.05, 3.15, 0.25, 0.12, '#F59E0B', {rx: 0.03})
    ]),
    // Grille, emblem and headlights.
    group(frontPlane([XF, 0, ZW - 0.15]), [rect(0.55, 0, 1.9, 1.25, '#163B94', {rx: 0.08}), ...bars, circle(1.5, 0.62, 0.14, '#DCE7FB'), ...lamp(0.1), ...lamp(2.4)]),
    ...box(XF, XF + 0.28, -0.02, 3.02, 0.72, 1.32, STEEL),
    group(frontPlane([XF + 0.28, 0, 1.32]), [rect(0.25, 0.18, 0.35, 0.18, '#FEF3C7', {rx: 0.05}), rect(2.4, 0.18, 0.35, 0.18, '#FEF3C7', {rx: 0.05}),
      rect(1.15, 0.15, 0.7, 0.24, '#FFFFFF', {rx: 0.03, stroke: '#64748B', strokeWidth: 0.03})]),
    // Fuel tank and steps.
    ...box(14.15, 15.35, 2.35, 2.98, 0.55, 1.15, STEEL),
    group(sidePlane([14.15, 2.98, 1.15]), [rect(0, 0.08, 1.2, 0.1, '#E2E8F0'), rect(0.15, 0, 0.08, 0.6, '#64748B'), rect(0.97, 0, 0.08, 0.6, '#64748B')]),
    ...box(15.5, 16.2, 2.75, 3.12, 0.62, 0.7, DARK), ...box(15.5, 16.2, 2.75, 3.12, 0.95, 1.02, DARK),
    // Near mirror.
    ...box(17, 17.15, 3, 3.3, 3.55, 3.6, DARK), ...box(17.05, 17.25, 3.25, 3.45, 2.9, 3.85, DARK),
    polygon([[17.25, 3.27, 2.98], [17.25, 3.43, 2.98], [17.25, 3.43, 3.77], [17.25, 3.27, 3.77]], '#9DB8E8')
  ];
}

const WHEEL_X = [1.8, 3.2, 4.6, 11.6, 13, 16.25] as const, WHEEL_R = 0.65, WHEEL_Y = 3.03;
/** The tyres (with depth layers), mudguards and mudflaps; the rims are separate spinning elements. */
function running(): SvgNode[] {
  const tyre = (x: number): SvgNode[] => [
    ...[2.78, 2.86, 2.94].map(y => group(sidePlane([x, y, WHEEL_R]), [circle(0, 0, WHEEL_R, '#0F172A')])),
    group(sidePlane([x, WHEEL_Y, WHEEL_R]), [circle(0, 0, WHEEL_R, '#1E293B'), {tag: 'circle', attrs: {r: 0.57, fill: 'none', stroke: '#334155', strokeWidth: 0.06}}])
  ];
  return [
    group(sidePlane([6.15, 2.98, 1.35]), [rect(0, 0.25, 3.3, 0.1, '#94A3B8'), rect(0, 0.55, 3.3, 0.1, '#94A3B8'), ...[0.2, 1.6, 3].map(x => rect(x, 0, 0.08, 0.7, '#64748B'))]),
    ...WHEEL_X.flatMap(tyre),
    group(sidePlane([0.95, 3.04, 1.35]), [rect(0, 0, 0.09, 1.2, '#1E293B')]),
    group(sidePlane([0, 3.06, WHEEL_R]), [
      {tag: 'path', attrs: {d: 'M10.8 0 A0.82 0.82 0 0 1 12.44 0', fill: 'none', stroke: '#1E293B', strokeWidth: 0.12}},
      {tag: 'path', attrs: {d: 'M12.18 0 A0.82 0.82 0 0 1 13.82 0', fill: 'none', stroke: '#1E293B', strokeWidth: 0.12}},
      {tag: 'path', attrs: {d: 'M15.4 0 A0.85 0.85 0 0 1 17.1 0', fill: 'none', stroke: '#1D4ED8', strokeWidth: 0.16}},
      rect(10.7, -0.2, 0.09, 0.8, '#1E293B')
    ])
  ];
}

/** The truck body, back to front: far mirror, chassis, trailer, hoses, cab and running gear. */
export const TRUCK: SvgNode[] = [
  ...box(17, 17.15, -0.35, -0.05, 3.55, 3.6, DARK), ...box(17.05, 17.25, -0.45, -0.25, 2.9, 3.85, DARK),
  ...box(0.6, 17.3, 0.45, 2.55, 0.75, 1.3, DARK),
  ...trailer(), ...hoses(), ...cab(), ...running()
];

/** Rim placement: the rim box is centred on the wheel and mapped into the side plane at `RIM_PX` pixels per unit. */
export const WHEELS: SceneWheel[] = WHEEL_X.map(x => {
  const [e, f] = project([x, WHEEL_Y + 0.01, WHEEL_R]);
  return {transform: `matrix(${[C * S / RIM_PX, SN * S / RIM_PX, 0, S / RIM_PX, e, f].map(n => Math.round(n * 1e4) / 1e4).join(',')})`, chrome: x > 10};
});

/** The exhaust stack's top, where the puffs start, in stage pixels. */
const [EXHAUST_X, EXHAUST_Y] = project([13.82, 2.7, 5.7]);
export const EXHAUST: Vec = [round(EXHAUST_X), round(EXHAUST_Y)];
