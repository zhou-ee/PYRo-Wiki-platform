import * as Y from 'yjs'
import { authenticateRequest, handleAuthRequest, isAuthResponse, type AuthEnv, type AuthUser } from './auth'
import { decideRevisionWrite, isRevisionConstraintError } from './testable'
import { fetchRepositoryArchive, fetchRepositoryMetadata, type RepositoryEnv } from './repository'
import { approveAndPublish, createPublishRequest, getCurrentPublishRequest, getPublishRequest, isPublisher, listPublishRequests, refreshPublishDeployment, rejectPublishRequest, retryPublishRequest } from './publishRequests'
import { enforceDailyQuota, RequestQuota } from './quota'
import { WorkspaceRoom } from './workspaceRoom'
import { approveWorkspaceBatch, createWorkspacePublishBatch, getWorkspaceBatch, isWorkspacePublisher, listWorkspaceBatches, refreshWorkspaceBatchDeployment, rejectWorkspaceBatch } from './workspacePublish'

export interface Env extends AuthEnv, RepositoryEnv {
  COLLABORATION_ROOM: DurableObjectNamespace
  WORKSPACE_ROOM: DurableObjectNamespace
  REQUEST_QUOTA: DurableObjectNamespace
}

type JsonRecord = Record<string, unknown>
const MAX_REQUEST_BYTES = 2_000_000
const MAX_COLLAB_MESSAGE_BYTES = 4_000_000

function json(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS' } })
}
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}
function error(message: string, status = 400): Response { return json({ error: message }, status) }
function now(): string { return new Date().toISOString() }
function idFor(workspace: string, path: string): string { return `${workspace}:${path}` }
function normalizePath(value: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return '' }
  return decoded.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/(^|\/)\.\.(?=\/|$)/g, '').replace(/^\/+/, '').trim()
}
function titleFor(path: string): string { return path.split('/').pop() || path }

async function body<T extends JsonRecord>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_REQUEST_BYTES) throw new Error('Document exceeds the 2 MB limit')
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) throw new Error('Document exceeds the 2 MB limit')
  try { return JSON.parse(raw) as T } catch { throw new Error('Invalid JSON request body') }
}

async function ensureWorkspace(db: D1Database, workspace: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)').bind(workspace, workspace).run()
}

async function ensureDocument(db: D1Database, workspace: string, documentPath: string): Promise<void> {
  await ensureWorkspace(db, workspace)
  await db.prepare('INSERT OR IGNORE INTO documents (id, workspace_id, path, title) VALUES (?, ?, ?, ?)').bind(idFor(workspace, documentPath), workspace, documentPath, titleFor(documentPath)).run()
}

async function readDocument(db: D1Database, workspace: string, documentPath: string): Promise<JsonRecord> {
  const row = await db.prepare(`SELECT d.path, d.title, d.current_revision as revision, d.updated_at as updatedAt,
      COALESCE(r.content, '') as content
      FROM documents d LEFT JOIN revisions r ON r.document_id=d.id AND r.revision=d.current_revision
      WHERE d.id=?`).bind(idFor(workspace, documentPath)).first<JsonRecord>()
  if (!row) throw new Error('Document not found')
  return row
}

async function listDocuments(db: D1Database, workspace: string): Promise<JsonRecord[]> {
  await ensureWorkspace(db, workspace)
  const result = await db.prepare(`SELECT d.path, d.title, d.current_revision as revision, d.updated_at as updatedAt
      FROM documents d
      WHERE d.workspace_id=? ORDER BY d.path`).bind(workspace).all<JsonRecord>()
  return result.results ?? []
}

async function revisionConflict(db: D1Database, workspace: string, documentPath: string, content: string, baseRevision: number): Promise<Response> {
  const remote = await readDocument(db, workspace, documentPath)
  const common = baseRevision > 0 ? await db.prepare(`SELECT content, revision, created_at as updatedAt FROM revisions WHERE document_id=? AND revision=?`).bind(idFor(workspace, documentPath), baseRevision).first<JsonRecord>() : null
  return json({ error: 'Document changed remotely', local: { content, revision: baseRevision }, remote, common }, 409)
}

