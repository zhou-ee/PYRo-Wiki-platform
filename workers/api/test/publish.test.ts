import { describe, expect, it } from 'vitest'
import { isPublisher } from '../src/publishRequests'
import { extractGitHubBranchSha, normalizeWorkflowStatus } from '../src/github'
import { permissionsFor } from '../src/permissions'
import { isIdempotentCreate } from '../src/testable'
import { changedWorkspacePaths } from '../src/workspacePublish'
import { ensureNavigationConfig, mergeNavigationIndex, parseNavigationIndex } from '../src/navigation'
import { checkpointDeletionPaths, missingCheckpointPaths } from '../src/workspaceRoom'

describe('publish request permissions', () => {
  it('allows the development anonymous maintainer only outside production', () => {
    const user = { id: 'dev-anonymous', openId: 'dev-anonymous', name: 'Development User' }
    expect(isPublisher({ PYRO_ENVIRONMENT: 'development' }, user)).toBe(true)
    expect(isPublisher({ PYRO_ENVIRONMENT: 'production' }, user)).toBe(false)
  })

  it('matches configured Feishu ids and rejects ordinary users', () => {
    const env = { PYRO_ENVIRONMENT: 'production', PYRO_PUBLISHER_IDS: 'maintainer-id,open-id-2' }
    expect(isPublisher(env, { id: 'maintainer-id', openId: 'other', name: 'Maintainer' })).toBe(true)
    expect(isPublisher(env, { id: 'user-id', openId: 'open-id-2', name: 'Maintainer' })).toBe(true)
    expect(isPublisher(env, { id: 'user-id', openId: 'ordinary-open-id', name: 'User' })).toBe(false)
  })
})


describe('GitHub branch response parsing', () => {
  it('reads the SHA from the GitHub branches API commit.sha field', () => {
    expect(extractGitHubBranchSha({ name: 'main', commit: { sha: 'abc123' } })).toBe('abc123')
  })

  it('keeps compatibility with object.sha responses', () => {
    expect(extractGitHubBranchSha({ object: { sha: 'legacy-sha' } })).toBe('legacy-sha')
  })

  it('rejects branch responses without a SHA', () => {
    expect(extractGitHubBranchSha({ name: 'main' })).toBeUndefined()
  })
})


describe('runtime permissions and Pages status', () => {
  it('derives publisher permission from Worker configuration', () => {
    expect(permissionsFor({ PYRO_ENVIRONMENT: 'production', PYRO_PUBLISHER_IDS: 'publisher-id' }, { id: 'publisher-id', openId: 'open', name: 'Publisher' }).canPublish).toBe(true)
    expect(permissionsFor({ PYRO_ENVIRONMENT: 'production', PYRO_PUBLISHER_IDS: 'publisher-id' }, { id: 'user-id', openId: 'open', name: 'User' }).canPublish).toBe(false)
  })

  it('allows development anonymous users to publish locally', () => {
    expect(permissionsFor({ PYRO_ENVIRONMENT: 'development' }, { id: 'dev-anonymous', openId: 'dev-anonymous', name: 'Development User' }).canPublish).toBe(true)
  })

  it('maps GitHub Actions states to deployment states', () => {
    expect(normalizeWorkflowStatus({ id: '1', status: 'queued' })).toBe('queued')
    expect(normalizeWorkflowStatus({ id: '2', status: 'in_progress' })).toBe('in_progress')
    expect(normalizeWorkflowStatus({ id: '3', status: 'completed', conclusion: 'success' })).toBe('success')
    expect(normalizeWorkflowStatus({ id: '4', status: 'completed', conclusion: 'failure' })).toBe('failure')
  })
})


describe('workspace manifest operation idempotency', () => {
  it('accepts a stale create when the destination already has identical content', () => {
    expect(isIdempotentCreate('same markdown', 'same markdown')).toBe(true)
  })

  it('keeps a real destination conflict when content differs', () => {
    expect(isIdempotentCreate('remote markdown', 'local markdown')).toBe(false)
  })
})


describe('workspace checkpoint deletion reconciliation', () => {
  it('identifies paths missing from an explicitly complete manifest', () => {
    expect(missingCheckpointPaths(
      ['PYRo-uCtrl-Unity/Peripheral/UART.md'],
      ['PYRo-uCtrl-Unity/Peripheral/UART.md', 'PYRo-uCtrl-Unity/Peripheral/GPIO.md', 'PYRo-uCtrl-Unity/Peripheral/GPIO.md']
    )).toEqual(['PYRo-uCtrl-Unity/Peripheral/GPIO.md'])
  })

  it('keeps ordinary checkpoints limited to explicit persisted tombstones', () => {
    expect(checkpointDeletionPaths(['UART.md'], ['UART.md', 'GPIO.md'], ['TIM.md'], false)).toEqual(['TIM.md'])
  })

  it('reconciles D1-only paths only for an explicitly complete manifest', () => {
    expect(checkpointDeletionPaths(['UART.md'], ['UART.md', 'GPIO.md'], ['TIM.md'], true)).toEqual(['GPIO.md', 'TIM.md'])
  })
})

