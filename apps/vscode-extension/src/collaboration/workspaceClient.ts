import * as path from 'node:path'
import * as vscode from 'vscode'
import * as Y from 'yjs'
import WebSocket from 'ws'
import type { AuthManager } from '../auth/session'
import { configuredWikiRoot, isWikiDocument } from '../workspace'
import { workspaceIdForRoot } from '../cloudWorkspace'
import { navigationRouteForDocument, navigationSectionForPath, publishedNavigationRoutes } from '../navigation'
import { textDeltaToEdits } from './textChanges'
import { COLLABORATION_PROTOCOL_VERSION, documentUpdateMessage, stableCollaborationColor } from './protocol'
import type { CollaborationMember, CollaborationSnapshot } from './client'

type ManifestEntry = { path: string; title: string; hash: string; updatedAt: number; updatedBy: string; deleted?: boolean; sidebarLabel?: string }
type ProvenanceRange = { start: number; end: number; userId: string; name: string; color: string; updatedAt: number }
type Session = { path: string; uri: vscode.Uri; doc: Y.Doc; text: Y.Text; localBootstrap: string; provenance: ProvenanceRange[]; applyingRemote: boolean; initialized: boolean; remoteEditChain: Promise<void> }
type WorkspaceOperation = { kind: 'create'; documentPath: string; content?: string; initialUpdate?: string; sidebarLabel?: string } | { kind: 'delete'; documentPath: string } | { kind: 'rename'; from: string; to: string } | { kind: 'move'; from: string; to: string }

type PendingDocumentUpdate = { updateId: string; documentPath: string; update: string; provenance: ProvenanceRange[] }

type WorkspaceMessage =
  | { type: 'workspace-sync'; manifestVersion: number; manifest: ManifestEntry[]; documentUpdates?: Array<{ documentPath: string; update: string }>; provenance?: Record<string, ProvenanceRange[]> }
  | { type: 'document-update'; documentPath: string; update: string; provenance?: ProvenanceRange[]; updateId?: string }
  | { type: 'manifest-op'; operation: WorkspaceOperation; operationId?: string; manifestVersion?: number }
  | { type: 'workspace-conflict'; conflictId: string; operation?: WorkspaceOperation; reason?: string }
  | { type: 'awareness'; status?: 'online' | 'offline'; presenceId?: string; userId?: string; name?: string; color?: string; documentPath?: string; cursor?: { anchor?: number; head?: number }; selection?: { start?: number; end?: number }; updatedAt?: number }
  | { type: 'ack'; updateId?: string; operationId?: string; persisted?: boolean }
  | { type: 'pong' }
  | { type: 'error'; error?: string; code?: string }

const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'
const REMOTE_ORIGIN = Symbol('pyro-workspace-remote')
const SYSTEM_ORIGIN = Symbol('pyro-workspace-system')
const AWARENESS_INTERVAL_MS = 100
const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 65_000
const CACHE_VERSION = 2

