export type CloudSyncStatus = 'synced' | 'remote-newer' | 'local-newer' | 'not-pulled' | 'missing-local'

export interface CloudDocumentLike {
  path: string
  title: string
}

export function filterCloudDocuments<T extends CloudDocumentLike>(documents: T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return documents
  return documents.filter((document) => `${document.path} ${document.title}`.toLocaleLowerCase().includes(normalized))
}

export function cloudSyncStatus(localExists: boolean, localRevision: number | undefined, remoteRevision: number): CloudSyncStatus {
  if (!localExists) return 'missing-local'
  if (localRevision === undefined) return 'not-pulled'
  if (localRevision === remoteRevision) return 'synced'
  return localRevision < remoteRevision ? 'remote-newer' : 'local-newer'
}
