import { describe, expect, it } from 'vitest'
import { decideRevisionWrite, isRevisionConstraintError } from '../src/testable'

describe('D1 revision write decisions', () => {
  it('accepts the initial write at revision zero', () => {
    expect(decideRevisionWrite(0, 0)).toEqual({ kind: 'write', nextRevision: 1 })
  })

  it('advances exactly one revision for a matching base', () => {
    expect(decideRevisionWrite(7, 7)).toEqual({ kind: 'write', nextRevision: 8 })
  })

  it('returns a conflict for a stale base revision', () => {
    expect(decideRevisionWrite(8, 7)).toEqual({ kind: 'conflict' })
  })

  it('classifies concurrent revision uniqueness errors as conflicts', () => {
    expect(isRevisionConstraintError(new Error('UNIQUE constraint failed: revisions.document_id, revisions.revision'))).toBe(true)
    expect(isRevisionConstraintError(new Error('UNIQUE constraint failed: users.name'))).toBe(false)
  })

  it('rejects invalid revision numbers', () => {
    expect(() => decideRevisionWrite(-1, 0)).toThrow()
    expect(() => decideRevisionWrite(1, 1.5)).toThrow()
  })
})
