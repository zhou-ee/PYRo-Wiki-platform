export function normalizePathForTest(value: string): string {
  return decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/(^|\/)\.\.(?=\/|$)/g, '').replace(/^\/+/, '').trim()
}


export interface RevisionWriteDecision {
  kind: 'write' | 'conflict'
  nextRevision?: number
}

export function decideRevisionWrite(currentRevision: number, baseRevision: number): RevisionWriteDecision {
  if (!Number.isInteger(currentRevision) || currentRevision < 0) throw new Error('currentRevision must be a non-negative integer')
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new Error('baseRevision must be a non-negative integer')
  if (baseRevision !== currentRevision) return { kind: 'conflict' }
  return { kind: 'write', nextRevision: currentRevision + 1 }
}


export function isRevisionConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed.*revisions/i.test(message) || /revisions.*unique constraint/i.test(message)
}


export function isIdempotentCreate(existingContent: string, incomingContent: string): boolean {
  return existingContent === incomingContent
}