function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function decode(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')) }
function randomId(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}-${crypto.randomUUID?.() ?? ''}` }
function isMarkdownPath(value: string): boolean { return value.toLowerCase().endsWith('.md') && !value.startsWith('/') && !value.split('/').includes('..') }
function relativePath(root: string, file: string): string { return path.relative(root, file).replaceAll('\\', '/') }
function mergeRanges(ranges: ProvenanceRange[]): ProvenanceRange[] {
  return ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start).reduce<ProvenanceRange[]>((result, current) => {
    const previous = result[result.length - 1]
    if (previous && previous.end >= current.start && previous.userId === current.userId) previous.end = Math.max(previous.end, current.end)
    else result.push({ ...current })
    return result
  }, [])
}
function rangeForChange(change: vscode.TextDocumentContentChangeEvent, user: { id: string; name: string }): ProvenanceRange {
  const start = change.rangeOffset
  return { start, end: start + change.text.length, userId: user.id, name: user.name, color: stableCollaborationColor(user.id), updatedAt: Date.now() }
}
function singleTextChange(current: string, desired: string): { offset: number; length: number; text: string } | undefined {
  if (current === desired) return undefined
  let prefix = 0
  while (prefix < current.length && prefix < desired.length && current[prefix] === desired[prefix]) prefix += 1
  let suffix = 0
  while (suffix < current.length - prefix && suffix < desired.length - prefix && current[current.length - 1 - suffix] === desired[desired.length - 1 - suffix]) suffix += 1
  return { offset: prefix, length: current.length - prefix - suffix, text: desired.slice(prefix, desired.length - suffix) }
}

function updateProvenanceForChanges(existing: ProvenanceRange[], changes: readonly vscode.TextDocumentContentChangeEvent[], user: { id: string; name: string }): ProvenanceRange[] {
  let ranges = existing.map((range) => ({ ...range }))
  for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    const delta = change.text.length - change.rangeLength
    ranges = ranges.flatMap((range) => {
      if (range.end <= change.rangeOffset) return [range]
      if (range.start >= change.rangeOffset + change.rangeLength) return [{ ...range, start: range.start + delta, end: range.end + delta }]
      const start = Math.min(range.start, change.rangeOffset)
      const end = Math.max(start, range.end + delta)
      return end > start ? [{ ...range, start, end }] : []
    })
    if (change.text.length) ranges.push(rangeForChange(change, user))
  }
  return mergeRanges(ranges)
}

class OfflineWorkspaceCache {
  private readonly root: vscode.Uri
  private readonly pending = new Map<string, PendingDocumentUpdate>()
  private readonly operations = new Map<string, { operationId: string; operation: WorkspaceOperation }>()
  private loaded = false

  constructor(private readonly context: vscode.ExtensionContext, private readonly workspaceId: string, private readonly userId: string) {
    this.root = vscode.Uri.joinPath(context.globalStorageUri, 'workspaces', workspaceId, userId)
  }

  private file(name: string): vscode.Uri { return vscode.Uri.joinPath(this.root, name) }
  private async ensure(): Promise<void> {
    const workspaces = vscode.Uri.joinPath(this.context.globalStorageUri, 'workspaces')
    const workspace = vscode.Uri.joinPath(workspaces, this.workspaceId)
    for (const uri of [this.context.globalStorageUri, workspaces, workspace, this.root]) {
      try { await vscode.workspace.fs.createDirectory(uri) } catch { /* directory may already exist */ }
    }
  }
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await vscode.workspace.fs.readFile(this.file('cache.json'))
      const data = JSON.parse(Buffer.from(raw).toString('utf8')) as { version?: number; pending?: Array<PendingDocumentUpdate & { type?: 'document-update' }>; operations?: Array<{ operationId: string; operation: WorkspaceOperation }> }
      if (data.version !== CACHE_VERSION) return
      for (const item of data.pending ?? []) this.pending.set(item.updateId, item)
      for (const item of data.operations ?? []) this.operations.set(item.operationId, item)
    } catch { /* first run */ }
  }
  private async save(): Promise<void> {
    await this.ensure()
    const value = { version: CACHE_VERSION, pending: [...this.pending.values()], operations: [...this.operations.values()] }
    await vscode.workspace.fs.writeFile(this.file('cache.json'), Buffer.from(JSON.stringify(value), 'utf8'))
  }
  async addUpdate(item: PendingDocumentUpdate): Promise<void> { await this.load(); this.pending.set(item.updateId, item); await this.save() }
  async addOperation(item: { operationId: string; operation: WorkspaceOperation }): Promise<void> { await this.load(); this.operations.set(item.operationId, item); await this.save() }
  async acknowledge(updateId?: string, operationId?: string): Promise<void> {
    await this.load()
    if (updateId) this.pending.delete(updateId)
    if (operationId) this.operations.delete(operationId)
    if (!this.pending.size && !this.operations.size) {
      try { await vscode.workspace.fs.delete(this.file('cache.json'), { useTrash: false }) } catch { /* already clean */ }
    } else {
      try { await this.save() } catch {
        try { await this.ensure(); await this.save() } catch { /* cache cleanup must not break realtime receive */ }
      }
    }
  }
  getUpdates(): PendingDocumentUpdate[] { return [...this.pending.values()] }
  getOperations(): Array<{ operationId: string; operation: WorkspaceOperation }> { return [...this.operations.values()] }
  getOperation(operationId: string): { operationId: string; operation: WorkspaceOperation } | undefined { return this.operations.get(operationId) }
  hasOperation(operationId: string): boolean { return this.operations.has(operationId) }
  async clear(): Promise<void> { this.pending.clear(); this.operations.clear(); try { await vscode.workspace.fs.delete(this.file('cache.json'), { useTrash: false }) } catch { /* no cache */ } }
}

export class WorkspaceCollaborationClient implements vscode.Disposable {
  private socket: WebSocket | undefined
  private socketGeneration = 0
  private reconnectTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private awarenessTimer: NodeJS.Timeout | undefined
  private lastMessageAt = 0
  private reconnectAttempt = 0
  private intentionalClose = false
  private root: string | undefined
  private workspaceId: string | undefined
  private cache: OfflineWorkspaceCache | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly manifest = new Map<string, ManifestEntry>()
  private readonly members = new Map<string, CollaborationMember>()
  private readonly baselineNonMarkdown = new Map<string, Uint8Array>()
  private readonly ignoredPaths = new Set<string>()
  // Serialize file-operation handlers so repeated VS Code notifications cannot
  // enqueue two manifest operations while the first is still awaiting I/O.
  private readonly pendingFileEvents = new Set<string>()
  private readonly pendingLocalRanges = new Map<string, ProvenanceRange[]>()
  // Registered by the "New Markdown Document" command just before it writes the
  // file, so handleFileCreated can attach the user-chosen sidebar label to the
  // create operation it builds moments later from VS Code's onDidCreateFiles.
  private readonly pendingSidebarLabels = new Map<string, string>()
  private pendingSidebarLabelStateChain: Promise<void> = Promise.resolve()
  private readonly events: string[] = []
  private readonly disposables: vscode.Disposable[] = []
  private readonly changeEmitter = new vscode.EventEmitter<CollaborationSnapshot>()
  private snapshot: CollaborationSnapshot = { status: 'offline', users: [], members: [], events: [] }
  private autoJoinInFlight = false
  private synchronizationReady = false
  private synchronizationResolver: (() => void) | undefined
  private synchronizationPromise: Promise<void> = Promise.resolve()
  private receiveChain: Promise<void> = Promise.resolve()

  readonly onDidChange = this.changeEmitter.event
  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: AuthManager) {
    this.disposables.push(
      this.changeEmitter,
      auth.onDidChange((user) => { if (user) void this.join(); else void this.leave(false) }),
      vscode.workspace.onDidChangeTextDocument((event) => { void this.handleTextChange(event) }),
      vscode.workspace.onDidCreateFiles((event) => { for (const uri of event.files) void this.handleFileCreated(uri) }),
      vscode.workspace.onDidDeleteFiles((event) => { for (const uri of event.files) void this.handleFileDeleted(uri) }),
      vscode.workspace.onDidRenameFiles((event) => { for (const file of event.files) void this.handleFileRenamed(file.oldUri, file.newUri) }),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleAwareness()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.update({ status: this.snapshot.status, documentPath: this.activePath(), users: this.userNames(), members: this.memberList(), error: this.snapshot.error })
        this.scheduleAwareness()
      })

    )
  }

  get state(): CollaborationSnapshot { return this.snapshot }

  private pendingSidebarLabelStateKey(workspaceId: string): string { return `pyroWiki.pendingSidebarLabels.${workspaceId}` }

  private updatePendingSidebarLabelState(workspaceId: string, update: (labels: Record<string, string>) => void): Promise<void> {
    const operation = this.pendingSidebarLabelStateChain.then(async () => {
      const key = this.pendingSidebarLabelStateKey(workspaceId)
      const labels = { ...this.context.workspaceState.get<Record<string, string>>(key, {}) }
      update(labels)
      await this.context.workspaceState.update(key, Object.keys(labels).length ? labels : undefined)
    })
    this.pendingSidebarLabelStateChain = operation.catch(() => undefined)
    return operation
  }

  private async loadPendingSidebarLabels(workspaceId: string): Promise<void> {
    this.pendingSidebarLabels.clear()
    const labels = this.context.workspaceState.get<Record<string, string>>(this.pendingSidebarLabelStateKey(workspaceId), {})
    for (const [documentPath, label] of Object.entries(labels)) if (label.trim()) this.pendingSidebarLabels.set(documentPath, label.trim())
  }

  async registerPendingSidebarLabel(documentPath: string, label: string, workspaceId = this.workspaceId): Promise<void> {
    const normalized = label.trim()
    if (!normalized) return
    this.pendingSidebarLabels.set(documentPath, normalized)
    if (workspaceId) await this.updatePendingSidebarLabelState(workspaceId, (labels) => { labels[documentPath] = normalized })
  }

  private async clearPendingSidebarLabel(documentPath: string, expectedLabel?: string): Promise<void> {
    const current = this.pendingSidebarLabels.get(documentPath)
    if (expectedLabel && current && current !== expectedLabel) return
    this.pendingSidebarLabels.delete(documentPath)
    if (!this.workspaceId) return
    await this.updatePendingSidebarLabelState(this.workspaceId, (labels) => {
      if (!expectedLabel || !labels[documentPath] || labels[documentPath] === expectedLabel) delete labels[documentPath]
    })
  }

  async synchronizeCreatedMarkdownDocument(document: vscode.TextDocument, label: string): Promise<boolean> {
    return this.synchronizeMarkdownDocument(document, label)
  }

  async synchronizeExistingMarkdownDocument(document: vscode.TextDocument): Promise<boolean> {
    return this.synchronizeMarkdownDocument(document)
  }

  private async synchronizeMarkdownDocument(document: vscode.TextDocument, label?: string): Promise<boolean> {
    const root = configuredWikiRoot(document)
    if (!root) return false
    const documentPath = relativePath(root, document.uri.fsPath)
    const normalizedLabel = label?.trim()
    if (normalizedLabel) await this.registerPendingSidebarLabel(documentPath, normalizedLabel, workspaceIdForRoot(root))
    if (!this.root || path.resolve(this.root).toLowerCase() !== path.resolve(root).toLowerCase()) await this.join(document)
    if (!(await this.waitForSynchronization())) return false
    while (this.pendingFileEvents.has(`create:${documentPath}`)) await new Promise((resolve) => setTimeout(resolve, 50))
    const entry = this.manifest.get(documentPath)
    if (normalizedLabel && entry?.sidebarLabel === normalizedLabel) {
      await this.clearPendingSidebarLabel(documentPath, normalizedLabel)
      return this.waitForPendingOperations()
    }
    if (entry && !normalizedLabel) return this.waitForPendingOperations()
    if (entry) {
      const session = await this.ensureSession(document.uri, document.getText())
      if (!session) return false
      this.bootstrapSession(session)
      session.initialized = true
      const operationId = randomId('operation')
      const operation: WorkspaceOperation = { kind: 'create', documentPath, content: document.getText(), initialUpdate: encode(Y.encodeStateAsUpdate(session.doc)), sidebarLabel: normalizedLabel }
      this.applyLocalManifestOperation(operation)
      await this.cache?.addOperation({ operationId, operation })
      this.send({ type: 'manifest-op', operationId, operation })
      return this.waitForOperationPersistence(operationId)
    }
    const operationId = await this.handleFileCreated(document.uri)
    return !operationId || this.waitForOperationPersistence(operationId)
  }

  async reconcileLocalMarkdownFiles(): Promise<boolean> {
    if (!this.root || !this.cache) return false
    const rootUri = vscode.Uri.file(this.root)
    const navigationSources: string[] = []
    for (const relative of ['.vitepress/config.mts', '.vitepress/pyro-wiki-sidebar.ts', '.vitepress/pyro-wiki-sidebar-baseline.ts', '.vitepress/pyro-wiki-sidebar-labels.json']) {
      try { navigationSources.push(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, relative))).toString('utf8')) }
      catch { /* navigation source is optional before first approved publish */ }
    }
    const publishedRoutes = publishedNavigationRoutes(navigationSources)
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.md'), new vscode.RelativePattern(rootUri, '**/{node_modules,.git}/**'))
    const localPaths = new Set<string>()
    for (const uri of files) {
      const documentPath = this.sessionPath(uri)
      if (!documentPath) continue
      localPaths.add(documentPath)
      const manifestEntry = this.manifest.get(documentPath)
      const published = publishedRoutes.has(navigationRouteForDocument(documentPath))
      if (manifestEntry?.sidebarLabel || (manifestEntry && published)) continue
      const document = await vscode.workspace.openTextDocument(uri)
      if (!manifestEntry && published && !this.pendingSidebarLabels.has(documentPath)) {
        if (!(await this.synchronizeExistingMarkdownDocument(document))) return false
        continue
      }
      const directory = path.posix.dirname(documentPath)
      if (!navigationSectionForPath(directory === '.' ? '' : directory)) continue
      let label = this.pendingSidebarLabels.get(documentPath)
      if (!label) {
        label = await vscode.window.showInputBox({
          prompt: `Navigation label for the unpublished document ${documentPath}`,
          placeHolder: 'Shown in the VitePress sidebar',
          ignoreFocusOut: true,
          validateInput: (value) => value.trim() ? undefined : 'A navigation label is required.'
        })
        if (label === undefined) return false
        await this.registerPendingSidebarLabel(documentPath, label)
      }
      if (!(await this.synchronizeCreatedMarkdownDocument(document, label))) return false
    }
    for (const documentPath of [...this.manifest.keys()]) {
      if (!isMarkdownPath(documentPath) || localPaths.has(documentPath)) continue
      const uri = vscode.Uri.file(path.join(this.root, documentPath))
      if (!(await this.synchronizeDeletedMarkdownDocument(uri))) return false
    }
    const persisted = await this.waitForPendingOperations()
    if (!persisted) void vscode.window.showErrorMessage('Some local Markdown files did not reach the cloud workspace. Check the connection and try again.')
    return persisted
  }

  async synchronizeDeletedMarkdownDocument(uri: vscode.Uri): Promise<boolean> {
    if (!this.root) await this.join()
    if (!(await this.waitForSynchronization())) return false
    const documentPath = this.sessionPath(uri)
    if (!documentPath || !isMarkdownPath(documentPath)) return false
    while (this.pendingFileEvents.has(`delete:${documentPath}`)) await new Promise((resolve) => setTimeout(resolve, 50))
    if (!this.manifest.has(documentPath)) return this.waitForPendingOperations()
    const operationId = await this.handleFileDeleted(uri)
    return !operationId || this.waitForOperationPersistence(operationId)
  }

  private async waitForOperationPersistence(operationId: string, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.cache?.hasOperation(operationId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    return !this.cache?.hasOperation(operationId)
  }

  private async waitForPendingOperations(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while ((this.cache?.getOperations().length ?? 0) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    return (this.cache?.getOperations().length ?? 0) === 0
  }


  async join(document = vscode.window.activeTextEditor?.document): Promise<void> {
    if (this.autoJoinInFlight) return
    const wikiRoot = document && isWikiDocument(document) ? configuredWikiRoot(document) : document ? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const user = this.auth.currentUser
    if (!wikiRoot || !user || this.snapshot.status === 'connected' || this.snapshot.status === 'connecting') return
    this.autoJoinInFlight = true
    try {
      await this.leave(false)
      this.root = wikiRoot
      this.workspaceId = workspaceIdForRoot(wikiRoot)
      await this.loadPendingSidebarLabels(this.workspaceId)
      this.cache = new OfflineWorkspaceCache(this.context, this.workspaceId, user.id)
      await this.cache.load()
      await this.captureNonMarkdownBaseline()
      await this.loadLocalSessions()
      this.intentionalClose = false
      this.synchronizationReady = false
      this.synchronizationPromise = new Promise((resolve) => { this.synchronizationResolver = resolve })
      this.update({ status: 'connecting', documentPath: this.activePath(), users: this.userNames(), members: this.memberList() })
      this.connect()
    } finally { this.autoJoinInFlight = false }
  }

  private apiBaseUrl(): string { return vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL).replace(/\/$/, '') }
  private socketUrl(): string { return `${this.apiBaseUrl().replace(/^http/, 'ws')}/workspace-collaboration/${encodeURIComponent(this.workspaceId ?? 'default')}` }
  private activePath(): string | undefined { const editor = vscode.window.activeTextEditor; return editor && this.root ? relativePath(this.root, editor.document.uri.fsPath) : undefined }
  private sessionPath(uri: vscode.Uri): string | undefined { return this.root ? relativePath(this.root, uri.fsPath) : undefined }
  private applyLocalManifestOperation(operation: WorkspaceOperation): void {
    const updatedAt = Date.now()
    if (operation.kind === 'create') {
      this.manifest.set(operation.documentPath, { path: operation.documentPath, title: path.basename(operation.documentPath, '.md'), hash: '', updatedAt, updatedBy: this.auth.currentUser?.id ?? 'local-user', sidebarLabel: operation.sidebarLabel })
    } else if (operation.kind === 'delete') {
      this.manifest.delete(operation.documentPath)
    } else {
      const entry = this.manifest.get(operation.from) ?? { path: operation.from, title: path.basename(operation.from, '.md'), hash: '', updatedAt, updatedBy: this.auth.currentUser?.id ?? 'local-user' }
      this.manifest.delete(operation.from)
      this.manifest.set(operation.to, { ...entry, path: operation.to, title: path.basename(operation.to, '.md'), updatedAt })
    }
  }
  private refreshWorkspaceViews(): void {
    void vscode.commands.executeCommand('pyroWiki.refreshDocuments')
    void vscode.commands.executeCommand('pyroWiki.refreshPreview')
  }
  private async captureNonMarkdownBaseline(): Promise<void> {
    if (!this.root) return
    const rootUri = vscode.Uri.file(this.root)
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*'), new vscode.RelativePattern(rootUri, '**/{node_modules,.git,.vitepress/cache}/**'))
    for (const uri of files) if (!uri.fsPath.toLowerCase().endsWith('.md')) { try { this.baselineNonMarkdown.set(uri.fsPath, await vscode.workspace.fs.readFile(uri)) } catch { /* ignore */ } }
  }

  private async loadLocalSessions(): Promise<void> {
    if (!this.root) return
    const rootUri = vscode.Uri.file(this.root)
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.md'), new vscode.RelativePattern(rootUri, '**/{node_modules,.git}/**'))
    for (const uri of files) await this.ensureSession(uri)
  }

  private async ensureSession(uri: vscode.Uri, content?: string): Promise<Session | undefined> {
    if (!this.root) return undefined
    const documentPath = this.sessionPath(uri)
    if (!documentPath || !isMarkdownPath(documentPath)) return undefined
    const existing = this.sessions.get(documentPath)
    if (existing) return existing
    let source = content
    if (source === undefined) { try { source = (await vscode.workspace.openTextDocument(uri)).getText() } catch { try { source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') } catch { source = '' } } }
    const doc = new Y.Doc()
    const text = doc.getText('markdown')
    const session: Session = { path: documentPath, uri, doc, text, localBootstrap: '', provenance: [], applyingRemote: false, initialized: false, remoteEditChain: Promise.resolve() }
    this.bindSession(session)
    // The local file is only used as the one-time bootstrap payload. It must
    // not be inserted into Y.Doc before the server decides whether this path
    // already exists, otherwise the same Markdown can be merged twice.
    session.localBootstrap = source ?? ''
    this.sessions.set(documentPath, session)
    return session
  }

  private bindSession(session: Session): void {
    session.doc.on('update', (update: Uint8Array, origin: unknown) => { void this.handleYUpdate(session, update, origin) })
    session.text.observe((event) => { void this.handleYTextEvent(session, event) })
  }

  private resetSessionDocument(session: Session, update: Uint8Array): void {
    const doc = new Y.Doc()
    const text = doc.getText('markdown')
    Y.applyUpdate(doc, update, REMOTE_ORIGIN)
    session.doc = doc
    session.text = text
    this.bindSession(session)
  }

  private bootstrapSession(session: Session): void {
    if (!session.localBootstrap || session.text.length) return
    session.doc.transact(() => session.text.insert(0, session.localBootstrap), SYSTEM_ORIGIN)
  }

  private async applyWorkspaceSyncDocument(session: Session, update: Uint8Array): Promise<void> {
    const localContent = session.localBootstrap
    const remoteDoc = new Y.Doc()
    Y.applyUpdate(remoteDoc, update, REMOTE_ORIGIN)
    const remoteContent = remoteDoc.getText('markdown').toString()
    this.resetSessionDocument(session, update)
    session.initialized = true
    const localChange = singleTextChange(remoteContent, localContent)
    if (localChange) {
      session.doc.transact(() => {
        if (localChange.length) session.text.delete(localChange.offset, localChange.length)
        if (localChange.text) session.text.insert(localChange.offset, localChange.text)
      }, 'local-reconcile')
    }
    session.localBootstrap = session.text.toString()
  }

  private async handleYUpdate(session: Session, update: Uint8Array, origin: unknown): Promise<void> {
    if (origin === REMOTE_ORIGIN || origin === SYSTEM_ORIGIN) return
    const updateId = randomId('update')
    const provenance = this.pendingLocalRanges.get(session.path) ?? session.provenance
    this.pendingLocalRanges.delete(session.path)
    const item: PendingDocumentUpdate = { updateId, documentPath: session.path, update: encode(update), provenance }
    // Cache every local incremental update, including edits made while the
    // first workspace sync is still in flight or while the socket is offline.
    await this.cache?.addUpdate(item)
    if (this.socket?.readyState === WebSocket.OPEN && session.initialized) this.send(documentUpdateMessage(item))
  }

  private handleYTextEvent(session: Session, event: Y.YTextEvent): void {
    if (!session.applyingRemote) return
    session.remoteEditChain = session.remoteEditChain.then(() => this.applyRemoteDelta(session, event)).catch((error) => {
      this.recordEvent(`Remote edit delayed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async applyRemoteDelta(session: Session, event: Y.YTextEvent): Promise<void> {
    const delta = event.delta.map((part) => ({ retain: part.retain, delete: part.delete, ...(typeof part.insert === 'string' ? { insert: part.insert } : {}) }))
    const edits = textDeltaToEdits(delta)
    if (!edits.length) return
    const document = await vscode.workspace.openTextDocument(session.uri)
    const workspaceEdit = new vscode.WorkspaceEdit()
    for (const edit of edits) {
      const start = document.positionAt(Math.max(0, Math.min(document.getText().length, edit.offset)))
      const endOffset = Math.max(edit.offset, edit.offset + edit.length)
      const end = document.positionAt(Math.max(0, Math.min(document.getText().length, endOffset)))
      workspaceEdit.replace(session.uri, new vscode.Range(start, end), edit.text)
    }
    this.ignoredPaths.add(session.uri.toString())
    try {
      const applied = await vscode.workspace.applyEdit(workspaceEdit)
      if (!applied) throw new Error(`VS Code rejected the remote edit for ${session.path}`)
    } finally { setTimeout(() => this.ignoredPaths.delete(session.uri.toString()), 100) }
  }

  private async handleTextChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (!this.root || !isWikiDocument(event.document) || this.ignoredPaths.has(event.document.uri.toString())) return
    const session = await this.ensureSession(event.document.uri)
    if (!session || session.applyingRemote) return
    const changes = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)
    const user = this.auth.currentUser
    if (user) {
      session.provenance = updateProvenanceForChanges(session.provenance, changes, user)
      this.pendingLocalRanges.set(session.path, session.provenance)
    }
    if (!session.initialized) {
      // Keep the editor as the local candidate until the server state vector
      // arrives. Applying a local bootstrap to Y.Doc before that point would
      // make the same text appear as an independent remote insertion.
      session.localBootstrap = event.document.getText()
      return
    }
    session.doc.transact(() => {
      for (const change of changes) {
        if (change.rangeLength) session.text.delete(change.rangeOffset, change.rangeLength)
        if (change.text) session.text.insert(change.rangeOffset, change.text)
      }
    }, 'local')
  }

  private async handleFileCreated(uri: vscode.Uri): Promise<string | undefined> {
    if (this.ignoredPaths.has(uri.toString())) return
    const documentPath = this.sessionPath(uri)
    if (!documentPath || !this.root) return
    if (!isMarkdownPath(documentPath)) { await this.restoreNonMarkdown(uri); return }
    const eventKey = `create:${documentPath}`
    if (this.pendingFileEvents.has(eventKey) || this.manifest.has(documentPath)) return
    this.pendingFileEvents.add(eventKey)
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      const session = await this.ensureSession(uri, document.getText())
      if (!session || this.manifest.has(documentPath)) return
      this.bootstrapSession(session)
      session.initialized = true
      const operationId = randomId('operation')
      const sidebarLabel = this.pendingSidebarLabels.get(documentPath)
      const operation: WorkspaceOperation = { kind: 'create', documentPath, content: document.getText(), initialUpdate: encode(Y.encodeStateAsUpdate(session.doc)), sidebarLabel }
      this.applyLocalManifestOperation(operation)
      await this.cache?.addOperation({ operationId, operation })
      this.send({ type: 'manifest-op', operationId, operation })
      this.refreshWorkspaceViews()
      return operationId
    } finally {
      this.pendingFileEvents.delete(eventKey)
    }
  }

  private async handleFileDeleted(uri: vscode.Uri): Promise<string | undefined> {
    if (this.ignoredPaths.has(uri.toString())) return
    const documentPath = this.sessionPath(uri)
    if (!documentPath) return
    if (!isMarkdownPath(documentPath)) { await this.restoreNonMarkdown(uri); return undefined }
    const eventKey = `delete:${documentPath}`
    if (this.pendingFileEvents.has(eventKey) || !this.manifest.has(documentPath)) return
    this.pendingFileEvents.add(eventKey)
    try {
      if (!this.manifest.has(documentPath)) return
      const operationId = randomId('operation')
      const operation: WorkspaceOperation = { kind: 'delete', documentPath }
      this.applyLocalManifestOperation(operation)
      await this.cache?.addOperation({ operationId, operation })
      this.send({ type: 'manifest-op', operationId, operation })
      this.refreshWorkspaceViews()
      return operationId
    } finally {
      this.pendingFileEvents.delete(eventKey)
    }
  }

  private async handleFileRenamed(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    if (this.ignoredPaths.has(oldUri.toString()) || this.ignoredPaths.has(newUri.toString())) return
    const from = this.sessionPath(oldUri); const to = this.sessionPath(newUri)
    if (!from || !to || (!this.manifest.has(from) && this.manifest.has(to))) return
    if (!isMarkdownPath(from) || !isMarkdownPath(to)) { await this.restoreNonMarkdown(oldUri); await this.restoreNonMarkdown(newUri); return }
    const eventKey = `rename:${from}->${to}`
    if (this.pendingFileEvents.has(eventKey)) return
    this.pendingFileEvents.add(eventKey)
    try {
      if (!this.manifest.has(from) && this.manifest.has(to)) return
      const session = this.sessions.get(from)
      if (session) { this.sessions.delete(from); session.path = to; session.uri = newUri; this.sessions.set(to, session) }
      const operationId = randomId('operation')
      const operation: WorkspaceOperation = { kind: 'rename', from, to }
      this.applyLocalManifestOperation(operation)
      await this.cache?.addOperation({ operationId, operation })
      this.send({ type: 'manifest-op', operationId, operation })
      this.refreshWorkspaceViews()
    } finally {
      this.pendingFileEvents.delete(eventKey)
    }
  }

  private async restoreNonMarkdown(uri: vscode.Uri): Promise<void> {
    if (this.ignoredPaths.has(uri.toString())) return
    const baseline = this.baselineNonMarkdown.get(uri.fsPath)
    this.ignoredPaths.add(uri.toString())
    try {
      if (baseline) await vscode.workspace.fs.writeFile(uri, baseline)
      else { try { await vscode.workspace.fs.delete(uri, { useTrash: false }) } catch { /* already absent */ } }
    } finally { setTimeout(() => this.ignoredPaths.delete(uri.toString()), 100) }
    void vscode.window.showWarningMessage('PYRo Wiki 协作工作区中的非 Markdown 文件为只读资源，插件已恢复本地修改。')
  }

  private connect(): void {
    const generation = ++this.socketGeneration
    void this.auth.getAccessToken().then((token) => {
      if (!token || this.intentionalClose || generation !== this.socketGeneration) return this.scheduleReconnect()
      const socket = new WebSocket(this.socketUrl(), { headers: { authorization: `Bearer ${token}` } })
      this.socket = socket
      socket.on('open', () => { if (generation !== this.socketGeneration) return void socket.close(1000, 'stale'); this.reconnectAttempt = 0; this.lastMessageAt = Date.now(); this.update({ status: 'connecting', documentPath: this.activePath(), users: this.userNames(), members: this.memberList() }); this.startHeartbeat(socket); this.sendHello(); this.resendCache() })
      socket.on('message', (raw) => { this.lastMessageAt = Date.now(); this.receiveChain = this.receiveChain.then(() => this.receive(String(raw))).catch((error) => { this.recordEvent(`Workspace receive failed: ${error instanceof Error ? error.message : String(error)}`) }) })
      socket.on('close', () => { if (this.socket === socket) this.socket = undefined; this.stopHeartbeat(); if (!this.intentionalClose) { this.update({ status: 'reconnecting', documentPath: this.activePath(), users: this.userNames(), members: this.memberList() }); this.scheduleReconnect() } })
      socket.on('error', () => { if (this.socket === socket) this.socket = undefined })
    }).catch(() => this.scheduleReconnect())
  }

  private sendHello(): void {
    const documentStateVectors: Record<string, string> = {}
    for (const session of this.sessions.values()) documentStateVectors[session.path] = encode(Y.encodeStateVector(session.doc))
    this.send({ type: 'workspace-hello', workspaceId: this.workspaceId, clientId: randomId('client'), yClientId: [...this.sessions.values()][0]?.doc.clientID ?? 0, documentStateVectors, manifestVersion: this.manifest.size })
  }

  private resendCache(): void {
    if (!this.cache) return
    for (const item of this.cache.getOperations()) this.send({ type: 'manifest-op', operationId: item.operationId, operation: item.operation })
    this.resendCachedUpdates()
  }

  private resendCachedUpdates(): void {
    if (!this.cache) return
    for (const item of this.cache.getUpdates()) this.send(documentUpdateMessage(item))
  }

  private async receive(raw: string): Promise<void> {
    let message: WorkspaceMessage
    try { message = JSON.parse(raw) as WorkspaceMessage } catch { return }
    if (message.type === 'pong') return
    if (message.type === 'workspace-sync') {
      this.manifest.clear()
      for (const entry of message.manifest) this.manifest.set(entry.path, entry)
      for (const [documentPath, label] of [...this.pendingSidebarLabels]) {
        if (this.manifest.get(documentPath)?.sidebarLabel === label) await this.clearPendingSidebarLabel(documentPath, label)
      }
      for (const [path, ranges] of Object.entries(message.provenance ?? {})) { const session = this.sessions.get(path); if (session) session.provenance = ranges }
      for (const item of message.documentUpdates ?? []) {
        const uri = this.root ? vscode.Uri.file(path.join(this.root, item.documentPath)) : undefined
        if (!uri) continue
        const session = await this.ensureSession(uri)
        if (!session) continue
        await this.applyWorkspaceSyncDocument(session, decode(item.update))
      }
      for (const session of this.sessions.values()) {
        session.initialized = true
        if (!this.manifest.has(session.path)) {
          const sidebarLabel = this.pendingSidebarLabels.get(session.path)
          if (!sidebarLabel) continue
          this.bootstrapSession(session)
          const operationId = randomId('operation')
          const operation: WorkspaceOperation = {
            kind: 'create',
            documentPath: session.path,
            content: session.text.toString(),
            initialUpdate: encode(Y.encodeStateAsUpdate(session.doc)),
            sidebarLabel
          }
          this.applyLocalManifestOperation(operation)
          await this.cache?.addOperation({ operationId, operation })
          this.send({ type: 'manifest-op', operationId, operation })
        }
      }
      // Local edits made while the initial sync was in flight were cached by
      // handleYUpdate. Flush only document updates here; manifest operations
      // were already sent above and must not be sent twice.
      this.resendCachedUpdates()
      this.synchronizationReady = true
      this.synchronizationResolver?.()
      this.synchronizationResolver = undefined
      this.update({ status: 'connected', documentPath: this.activePath(), users: this.userNames(), members: this.memberList() })
      this.recordEvent('Workspace synchronized')
      return
    }
    if (message.type === 'document-update') {
      const uri = this.root ? vscode.Uri.file(path.join(this.root, message.documentPath)) : undefined
      if (!uri) return
      const session = await this.ensureSession(uri)
      if (!session) return
      session.applyingRemote = true
      try { Y.applyUpdate(session.doc, decode(message.update), REMOTE_ORIGIN); await session.remoteEditChain; if (message.provenance) session.provenance = mergeRanges(message.provenance) } finally { session.applyingRemote = false }
      return
    }
    if (message.type === 'manifest-op') { await this.applyRemoteOperation(message.operation); return }
    if (message.type === 'workspace-conflict') { this.recordEvent(`Workspace conflict: ${message.reason ?? message.conflictId}`); void vscode.window.showWarningMessage(`PYRo Wiki workspace conflict: ${message.reason ?? message.conflictId}`); return }
    if (message.type === 'ack') {
      const operation = message.operationId ? this.cache?.getOperation(message.operationId)?.operation : undefined
      await this.cache?.acknowledge(message.updateId, message.operationId)
      if (message.persisted && operation?.kind === 'create' && operation.sidebarLabel) await this.clearPendingSidebarLabel(operation.documentPath, operation.sidebarLabel)
      return
    }
    if (message.type === 'awareness') { this.applyAwareness(message); return }
    if (message.type === 'error') {
      this.recordEvent(`Workspace error: ${message.error ?? message.code ?? 'unknown'}`)
      this.update({ status: 'error', documentPath: this.activePath(), users: this.userNames(), members: this.memberList(), error: message.error ?? message.code })
      if (message.code === 'IDENTITY_UNAVAILABLE' || message.code === 'HELLO_REQUIRED' || message.code === 'DUPLICATE_HELLO') {
        const socket = this.socket
        this.socket = undefined
        this.stopHeartbeat()
        try { socket?.terminate() } catch { /* already closed */ }
      }
      return
    }
  }

  private async applyRemoteOperation(operation: WorkspaceOperation): Promise<void> {
    if (!this.root) return
    if (operation.kind === 'create') {
      if (!isMarkdownPath(operation.documentPath)) return
      const uri = vscode.Uri.file(path.join(this.root, operation.documentPath))
      let exists = true
      try { await vscode.workspace.fs.stat(uri) } catch { exists = false }
      if (!exists) {
        const edit = new vscode.WorkspaceEdit()
        edit.createFile(uri, { ignoreIfExists: true, overwrite: false })
        edit.insert(uri, new vscode.Position(0, 0), operation.content ?? '')
        this.ignoredPaths.add(uri.toString())
        try {
          const applied = await vscode.workspace.applyEdit(edit)
          if (!applied) throw new Error(`VS Code rejected remote file creation for ${operation.documentPath}`)
        } finally { setTimeout(() => this.ignoredPaths.delete(uri.toString()), 100) }
      }
      const document = await vscode.workspace.openTextDocument(uri)
      if (exists && typeof operation.content === 'string' && document.getText() !== operation.content) {
        this.recordEvent(`Remote create conflicted with local file ${operation.documentPath}`)
        return
      }
      this.applyLocalManifestOperation(operation)
      const session = await this.ensureSession(uri, document.getText())
      if (!session) return
      if (operation.initialUpdate) {
        try {
          this.resetSessionDocument(session, decode(operation.initialUpdate))
          session.localBootstrap = document.getText()
          session.initialized = true
        } catch (error) {
          this.recordEvent(`Remote file bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        this.bootstrapSession(session)
        session.initialized = true
      }
      this.refreshWorkspaceViews()
      return
    }
    if (operation.kind === 'delete') {
      if (!isMarkdownPath(operation.documentPath)) return
      const uri = vscode.Uri.file(path.join(this.root, operation.documentPath))
      const edit = new vscode.WorkspaceEdit()
      edit.deleteFile(uri, { ignoreIfNotExists: true })
      this.ignoredPaths.add(uri.toString())
      try {
        const applied = await vscode.workspace.applyEdit(edit)
        if (!applied) throw new Error(`VS Code rejected remote file deletion for ${operation.documentPath}`)
      } catch (error) {
        this.recordEvent(`Remote file deletion delayed: ${error instanceof Error ? error.message : String(error)}`)
      } finally { setTimeout(() => this.ignoredPaths.delete(uri.toString()), 100) }
      this.sessions.delete(operation.documentPath)
      this.applyLocalManifestOperation(operation)
      this.refreshWorkspaceViews()
      return
    }
    const from = operation.from
    const to = operation.to
    if (!isMarkdownPath(from) || !isMarkdownPath(to)) return
    const oldUri = vscode.Uri.file(path.join(this.root, from))
    const newUri = vscode.Uri.file(path.join(this.root, to))
    const edit = new vscode.WorkspaceEdit()
    edit.renameFile(oldUri, newUri, { overwrite: false, ignoreIfExists: true })
    this.ignoredPaths.add(oldUri.toString())
    this.ignoredPaths.add(newUri.toString())
    try {
      const applied = await vscode.workspace.applyEdit(edit)
      if (!applied) throw new Error(`VS Code rejected remote file rename for ${from}`)
    } catch (error) {
      this.recordEvent(`Remote file rename delayed: ${error instanceof Error ? error.message : String(error)}`)
      return
    } finally {
      setTimeout(() => this.ignoredPaths.delete(oldUri.toString()), 100)
      setTimeout(() => this.ignoredPaths.delete(newUri.toString()), 100)
    }
    this.applyLocalManifestOperation(operation)
    this.refreshWorkspaceViews()
    const session = this.sessions.get(from)
    if (session) {
      this.sessions.delete(from)
      session.path = to
      session.uri = newUri
      this.sessions.set(to, session)
    }
  }

  private startHeartbeat(socket: WebSocket): void { this.stopHeartbeat(); this.heartbeatTimer = setInterval(() => { if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return; if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) return void socket.terminate(); this.send({ type: 'ping' }) }, HEARTBEAT_INTERVAL_MS) }
  private stopHeartbeat(): void { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
  private scheduleReconnect(): void { if (this.intentionalClose || this.reconnectTimer) return; const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt); this.reconnectAttempt += 1; this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect() }, delay) }
  private send(message: Record<string, unknown>): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)) }
  private scheduleAwareness(): void { if (this.awarenessTimer) return; this.awarenessTimer = setTimeout(() => { this.awarenessTimer = undefined; this.sendAwareness() }, AWARENESS_INTERVAL_MS) }
  private sendAwareness(status: 'online' | 'offline' = 'online'): void { const editor = vscode.window.activeTextEditor; if (!editor || !this.root || !this.socket) return; const selection = editor.selection; this.send({ type: 'awareness', status, documentPath: relativePath(this.root, editor.document.uri.fsPath), cursor: { anchor: editor.document.offsetAt(selection.anchor), head: editor.document.offsetAt(selection.active) }, selection: { start: editor.document.offsetAt(selection.start), end: editor.document.offsetAt(selection.end) }, updatedAt: Date.now() }) }
  private applyAwareness(message: Extract<WorkspaceMessage, { type: 'awareness' }>): void { if (!message.presenceId || message.userId === this.auth.currentUser?.id) return; const previous = this.members.get(message.presenceId); this.members.set(message.presenceId, { presenceId: message.presenceId, userId: message.userId ?? message.presenceId, name: message.name ?? 'Unknown', color: message.color ?? stableCollaborationColor(message.userId ?? ''), status: message.status === 'offline' ? 'offline' : 'online', documentPath: message.documentPath ?? '', cursor: { anchor: message.cursor?.anchor ?? previous?.cursor.anchor ?? 0, head: message.cursor?.head ?? previous?.cursor.head ?? 0 }, selection: { start: message.selection?.start ?? previous?.selection.start ?? 0, end: message.selection?.end ?? previous?.selection.end ?? 0 }, updatedAt: message.updatedAt ?? Date.now() }); this.update({ status: this.snapshot.status, documentPath: this.activePath(), users: this.userNames(), members: this.memberList() }) }
  private userNames(): string[] { return this.memberList().map((member) => member.name) }
  private memberList(): CollaborationMember[] { return [...this.members.values()] }
  private recordEvent(message: string): void { this.events.unshift(`${new Date().toLocaleTimeString()} ${message}`); this.events.splice(8); this.update({ status: this.snapshot.status, documentPath: this.activePath(), users: this.userNames(), members: this.memberList(), error: this.snapshot.error }) }
  private update(next: Omit<CollaborationSnapshot, 'events'>): void { this.snapshot = { ...next, events: [...this.events] }; this.changeEmitter.fire(this.snapshot) }

  async waitForSynchronization(timeoutMs = 15_000): Promise<boolean> {
    if (!this.workspaceId) return false
    if (!this.synchronizationReady) {
      await Promise.race([this.synchronizationPromise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
    }
    return this.synchronizationReady
  }

  async leave(showMessage = true): Promise<void> { this.intentionalClose = true; this.synchronizationResolver?.(); this.synchronizationResolver = undefined; this.synchronizationReady = false; this.socketGeneration += 1; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.stopHeartbeat(); if (this.awarenessTimer) clearTimeout(this.awarenessTimer); this.awarenessTimer = undefined; this.sendAwareness('offline'); this.socket?.close(1000, 'leaving workspace'); this.socket = undefined; this.members.clear(); this.sessions.clear(); this.manifest.clear(); this.pendingSidebarLabels.clear(); this.root = undefined; this.workspaceId = undefined; this.cache = undefined; this.update({ status: 'offline', users: [], members: [] }); if (showMessage) void vscode.window.showInformationMessage('Left PYRo Wiki workspace collaboration.') }
  async authorAt(document: vscode.TextDocument, offset: number): Promise<ProvenanceRange | undefined> { const root = configuredWikiRoot(document); if (!root) return undefined; const session = this.sessions.get(relativePath(root, document.uri.fsPath)); return session?.provenance.find((range) => offset >= range.start && offset < range.end) }
  dispose(): void { void this.leave(false); for (const disposable of this.disposables) disposable.dispose() }
}
