import * as Y from 'yjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyTextChanges, textDeltaToEdits } from '../src/collaboration/textChanges'
import { clampAwarenessOffset, documentUpdateMessage, normalizeAwarenessPosition, stableCollaborationColor } from '../src/collaboration/protocol'
import { navigationRouteForDocument, navigationSectionForPath, publishedNavigationRoutes } from '../src/navigation'

describe('incremental collaboration text operations', () => {
  it('applies insert, replace, and delete changes against one old snapshot', () => {
    expect(applyTextChanges('abcdef', [{ rangeOffset: 1, rangeLength: 2, text: 'XY' }])).toBe('aXYdef')
    expect(applyTextChanges('abcdef', [
      { rangeOffset: 4, rangeLength: 1, text: '!' },
      { rangeOffset: 1, rangeLength: 2, text: '' }
    ])).toBe('ad!f')
  })

  it('handles document beginning, middle, end, and multiple changes', () => {
    expect(applyTextChanges('middle', [{ rangeOffset: 0, rangeLength: 0, text: 'start-' }])).toBe('start-middle')
    expect(applyTextChanges('abcdef', [{ rangeOffset: 2, rangeLength: 2, text: '' }])).toBe('abef')
    expect(applyTextChanges('tail', [{ rangeOffset: 4, rangeLength: 0, text: '-end' }])).toBe('tail-end')
    expect(applyTextChanges('0123456789', [
      { rangeOffset: 8, rangeLength: 2, text: 'XY' },
      { rangeOffset: 1, rangeLength: 3, text: 'A' },
      { rangeOffset: 5, rangeLength: 0, text: '!' }
    ])).toBe('0A4!567XY')
  })

  it('converts Y.Text delta to minimal descending edits', () => {
    expect(textDeltaToEdits([{ retain: 2 }, { delete: 1 }, { insert: 'XY' }, { retain: 3 }])).toEqual([
      { offset: 2, length: 1, text: 'XY' }
    ])
    expect(textDeltaToEdits([{ insert: 'A' }, { retain: 2 }, { delete: 2 }, { insert: 'BC' }])).toEqual([
      { offset: 3, length: 2, text: 'BC' },
      { offset: 0, length: 0, text: 'A' }
    ])
  })

  it('merges concurrent Yjs changes without last-write full replacement', () => {
    const first = new Y.Doc()
    first.getText('markdown').insert(0, 'abcd')
    const second = new Y.Doc()
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    const firstUpdate = (() => {
      let value: Uint8Array | undefined
      first.once('update', (update) => { value = update })
      first.getText('markdown').insert(0, 'A')
      return value!
    })()
    const secondUpdate = (() => {
      let value: Uint8Array | undefined
      second.once('update', (update) => { value = update })
      second.getText('markdown').insert(4, 'B')
      return value!
    })()
    Y.applyUpdate(first, secondUpdate)
    Y.applyUpdate(second, firstUpdate)
    expect(first.getText('markdown').toString()).toContain('A')
    expect(first.getText('markdown').toString()).toContain('B')
    expect(second.getText('markdown').toString()).toBe(first.getText('markdown').toString())
  })
})

describe('workspace message framing', () => {
  it('always adds the document-update discriminator to live and cached payloads', () => {
    expect(documentUpdateMessage({ updateId: 'u-1', documentPath: 'docs/a.md', update: 'base64', provenance: [] })).toEqual({
      type: 'document-update', updateId: 'u-1', documentPath: 'docs/a.md', update: 'base64', provenance: []
    })
  })
})

describe('workspace session behavior', () => {
  it('tracks the active editor independently from the document that joined first', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/collaboration/workspaceClient.ts'), 'utf8')
    expect(source).toContain('vscode.window.onDidChangeActiveTextEditor')
    expect(source).toContain('documentPath: this.activePath()')
    expect(source).toContain('textDeltaToEdits')
    expect(source).not.toContain('edit.replace(session.uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(editor.document.lineCount, 0)), content)')
  })

  it('does not overwrite an existing Markdown file from a remote manifest operation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/collaboration/workspaceClient.ts'), 'utf8')
    const remoteOperation = source.slice(source.indexOf('private async applyRemoteOperation'), source.indexOf('private startHeartbeat'))
    expect(remoteOperation).toContain('vscode.workspace.fs.stat(uri)')
    expect(remoteOperation).toContain('edit.createFile(uri')
    expect(remoteOperation).toContain('edit.renameFile(oldUri, newUri')
    expect(remoteOperation).not.toContain('vscode.workspace.fs.writeFile(uri, Buffer.from(operation.content')
    expect(source).toContain('if (this.ignoredPaths.has(uri.toString())) return')
    expect(source).toContain('this.ignoredPaths.has(oldUri.toString()) || this.ignoredPaths.has(newUri.toString())')
  })

  it('uses one Yjs bootstrap update for a new file instead of content plus a second full update', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/collaboration/workspaceClient.ts'), 'utf8')
    const syncBlock = source.slice(source.indexOf("if (!this.manifest.has(session.path))"), source.lastIndexOf('this.resendCachedUpdates()'))
    expect(syncBlock).toContain('initialUpdate: encode(Y.encodeStateAsUpdate(session.doc))')
    expect(syncBlock).not.toContain("type: 'document-update'")
    expect(source).toContain('session.localBootstrap')
    expect(source).toContain('private async applyWorkspaceSyncDocument')
    expect(source).toContain('const CACHE_VERSION = 2')
  })
})

