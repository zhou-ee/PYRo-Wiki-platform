import * as Y from 'yjs'
import { reserveD1Budget } from './quota'
import { isIdempotentCreate } from './testable'

export type WorkspaceManifestEntry = {
  path: string
  title: string
  hash: string
  deleted?: boolean
  updatedAt: number
  updatedBy: string
  sidebarLabel?: string
}

export type WorkspacePresence = {
  presenceId: string
  userId: string
  name: string
  color: string
  documentPath: string
  cursor: { anchor: number; head: number }
  selection: { start: number; end: number }
  status: 'online' | 'offline'
  updatedAt: number
  initialized: boolean
}

export type ProvenanceRange = {
  start: number
  end: number
  userId: string
  name: string
  color: string
  updatedAt: number
}

type WorkspaceEnv = {
  DB: D1Database
  REQUEST_QUOTA?: DurableObjectNamespace
  PYRO_ENVIRONMENT?: string
}
type JsonRecord = Record<string, unknown>
type Socket = WebSocket

const PROTOCOL = 2
const SNAPSHOT_DEBOUNCE_MS = 250
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000
const MAX_MESSAGE_BYTES = 4_000_000
const MAX_PATH_BYTES = 512
const MANIFEST_KEY = 'workspace:manifest'
const DELETED_PATHS_KEY = 'workspace:deleted-paths'
const DOC_PREFIX = 'workspace:doc:'
const PROVENANCE_PREFIX = 'workspace:provenance:'
const EMPTY_STATE_VECTOR = new Uint8Array([0])
const COLORS = ['#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444']

function encode(value: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < value.length; i += chunk) binary += String.fromCharCode(...value.subarray(i, i + chunk))
  return btoa(binary)
}
function decode(value: string): Uint8Array { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) }
function stableColor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i += 1) hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0
  return COLORS[Math.abs(hash) % COLORS.length]
}
function isMarkdownPath(value: string): boolean { return value.toLowerCase().endsWith('.md') && !value.includes('..') && !value.startsWith('/') && value.length <= MAX_PATH_BYTES }
export function missingCheckpointPaths(activePaths: Iterable<string>, persistedPaths: Iterable<string>): string[] {
  const active = new Set(activePaths)
  return [...new Set(persistedPaths)].filter((documentPath) => !active.has(documentPath)).sort()
}
export function checkpointDeletionPaths(activePaths: Iterable<string>, persistedPaths: Iterable<string>, tombstones: Iterable<string>, reconcileMissing: boolean): string[] {
  const deleted = new Set(tombstones)
  if (reconcileMissing) for (const documentPath of missingCheckpointPaths(activePaths, persistedPaths)) deleted.add(documentPath)
  return [...deleted].sort()
}
function titleFor(value: string): string { return value.split('/').pop() || value }
function hashText(value: string): string { let hash = 2166136261; for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(16).padStart(8, '0') }
function json(value: JsonRecord, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) }
function keyForPath(prefix: string, path: string): string { return `${prefix}${encodeURIComponent(path)}` }
function ranges(value: unknown, identity: WorkspacePresence, length: number): ProvenanceRange[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as JsonRecord
    const start = typeof record.start === 'number' && Number.isFinite(record.start) ? Math.max(0, Math.min(length, Math.floor(record.start))) : 0
    const end = typeof record.end === 'number' && Number.isFinite(record.end) ? Math.max(start, Math.min(length, Math.floor(record.end))) : start
    return end > start ? [{ start, end, userId: identity.userId, name: identity.name, color: identity.color, updatedAt: Date.now() }] : []
  })
}

export class WorkspaceRoom {
  private readonly docs = new Map<string, Y.Doc>()
  private readonly manifest = new Map<string, WorkspaceManifestEntry>()
  private readonly provenance = new Map<string, ProvenanceRange[]>()
  private readonly socketUsers = new Map<Socket, WorkspacePresence>()
  private readonly pendingAcks = new Map<Socket, Array<{ updateId?: string; operationId?: string }>>()
  private deletedPaths = new Set<string>()
  private loaded = false
  private loading: Promise<void> | undefined
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private persistInFlight: Promise<void> = Promise.resolve()
  private messageQueue: Promise<void> = Promise.resolve()
  private dirty = false
  private checkpointDirty = false
  private readonly dirtyPaths = new Set<string>()
  private manifestVersion = 0
  private currentWorkspaceId = 'default'

  constructor(private readonly state: DurableObjectState, private readonly env: WorkspaceEnv) {}

