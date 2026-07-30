import * as vscode from 'vscode'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { isWikiDocument, workspaceRoot } from '../workspace'
import type { AuthManager } from '../auth/session'
import { textDeltaToEdits, type TextDeltaPart } from './textChanges'
import { clampAwarenessOffset, normalizeAwarenessPosition, normalizeAwarenessSelection, stableCollaborationColor } from './protocol'

type YTextDelta = Y.YTextEvent['delta']
type CollaborationStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'error'
type MemberStatus = 'online' | 'offline' | 'reconnecting'

type AwarenessMessage = {
  type: 'awareness'
  status?: 'online' | 'update' | 'offline'
  presenceId?: string
  userId?: string
  user?: string
  name?: string
  color?: string
  documentPath?: string
  cursor?: { anchor?: number; head?: number }
  selection?: { start?: number; end?: number }
  updatedAt?: number
}

type SyncMessage = { type: 'sync'; update?: string; stateVector?: string }
type ServerMessage = SyncMessage | AwarenessMessage | { type: 'update'; id?: string; update?: string } | { type: 'ack'; id?: string } | { type: 'pong' } | { type: 'error'; error?: string; code?: string }

function encode(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function decode(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')) }
function randomId(prefix: string): string {
  try { return `${prefix}-${crypto.randomUUID()}` } catch { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}` }
}
export interface CollaborationMember {
  presenceId: string
  userId: string
  name: string
  color: string
  status: MemberStatus
  documentPath: string
  cursor: { anchor: number; head: number }
  selection: { start: number; end: number }
  updatedAt: number
}

export interface CollaborationSnapshot {
  status: CollaborationStatus
  documentPath?: string
  users: string[]
  members: CollaborationMember[]
  error?: string
  events: string[]
}

const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 65_000
const AWARENESS_DEBOUNCE_MS = 75
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

export class CollaborationClient implements vscode.Disposable {
  private socket: WebSocket | undefined
  private ydoc = new Y.Doc()
  private text = this.ydoc.getText('markdown')
  private applyingRemote = false
  private initializing = false
  private document: vscode.TextDocument | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private awarenessTimer: NodeJS.Timeout | undefined
  private reconnectAttempt = 0
  private connectionGeneration = 0
  private lastMessageAt = 0
  private intentionalClose = false
  private clientId = randomId('client')
  private readonly members = new Map<string, CollaborationMember>()
  private readonly pendingUpdateIds = new Set<string>()
  private pendingSyncUpdateIds = new Set<string>()
  private syncRequestId: string | undefined
  private readonly events: string[] = []
  private readonly disposables: vscode.Disposable[] = []
  private readonly decorationTypes = new Map<string, { selection: vscode.TextEditorDecorationType; cursor: vscode.TextEditorDecorationType }>()
  private idleTimer: NodeJS.Timeout | undefined
  private pendingAutoDocument: vscode.TextDocument | undefined
  private autoJoinInFlight = false
  private loginPrompted = false
  private pendingRemoteDeltas: YTextDelta[] = []
  private receiveChain: Promise<void> = Promise.resolve()
  private remoteApplyChain: Promise<void> = Promise.resolve()
  private readonly changeEmitter = new vscode.EventEmitter<CollaborationSnapshot>()
  private snapshot: CollaborationSnapshot = { status: 'offline', users: [], members: [], events: [] }

  readonly onDidChange = this.changeEmitter.event

  constructor(private readonly auth: AuthManager) {
    this.disposables.push(
      this.changeEmitter,
      auth.onDidChange((user) => {
        if (user) {
          this.loginPrompted = false
          const pending = this.pendingAutoDocument
          if (pending) void this.autoJoin(pending)
        } else {
          this.pendingAutoDocument = undefined
          void this.leave(false)
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => { void this.handleTextDocumentChange(event) }),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleAwareness()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.renderDecorations()
        this.scheduleAwareness()
      })
    )
    this.attachYDoc()
  }

  get state(): CollaborationSnapshot { return this.snapshot }

  private attachYDoc(): void {
    this.ydoc.on('update', this.handleYjsUpdate)
    this.text.observe(this.handleYTextChange)
  }

  private detachYDoc(): void {
    this.ydoc.off('update', this.handleYjsUpdate)
    this.text.unobserve(this.handleYTextChange)
    this.ydoc.destroy()
  }

  private resetYDoc(content = ''): void {
    this.detachYDoc()
    this.ydoc = new Y.Doc()
    this.text = this.ydoc.getText('markdown')
    this.attachYDoc()
    if (content) this.ydoc.transact(() => this.text.insert(0, content), 'vscode-initial')
  }

  private membersList(): CollaborationMember[] {
    return [...this.members.values()].sort((left, right) => left.name.localeCompare(right.name) || left.presenceId.localeCompare(right.presenceId))
  }

  private userNames(): string[] { return this.membersList().map((member) => member.name) }

  async handleLocalEdit(document: vscode.TextDocument): Promise<void> {
    if (!isWikiDocument(document)) return
    this.pendingAutoDocument = document
    this.armIdleTimer()
    if (this.document?.uri.toString() === document.uri.toString() && this.snapshot.status !== 'offline') return
    await this.autoJoin(document)
  }

  private async handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    const document = event.document
    if (!event.contentChanges.length || !isWikiDocument(document)) return
    this.pendingAutoDocument = document
    this.armIdleTimer()
    if (this.document?.uri.toString() === document.uri.toString()) {
      if (this.applyingRemote || this.initializing) return
      this.ydoc.transact(() => this.applyLocalContentChanges(event.contentChanges), 'vscode')
      this.scheduleAwareness()
      return
    }
    await this.autoJoin(document)
  }

  private async autoJoin(document: vscode.TextDocument): Promise<void> {
    if (this.autoJoinInFlight) return
    this.autoJoinInFlight = true
    try {
      const token = await this.auth.getAccessToken()
      if (!token) {
        if (!this.loginPrompted) {
          this.loginPrompted = true
          void this.auth.signIn()
        }
        this.update({ status: 'offline', documentPath: document.fileName, users: [], members: [], error: 'Feishu login required for collaboration' })
        return
      }
      await this.join(document, { showMessage: false })
    } finally {
      this.autoJoinInFlight = false
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.pendingAutoDocument = undefined
      void this.leave(false)
    }, IDLE_TIMEOUT_MS)
  }

  async join(document = vscode.window.activeTextEditor?.document, options: { showMessage?: boolean } = {}): Promise<void> {
    const showMessage = options.showMessage !== false
    if (!document || !isWikiDocument(document)) {
      if (showMessage) void vscode.window.showWarningMessage('Open a Wiki Markdown file before joining collaboration.')
      return
    }
    const token = await this.auth.getAccessToken()
    if (!token) {
      if (showMessage) void vscode.window.showWarningMessage('Sign in with Feishu before joining collaboration.')
      return
    }
    await this.leave(false)
    this.document = document
    this.pendingAutoDocument = document
    this.intentionalClose = false
    this.reconnectAttempt = 0
    this.clientId = randomId('client')
    this.members.clear()
    this.pendingUpdateIds.clear()
    this.pendingSyncUpdateIds.clear()
    this.events.length = 0
    this.initializing = true
    this.resetYDoc(document.getText())
    this.initializing = false
    this.recordEvent(`Joining ${document.fileName}`)
    this.armIdleTimer()
    this.connect()
  }

  private applyLocalContentChanges(changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const ordered = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)
    for (const change of ordered) {
      if (change.rangeLength > 0) this.text.delete(change.rangeOffset, change.rangeLength)
      if (change.text) this.text.insert(change.rangeOffset, change.text)
    }
  }

  private readonly handleYTextChange = (event: Y.YTextEvent): void => {
    if (event.transaction.origin === 'remote') this.pendingRemoteDeltas.push(event.delta)
  }

  private async applyRemoteDelta(delta: YTextDelta): Promise<void> {
    if (!this.document) return
    const document = this.document
    const edits = textDeltaToEdits(delta as readonly TextDeltaPart[])
    if (!edits.length) return
    const editor = vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === document.uri.toString())
    this.applyingRemote = true
    try {
      if (editor) {
        const applied = await editor.edit((builder) => {
          for (const edit of edits) {
            builder.replace(new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.text)
          }
        }, { undoStopBefore: false, undoStopAfter: false })
        if (!applied) throw new Error('VS Code rejected a remote collaboration edit')
      } else {
        const workspaceEdit = new vscode.WorkspaceEdit()
        for (const edit of edits) {
          workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.text)
        }
        const applied = await vscode.workspace.applyEdit(workspaceEdit)
        if (!applied) throw new Error('VS Code rejected a remote collaboration edit')
      }
    } finally {
      this.applyingRemote = false
    }
  }

  private queueRemoteUpdate(update: Uint8Array, eventName: string): Promise<void> {
    const next = this.remoteApplyChain.then(async () => {
      if (!this.document) return
      this.applyingRemote = true
      this.pendingRemoteDeltas = []
      try {
        Y.applyUpdate(this.ydoc, update, 'remote')
        const deltas = this.pendingRemoteDeltas.splice(0)
        this.recordEvent(eventName)
        for (const delta of deltas) await this.applyRemoteDelta(delta)
      } finally {
        this.pendingRemoteDeltas = []
        this.applyingRemote = false
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.recordEvent(`Remote edit failed: ${message}`, message)
    })
    this.remoteApplyChain = next
    return next
  }

  private readonly handleYjsUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote' || origin === 'vscode-initial' || this.applyingRemote || this.initializing) return
    const id = randomId('update')
    this.pendingUpdateIds.add(id)
    this.send({ type: 'update', id, update: encode(update) })
  }

  private connect(): void {
    if (!this.document) return
    const root = workspaceRoot(this.document)
    if (!root) return
    const generation = ++this.connectionGeneration
    const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', 'https://pyro-wiki-api.luckyy.ccwu.cc').replace(/^http/, 'ws')
    const workspaceId = encodeURIComponent(root.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase())
    const documentPath = encodeURIComponent(this.document.uri.fsPath.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/'))
    const decodedPath = decodeURIComponent(documentPath)
    const url = `${baseUrl}/collaboration/${documentPath}?workspace=${workspaceId}`
    this.update({ status: this.reconnectAttempt ? 'reconnecting' : 'connecting', documentPath: decodedPath, users: this.userNames(), members: this.membersList() })
    void this.auth.getAccessToken().then((token) => {
      if (!token || !this.document || generation !== this.connectionGeneration || this.intentionalClose) return
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
      this.socket = socket
      socket.on('open', () => {
        if (generation !== this.connectionGeneration) return void socket.close(1000, 'stale connection')
        this.reconnectAttempt = 0
        this.lastMessageAt = Date.now()
        this.startHeartbeat(socket)
        this.update({ status: 'connected', documentPath: decodedPath, users: this.userNames(), members: this.membersList(), error: undefined })
        this.recordEvent('Connected to collaboration room')
        this.send({ type: 'hello', protocol: 1, clientId: this.clientId, stateVector: encode(Y.encodeStateVector(this.ydoc)) })
      })
      socket.on('message', (data) => {
        this.lastMessageAt = Date.now()
        this.receiveChain = this.receiveChain.then(() => this.receive(data.toString())).catch(() => {})
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined
        this.stopHeartbeat()
        this.clearRemoteMembers()
        if (generation !== this.connectionGeneration) return
        if (!this.intentionalClose && this.document) {
          this.recordEvent('Connection closed; scheduling reconnect')
          this.scheduleReconnect()
        } else if (this.intentionalClose) {
          this.update({ status: 'offline', users: [], members: [] })
        }
      })
      socket.on('error', (error) => {
        if (generation !== this.connectionGeneration) return
        this.update({ status: 'error', documentPath: decodedPath, users: this.userNames(), members: this.membersList(), error: error.message })
        this.recordEvent(`Socket error: ${error.message}`, error.message)
      })
    }).catch((error) => {
      if (generation === this.connectionGeneration && !this.intentionalClose) {
        const message = error instanceof Error ? error.message : String(error)
        this.update({ status: 'error', documentPath: decodedPath, users: this.userNames(), members: this.membersList(), error: message })
        this.recordEvent(`Authentication/connection error: ${message}`, message)
        this.scheduleReconnect()
      }
    })
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) return void socket.terminate()
      socket.send(JSON.stringify({ type: 'ping' }))
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.document || this.intentionalClose) return
    this.reconnectAttempt += 1
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 4))
    const retryMessage = `Retrying in ${Math.ceil(delay / 1000)}s`
    this.update({ status: 'reconnecting', documentPath: this.snapshot.documentPath, users: this.userNames(), members: this.membersList(), error: retryMessage })
    this.recordEvent(`Reconnect scheduled (${Math.ceil(delay / 1000)}s)`, retryMessage)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect() }, delay)
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private async receive(raw: string): Promise<void> {
    let message: ServerMessage
    try { message = JSON.parse(raw) as ServerMessage } catch { return }
    if (message.type === 'pong') return
    if (message.type === 'sync') {
      if (message.update) await this.queueRemoteUpdate(decode(message.update), 'Received Yjs sync state')
      if (message.stateVector) {
        const missingForServer = Y.encodeStateAsUpdate(this.ydoc, decode(message.stateVector))
        const idsAtSync = new Set(this.pendingUpdateIds)
        this.pendingSyncUpdateIds = idsAtSync
        if (missingForServer.byteLength > 0) {
          this.syncRequestId = randomId('sync')
          this.send({ type: 'sync', id: this.syncRequestId, update: encode(missingForServer) })
        } else {
          for (const id of idsAtSync) this.pendingUpdateIds.delete(id)
          this.sendAwareness('online')
        }
      }
      return
    }
    if (message.type === 'update' && message.update) {
      await this.queueRemoteUpdate(decode(message.update), 'Received remote Yjs update')
      return
    }
    if (message.type === 'ack') {
      if (message.id === this.syncRequestId) {
        for (const id of this.pendingSyncUpdateIds) this.pendingUpdateIds.delete(id)
        this.pendingSyncUpdateIds.clear()
        this.syncRequestId = undefined
      } else if (message.id) {
        this.pendingUpdateIds.delete(message.id)
      }
      if (this.snapshot.status === 'connected') this.sendAwareness('online')
      return
    }
    if (message.type === 'awareness') {
      this.applyAwareness(message)
      return
    }
    if (message.type === 'error') {
      const error = message.error ?? 'Collaboration server error'
      this.update({ status: 'error', documentPath: this.snapshot.documentPath, users: this.userNames(), members: this.membersList(), error })
      this.recordEvent(`Server error: ${error}`, error)
    }
  }

  private applyAwareness(message: AwarenessMessage): void {
    const presenceId = message.presenceId ?? message.userId
    if (!presenceId) return
    if (message.status === 'offline') {
      const member = this.members.get(presenceId)
      this.members.delete(presenceId)
      this.clearMemberDecorations(presenceId)
      if (member) this.recordEvent(`${member.name} left the room`)
      this.update({ status: this.snapshot.status, documentPath: this.snapshot.documentPath, users: this.userNames(), members: this.membersList(), error: this.snapshot.error })
      return
    }
    const previous = this.members.get(presenceId)
    const member: CollaborationMember = {
      presenceId,
      userId: message.userId ?? previous?.userId ?? presenceId,
      name: message.name ?? message.user ?? previous?.name ?? 'Unknown user',
      color: message.color ?? previous?.color ?? stableCollaborationColor(message.userId ?? previous?.userId ?? presenceId),
      status: 'online',
      documentPath: message.documentPath ?? previous?.documentPath ?? '',
      cursor: normalizeAwarenessPosition(message.cursor, Number.MAX_SAFE_INTEGER, previous?.cursor.anchor ?? 0),
      selection: normalizeAwarenessSelection(message.selection, Number.MAX_SAFE_INTEGER, previous?.selection.start ?? 0),
      updatedAt: message.updatedAt ?? Date.now()
    }
    this.members.set(presenceId, member)
    if (!previous) this.recordEvent(`${member.name} is online`)
    this.update({ status: this.snapshot.status, documentPath: this.snapshot.documentPath, users: this.userNames(), members: this.membersList(), error: this.snapshot.error })
    this.renderDecorations()
  }

  private clearRemoteMembers(): void {
    this.members.clear()
    this.clearAllDecorations()
    this.update({ status: this.snapshot.status, documentPath: this.snapshot.documentPath, users: [], members: [], error: this.snapshot.error })
  }

  private currentAwareness(): Pick<AwarenessMessage, 'documentPath' | 'cursor' | 'selection'> {
    const editor = vscode.window.activeTextEditor
    if (!this.document || !editor || editor.document.uri.toString() !== this.document.uri.toString()) {
      return { documentPath: this.snapshot.documentPath, cursor: { anchor: 0, head: 0 }, selection: { start: 0, end: 0 } }
    }
    const selection = editor.selection
    return {
      documentPath: this.snapshot.documentPath,
      cursor: { anchor: editor.document.offsetAt(selection.anchor), head: editor.document.offsetAt(selection.active) },
      selection: { start: editor.document.offsetAt(selection.start), end: editor.document.offsetAt(selection.end) }
    }
  }

  private sendAwareness(status: 'online' | 'update' | 'offline' = 'update'): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    const awareness = this.currentAwareness()
    this.send({ type: 'awareness', status, ...awareness, updatedAt: Date.now() })
  }

  private scheduleAwareness(): void {
    if (!this.document || this.snapshot.status !== 'connected') return
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer)
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = undefined
      this.sendAwareness('update')
    }, AWARENESS_DEBOUNCE_MS)
  }

  private ensureDecorationTypes(member: CollaborationMember): { selection: vscode.TextEditorDecorationType; cursor: vscode.TextEditorDecorationType } {
    const existing = this.decorationTypes.get(member.presenceId)
    if (existing) return existing
    const selection = vscode.window.createTextEditorDecorationType({
      backgroundColor: `${member.color}33`,
      overviewRulerColor: member.color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    })
    const cursor = vscode.window.createTextEditorDecorationType({
      border: `2px solid ${member.color}`,
      borderStyle: 'solid',
      before: { contentText: member.name, color: member.color, margin: '0 0.25em 0 0' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    })
    const types = { selection, cursor }
    this.decorationTypes.set(member.presenceId, types)
    return types
  }

  private renderDecorations(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor || !this.document || editor.document.uri.toString() !== this.document.uri.toString()) {
      this.clearAllDecorations()
      return
    }
    const length = editor.document.getText().length
    const ownUserId = this.auth.currentUser?.id
    const activePresenceIds = new Set<string>()
    for (const member of this.members.values()) {
      if (member.userId === ownUserId || member.status !== 'online' || member.documentPath !== this.snapshot.documentPath) continue
      activePresenceIds.add(member.presenceId)
      const types = this.ensureDecorationTypes(member)
      const start = clampAwarenessOffset(member.selection.start, length)
      const end = clampAwarenessOffset(member.selection.end, length, start)
      const cursor = clampAwarenessOffset(member.cursor.head, length)
      editor.setDecorations(types.selection, start === end ? [] : [new vscode.Range(editor.document.positionAt(Math.min(start, end)), editor.document.positionAt(Math.max(start, end)))])
      editor.setDecorations(types.cursor, [new vscode.Range(editor.document.positionAt(cursor), editor.document.positionAt(cursor))])
    }
    for (const [presenceId, types] of this.decorationTypes) {
      if (!activePresenceIds.has(presenceId)) {
        editor.setDecorations(types.selection, [])
        editor.setDecorations(types.cursor, [])
      }
    }
  }

  private clearMemberDecorations(presenceId: string): void {
    const types = this.decorationTypes.get(presenceId)
    if (!types) return
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(types.selection, [])
      editor.setDecorations(types.cursor, [])
    }
    types.selection.dispose()
    types.cursor.dispose()
    this.decorationTypes.delete(presenceId)
  }

  private clearAllDecorations(): void {
    for (const types of this.decorationTypes.values()) {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(types.selection, [])
        editor.setDecorations(types.cursor, [])
      }
      types.selection.dispose()
      types.cursor.dispose()
    }
    this.decorationTypes.clear()
  }

  async leave(showMessage = true): Promise<void> {
    this.intentionalClose = true
    this.connectionGeneration += 1
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer)
    this.idleTimer = undefined
    this.reconnectTimer = undefined
    this.awarenessTimer = undefined
    this.stopHeartbeat()
    this.sendAwareness('offline')
    this.socket?.close(1000, 'client leaving')
    this.socket = undefined
    this.clearRemoteMembers()
    this.clearAllDecorations()
    this.document = undefined
    this.pendingAutoDocument = undefined
    this.pendingUpdateIds.clear()
    this.pendingSyncUpdateIds.clear()
    this.syncRequestId = undefined
    this.resetYDoc()
    this.update({ status: 'offline', users: [], members: [] })
    this.recordEvent('Left collaboration room')
    if (showMessage) void vscode.window.showInformationMessage('Left PYRo Wiki collaboration.')
  }

  private update(next: Omit<CollaborationSnapshot, 'events'>): void {
    this.snapshot = { ...next, events: [...this.events] }
    this.changeEmitter.fire(this.snapshot)
    this.renderDecorations()
  }

  private recordEvent(message: string, error = this.snapshot.error): void {
    this.events.unshift(`${new Date().toLocaleTimeString()} ${message}`)
    this.events.splice(8)
    this.update({ status: this.snapshot.status, documentPath: this.snapshot.documentPath, users: this.userNames(), members: this.membersList(), error })
  }

  dispose(): void {
    void this.leave(false)
    for (const disposable of this.disposables) disposable.dispose()
    this.clearAllDecorations()
  }
}