describe('incremental workspace publish diff', () => {
  it('includes only changed, added, and deleted paths', () => {
    expect(changedWorkspacePaths([
      { document_path: 'same.md', content_hash: 'a', deleted: 0 },
      { document_path: 'changed.md', content_hash: 'new', deleted: 0 },
      { document_path: 'added.md', content_hash: 'added', deleted: 0 },
      { document_path: 'removed.md', content_hash: '', deleted: 1 }
    ], [
      { document_path: 'same.md', content_hash: 'a', deleted: 0 },
      { document_path: 'changed.md', content_hash: 'old', deleted: 0 },
      { document_path: 'removed.md', content_hash: 'old', deleted: 0 }
    ])).toEqual(['added.md', 'changed.md', 'removed.md'])
  })

  it('treats an empty previous publication as an initial full diff', () => {
    expect(changedWorkspacePaths([{ document_path: 'a.md', content_hash: 'a', deleted: 0 }], [])).toEqual(['a.md'])
  })

  it('treats a navigation-label update as a publishable change', () => {
    expect(changedWorkspacePaths(
      [{ document_path: 'a.md', content_hash: 'a', deleted: 0, sidebar_label: 'New' }],
      [{ document_path: 'a.md', content_hash: 'a', deleted: 0, sidebar_label: 'Old' }]
    )).toEqual(['a.md'])
  })
})

describe('approved navigation publishing', () => {
  it('extracts the complete static sidebar baseline without truncating nested groups', () => {
    const source = `import { defineConfig } from 'vitepress'\nexport default defineConfig({ themeConfig: { sidebar: {\n      '/PYRo-uCtrl-Unity': [{ text: 'Root', items: [{ text: 'Peripheral', collapsed: true, items: [{ text: 'UART', link: '/PYRo-uCtrl-Unity/Peripheral/UART' }, { text: 'GPIO', link: '/PYRo-uCtrl-Unity/Peripheral/GPIO' }] }] }],\n      '/Course/embedded': [{ text: 'Intro', link: '/Course/embedded/intro' }]\n    }, outline: { level: [2, 3] } } })`
    const result = ensureNavigationConfig(source)
    expect(result.content).toContain("import { sidebarBaseline } from './pyro-wiki-sidebar-baseline'")
    expect(result.content).toContain('sidebar: pyroWikiSidebar(sidebarBaseline)')
    expect(result.content).toContain("outline: { level: [2, 3] }")
    expect(result.baselineContent).toContain("'/Course/embedded'")
    expect(result.baselineContent).toContain("'/PYRo-uCtrl-Unity/Peripheral/UART'")
    expect(result.baselineContent).not.toContain("'/PYRo-uCtrl-Unity/Peripheral/GPIO'")
  })

  it('removes the legacy duplicate dynamic sidebar override during migration', () => {
    const source = `import { defineConfig } from 'vitepress'\nimport { pyroWikiSidebar } from './pyro-wiki-sidebar'\nexport default defineConfig({ themeConfig: { sidebar: { '/PYRo-uCtrl-Unity': [{ text: 'UART', link: '/PYRo-uCtrl-Unity/Peripheral/UART' }] }, sidebar: pyroWikiSidebar(), outline: {} } })`
    const result = ensureNavigationConfig(source)
    expect(result.content.match(/sidebar\s*:/g)).toHaveLength(1)
    expect(result.content).toContain('sidebar: pyroWikiSidebar(sidebarBaseline)')
    expect(result.baselineContent).toContain("'/PYRo-uCtrl-Unity/Peripheral/UART'")
  })

  it('preserves prior approved labels and records deletion tombstones', () => {
    const existing = parseNavigationIndex('{"Course/embedded/old.md":"Old","PYRo-uCtrl-Unity/Peripheral/Keep.md":"Keep"}')
    expect(mergeNavigationIndex(existing, [
      { document_path: 'Course/embedded/new.md', sidebar_label: 'New Label', deleted: 0 },
      { document_path: 'Course/embedded/old.md', sidebar_label: 'Old', deleted: 1 }
    ])).toEqual({
      'Course/embedded/new.md': 'New Label',
      'Course/embedded/old.md': null,
      'PYRo-uCtrl-Unity/Peripheral/Keep.md': 'Keep'
    })
  })
})