  private async loadOnce(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      const storedManifest = await this.state.storage.get<WorkspaceManifestEntry[]>(MANIFEST_KEY)
      for (const entry of storedManifest ?? []) if (isMarkdownPath(entry.path)) this.manifest.set(entry.path, entry)
      const storedDeletedPaths = await this.state.storage.get<string[]>(DELETED_PATHS_KEY)
      this.deletedPaths = new Set((storedDeletedPaths ?? []).filter(isMarkdownPath))
      this.manifestVersion = await this.state.storage.get<number>('workspace:manifest-version') ?? 0
      const storedDocs = await this.state.storage.list<ArrayBuffer | Uint8Array>({ prefix: DOC_PREFIX })
      for (const [key, stored] of storedDocs) {
        const path = decodeURIComponent(key.slice(DOC_PREFIX.length))
        if (!isMarkdownPath(path)) continue
        const doc = new Y.Doc()
        if (stored) Y.applyUpdate(doc, stored instanceof Uint8Array ? stored : new Uint8Array(stored))
        this.docs.set(path, doc)
      }
      const storedProvenance = await this.state.storage.list<ProvenanceRange[]>({ prefix: PROVENANCE_PREFIX })
      for (const [key, value] of storedProvenance) {
        const path = decodeURIComponent(key.slice(PROVENANCE_PREFIX.length))
        if (isMarkdownPath(path) && Array.isArray(value)) this.provenance.set(path, value)
      }
      this.loaded = true
    })()
    return this.loading
  }

  private getDoc(path: string): Y.Doc {
    let doc = this.docs.get(path)
    if (!doc) { doc = new Y.Doc(); this.docs.set(path, doc) }
    return doc
  }

  private send(socket: Socket, message: JsonRecord): void { try { socket.send(JSON.stringify({ protocol: PROTOCOL, ...message })) } catch { /* closed */ } }
  private broadcast(message: JsonRecord, except?: Socket): void { for (const socket of this.state.getWebSockets()) if (socket !== except) this.send(socket, message) }
  private error(socket: Socket, message: string, code: string): void { this.send(socket, { type: 'error', code, error: message }) }

  private presenceMessage(presence: WorkspacePresence, status = presence.status): JsonRecord {
    return { type: 'awareness', status, presenceId: presence.presenceId, userId: presence.userId, name: presence.name, color: presence.color, documentPath: presence.documentPath, cursor: presence.cursor, selection: presence.selection, updatedAt: presence.updatedAt }
  }

  private schedulePersist(): void {
    this.dirty = true
    this.checkpointDirty = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.state.waitUntil(this.flushPersist()) }, SNAPSHOT_DEBOUNCE_MS)
    if (this.socketUsers.size > 0) this.state.waitUntil(this.ensureCheckpointAlarm())
  }

  private async ensureCheckpointAlarm(): Promise<void> {
    if (!this.checkpointDirty || this.socketUsers.size === 0) return
    const alarm = await this.state.storage.getAlarm()
    if (!alarm || alarm > Date.now() + CHECKPOINT_INTERVAL_MS) await this.state.storage.setAlarm(Date.now() + CHECKPOINT_INTERVAL_MS)
  }

  private async flushPersist(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    this.persistInFlight = this.persistInFlight.then(async () => {
      const manifest = [...this.manifest.values()]
      await this.state.storage.put(MANIFEST_KEY, manifest)
      if (this.deletedPaths.size) await this.state.storage.put(DELETED_PATHS_KEY, [...this.deletedPaths].sort())
      else await this.state.storage.delete(DELETED_PATHS_KEY)
      await this.state.storage.put('workspace:manifest-version', this.manifestVersion)
      for (const [path, doc] of this.docs) {
        const update = Y.encodeStateAsUpdate(doc)
        await this.state.storage.put(keyForPath(DOC_PREFIX, path), update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer)
      }
      for (const [path, value] of this.provenance) await this.state.storage.put(keyForPath(PROVENANCE_PREFIX, path), value)
      for (const path of this.deletedPaths) {
        await this.state.storage.delete(keyForPath(DOC_PREFIX, path))
        await this.state.storage.delete(keyForPath(PROVENANCE_PREFIX, path))
      }
      for (const [socket, acknowledgements] of this.pendingAcks) {
        for (const acknowledgement of acknowledgements) this.send(socket, { type: 'ack', ...acknowledgement, persisted: true })
        this.pendingAcks.delete(socket)
      }
    })
    try { await this.persistInFlight } catch { this.dirty = true; this.checkpointDirty = true; this.state.waitUntil(this.retryPersist()) }
  }

  private async retryPersist(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 1_000)); await this.flushPersist() }

  private queueAck(socket: Socket, acknowledgement: { updateId?: string; operationId?: string }): void {
    const list = this.pendingAcks.get(socket) ?? []
    list.push(acknowledgement)
    this.pendingAcks.set(socket, list)
  }

  private async checkpointToD1(force = false, reconcileMissing = false): Promise<string[]> {
    if ((!force && !this.checkpointDirty) || !this.env.DB) return []
    const changedDocumentPaths = new Set(this.dirtyPaths)
    await this.flushPersist()
    const active = [...this.manifest.values()]
    let persistedPaths: string[] = []
    if (reconcileMissing) {
      const persisted = await this.env.DB.prepare('SELECT document_path FROM workspace_draft_manifest WHERE workspace_id=? AND deleted=0').bind(this.workspaceId()).all<{ document_path: string }>()
      persistedPaths = (persisted.results ?? []).map((entry) => entry.document_path)
    }
    const reconciledDeletedPaths = checkpointDeletionPaths(active.map((entry) => entry.path), persistedPaths, this.deletedPaths, reconcileMissing)
    for (const documentPath of reconciledDeletedPaths) changedDocumentPaths.add(documentPath)
    const statements: D1PreparedStatement[] = [this.env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)').bind(this.workspaceId(), this.workspaceId())]
    for (const entry of active) {
      statements.push(this.env.DB.prepare('INSERT INTO workspace_draft_manifest (workspace_id, document_path, deleted, sidebar_label, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(workspace_id, document_path) DO UPDATE SET deleted=0, sidebar_label=COALESCE(excluded.sidebar_label, workspace_draft_manifest.sidebar_label), updated_at=excluded.updated_at').bind(this.workspaceId(), entry.path, entry.sidebarLabel ?? null, new Date().toISOString()))
      const content = this.docs.get(entry.path)?.getText('markdown').toString() ?? ''
      const provenanceJson = JSON.stringify(this.provenance.get(entry.path) ?? [])
      statements.push(this.env.DB.prepare(`INSERT INTO document_drafts (workspace_id, document_path, content, content_hash, provenance_json, last_author_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, document_path) DO UPDATE SET content=excluded.content, content_hash=excluded.content_hash,
        provenance_json=excluded.provenance_json, last_author_id=excluded.last_author_id, updated_at=excluded.updated_at`)
        .bind(this.workspaceId(), entry.path, content, hashText(content), provenanceJson, entry.updatedBy, new Date().toISOString()))
    }
    for (const path of reconciledDeletedPaths) {
      statements.push(this.env.DB.prepare('DELETE FROM document_drafts WHERE workspace_id=? AND document_path=?').bind(this.workspaceId(), path))
      statements.push(this.env.DB.prepare('INSERT INTO workspace_draft_manifest (workspace_id, document_path, deleted, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(workspace_id, document_path) DO UPDATE SET deleted=1, updated_at=excluded.updated_at').bind(this.workspaceId(), path, new Date().toISOString()))
    }
    const budget = await reserveD1Budget(this.env, statements.length * 2, statements.length * 2)
    if (budget && !budget.allowed) throw new Error('D1 checkpoint deferred by daily budget guard')
    if (statements.length > 1) await this.env.DB.batch(statements)
    this.checkpointDirty = false
    this.deletedPaths.clear()
    this.dirtyPaths.clear()
    await this.state.storage.delete(DELETED_PATHS_KEY)
    await this.state.storage.deleteAlarm()
    return [...changedDocumentPaths].sort()
  }

  private workspaceId(): string { return this.currentWorkspaceId }

  private savePresence(socket: Socket, presence: WorkspacePresence): void {
    try { socket.serializeAttachment(presence) } catch { /* attachment persistence is best effort */ }
  }

  private restorePresence(socket: Socket): WorkspacePresence | undefined {
    const existing = this.socketUsers.get(socket)
    if (existing) return existing
    let attached: Partial<WorkspacePresence> | null = null
    try { attached = socket.deserializeAttachment() as Partial<WorkspacePresence> | null } catch { /* attachment unavailable */ }
    if (!attached || typeof attached.presenceId !== 'string' || typeof attached.userId !== 'string' || typeof attached.name !== 'string') return undefined
    const presence: WorkspacePresence = {
      presenceId: attached.presenceId,
      userId: attached.userId,
      name: attached.name,
      color: typeof attached.color === 'string' ? attached.color : stableColor(attached.userId),
      documentPath: typeof attached.documentPath === 'string' ? attached.documentPath : '',
      cursor: { anchor: attached.cursor?.anchor ?? 0, head: attached.cursor?.head ?? 0 },
      selection: { start: attached.selection?.start ?? 0, end: attached.selection?.end ?? 0 },
      status: attached.status === 'offline' ? 'offline' : 'online',
      updatedAt: typeof attached.updatedAt === 'number' ? attached.updatedAt : Date.now(),
      initialized: attached.initialized === true
    }
    this.socketUsers.set(socket, presence)
    return presence
  }

  private async hello(socket: Socket, message: JsonRecord, presence: WorkspacePresence): Promise<void> {
    if (presence.initialized) return this.error(socket, 'Duplicate workspace hello is not allowed', 'DUPLICATE_HELLO')
    presence.initialized = true
    this.savePresence(socket, presence)
    if (typeof message.workspaceId === 'string' && message.workspaceId.trim()) this.currentWorkspaceId = message.workspaceId.trim().slice(0, 200)
    const vectors = message.documentStateVectors && typeof message.documentStateVectors === 'object' ? message.documentStateVectors as Record<string, unknown> : {}
    const updates: Array<{ documentPath: string; update: string }> = []
    for (const [path, doc] of this.docs) {
      const raw = typeof vectors[path] === 'string' ? decode(vectors[path] as string) : EMPTY_STATE_VECTOR
      updates.push({ documentPath: path, update: encode(Y.encodeStateAsUpdate(doc, raw)) })
    }
    this.send(socket, { type: 'workspace-sync', manifestVersion: this.manifestVersion, manifest: [...this.manifest.values()], documentUpdates: updates, provenance: Object.fromEntries(this.provenance) })
    for (const member of this.socketUsers.values()) if (member.initialized && member.status === 'online') this.send(socket, this.presenceMessage(member))
    this.broadcast(this.presenceMessage(presence, 'online'), socket)
  }

  private async handleMessage(socket: Socket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) return this.error(socket, 'Workspace message is too large', 'MESSAGE_TOO_LARGE')
    let message: JsonRecord
    try { message = JSON.parse(text) as JsonRecord } catch { return this.error(socket, 'Invalid JSON message', 'INVALID_JSON') }
    const presence = this.restorePresence(socket)
    if (!presence) return this.error(socket, 'Workspace identity unavailable', 'IDENTITY_UNAVAILABLE')
    if (message.type === 'ping') return this.send(socket, { type: 'pong' })
    if (message.type === 'workspace-hello') return this.hello(socket, message, presence)
    if (!presence.initialized) return this.error(socket, 'workspace-hello is required', 'HELLO_REQUIRED')
    if (message.type === 'document-update') {
      const path = typeof message.documentPath === 'string' ? message.documentPath : ''
      if (!isMarkdownPath(path)) return this.error(socket, 'Only Markdown documents can be synchronized', 'MARKDOWN_ONLY')
      const encoded = typeof message.update === 'string' ? decode(message.update) : undefined
      if (!encoded) return this.error(socket, 'Document update is required', 'UPDATE_REQUIRED')
      const doc = this.getDoc(path)
      Y.applyUpdate(doc, encoded)
      const content = doc.getText('markdown').toString()
      if (!this.manifest.has(path)) this.manifest.set(path, { path, title: titleFor(path), hash: hashText(content), updatedAt: Date.now(), updatedBy: presence.userId })
      else { const entry = this.manifest.get(path)!; entry.hash = hashText(content); entry.updatedAt = Date.now(); entry.updatedBy = presence.userId }
      if (Array.isArray(message.provenance)) this.provenance.set(path, ranges(message.provenance, presence, content.length))
      this.dirtyPaths.add(path)
      this.schedulePersist()
      this.broadcast({ type: 'document-update', updateId: typeof message.updateId === 'string' ? message.updateId : undefined, documentPath: path, update: encode(encoded), provenance: this.provenance.get(path) ?? [] }, socket)
      if (typeof message.updateId === 'string') this.queueAck(socket, { updateId: message.updateId })
      return
    }
    if (message.type === 'manifest-op') {
      const operationId = typeof message.operationId === 'string' ? message.operationId : undefined
      const operation = message.operation && typeof message.operation === 'object' ? message.operation as JsonRecord : undefined
      const kind = operation?.kind
      const path = typeof operation?.documentPath === 'string' ? operation.documentPath : ''
      if (!operation || typeof kind !== 'string') return this.error(socket, 'Manifest operation is required', 'OPERATION_REQUIRED')
      if ((kind === 'create' || kind === 'delete') && !isMarkdownPath(path)) return this.error(socket, 'Only Markdown documents can be created or deleted', 'MARKDOWN_ONLY')
      if ((kind === 'rename' || kind === 'move')) {
        const from = typeof operation.from === 'string' ? operation.from : ''
        const to = typeof operation.to === 'string' ? operation.to : ''
        if (!isMarkdownPath(from) || !isMarkdownPath(to)) return this.error(socket, 'Only Markdown documents can be moved', 'MARKDOWN_ONLY')
        if (this.manifest.has(to) && !this.manifest.has(from)) {
          if (operationId) this.queueAck(socket, { operationId })
          return
        }
        if (this.manifest.has(to)) return this.send(socket, { type: 'workspace-conflict', conflictId: operationId ?? crypto.randomUUID(), operation, reason: 'destination-exists' })
        const entry = this.manifest.get(from)
        if (!entry) return this.send(socket, { type: 'workspace-conflict', conflictId: operationId ?? crypto.randomUUID(), operation, reason: 'source-missing' })
        this.manifest.delete(from); entry.path = to; entry.title = titleFor(to); entry.updatedAt = Date.now(); entry.updatedBy = presence.userId; this.manifest.set(to, entry)
        this.deletedPaths.delete(to)
        this.dirtyPaths.add(from); this.dirtyPaths.add(to)
        const doc = this.docs.get(from); if (doc) { this.docs.delete(from); this.docs.set(to, doc) }
        const provenance = this.provenance.get(from); if (provenance) { this.provenance.delete(from); this.provenance.set(to, provenance) }
        this.deletedPaths.add(from)
      } else if (kind === 'create') {
        const content = typeof operation.content === 'string' ? operation.content : ''
        const initialUpdate = typeof operation.initialUpdate === 'string' ? operation.initialUpdate : undefined
        if (this.manifest.has(path)) {
          let incomingContent = content
          if (initialUpdate) {
            try {
              const incomingDoc = new Y.Doc()
              Y.applyUpdate(incomingDoc, decode(initialUpdate))
              incomingContent = incomingDoc.getText('markdown').toString()
            } catch { return this.error(socket, 'Initial Markdown update is invalid', 'INITIAL_UPDATE_INVALID') }
          }
          const existingContent = this.docs.get(path)?.getText('markdown').toString() ?? ''
          if (isIdempotentCreate(existingContent, incomingContent)) {
            const sidebarLabel = typeof operation.sidebarLabel === 'string' && operation.sidebarLabel.trim() ? operation.sidebarLabel.trim() : undefined
            if (sidebarLabel) {
              const entry = this.manifest.get(path)
              if (entry && entry.sidebarLabel !== sidebarLabel) { entry.sidebarLabel = sidebarLabel; entry.updatedAt = Date.now(); entry.updatedBy = presence.userId; this.dirtyPaths.add(path); this.manifestVersion += 1; this.schedulePersist() }
            }
            if (operationId) this.queueAck(socket, { operationId })
            return
          }
          return this.send(socket, { type: 'workspace-conflict', conflictId: operationId ?? crypto.randomUUID(), operation, reason: 'destination-exists' })
        }
        const doc = this.getDoc(path)
        if (initialUpdate) {
          try { Y.applyUpdate(doc, decode(initialUpdate)) }
          catch { return this.error(socket, 'Initial Markdown update is invalid', 'INITIAL_UPDATE_INVALID') }
        } else if (content) {
          // Legacy clients used content plus a separate full document-update. Keep
          // this fallback for old clients; current clients send initialUpdate so
          // the bootstrap is applied exactly once.
          doc.getText('markdown').insert(0, content)
        }
        const canonicalContent = doc.getText('markdown').toString()
        const sidebarLabel = typeof operation.sidebarLabel === 'string' && operation.sidebarLabel.trim() ? operation.sidebarLabel.trim() : undefined
        this.manifest.set(path, { path, title: titleFor(path), hash: hashText(canonicalContent), updatedAt: Date.now(), updatedBy: presence.userId, sidebarLabel })
        this.deletedPaths.delete(path)
        this.dirtyPaths.add(path)
      } else if (kind === 'delete') {
        if (!this.manifest.has(path)) {
          if (operationId) this.queueAck(socket, { operationId })
          return
        }
        this.manifest.delete(path); this.docs.delete(path); this.provenance.delete(path); this.deletedPaths.add(path); this.dirtyPaths.add(path)
      } else return this.error(socket, 'Unknown manifest operation', 'UNKNOWN_OPERATION')
      this.manifestVersion += 1
      this.schedulePersist()
      this.broadcast({ type: 'manifest-op', operationId, operation, manifestVersion: this.manifestVersion }, socket)
      if (operationId) this.queueAck(socket, { operationId })
      return
    }
    if (message.type === 'awareness') {
      presence.documentPath = typeof message.documentPath === 'string' && isMarkdownPath(message.documentPath) ? message.documentPath : ''
      const cursor = message.cursor as JsonRecord | undefined
      const selection = message.selection as JsonRecord | undefined
      const clean = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
      presence.cursor = { anchor: clean(cursor?.anchor, 0), head: clean(cursor?.head, 0) }
      presence.selection = { start: clean(selection?.start, 0), end: clean(selection?.end, 0) }
      presence.updatedAt = Date.now()
      this.savePresence(socket, presence)
      this.broadcast(this.presenceMessage(presence, message.status === 'offline' ? 'offline' : 'online'), socket)
      return
    }
    this.error(socket, 'Unknown workspace message type', 'UNKNOWN_MESSAGE')
  }

  async alarm(): Promise<void> {
    if (!this.checkpointDirty) return
    try { await this.checkpointToD1() }
    catch { await this.state.storage.setAlarm(Date.now() + CHECKPOINT_INTERVAL_MS) }
  }

  async fetch(request: Request): Promise<Response> {
    // The Durable Object can be cold-started for a checkpoint HTTP request
    // without an active WebSocket hello. Restore the route identity first so
    // drafts are never written under the fallback "default" workspace.
    const workspaceId = request.headers.get('x-pyro-workspace-id')?.trim()
    if (workspaceId) this.currentWorkspaceId = workspaceId.slice(0, 200)
    if (request.method === 'POST' && request.headers.get('x-pyro-checkpoint') === '1') {
      await this.messageQueue
      await this.loadOnce()
      this.checkpointDirty = true
      try {
        const changedDocumentPaths = await this.checkpointToD1(true, request.headers.get('x-pyro-full-manifest') === '1')
        return json({ ok: true, workspaceId: this.currentWorkspaceId, manifestCount: this.manifest.size, documentPaths: [...this.manifest.keys()], changedCount: changedDocumentPaths.length, changedDocumentPaths })
      }
      catch (cause) { return json({ ok: false, error: cause instanceof Error ? cause.message : 'Workspace checkpoint failed' }, 503) }
    }
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426)
    const userId = request.headers.get('x-pyro-user-id')
    const userName = request.headers.get('x-pyro-user-name')
    if (!userId || !userName) return json({ error: 'Workspace authentication required' }, 401)
    const pair = new WebSocketPair()
    const presence: WorkspacePresence = { presenceId: crypto.randomUUID(), userId, name: userName, color: stableColor(userId), documentPath: '', cursor: { anchor: 0, head: 0 }, selection: { start: 0, end: 0 }, status: 'online', updatedAt: Date.now(), initialized: false }
    this.savePresence(pair[1], presence)
    this.socketUsers.set(pair[1], presence)
    this.state.acceptWebSocket(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(socket: Socket, message: string | ArrayBuffer): void {
    this.messageQueue = this.messageQueue.then(async () => { await this.loadOnce(); await this.handleMessage(socket, message) }).catch(() => undefined)
    this.state.waitUntil(this.messageQueue)
  }
  webSocketClose(socket: Socket): void {
    const presence = this.restorePresence(socket)
    this.socketUsers.delete(socket)
    this.pendingAcks.delete(socket)
    if (presence) this.broadcast(this.presenceMessage(presence, 'offline'), socket)
    if (this.socketUsers.size === 0) {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined }
      this.state.waitUntil(this.messageQueue.then(() => this.flushPersist()).then(() => this.checkpointToD1()).catch(async () => { await this.state.storage.setAlarm(Date.now() + CHECKPOINT_INTERVAL_MS) }))
    }
  }
  webSocketError(socket: Socket): void { try { socket.close(1011, 'workspace socket error') } catch { /* already closed */ } }
}
