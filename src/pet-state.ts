import type { Rect } from './window-state';

export type PetEdge = 'left' | 'right' | 'top' | 'bottom';
export interface PetOptions {
  petEnabled: boolean; petColor: string; petSize: number; petEyeSize: number;
  petGaze: number; petLife: number; petWidth: number; petViscosity: number;
  petDistance: number; petMotion: 'lively' | 'sticky' | 'crisp';
}
export const petDefaults: PetOptions = {
  petEnabled: true, petColor: '#000000', petSize: 82, petEyeSize: 140,
  petGaze: 24, petLife: 1.2, petWidth: 248, petViscosity: 1,
  petDistance: 52, petMotion: 'sticky'
};
export const petRanges = { petSize: [60, 100], petEyeSize: [70, 140], petGaze: [12, 32],
  petLife: [.5, 1.8], petWidth: [200, 320], petViscosity: [.35, 1], petDistance: [20, 100] } as const;
export const petFields = Object.keys(petDefaults) as (keyof PetOptions)[];
export function validPetField(key: keyof PetOptions, value: unknown): boolean {
  if (key === 'petEnabled') return typeof value === 'boolean';
  if (key === 'petColor') return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  if (key === 'petMotion') return ['lively', 'sticky', 'crisp'].includes(value as string);
  const range = petRanges[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1];
}
export function petOptions(settings: Partial<PetOptions>): PetOptions {
  const result = { ...petDefaults };
  for (const key of petFields) if (validPetField(key, settings[key])) Object.assign(result, { [key]: settings[key] });
  return result;
}
export interface PetPosition { x: number; y: number; side: PetEdge | null; displayId?: number }
export interface DesktopArea extends Rect { id: number }
export interface DesktopScene {
  bounds: Rect; areas: DesktopArea[]; position: PetPosition; options: PetOptions;
  mode: 'expanded' | 'collapsed' | 'hidden';
}
export function isPetPosition(value: unknown): value is PetPosition {
  if (!value || typeof value !== 'object') return false;
  const p = value as PetPosition;
  return Number.isFinite(p.x) && Number.isFinite(p.y) &&
    (p.side === null || ['left', 'right', 'top', 'bottom'].includes(p.side)) &&
    (p.displayId === undefined || Number.isFinite(p.displayId));
}
export function desktopBounds(areas: DesktopArea[]): Rect {
  if (!areas.length) throw new Error('No display work areas');
  const x = Math.min(...areas.map(a => a.x)), y = Math.min(...areas.map(a => a.y));
  return { x, y, width: Math.max(...areas.map(a => a.x + a.width)) - x, height: Math.max(...areas.map(a => a.y + a.height)) - y };
}
export function placePet(position: PetPosition, areas: DesktopArea[], size: number): PetPosition {
  const distance = (a: Rect): number => Math.hypot(Math.max(a.x - position.x, 0, position.x - a.x - a.width), Math.max(a.y - position.y, 0, position.y - a.y - a.height));
  const area = areas.find(a => a.id === position.displayId) || [...areas].sort((a, b) => distance(a) - distance(b))[0]!;
  const r = 49 * size / 100, normal = r * .85, margin = r * 1.18 + 3;
  const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, max));
  const side = position.side;
  return { x: side === 'left' ? area.x + normal : side === 'right' ? area.x + area.width - normal : clamp(position.x, area.x + margin, area.x + area.width - margin),
    y: side === 'top' ? area.y + normal : side === 'bottom' ? area.y + area.height - normal : clamp(position.y, area.y + margin, area.y + area.height - margin), side, displayId: area.id };
}
export function shapeRegions(value: unknown, bounds: Rect): Rect[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('Invalid shape');
  return value.map((r: Rect) => {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw new Error('Invalid region');
    const x = Math.max(0, Math.min(bounds.width - 1, Math.floor(r.x))), y = Math.max(0, Math.min(bounds.height - 1, Math.floor(r.y)));
    return { x, y, width: Math.max(1, Math.min(bounds.width - x, Math.ceil(r.x + r.width) - x)), height: Math.max(1, Math.min(bounds.height - y, Math.ceil(r.y + r.height) - y)) };
  });
}
