interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage = (): MinimalStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readStoredBool(key: string, fallback: boolean, storage: MinimalStorage | null = defaultStorage()): boolean {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredBool(key: string, value: boolean, storage: MinimalStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(key, value ? '1' : '0');
  } catch {
    /* Optional UI preference */
  }
}

export function readStoredStringList(key: string, storage: MinimalStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 160).slice(0, 200);
  } catch {
    return [];
  }
}

export function writeStoredStringList(key: string, values: readonly string[], storage: MinimalStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const unique = [...new Set(values.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 160))].slice(0, 200);
    storage.setItem(key, JSON.stringify(unique));
  } catch {
    /* Optional UI preference */
  }
}

export function readStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  storage: MinimalStorage | null = defaultStorage(),
): T {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredString(key: string, value: string, storage: MinimalStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (typeof value === 'string' && value.length <= 160) storage.setItem(key, value);
  } catch {
    /* Optional UI preference */
  }
}

export function isSubmitShortcut(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  return event.key === 'Enter' && Boolean(event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}

export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"], .ant-select-open, .ant-modal, .ant-drawer')) return true;
  return false;
}

export function clearSearchOnEscape(
  currentValue: string,
  onClear: () => void,
): (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void {
  return event => {
    if (event.key === 'Escape' && currentValue.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      onClear();
    }
  };
}

export type SavedQuickScope = 'all' | 'mine' | 'unclaimed' | 'active' | 'done';

export interface SavedTaskFilterView {
  id: string;
  name: string;
  quickScope: SavedQuickScope;
  query?: string;
  statusFilter?: string;
  jiraTypeFilter?: string;
  jiraStatusFilter?: string;
  jiraVersionFilter?: string;
  viewMode?: 'split' | 'list' | 'board';
}

const ALLOWED_SAVED_SCOPES: readonly SavedQuickScope[] = ['all', 'mine', 'unclaimed', 'active', 'done'];

function savedViewsStorageKey(projectId: string): string {
  return `taskflow.tasks.savedViews.${projectId || 'default'}`;
}

function sanitizeOptionalFilter(val: unknown, maxLen = 80): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed && trimmed.length <= maxLen ? trimmed : undefined;
}

export function readSavedTaskViews(
  projectId: string,
  storage: MinimalStorage | null = defaultStorage(),
): SavedTaskFilterView[] {
  if (!storage || !projectId) return [];
  try {
    const raw = storage.getItem(savedViewsStorageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SavedTaskFilterView[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const id = sanitizeOptionalFilter(obj.id, 64);
      const name = sanitizeOptionalFilter(obj.name, 40);
      const quickScope = typeof obj.quickScope === 'string' && (ALLOWED_SAVED_SCOPES as readonly string[]).includes(obj.quickScope)
        ? (obj.quickScope as SavedQuickScope)
        : 'all';
      if (!id || !name) continue;
      out.push({
        id,
        name,
        quickScope,
        ...(sanitizeOptionalFilter(obj.query) ? { query: sanitizeOptionalFilter(obj.query) } : {}),
        ...(sanitizeOptionalFilter(obj.statusFilter) ? { statusFilter: sanitizeOptionalFilter(obj.statusFilter) } : {}),
        ...(sanitizeOptionalFilter(obj.jiraTypeFilter) ? { jiraTypeFilter: sanitizeOptionalFilter(obj.jiraTypeFilter) } : {}),
        ...(sanitizeOptionalFilter(obj.jiraStatusFilter) ? { jiraStatusFilter: sanitizeOptionalFilter(obj.jiraStatusFilter) } : {}),
        ...(sanitizeOptionalFilter(obj.jiraVersionFilter) ? { jiraVersionFilter: sanitizeOptionalFilter(obj.jiraVersionFilter) } : {}),
        ...(obj.viewMode === 'split' || obj.viewMode === 'list' || obj.viewMode === 'board' ? { viewMode: obj.viewMode } : {}),
      });
      if (out.length >= 12) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function saveTaskFilterView(
  projectId: string,
  draft: Omit<SavedTaskFilterView, 'id'> & { id?: string },
  storage: MinimalStorage | null = defaultStorage(),
): SavedTaskFilterView[] {
  if (!projectId) return [];
  const cleanName = (draft.name || '').trim().slice(0, 40);
  if (!cleanName) return readSavedTaskViews(projectId, storage);

  const existing = readSavedTaskViews(projectId, storage);
  const existingMatch = existing.find(
    v => (draft.id && v.id === draft.id) || v.name.toLowerCase() === cleanName.toLowerCase(),
  );
  const id = existingMatch?.id || draft.id || `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const normalized: SavedTaskFilterView = {
    id,
    name: cleanName,
    quickScope: ALLOWED_SAVED_SCOPES.includes(draft.quickScope) ? draft.quickScope : 'all',
    ...(sanitizeOptionalFilter(draft.query) ? { query: sanitizeOptionalFilter(draft.query) } : {}),
    ...(sanitizeOptionalFilter(draft.statusFilter) ? { statusFilter: sanitizeOptionalFilter(draft.statusFilter) } : {}),
    ...(sanitizeOptionalFilter(draft.jiraTypeFilter) ? { jiraTypeFilter: sanitizeOptionalFilter(draft.jiraTypeFilter) } : {}),
    ...(sanitizeOptionalFilter(draft.jiraStatusFilter) ? { jiraStatusFilter: sanitizeOptionalFilter(draft.jiraStatusFilter) } : {}),
    ...(sanitizeOptionalFilter(draft.jiraVersionFilter) ? { jiraVersionFilter: sanitizeOptionalFilter(draft.jiraVersionFilter) } : {}),
    ...(draft.viewMode === 'split' || draft.viewMode === 'list' || draft.viewMode === 'board' ? { viewMode: draft.viewMode } : {}),
  };

  const next = [normalized, ...existing.filter(v => v.id !== id)].slice(0, 12);
  if (storage) {
    try {
      storage.setItem(savedViewsStorageKey(projectId), JSON.stringify(next));
    } catch {
      /* Optional UI preference */
    }
  }
  return next;
}

export function deleteSavedTaskView(
  projectId: string,
  viewId: string,
  storage: MinimalStorage | null = defaultStorage(),
): SavedTaskFilterView[] {
  if (!projectId) return [];
  const next = readSavedTaskViews(projectId, storage).filter(v => v.id !== viewId);
  if (storage) {
    try {
      storage.setItem(savedViewsStorageKey(projectId), JSON.stringify(next));
    } catch {
      /* Optional UI preference */
    }
  }
  return next;
}

export function isSavedViewActive(
  view: SavedTaskFilterView,
  current: {
    quickScope: SavedQuickScope;
    query?: string;
    statusFilter?: string;
    jiraTypeFilter?: string;
    jiraStatusFilter?: string;
    jiraVersionFilter?: string;
  },
): boolean {
  return (
    view.quickScope === current.quickScope &&
    (view.query || '') === (current.query || '').trim() &&
    (view.statusFilter || '') === (current.statusFilter || '') &&
    (view.jiraTypeFilter || '') === (current.jiraTypeFilter || '') &&
    (view.jiraStatusFilter || '') === (current.jiraStatusFilter || '') &&
    (view.jiraVersionFilter || '') === (current.jiraVersionFilter || '')
  );
}
