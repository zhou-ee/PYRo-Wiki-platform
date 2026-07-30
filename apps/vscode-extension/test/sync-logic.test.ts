import { describe, expect, it } from 'vitest'
import { cloudSyncStatus, filterCloudDocuments } from '../src/cloudWorkspaceLogic'
import { removePendingSyncItem, upsertPendingSyncItem, type PendingSyncItem } from '../src/sync/queueLogic'

const documents = [
  { path: 'Course/embedded/intro.md', title: 'Embedded intro' },
  { path: 'Course/front-end/setup.md', title: 'VitePress setup' },
  { path: 'about_us/index.md', title: 'About us' }
]

describe('cloud document logic', () => {
  it('filters by path and title case-insensitively', () => {
    expect(filterCloudDocuments(documents, 'EMBEDDED').map((document) => document.path)).toEqual(['Course/embedded/intro.md'])
    expect(filterCloudDocuments(documents, 'about').map((document) => document.path)).toEqual(['about_us/index.md'])
    expect(filterCloudDocuments(documents, '   ')).toEqual(documents)
  })

  it('calculates local/cloud synchronization status', () => {
    expect(cloudSyncStatus(false, undefined, 1)).toBe('missing-local')
    expect(cloudSyncStatus(true, undefined, 1)).toBe('not-pulled')
    expect(cloudSyncStatus(true, 2, 2)).toBe('synced')
    expect(cloudSyncStatus(true, 1, 2)).toBe('remote-newer')
    expect(cloudSyncStatus(true, 3, 2)).toBe('local-newer')
  })
})

describe('sync queue logic', () => {
  const first: PendingSyncItem = { id: 'file:///a.md', uri: 'file:///a.md', path: 'a.md', workspaceId: 'wiki', content: 'v1', baseRevision: 1, queuedAt: 't1' }

  it('deduplicates by URI and keeps the newest content', () => {
    const { id: _id, queuedAt: _queuedAt, ...newItem } = first
    const next = upsertPendingSyncItem([first], { ...newItem, content: 'v2', baseRevision: 2, kind: 'draft' }, 't2')
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'file:///a.md', content: 'v2', baseRevision: 2, kind: 'draft', queuedAt: 't2' })
  })

  it('removes only the requested queued document', () => {
    const second = { ...first, id: 'file:///b.md', uri: 'file:///b.md', path: 'b.md' }
    expect(removePendingSyncItem([first, second], first.id)).toEqual([second])
  })
})