async function writeDocument(db: D1Database, workspace: string, documentPath: string, content: string, baseRevision: number, kind: 'published' | 'draft', authorId: string, message?: string): Promise<JsonRecord | Response> {
  await ensureDocument(db, workspace, documentPath)
  const current = await db.prepare(`SELECT d.current_revision as revision, r.content
      FROM documents d LEFT JOIN revisions r ON r.document_id=d.id AND r.revision=d.current_revision
      WHERE d.id=?`).bind(idFor(workspace, documentPath)).first<{ revision: number; content?: string }>()
  const revision = Number(current?.revision ?? 0)
  if (kind === 'draft' && revision > 0 && current?.content === content && revision === baseRevision) return readDocument(db, workspace, documentPath)
  const decision = decideRevisionWrite(revision, baseRevision)
  if (decision.kind === 'conflict') return revisionConflict(db, workspace, documentPath, content, baseRevision)
  const next = decision.nextRevision!
  const documentId = idFor(workspace, documentPath)
  const revisionId = crypto.randomUUID()
  await db.batch([
    db.prepare('INSERT INTO revisions (id, document_id, revision, content, kind, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(revisionId, documentId, next, content, kind, message ?? null, authorId, now()),
    db.prepare('UPDATE documents SET current_revision=?, updated_at=? WHERE id=?').bind(next, now(), documentId)
  ])
  return readDocument(db, workspace, documentPath)
}

type CollaborationCursor = { anchor: number; head: number }
type CollaborationSelection = { start: number; end: number }
type SocketPresence = {
  presenceId: string
  userId: string
  name: string
  color: string
  status: 'online' | 'offline'
  documentPath: string
  cursor: CollaborationCursor
  selection: CollaborationSelection
  updatedAt: number
  initialized: boolean
}

const COLLABORATION_PROTOCOL_VERSION = 1
const COLLABORATION_SNAPSHOT_DEBOUNCE_MS = 250
const EMPTY_YJS_STATE_VECTOR = new Uint8Array([0])
const COLLABORATION_COLORS = [
  '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444'
]

function collaborationColor(userId: string): string {
  let hash = 0
  for (let index = 0; index < userId.length; index += 1) hash = ((hash << 5) - hash + userId.charCodeAt(index)) | 0
  return COLLABORATION_COLORS[Math.abs(hash) % COLLABORATION_COLORS.length]
}

function clampInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

export class CollaborationRoom {
  private readonly doc = new Y.Doc()
  private loaded = false
  private loading: Promise<void> | undefined
  private readonly socketUsers = new Map<WebSocket, SocketPresence>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private persistInFlight: Promise<void> = Promise.resolve()
  private persistDirty = false

  constructor(private readonly state: DurableObjectState, _env: Env) {}

  private loadOnce(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.state.storage.get<ArrayBuffer>('yjs-state').then((stored) => {
      if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored))
      this.loaded = true
    })
    return this.loading
  }

  private schedulePersist(): void {
    this.persistDirty = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.state.waitUntil(this.flushPersist())
    }, COLLABORATION_SNAPSHOT_DEBOUNCE_MS)
  }

  private async flushPersist(): Promise<void> {
    if (!this.persistDirty) return
    this.persistDirty = false
    const encoded = Y.encodeStateAsUpdate(this.doc)
    const snapshot = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
    this.persistInFlight = this.persistInFlight.then(() => this.state.storage.put('yjs-state', snapshot))
    try {
      await this.persistInFlight
    } catch {
      this.persistDirty = true
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = undefined
          this.state.waitUntil(this.flushPersist())
        }, 1_000)
      }
    }
  }

  private broadcast(message: JsonRecord, except?: WebSocket): void {
    const encoded = JSON.stringify(message)
    for (const socket of this.state.getWebSockets()) if (socket !== except) {
      try { socket.send(encoded) } catch { socket.close(1011, 'broadcast failed') }
    }
  }

  private presenceMessage(presence: SocketPresence, status = presence.status): JsonRecord {
    return {
      type: 'awareness',
      protocol: COLLABORATION_PROTOCOL_VERSION,
      presenceId: presence.presenceId,
      userId: presence.userId,
      user: presence.name,
      name: presence.name,
      color: presence.color,
      status,
      documentPath: presence.documentPath,
      cursor: presence.cursor,
      selection: presence.selection,
      updatedAt: presence.updatedAt
    }
  }

  private sendError(server: WebSocket, error: string, code = 'COLLABORATION_ERROR'): void {
    try { server.send(JSON.stringify({ type: 'error', protocol: COLLABORATION_PROTOCOL_VERSION, code, error })) } catch { /* socket already closed */ }
  }

  private applyUpdate(update: Uint8Array, except: WebSocket, id?: string): void {
    Y.applyUpdate(this.doc, update)
    this.schedulePersist()
    this.broadcast({ type: 'update', protocol: COLLABORATION_PROTOCOL_VERSION, id, update: toBase64(update) }, except)
  }

  private async handleMessage(server: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      const rawText = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      if (new TextEncoder().encode(rawText).byteLength > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration message is too large')
      const message = JSON.parse(rawText) as JsonRecord
      const presence = this.socketUsers.get(server)
      if (!presence) return this.sendError(server, 'Collaboration identity unavailable', 'IDENTITY_UNAVAILABLE')

      if (message.type === 'ping') {
        server.send(JSON.stringify({ type: 'pong', protocol: COLLABORATION_PROTOCOL_VERSION }))
        return
      }

      if (message.type === 'hello') {
        if (presence.initialized) return this.sendError(server, 'Duplicate hello is not allowed', 'DUPLICATE_HELLO')
        presence.initialized = true

        // Keep compatibility with 0.1.8 clients while new clients use stateVector.
        if (typeof message.state === 'string') {
          if (message.state.length > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration state is too large')
          const legacyUpdate = fromBase64(message.state)
          Y.applyUpdate(this.doc, legacyUpdate)
          this.schedulePersist()
        }

        const clientStateVector = typeof message.stateVector === 'string' ? fromBase64(message.stateVector) : EMPTY_YJS_STATE_VECTOR
        const serverStateVector = Y.encodeStateVector(this.doc)
        const missingForClient = Y.encodeStateAsUpdate(this.doc, clientStateVector)
        server.send(JSON.stringify({
          type: 'sync',
          protocol: COLLABORATION_PROTOCOL_VERSION,
          update: toBase64(missingForClient),
          stateVector: toBase64(serverStateVector)
        }))

        for (const [socket, member] of this.socketUsers) {
          if (member.initialized && member.status === 'online') server.send(JSON.stringify(this.presenceMessage(member)))
          if (socket === server) break
        }
        this.broadcast(this.presenceMessage(presence, 'online'), server)
        return
      }

      if (!presence.initialized) return this.sendError(server, 'hello is required before collaboration messages', 'HELLO_REQUIRED')

      if (message.type === 'sync' && typeof message.update === 'string') {
        if (message.update.length > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration update is too large')
        const update = fromBase64(message.update)
        if (update.byteLength > 0) this.applyUpdate(update, server, typeof message.id === 'string' ? message.id : undefined)
        server.send(JSON.stringify({ type: 'ack', protocol: COLLABORATION_PROTOCOL_VERSION, id: message.id ?? 'sync' }))
        return
      }

      if (message.type === 'update' && typeof message.update === 'string') {
        if (message.update.length > MAX_COLLAB_MESSAGE_BYTES) throw new Error('Collaboration update is too large')
        this.applyUpdate(fromBase64(message.update), server, typeof message.id === 'string' ? message.id : undefined)
        server.send(JSON.stringify({ type: 'ack', protocol: COLLABORATION_PROTOCOL_VERSION, id: message.id }))
        return
      }

      if (message.type === 'awareness') {
        const status = message.status === 'offline' ? 'offline' : 'online'
        presence.status = status
        if (typeof message.documentPath === 'string') presence.documentPath = message.documentPath.slice(0, 512)
        const cursor = message.cursor as JsonRecord | undefined
        const selection = message.selection as JsonRecord | undefined
        presence.cursor = {
          anchor: clampInteger(cursor?.anchor, presence.cursor.anchor),
          head: clampInteger(cursor?.head, presence.cursor.head)
        }
        presence.selection = {
          start: clampInteger(selection?.start, presence.selection.start),
          end: clampInteger(selection?.end, presence.selection.end)
        }
        presence.updatedAt = Date.now()
        this.broadcast(this.presenceMessage(presence, status), server)
        return
      }

      this.sendError(server, 'Unknown collaboration message type', 'UNKNOWN_MESSAGE')
    } catch (cause) {
      this.sendError(server, cause instanceof Error ? cause.message : 'Invalid collaboration message')
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426)
    const userId = request.headers.get('x-pyro-user-id')
    const userName = request.headers.get('x-pyro-user-name')
    if (!userId || !userName) return json({ error: 'Collaboration authentication required' }, 401)
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.socketUsers.set(server, {
      presenceId: crypto.randomUUID(),
      userId,
      name: userName,
      color: collaborationColor(userId),
      status: 'online',
      documentPath: '',
      cursor: { anchor: 0, head: 0 },
      selection: { start: 0, end: 0 },
      updatedAt: Date.now(),
      initialized: false
    })
    this.state.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(server: WebSocket, message: string | ArrayBuffer): void {
    this.state.waitUntil(this.loadOnce().then(() => this.handleMessage(server, message)))
  }

  webSocketClose(server: WebSocket): void {
    const presence = this.socketUsers.get(server)
    this.socketUsers.delete(server)
    if (presence) this.broadcast(this.presenceMessage(presence, 'offline'), server)
    if (this.socketUsers.size === 0) {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined }
      this.state.waitUntil(this.flushPersist())
    }
  }

  webSocketError(server: WebSocket): void {
    try { server.close(1011, 'socket error') } catch { /* already closed */ }
  }
}
function toBase64(value: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < value.length; offset += chunkSize) binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize))
  return btoa(binary)
}
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const quotaResponse = await enforceDailyQuota(request, env)
    if (quotaResponse) return quotaResponse
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS' } })
    const authResponse = await handleAuthRequest(request, env)
    if (authResponse) return authResponse
    const url = new URL(request.url)
    if (url.pathname === '/repository/archive' && request.method === 'GET') {
      return fetchRepositoryArchive(env)
    }
    if (url.pathname === '/repository/metadata' && request.method === 'GET') {
      return fetchRepositoryMetadata(env)
    }
    if (url.pathname === '/' && request.method === 'GET') {
      const repositoryUrl = env.PYRO_GITHUB_REPOSITORY_URL || 'https://github.com/zhou-ee/PYRo-Wiki'
      return html(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PYRo Wiki API</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6e6e6;background:#111827}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,#24456a 0,#111827 45%,#080b12 100%)}
    main{width:min(720px,calc(100% - 40px));padding:36px;border:1px solid #334155;border-radius:20px;background:rgba(15,23,42,.88);box-shadow:0 24px 80px rgba(0,0,0,.35)}
    h1{margin:0 0 10px;font-size:32px}p{color:#aab5c5;line-height:1.7}.badge{display:inline-block;padding:5px 10px;border-radius:999px;background:#164e63;color:#67e8f9;font-size:13px}
    .links{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:24px}.links a{display:block;padding:14px 16px;border:1px solid #334155;border-radius:12px;color:#dbeafe;text-decoration:none;background:#172033}.links a:hover{border-color:#60a5fa;background:#1e293b}.links small{display:block;margin-top:5px;color:#94a3b8}
    code{color:#bae6fd}
  </style>
</head>
<body><main>
  <span class="badge">Production Worker - ${env.PYRO_ENVIRONMENT || 'unknown'}</span>
  <h1>PYRo Wiki API</h1>
  <p>This is the PYRo Wiki API gateway. The VS Code extension uses this Worker for repository sync, D1 documents, collaboration, and publishing.</p>
  <p>GitHub source repository: <code>${repositoryUrl}</code></p>
  <div class="links">
    <a href="/health">Health check<small>Worker and D1 status</small></a>
    <a href="/repository/metadata">Repository metadata<small>main branch and commit SHA</small></a>
    <a href="/auth/feishu/start">Feishu login<small>Start OAuth login</small></a>
    <a href="https://zhou-ee.github.io/PYRo-Wiki/">Open Wiki<small>GitHub Pages documentation site</small></a>
  </div>
</main></body></html>`)
    }
    if (url.pathname === '/health') {
      try {
        await env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>()
        return json({ ok: true, database: 'ok', environment: env.PYRO_ENVIRONMENT, authMode: env.PYRO_AUTH_MODE, time: now() })
      } catch {
        return json({ ok: false, database: 'unavailable', environment: env.PYRO_ENVIRONMENT, authMode: env.PYRO_AUTH_MODE, time: now() }, 503)
      }
    }
    const authenticated = await authenticateRequest(request, env)
    if (isAuthResponse(authenticated)) return authenticated
    if (url.pathname === '/publish-requests/current' && request.method === 'GET') {
      const workspace = url.searchParams.get('workspace') || 'default'
      const documentPath = normalizePath(url.searchParams.get('documentPath') || '')
      const revisionParam = url.searchParams.get('revision')
      const revision = revisionParam ? Number(revisionParam) : undefined
      if (!documentPath) return error('documentPath is required')
      if (revisionParam && (!Number.isInteger(revision) || revision! < 1)) return error('revision must be a positive integer')
      return json({ request: await getCurrentPublishRequest(env.DB, env, authenticated, { workspace, documentPath, revision }) })
    }
    if (url.pathname === '/publish-requests' && request.method === 'GET') {
      const workspace = url.searchParams.get('workspace') || 'default'
      return json({ requests: await listPublishRequests(env.DB, authenticated, env, workspace) })
    }
    if (url.pathname === '/publish-requests' && request.method === 'POST') {
      try {
        const input = await body<{ workspace?: string; documentPath?: string; revision?: number }>(request)
        const workspace = input.workspace || url.searchParams.get('workspace') || 'default'
        const documentPath = normalizePath(input.documentPath || '')
        if (!documentPath || typeof input.revision !== 'number' || input.revision < 1) return error('documentPath and positive numeric revision are required')
        return json({ request: await createPublishRequest(env.DB, env, authenticated, { workspace, documentPath, revision: input.revision }) }, 201)
      } catch (cause) { return error(cause instanceof Error ? cause.message : 'Could not create publish request', 400) }
    }
    const publishMatch = url.pathname.match(/^\/publish-requests\/([^/]+)(?:\/(approve|reject|retry))?$/)
    if (publishMatch) {
      const requestId = decodeURIComponent(publishMatch[1])
      const action = publishMatch[2]
      const existing = await getPublishRequest(env.DB, requestId)
      if (!existing) return error('Publish request not found', 404)
      if (!isPublisher(env, authenticated) && existing.requesterId !== authenticated.id) return error('Publish request access denied', 403)
      try {
        if (request.method === 'GET' && !action) return json({ request: await refreshPublishDeployment(env.DB, env, existing) })
        if (request.method !== 'POST' || !action) return error('Method not allowed', 405)
        const input = await body<{ message?: string }>(request)
        if (action === 'approve') return json({ request: await approveAndPublish(env.DB, env, authenticated, requestId, input.message) })
        if (action === 'reject') return json({ request: await rejectPublishRequest(env.DB, env, authenticated, requestId, input.message || '') })
        if (action === 'retry') return json({ request: await retryPublishRequest(env.DB, env, authenticated, requestId) })
        return error('Unknown publish request action', 404)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Publish request operation failed'
        const status = /permission required|access denied/i.test(message) ? 403 : /conflict|changed before/i.test(message) ? 409 : /not configured|GitHub API|GitHub App/i.test(message) ? 502 : 400
        return error(message, status)
      }
    }
    if (url.pathname === '/authors' && request.method === 'GET') {
      const authors = await env.DB.prepare('SELECT id, name, avatar, title, description, links_json as links FROM authors ORDER BY name').all<JsonRecord>()
      return json({ authors: authors.results ?? [] })
    }
    if (url.pathname === '/workspace-publish-requests' && request.method === 'GET') {
      const workspace = url.searchParams.get('workspace') || 'default'
      return json({ batches: await listWorkspaceBatches(env.DB, workspace, env) as unknown as JsonRecord[] })
    }
    if (url.pathname === '/workspace-publish-requests' && request.method === 'POST') {
      try {
        const input = await body<{ workspace?: string }>(request)
        return json({ batch: await createWorkspacePublishBatch(env.DB, env, authenticated, input.workspace || 'default') as unknown as JsonRecord })
      } catch (cause) { return error(cause instanceof Error ? cause.message : 'Workspace publish batch creation failed', 400) }
    }
    const workspacePublishMatch = url.pathname.match(/^\/workspace-publish-requests\/([^/]+)(?:\/(approve|reject))?$/)
    if (workspacePublishMatch) {
      const batchId = decodeURIComponent(workspacePublishMatch[1])
      try {
        if (request.method === 'GET' && !workspacePublishMatch[2]) {
          const batch = await getWorkspaceBatch(env.DB, batchId)
          if (!batch) return error('Workspace publish batch not found', 404)
          const refreshed = await refreshWorkspaceBatchDeployment(env.DB, env, batch)
          return json({ batch: refreshed as unknown as JsonRecord })
        }
        if (request.method !== 'POST' || !workspacePublishMatch[2]) return error('Method not allowed', 405)
        const input = await body<{ message?: string }>(request)
        if (workspacePublishMatch[2] === 'approve') return json({ batch: await approveWorkspaceBatch(env.DB, env, authenticated, batchId, input.message) as unknown as JsonRecord })
        return json({ batch: await rejectWorkspaceBatch(env.DB, env, authenticated, batchId, input.message || '') as unknown as JsonRecord })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Workspace publish batch failed'
        const status = /permission required/i.test(message) ? 403 : /not found/i.test(message) ? 404 : /conflict|changed before/i.test(message) ? 409 : 400
        return error(message, status)
      }
    }
    if (url.pathname.startsWith('/workspace-collaboration/')) {
      const workspace = decodeURIComponent(url.pathname.slice('/workspace-collaboration/'.length)).trim() || 'default'
      const id = env.WORKSPACE_ROOM.idFromName(workspace)
      if (request.method === 'POST' && url.searchParams.get('checkpoint') === '1' && env.PYRO_ENVIRONMENT === 'production' && !isWorkspacePublisher(env, authenticated)) return error('Publisher permission required', 403)
      const forwarded = new Request(request, { headers: new Headers(request.headers) })
      forwarded.headers.set('x-pyro-user-id', authenticated.id)
      forwarded.headers.set('x-pyro-user-name', authenticated.name)
      forwarded.headers.set('x-pyro-workspace-id', workspace)
      if (request.method === 'POST' && url.searchParams.get('checkpoint') === '1') forwarded.headers.set('x-pyro-checkpoint', '1')
      if (request.method === 'POST' && url.searchParams.get('fullManifest') === '1') forwarded.headers.set('x-pyro-full-manifest', '1')
      return env.WORKSPACE_ROOM.get(id).fetch(forwarded)
    }
    if (url.pathname.startsWith('/collaboration/')) {
      const documentPath = normalizePath(url.pathname.slice('/collaboration/'.length))
      if (!documentPath) return error('Document path is required')
      const workspace = url.searchParams.get('workspace') || 'default'
      const id = env.COLLABORATION_ROOM.idFromName(idFor(workspace, documentPath))
      const forwarded = new Request(request, { headers: new Headers(request.headers) })
      forwarded.headers.set('x-pyro-user-id', authenticated.id)
      forwarded.headers.set('x-pyro-user-name', authenticated.name)
      return env.COLLABORATION_ROOM.get(id).fetch(forwarded)
    }
    if (url.pathname === '/documents' && request.method === 'GET') {
      const workspace = url.searchParams.get('workspace') || 'default'
      return json({ documents: await listDocuments(env.DB, workspace) })
    }
    if (url.pathname.startsWith('/documents/')) {
      const suffix = url.pathname.slice('/documents/'.length)
      const restoreMatch = suffix.match(/^(.*)\/revisions\/([1-9]\d*)\/restore$/)
      const isRestore = Boolean(restoreMatch)
      const isDraft = suffix.endsWith('/drafts')
      const isRevisions = suffix.endsWith('/revisions')
      const rawPath = isRestore ? restoreMatch![1] : isDraft || isRevisions ? suffix.slice(0, suffix.lastIndexOf('/')) : suffix
      const documentPath = normalizePath(rawPath)
      const workspace = url.searchParams.get('workspace') || 'default'
      if (!documentPath) return error('Document path is required')
      if (request.method === 'GET' && isRevisions) {
        const document = await env.DB.prepare('SELECT id FROM documents WHERE id=?').bind(idFor(workspace, documentPath)).first<{ id: string }>()
        if (!document) return error('Document not found', 404)
        const revisions = await env.DB.prepare('SELECT revision, content, kind, message, created_at as updatedAt FROM revisions WHERE document_id=? ORDER BY revision DESC').bind(idFor(workspace, documentPath)).all<JsonRecord>()
        return json({ revisions: revisions.results ?? [] })
      }
      if (request.method === 'POST' && isRestore) {
        let input: { workspace?: string; baseRevision?: number; message?: string } | undefined
        let selectedWorkspace = workspace
        try {
          input = await body<{ workspace?: string; baseRevision?: number; message?: string }>(request)
          selectedWorkspace = input.workspace || workspace
          if (typeof input.baseRevision !== 'number') return error('numeric baseRevision is required')
          const historicalRevision = Number(restoreMatch![2])
          const historical = await env.DB.prepare('SELECT content FROM revisions WHERE document_id=? AND revision=?').bind(idFor(selectedWorkspace, documentPath), historicalRevision).first<{ content: string }>()
          if (!historical) return error('Revision not found', 404)
          const result = await writeDocument(env.DB, selectedWorkspace, documentPath, historical.content, input.baseRevision, 'published', authenticated.id, input.message ?? `Restored revision ${historicalRevision}`)
          return result instanceof Response ? result : json(result)
        } catch (cause) {
          if (isRevisionConstraintError(cause)) return revisionConflict(env.DB, selectedWorkspace, documentPath, '', input?.baseRevision ?? 0)
          return error(cause instanceof Error ? cause.message : 'Invalid request')
        }
      }
      if (request.method === 'GET') {
        try { return json(await readDocument(env.DB, workspace, documentPath)) }
        catch (cause) { if (cause instanceof Error && cause.message === 'Document not found') return error('Document not found', 404); throw cause }
      }
      if (request.method === 'PUT' || (request.method === 'POST' && isDraft)) {
        let input: { workspace?: string; content?: string; baseRevision?: number; message?: string } | undefined
        let selectedWorkspace = workspace
        try {
          input = await body<{ workspace?: string; content?: string; baseRevision?: number; message?: string }>(request)
          selectedWorkspace = input.workspace || workspace
          if (typeof input.content !== 'string' || typeof input.baseRevision !== 'number') return error('content and numeric baseRevision are required')
          const result = await writeDocument(env.DB, selectedWorkspace, documentPath, input.content, input.baseRevision, isDraft ? 'draft' : 'published', authenticated.id, input.message)
          return result instanceof Response ? result : json(result)
        } catch (cause) {
          if (isRevisionConstraintError(cause)) return revisionConflict(env.DB, selectedWorkspace, documentPath, input?.content ?? '', input?.baseRevision ?? 0)
          return error(cause instanceof Error ? cause.message : 'Invalid request')
        }
      }
    }
    return error('Not found', 404)
  }
}

export { RequestQuota, WorkspaceRoom }
