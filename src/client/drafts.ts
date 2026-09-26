import type {Json} from '../shared/merge.js';
import type {Side} from './conflict.js';

// Unresolved local drafts survive a page reload. Each draft keeps the baseline
// document the editing session started from, so after reloading we fetch the
// newest server revision and re-run the three-way merge to re-confirm.

export interface StoredDraft {
  contractId: string;
  text: string; // raw editor text, may be invalid JSON
  baseline: Json;
  baselineRevision: number;
  savedAt: number;
}

export interface StoredChoices {
  [conflictKey: string]: Side;
}

const DRAFT_PREFIX = 'contract-studio:draft:';
const CHOICES_PREFIX = 'contract-studio:choices:';

export interface DraftStore {
  loadDraft(contractId: string): StoredDraft | null;
  saveDraft(draft: StoredDraft): void;
  clearDraft(contractId: string): void;
  loadChoices(contractId: string): Record<string, Side>;
  saveChoices(contractId: string, choices: Record<string, Side>): void;
  clearChoices(contractId: string): void;
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createDraftStore(storage: Storage = window.localStorage): DraftStore {
  return {
    loadDraft(contractId) {
      const draft = safeParse(storage.getItem(DRAFT_PREFIX + contractId));
      if (!draft || typeof draft !== 'object') return null;
      const value = draft as Partial<StoredDraft>;
      if (value.contractId !== contractId || typeof value.text !== 'string' || value.baseline == null) {
        return null;
      }
      return value as StoredDraft;
    },
    saveDraft(draft) {
      storage.setItem(DRAFT_PREFIX + draft.contractId, JSON.stringify(draft));
    },
    clearDraft(contractId) {
      storage.removeItem(DRAFT_PREFIX + contractId);
    },
    loadChoices(contractId) {
      const parsed = safeParse(storage.getItem(CHOICES_PREFIX + contractId));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Side>) : {};
    },
    saveChoices(contractId, choices) {
      storage.setItem(CHOICES_PREFIX + contractId, JSON.stringify(choices));
    },
    clearChoices(contractId) {
      storage.removeItem(CHOICES_PREFIX + contractId);
    },
  };
}
