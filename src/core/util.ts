/** Deep copy that also works on immer drafts (structuredClone rejects proxies). */
export function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Structural equality that short-circuits on shared subtrees (as immer leaves them); undefined-valued keys count as absent. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined)
  const ka = keys(a)
  return ka.length === keys(b).length && ka.every((k) => structurallyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
