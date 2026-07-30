import type { AuthUser } from './auth'
import { dispatchPagesWorkflow, getGitHubBranchSha, getPagesWorkflowRun, publishGitHubWorkspace, readGitHubFile, readGitHubFileOptional, waitForPagesWorkflowRun, normalizeWorkflowStatus, type GitHubWorkspaceFile } from './github'
import { getRepositoryMetadataValue, type RepositoryEnv } from './repository'
import { ensureNavigationConfig, mergeNavigationIndex, NAVIGATION_BASELINE_PATH, NAVIGATION_HELPER_PATH, NAVIGATION_HELPER_SOURCE, NAVIGATION_INDEX_PATH, parseNavigationIndex } from './navigation'

export type WorkspaceBatchStatus = 'submitted' | 'approved' | 'rejected' | 'publishing' | 'published' | 'conflict' | 'failed'

export interface WorkspaceBatch {
  id: string
  workspaceId: string
  snapshotId: string
  status: WorkspaceBatchStatus
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

type JsonRecord = Record<string, unknown>
type SnapshotComparable = { document_path: string; content_hash: string; deleted: number; sidebar_label?: string | null }
export type WorkspacePublishEnv = RepositoryEnv & { DB: D1Database; PYRO_PUBLISHER_IDS?: string; PYRO_ENVIRONMENT?: string }

function row(value: JsonRecord): WorkspaceBatch {
  return {
    id: String(value.id), workspaceId: String(value.workspace_id), snapshotId: String(value.snapshot_id), status: value.status as WorkspaceBatchStatus,
    requesterId: String(value.requester_id), reviewerId: value.reviewer_id ? String(value.reviewer_id) : undefined,
    reviewMessage: value.review_message ? String(value.review_message) : undefined, githubCommitSha: value.github_commit_sha ? String(value.github_commit_sha) : undefined,
    githubWorkflowRunId: value.github_workflow_run_id ? String(value.github_workflow_run_id) : undefined, errorMessage: value.error_message ? String(value.error_message) : undefined,
    createdAt: String(value.created_at), updatedAt: String(value.updated_at)
  }
}

function canPublish(env: WorkspacePublishEnv, user: AuthUser): boolean {
  if (env.PYRO_ENVIRONMENT !== 'production' && user.id === 'dev-anonymous') return true
  const values = (env.PYRO_PUBLISHER_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return values.includes(user.id) || values.includes(user.openId)
}
export function isWorkspacePublisher(env: WorkspacePublishEnv, user: AuthUser): boolean { return canPublish(env, user) }

export function changedWorkspacePaths(current: SnapshotComparable[], previous: SnapshotComparable[]): string[] {
  const currentMap = new Map(current.map((item) => [item.document_path, item]))
  const previousMap = new Map(previous.map((item) => [item.document_path, item]))
  const paths = new Set([...currentMap.keys(), ...previousMap.keys()])
  return [...paths].filter((path) => {
    const next = currentMap.get(path)
    const old = previousMap.get(path)
    return !next || !old || next.content_hash !== old.content_hash || Boolean(next.deleted) !== Boolean(old.deleted) || (next.sidebar_label ?? null) !== (old.sidebar_label ?? null)
  }).sort()
}

async function lastPublishedSnapshotItems(db: D1Database, workspaceId: string): Promise<SnapshotComparable[]> {
  const result = await db.prepare(`SELECT i.document_path, i.content_hash, i.deleted, i.sidebar_label
    FROM workspace_snapshot_items i
    JOIN workspace_snapshots s ON s.id=i.snapshot_id
    JOIN publish_batches b ON b.snapshot_id=s.id
    WHERE b.workspace_id=? AND b.status='published'
    AND b.updated_at=(SELECT MAX(b2.updated_at) FROM publish_batches b2 WHERE b2.workspace_id=? AND b2.status='published')
    ORDER BY i.document_path`).bind(workspaceId, workspaceId).all<SnapshotComparable>()
  return result.results ?? []
}

async function snapshotChangedPaths(db: D1Database, workspaceId: string, snapshotId: string): Promise<string[]> {
  const current = await db.prepare('SELECT document_path, content_hash, deleted, sidebar_label FROM workspace_snapshot_items WHERE snapshot_id=? ORDER BY document_path').bind(snapshotId).all<SnapshotComparable>()
  return changedWorkspacePaths(current.results ?? [], await lastPublishedSnapshotItems(db, workspaceId))
}

async function withChangeSummary(db: D1Database, batch: WorkspaceBatch): Promise<WorkspaceBatch> {
  const paths = await snapshotChangedPaths(db, batch.workspaceId, batch.snapshotId)
  return { ...batch, changedCount: paths.length, changedDocumentPaths: paths }
}

export async function createWorkspacePublishBatch(db: D1Database, env: WorkspacePublishEnv, user: AuthUser, workspaceId: string): Promise<WorkspaceBatch> {
  const snapshotId = crypto.randomUUID()
  const metadata = await getRepositoryMetadataValue(env)
  const drafts = await db.prepare(`SELECT m.document_path, m.deleted, m.sidebar_label, COALESCE(d.content, '') as content, COALESCE(d.content_hash, '') as content_hash, COALESCE(d.provenance_json, '[]') as provenance_json FROM workspace_draft_manifest m LEFT JOIN document_drafts d ON d.workspace_id=m.workspace_id AND d.document_path=m.document_path WHERE m.workspace_id=? ORDER BY m.document_path`).bind(workspaceId).all<{ document_path: string; deleted: number; sidebar_label: string | null; content: string; content_hash: string; provenance_json: string }>()
  if (!drafts.results?.length) throw new Error('Workspace has no checkpointed Markdown drafts')
  const current = drafts.results.map((draft) => ({ document_path: draft.document_path, content_hash: draft.content_hash, deleted: draft.deleted, sidebar_label: draft.sidebar_label }))
  const changed = new Set(changedWorkspacePaths(current, await lastPublishedSnapshotItems(db, workspaceId)))
  if (!changed.size) throw new Error('Workspace has no unpublished Markdown changes')
  const manifest = drafts.results.map((draft) => ({ path: draft.document_path, hash: draft.content_hash, deleted: Boolean(draft.deleted) }))
  const timestamp = new Date().toISOString()
  const statements: D1PreparedStatement[] = [db.prepare('INSERT INTO workspace_snapshots (id, workspace_id, manifest_json, base_github_sha, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(snapshotId, workspaceId, JSON.stringify(manifest), metadata.commitSha, 'draft', user.id, timestamp, timestamp)]
  for (const draft of drafts.results) statements.push(db.prepare('INSERT INTO workspace_snapshot_items (snapshot_id, document_path, content, content_hash, provenance_json, sidebar_label, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(snapshotId, draft.document_path, draft.content, draft.content_hash, draft.provenance_json, draft.sidebar_label, draft.deleted ? 1 : 0))
  const batchId = crypto.randomUUID()
  statements.push(db.prepare('INSERT INTO publish_batches (id, workspace_id, snapshot_id, status, requester_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(batchId, workspaceId, snapshotId, 'submitted', user.id, timestamp, timestamp))
  for (const draft of drafts.results) if (changed.has(draft.document_path)) statements.push(db.prepare('INSERT INTO publish_batch_items (batch_id, document_path, content_hash) VALUES (?, ?, ?)').bind(batchId, draft.document_path, draft.content_hash))
  await db.batch(statements)
  return (await getWorkspaceBatch(db, batchId))!
}

export async function getWorkspaceBatch(db: D1Database, id: string): Promise<WorkspaceBatch | undefined> {
  const result = await db.prepare('SELECT id, workspace_id, snapshot_id, status, requester_id, reviewer_id, review_message, github_commit_sha, github_workflow_run_id, error_message, created_at, updated_at FROM publish_batches WHERE id=?').bind(id).first<JsonRecord>()
  return result ? withChangeSummary(db, row(result)) : undefined
}

export async function listWorkspaceBatches(db: D1Database, workspaceId: string, env?: WorkspacePublishEnv): Promise<WorkspaceBatch[]> {
  const result = await db.prepare('SELECT id, workspace_id, snapshot_id, status, requester_id, reviewer_id, review_message, github_commit_sha, github_workflow_run_id, error_message, created_at, updated_at FROM publish_batches WHERE workspace_id=? ORDER BY updated_at DESC').bind(workspaceId).all<JsonRecord>()
  const batches = await Promise.all((result.results ?? []).map((value) => withChangeSummary(db, row(value))))
  if (!env) return batches
  const refreshed: WorkspaceBatch[] = []
  for (const batch of batches) refreshed.push(await refreshWorkspaceBatchDeployment(db, env, batch))
  return refreshed
}

export async function refreshWorkspaceBatchDeployment(db: D1Database, env: WorkspacePublishEnv, batch: WorkspaceBatch): Promise<WorkspaceBatch> {
  if (batch.status !== 'publishing' || !batch.githubWorkflowRunId) return batch
  try {
    const run = await getPagesWorkflowRun(env, batch.githubWorkflowRunId)
    const status = normalizeWorkflowStatus(run)
    if (status === 'success') await db.prepare("UPDATE publish_batches SET status='published', error_message=NULL, updated_at=? WHERE id=? AND status='publishing'").bind(new Date().toISOString(), batch.id).run()
    else if (status === 'failure' || status === 'cancelled') await db.prepare("UPDATE publish_batches SET status='failed', error_message=?, updated_at=? WHERE id=? AND status='publishing'").bind(`GitHub Pages workflow ${run.id} did not succeed (${run.conclusion ?? run.status})`, new Date().toISOString(), batch.id).run()
    return (await getWorkspaceBatch(db, batch.id)) ?? batch
  } catch {
    return batch
  }
}

export async function rejectWorkspaceBatch(db: D1Database, env: WorkspacePublishEnv, user: AuthUser, id: string, message: string): Promise<WorkspaceBatch> {
  if (!canPublish(env, user)) throw new Error('Publisher permission required')
  const batch = await getWorkspaceBatch(db, id)
  if (!batch) throw new Error('Workspace publish batch not found')
  const timestamp = new Date().toISOString()
  await db.prepare("UPDATE publish_batches SET status='rejected', reviewer_id=?, review_message=?, updated_at=? WHERE id=?").bind(user.id, message || null, timestamp, id).run()
  return (await getWorkspaceBatch(db, id))!
}

export async function approveWorkspaceBatch(db: D1Database, env: WorkspacePublishEnv, user: AuthUser, id: string, message?: string): Promise<WorkspaceBatch> {
  if (!canPublish(env, user)) throw new Error('Publisher permission required')
  const batch = await getWorkspaceBatch(db, id)
  if (!batch) throw new Error('Workspace publish batch not found')
  if (!['submitted', 'failed'].includes(batch.status)) throw new Error(`Cannot approve workspace batch in ${batch.status} status`)
  const snapshot = await db.prepare('SELECT workspace_id, base_github_sha FROM workspace_snapshots WHERE id=?').bind(batch.snapshotId).first<{ workspace_id: string; base_github_sha: string }>()
  if (!snapshot) throw new Error('Workspace snapshot not found')
  const currentSha = await getGitHubBranchSha(env)
  if (currentSha !== snapshot.base_github_sha) {
    await db.prepare("UPDATE publish_batches SET status='conflict', error_message=?, updated_at=? WHERE id=?").bind('GitHub branch changed before workspace publish', new Date().toISOString(), id).run()
    throw new Error('GitHub branch changed before workspace publish')
  }
  const items = await db.prepare(`SELECT s.document_path, s.content, s.deleted, s.sidebar_label
    FROM publish_batch_items i JOIN workspace_snapshot_items s ON s.snapshot_id=? AND s.document_path=i.document_path
    WHERE i.batch_id=? ORDER BY s.document_path`).bind(batch.snapshotId, id).all<{ document_path: string; content: string; deleted: number; sidebar_label: string | null }>()
  const files: GitHubWorkspaceFile[] = (items.results ?? []).map((item) => ({ path: item.document_path, content: item.content, deleted: Boolean(item.deleted) }))
  const snapshotLabels = await db.prepare('SELECT document_path, sidebar_label, deleted FROM workspace_snapshot_items WHERE snapshot_id=? ORDER BY document_path').bind(batch.snapshotId).all<{ document_path: string; sidebar_label: string | null; deleted: number }>()
  const currentIndex = parseNavigationIndex(await readGitHubFileOptional(env, NAVIGATION_INDEX_PATH))
  const labels = mergeNavigationIndex(currentIndex, snapshotLabels.results ?? [])
  files.push({ path: NAVIGATION_INDEX_PATH, content: `${JSON.stringify(labels, null, 2)}\n`, deleted: false })
  const config = await readGitHubFile(env, '.vitepress/config.mts')
  const navigationConfig = ensureNavigationConfig(config)
  if (navigationConfig.changed) {
    files.push({ path: '.vitepress/config.mts', content: navigationConfig.content, deleted: false })
    files.push({ path: NAVIGATION_BASELINE_PATH, content: navigationConfig.baselineContent, deleted: false })
  }
  files.push({ path: NAVIGATION_HELPER_PATH, content: NAVIGATION_HELPER_SOURCE, deleted: false })
  if (!files.length) throw new Error('Workspace publish batch has no changed Markdown files')
  const timestamp = new Date().toISOString()
  await db.prepare("UPDATE publish_batches SET status='publishing', reviewer_id=?, review_message=?, updated_at=? WHERE id=?").bind(user.id, message || null, timestamp, id).run()
  try {
    const published = await publishGitHubWorkspace(env, files, `docs(workspace): publish ${snapshot.workspace_id}`)
    await db.prepare("UPDATE publish_batches SET status='approved', github_commit_sha=?, updated_at=? WHERE id=?").bind(published.commitSha, new Date().toISOString(), id).run()
    await dispatchPagesWorkflow(env)
    const run = await waitForPagesWorkflowRun(env, published.commitSha)
    if (!run) throw new Error('GitHub Pages workflow was dispatched but its run could not be found')
    const workflowStatus = normalizeWorkflowStatus(run)
    if (workflowStatus === 'success') await db.prepare("UPDATE publish_batches SET status='published', github_workflow_run_id=?, updated_at=? WHERE id=?").bind(run.id, new Date().toISOString(), id).run()
    else if (workflowStatus === 'queued' || workflowStatus === 'in_progress') await db.prepare("UPDATE publish_batches SET status='publishing', github_workflow_run_id=?, updated_at=? WHERE id=?").bind(run.id, new Date().toISOString(), id).run()
    else throw new Error(`GitHub Pages workflow ${run.id} did not succeed (${run.conclusion ?? run.status})`)
  } catch (cause) {
    const messageText = cause instanceof Error ? cause.message : String(cause)
    await db.prepare("UPDATE publish_batches SET status='failed', error_message=?, updated_at=? WHERE id=?").bind(messageText, new Date().toISOString(), id).run()
    throw cause
  }
  return (await getWorkspaceBatch(db, id))!
}
