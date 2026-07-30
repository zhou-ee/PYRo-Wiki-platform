import type { AuthProvider } from '../auth/session'

export interface RemoteDocument {
  path: string
  title: string
  content?: string
  revision: number
  updatedAt: string
}

export interface RemoteRevision {
  revision: number
  content: string
  updatedAt: string
  kind?: 'published' | 'draft'
  message?: string
}
export interface WorkspacePublishBatch {
  id: string
  workspaceId: string
  snapshotId: string
  status: 'submitted' | 'approved' | 'rejected' | 'publishing' | 'published' | 'conflict' | 'failed'
  requesterId: string
  reviewerId?: string
  reviewMessage?: string
  githubCommitSha?: string
  githubWorkflowRunId?: string
  errorMessage?: string
  changedCount?: number
  changedDocumentPaths?: string[]
  createdAt: string
  updatedAt: string
}

export interface ConflictResponse {
  local: { content: string; revision: number }
  remote: RemoteDocument
  common: { content: string; revision: number } | null
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

const MAX_NETWORK_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 20_000

function isRetryableMethod(method: string): boolean { return method === 'GET' || method === 'HEAD' }
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly workspaceId: string, private readonly auth?: AuthProvider) {}
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, '')}${path}` }

  private async request<T>(path: string, init: RequestInit = {}, refreshed = false, attempt = 1): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    let token: string | undefined
    try { token = await this.auth?.getAccessToken() } catch (cause) {
      const status = (cause as { status?: number }).status
      if (status === 401) throw new ApiError('Authentication expired', 401, cause)
      throw cause
    }
    if (token) headers.set('authorization', `Bearer ${token}`)
    const method = (init.method ?? 'GET').toUpperCase()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.url(path), { ...init, headers, signal: init.signal ?? controller.signal })
    } catch (cause) {
      if (isRetryableMethod(method) && attempt < MAX_NETWORK_ATTEMPTS) {
        await wait(250 * 2 ** (attempt - 1))
        return this.request<T>(path, init, refreshed, attempt + 1)
      }
      const message = cause instanceof Error && cause.name === 'AbortError' ? 'Request timed out' : 'Network request failed'
      throw new ApiError(message, undefined, cause)
    } finally {
      clearTimeout(timeout)
    }
    const body = await response.json().catch(() => ({})) as T & { error?: string }
    if (response.status === 401 && this.auth && !refreshed) {
      try {
        const refreshedToken = await this.auth.refresh()
        if (refreshedToken) return this.request<T>(path, init, true)
      } catch (cause) {
        throw new ApiError('Authentication expired', 401, cause)
      }
    }
    if (isRetryableMethod(method) && (response.status === 429 || response.status >= 500) && attempt < MAX_NETWORK_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      await wait(retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : 250 * 2 ** (attempt - 1))
      return this.request<T>(path, init, refreshed, attempt + 1)
    }
    if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body)
    return body
  }

  health(): Promise<{ ok: boolean }> { return this.request('/health') }
  me(): Promise<{ user: unknown }> { return this.request('/me') }
  listDocuments(): Promise<{ documents: RemoteDocument[] }> { return this.request(`/documents?workspace=${encodeURIComponent(this.workspaceId)}`) }
  getDocument(path: string): Promise<RemoteDocument> { return this.request(`/documents/${encodeURIComponent(path)}?workspace=${encodeURIComponent(this.workspaceId)}`) }
  putDocument(path: string, content: string, baseRevision: number, message?: string): Promise<RemoteDocument> {
    return this.request(`/documents/${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ workspace: this.workspaceId, content, baseRevision, message }) })
  }
  saveDraft(path: string, content: string, baseRevision: number): Promise<RemoteDocument> {
    return this.request(`/documents/${encodeURIComponent(path)}/drafts`, { method: 'POST', body: JSON.stringify({ workspace: this.workspaceId, content, baseRevision }) })
  }
  revisions(path: string): Promise<{ revisions: RemoteRevision[] }> { return this.request(`/documents/${encodeURIComponent(path)}/revisions?workspace=${encodeURIComponent(this.workspaceId)}`) }
  restoreRevision(path: string, revision: number, baseRevision: number, message?: string): Promise<RemoteDocument> {
    return this.request(`/documents/${encodeURIComponent(path)}/revisions/${revision}/restore?workspace=${encodeURIComponent(this.workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify({ workspace: this.workspaceId, baseRevision, message })
    })
  }
  authors(): Promise<{ authors: unknown[] }> { return this.request('/authors') }
  checkpointWorkspace(fullManifest = false): Promise<{ ok: boolean; workspaceId: string; manifestCount: number; documentPaths: string[]; changedCount?: number; changedDocumentPaths?: string[] }> {
    return this.request(`/workspace-collaboration/${encodeURIComponent(this.workspaceId)}?checkpoint=1${fullManifest ? '&fullManifest=1' : ''}`, { method: 'POST' })
  }
  workspacePublishBatches(): Promise<{ batches: WorkspacePublishBatch[] }> { return this.request(`/workspace-publish-requests?workspace=${encodeURIComponent(this.workspaceId)}`) }
  createWorkspacePublishBatch(): Promise<{ batch: WorkspacePublishBatch }> { return this.request('/workspace-publish-requests', { method: 'POST', body: JSON.stringify({ workspace: this.workspaceId }) }) }
  getWorkspacePublishBatch(id: string): Promise<{ batch: WorkspacePublishBatch }> { return this.request(`/workspace-publish-requests/${encodeURIComponent(id)}`) }
  approveWorkspacePublishBatch(id: string, message?: string): Promise<{ batch: WorkspacePublishBatch }> { return this.request(`/workspace-publish-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ message }) }) }
  rejectWorkspacePublishBatch(id: string, message: string): Promise<{ batch: WorkspacePublishBatch }> { return this.request(`/workspace-publish-requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ message }) }) }
}
