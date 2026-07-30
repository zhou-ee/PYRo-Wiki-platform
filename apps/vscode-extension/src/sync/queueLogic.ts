export interface PendingSyncItem {
  id: string
  uri: string
  path: string
  workspaceId: string
  content: string
  baseRevision: number
  kind?: 'draft' | 'published'
  queuedAt: string
}

export type NewPendingSyncItem = Omit<PendingSyncItem, 'id' | 'queuedAt'>

export function upsertPendingSyncItem(current: PendingSyncItem[], item: NewPendingSyncItem, queuedAt: string): PendingSyncItem[] {
  const next = current.filter((queued) => queued.id !== item.uri)
  next.push({ ...item, id: item.uri, queuedAt })
  return next
}

export function removePendingSyncItem(current: PendingSyncItem[], id: string): PendingSyncItem[] {
  return current.filter((item) => item.id !== id)
}