describe('workspace publish UI migration', () => {
  it('exposes only workspace publish commands and never calls legacy per-document publish from activation', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { activationEvents: string[]; contributes: { commands: Array<{ command: string }> } }
    const commands = packageJson.contributes.commands.map((command) => command.command)
    const legacy = ['pyroWiki.saveDraft', 'pyroWiki.submitPublishRequest', 'pyroWiki.viewPublishRequests', 'pyroWiki.approveAndPublish', 'pyroWiki.rejectPublishRequest', 'pyroWiki.retryPublishRequest']
    expect(commands).not.toEqual(expect.arrayContaining(legacy))
    expect(packageJson.activationEvents).not.toEqual(expect.arrayContaining(legacy))
    expect(commands).toEqual(expect.arrayContaining(['pyroWiki.createWorkspacePublishBatch', 'pyroWiki.approveWorkspacePublishBatch', 'pyroWiki.rejectWorkspacePublishBatch']))

    const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8')
    expect(extensionSource).not.toContain('saveDraftCurrent')
    expect(extensionSource).not.toContain('submitPublishRequestCurrent')
    expect(extensionSource).not.toContain('getCurrentPublishRequest')
    expect(extensionSource).toContain('createWorkspacePublishBatch')
  })
})

describe('navigation-aware Markdown creation', () => {
  it('allows configured sections, supports new nested groups, and rejects unmanaged paths', () => {
    expect(navigationSectionForPath('PYRo-uCtrl-Unity/Peripheral')).toBe('/PYRo-uCtrl-Unity')
    expect(navigationSectionForPath('PYRo-uCtrl-Unity\\Peripheral')).toBe('/PYRo-uCtrl-Unity')
    expect(navigationSectionForPath('PYRo-uCtrl-Unity/NewSubsystem')).toBe('/PYRo-uCtrl-Unity')
    expect(navigationSectionForPath('Course/embedded/new-topic')).toBe('/Course/embedded')
    expect(navigationSectionForPath('about_us')).toBeUndefined()
    expect(navigationSectionForPath('BrandNewTopLevel')).toBeUndefined()
    expect(navigationSectionForPath('')).toBeUndefined()
    expect(navigationRouteForDocument('PYRo-uCtrl-Unity\\Peripheral\\UART.md')).toBe('/PYRo-uCtrl-Unity/Peripheral/UART')
    const published = publishedNavigationRoutes([
      "{ text: 'UART', link: '/PYRo-uCtrl-Unity/Peripheral/UART' }",
      JSON.stringify({ 'PYRo-uCtrl-Unity/Peripheral/GPIO.md': 'GPIO', 'PYRo-uCtrl-Unity/Peripheral/Removed.md': null })
    ])
    expect(published.has('/PYRo-uCtrl-Unity/Peripheral/UART')).toBe(true)
    expect(published.has('/PYRo-uCtrl-Unity/Peripheral/GPIO')).toBe(true)
    expect(published.has('/PYRo-uCtrl-Unity/Peripheral/Removed')).toBe(false)
  })

  it('explicitly synchronizes plugin-created files and reconciles missed file events before publishing', () => {
    const workspaceSource = readFileSync(resolve(process.cwd(), 'src/collaboration/workspaceClient.ts'), 'utf8')
    const markdownSource = readFileSync(resolve(process.cwd(), 'src/markdownWorkspace.ts'), 'utf8')
    const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8')
    expect(markdownSource).toContain('synchronizeCreatedDocument(document, sidebarLabel.trim())')
    expect(workspaceSource).toContain('async synchronizeCreatedMarkdownDocument')
    expect(workspaceSource).toContain('async synchronizeExistingMarkdownDocument')
    expect(workspaceSource).toContain('async reconcileLocalMarkdownFiles')
    expect(workspaceSource).toContain('publishedRoutes.has(navigationRouteForDocument(documentPath))')
    expect(workspaceSource).toContain('await this.synchronizeExistingMarkdownDocument(document)')
    expect(workspaceSource).toContain('await this.synchronizeCreatedMarkdownDocument(document, label)')
    expect(workspaceSource).toContain('async synchronizeDeletedMarkdownDocument')
    expect(workspaceSource).toContain('localPaths.has(documentPath)')
    expect(markdownSource).toContain('synchronizeDeletedDocument(node.uri)')
    expect(extensionSource).toContain('collaboration.synchronizeDeletedMarkdownDocument(uri)')
    expect(workspaceSource).toContain('waitForPendingOperations')
    expect(workspaceSource).toContain('pyroWiki.pendingSidebarLabels.')
    expect(workspaceSource).toContain('message.persisted')
    expect(extensionSource).toContain('await collaboration.reconcileLocalMarkdownFiles()')
  })
})

describe('collaboration awareness protocol helpers', () => {
  it('assigns deterministic colors and clamps offsets', () => {
    expect(stableCollaborationColor('user-1')).toBe(stableCollaborationColor('user-1'))
    expect(stableCollaborationColor('user-1')).not.toBe('')
    expect(clampAwarenessOffset(-10, 5)).toBe(0)
    expect(clampAwarenessOffset(99, 5)).toBe(5)
    expect(clampAwarenessOffset('bad', 5, 2)).toBe(2)
    expect(normalizeAwarenessPosition({ anchor: 2, head: 8 }, 5)).toEqual({ anchor: 2, head: 5 })
  })
})
