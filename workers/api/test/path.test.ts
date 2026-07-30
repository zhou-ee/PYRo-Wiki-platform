import { describe, expect, it } from 'vitest'
import { normalizePathForTest } from '../src/testable'

describe('worker path normalization', () => {
  it('normalizes encoded separators and traversal', () => {
    expect(normalizePathForTest('%2Fdocs%2Fintro.md')).toBe('docs/intro.md')
    expect(normalizePathForTest('docs\\intro.md')).toBe('docs/intro.md')
    expect(normalizePathForTest('../secret.md')).toBe('secret.md')
  })
})
