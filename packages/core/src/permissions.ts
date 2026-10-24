import type { Role } from './types';

/** Every privileged capability in the app. The server checks these on every request. */
export type Permission =
  | 'league.view'
  | 'league.edit_settings'
  | 'league.edit_scoring'
  | 'league.manage_members'
  | 'league.assign_co_commissioner'
  | 'league.delete'
  | 'team.manage_own'
  | 'team.manage_any'          // emergency roster corrections
  | 'trade.propose'
  | 'trade.review'             // approve / veto when commissioner review applies
  | 'trade.vote'
  | 'waiver.claim'
  | 'waiver.process_now'
  | 'draft.pick_own'
  | 'draft.control'            // start, pause, resume, undo, pick for others
  | 'scores.recalculate'
  | 'chat.post'
  | 'chat.moderate'
  | 'announce';

const MANAGER: Permission[] = ['league.view', 'team.manage_own', 'trade.propose', 'trade.vote', 'waiver.claim', 'draft.pick_own', 'chat.post'];
const CO: Permission[] = [...MANAGER, 'league.edit_settings', 'league.manage_members', 'team.manage_any', 'trade.review', 'waiver.process_now', 'draft.control', 'chat.moderate', 'announce'];
const COMMISH: Permission[] = [...CO, 'league.edit_scoring', 'league.assign_co_commissioner', 'league.delete', 'scores.recalculate'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  commissioner: new Set(COMMISH),
  co_commissioner: new Set(CO),
  manager: new Set(MANAGER),
  observer: new Set<Permission>(['league.view']),
};

export function can(role: Role | null | undefined, p: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].has(p);
}

export const ROLE_LABELS: Record<Role, string> = {
  commissioner: 'Commissioner',
  co_commissioner: 'Co-commissioner',
  manager: 'Manager',
  observer: 'Observer (read-only)',
};
