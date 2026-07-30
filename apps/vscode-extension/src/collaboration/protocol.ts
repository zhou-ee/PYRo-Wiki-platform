export const COLLABORATION_PROTOCOL_VERSION = 1

export type WorkspaceDocumentUpdate = {
  updateId: string
  documentPath: string
  update: string
  provenance?: unknown[]
}

/** Build the explicitly typed wire message used by WorkspaceRoom. */
export function documentUpdateMessage<T extends WorkspaceDocumentUpdate>(item: T): T & { type: 'document-update' } {
  return { ...item, type: 'document-update' }
}

export const COLLABORATION_COLORS = [
  '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444'
] as const

export function stableCollaborationColor(userId: string): string {
  let hash = 0
  for (let index = 0; index < userId.length; index += 1) hash = ((hash << 5) - hash + userId.charCodeAt(index)) | 0
  return COLLABORATION_COLORS[Math.abs(hash) % COLLABORATION_COLORS.length]
}

export function clampAwarenessOffset(value: unknown, length: number, fallback = 0): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(0, Math.min(length, number))
}

export function normalizeAwarenessPosition(position: { anchor?: unknown; head?: unknown } | undefined, length: number, fallback = 0): { anchor: number; head: number } {
  return {
    anchor: clampAwarenessOffset(position?.anchor, length, fallback),
    head: clampAwarenessOffset(position?.head, length, fallback)
  }
}

export function normalizeAwarenessSelection(position: { start?: unknown; end?: unknown } | undefined, length: number, fallback = 0): { start: number; end: number } {
  return {
    start: clampAwarenessOffset(position?.start, length, fallback),
    end: clampAwarenessOffset(position?.end, length, fallback)
  }
}
