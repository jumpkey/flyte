export interface SortState { key: string; dir: 'ASC' | 'DESC'; }

/** Validate a client sort request against an allowlist of keys. */
export function resolveSort(rawSort: string | undefined, rawDir: string | undefined, allowedKeys: string[], defaultKey: string): SortState {
  const key = rawSort && allowedKeys.includes(rawSort) ? rawSort : defaultKey;
  const dir: 'ASC' | 'DESC' = String(rawDir ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return { key, dir };
}
