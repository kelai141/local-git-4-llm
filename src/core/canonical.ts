import { createHash } from 'node:crypto'
import type { JsonValue } from './types.js'

/** Reject JSON-adjacent values that would make a repository hash ambiguous. */
export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

/** Serialize a lossless JSON value with stable key order for content addressing. */
export function canonicalJson(value: unknown): string {
  return stringify(value, new Set<object>())
}

/** SHA-256 identifier for a canonical JSON payload. */
export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** Create an immutable-by-convention JSON clone at the persistence boundary. */
export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

function stringify(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('repository values must not contain non-finite numbers')
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'object':
      break
    default:
      throw new CanonicalJsonError(`repository values must be JSON; received ${typeof value}`)
  }

  if (seen.has(value)) throw new CanonicalJsonError('repository values must not contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => stringify(item, seen)).join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('repository values must use plain JSON objects')
    }

    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stringify(object[key], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}
