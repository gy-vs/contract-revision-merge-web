import {
  applyChoices,
  conflictKey,
  threeWayMerge,
  type Conflict,
  type Json,
} from '../shared/merge.js';

export type Side = 'local' | 'remote';

export interface ConflictState {
  baseline: Json; // revision the editor started from
  baselineRevision: number;
  latest: Json; // newest server content
  latestRevision: number;
  expectedVersion: string; // version to retry against
  merged: Json; // auto-merged document with placeholder values
  conflicts: Conflict[];
  choices: Record<string, Side>;
}

// Rebuild the conflict state against a freshly fetched remote document.
// Previous per-path choices are re-applied (sticky resolutions) so the user
// does not have to decide the same field twice when the server moved again.
export function buildConflictState(args: {
  baseline: Json;
  baselineRevision: number;
  latest: Json;
  latestRevision: number;
  latestVersion: string;
  local: Json;
  previousChoices?: Record<string, Side>;
}): ConflictState {
  const {merged, conflicts} = threeWayMerge(args.baseline, args.local, args.latest);
  const choices: Record<string, Side> = {};
  if (args.previousChoices) {
    for (const conflict of conflicts) {
      const previous = args.previousChoices[conflictKey(conflict)];
      if (previous) choices[conflictKey(conflict)] = previous;
    }
  }
  return {
    baseline: args.baseline,
    baselineRevision: args.baselineRevision,
    latest: args.latest,
    latestRevision: args.latestRevision,
    expectedVersion: args.latestVersion,
    merged,
    conflicts,
    choices,
  };
}

export function resolveConflict(state: ConflictState, path: Path, side: Side): ConflictState {
  const target = state.conflicts.find(c => samePath(c.path, path));
  if (!target) return state;
  const choices = {...state.choices, [conflictKey(target)]: side};
  return {...state, choices, merged: applyChoices(state.merged, state.conflicts, choices)};
}

export function unresolvedCount(state: ConflictState): number {
  return state.conflicts.filter(conflict => !state.choices[conflictKey(conflict)]).length;
}

export function resolvedDocument(state: ConflictState): Json {
  return applyChoices(state.merged, state.conflicts, state.choices);
}

type Path = (string | number)[];

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}
