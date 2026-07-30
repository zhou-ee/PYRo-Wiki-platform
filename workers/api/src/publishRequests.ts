import type { AuthUser } from './auth'
import { dispatchPagesWorkflow, waitForPagesWorkflowRun, getGitHubBranchSha, getPagesWorkflowRun, GitHubPublishError, normalizeWorkflowStatus, publishGitHubFile } from './github'
import { getRepositoryMetadataValue, type RepositoryEnv } from './repository'
import { canPublish } from './permissions'

export type PublishStatus = 'draft' | 'submitted' | 'approved' | 'publishing' | 'published' | 'rejected' | 'conflict' | 'failed'
export type DeploymentStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'unknown'

export interface PublishRequestRow {
  id: string
  workspaceId: string
  documentPath: string
  revision: number
  baseGithubSha: string
  requesterId: string
  status: PublishStatus
  reviewBy?: string
  reviewMessage?: string
  githubCommitSha?: string
  githubWorkflowRunId?: string
  deploymentStatus?: DeploymentStatus
  deploymentUrl?: string
  deploymentError?: string
  deploymentCheckedAt?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
  submittedAt?: string
  approvedAt?: string
  publishedAt?: string
  deployedAt?: string
}

interface PublishEnv extends RepositoryEnv { PYRO_PUBLISHER_IDS?: string; PYRO_ENVIRONMENT?: string }
type JsonRecord = Record<string, unknown>

function row(value: JsonRecord): PublishRequestRow {
  return {
    id: String(value.id), workspaceId: String(value.workspaceId), documentPath: String(value.documentPath), revision: Number(value.revision),
    baseGithubSha: String(value.baseGithubSha), requesterId: String(value.requesterId), status: value.status as PublishStatus,
    reviewBy: value.reviewBy ? String(value.reviewBy) : undefined, reviewMessage: value.reviewMessage ? String(value.reviewMessage) : undefined,
    githubCommitSha: value.githubCommitSha ? String(value.githubCommitSha) : undefined,
    githubWorkflowRunId: value.githubWorkflowRunId ? String(value.githubWorkflowRunId) : undefined,
    deploymentStatus: value.deploymentStatus ? value.deploymentStatus as DeploymentStatus : undefined,
    deploymentUrl: value.deploymentUrl ? String(value.deploymentUrl) : undefined,
    deploymentError: value.deploymentError ? String(value.deploymentError) : undefined,
    deploymentCheckedAt: value.deploymentCheckedAt ? String(value.deploymentCheckedAt) : undefined,
    errorMessage: value.errorMessage ? String(value.errorMessage) : undefined,
    createdAt: String(value.createdAt), updatedAt: String(value.updatedAt), submittedAt: value.submittedAt ? String(value.submittedAt) : undefined,
    approvedAt: value.approvedAt ? String(value.approvedAt) : undefined, publishedAt: value.publishedAt ? String(value.publishedAt) : undefined,
    deployedAt: value.deployedAt ? String(value.deployedAt) : undefined
  }
}

export function isPublisher(env: PublishEnv, user: AuthUser): boolean { return canPublish(env, user) }

function selectSql(where: string): string {
  return `SELECT id, workspace_id as workspaceId, document_path as documentPath, revision, base_github_sha as baseGithubSha,
    requester_id as requesterId, status, review_by as reviewBy, review_message as reviewMessage,
    github_commit_sha as githubCommitSha, github_workflow_run_id as githubWorkflowRunId,
    deployment_status as deploymentStatus, deployment_url as deploymentUrl, deployment_error as deploymentError,
    deployment_checked_at as deploymentCheckedAt, deployed_at as deployedAt,
    error_message as errorMessage, created_at as createdAt, updated_at as updatedAt,
    submitted_at as submittedAt, approved_at as approvedAt, published_at as publishedAt
    FROM publish_requests WHERE ${where}`
}

export async function getPublishRequest(db: D1Database, id: string): Promise<PublishRequestRow | undefined> {
  const value = await db.prepare(selectSql('id=?')).bind(id).first<JsonRecord>()
  return value ? row(value) : undefined
}

export async function listPublishRequests(db: D1Database, user: AuthUser, env: PublishEnv, workspace: string): Promise<PublishRequestRow[]> {
  const publisher = isPublisher(env, user)
  const query = publisher ? selectSql('workspace_id=? ORDER BY updated_at DESC LIMIT 100') : selectSql('workspace_id=? AND requester_id=? ORDER BY updated_at DESC LIMIT 100')
  const result = publisher ? await db.prepare(query).bind(workspace).all<JsonRecord>() : await db.prepare(query).bind(workspace, user.id).all<JsonRecord>()
  return (result.results ?? []).map(row)
}

export async function getCurrentPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, input: { workspace: string; documentPath: string; revision?: number }): Promise<PublishRequestRow | undefined> {
  const publisher = isPublisher(env, user)
  const revisionClause = typeof input.revision === 'number' && input.revision > 0 ? ' AND revision=?' : ''
  const requesterClause = publisher ? '' : ' AND requester_id=?'
  const query = selectSql(`workspace_id=? AND document_path=?${revisionClause}${requesterClause} ORDER BY updated_at DESC LIMIT 1`)
  const bindings: (string | number)[] = [input.workspace, input.documentPath]
  if (revisionClause) bindings.push(input.revision!)
  if (requesterClause) bindings.push(user.id)
  const value = await db.prepare(query).bind(...bindings).first<JsonRecord>()
  if (!value) return undefined
  return refreshPublishDeployment(db, env, row(value))
}

export async function createPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, input: { workspace: string; documentPath: string; revision: number }): Promise<PublishRequestRow> {
  const document = await db.prepare('SELECT d.current_revision as revision FROM documents d WHERE d.id=?').bind(`${input.workspace}:${input.documentPath}`).first<{ revision: number }>()
  if (!document) throw new Error('Document not found')
  if (Number(document.revision) !== input.revision) throw new Error(`Document revision is ${document.revision}; refresh before submitting`)
  const metadata = await getRepositoryMetadataValue(env)
  const id = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  await db.prepare(`INSERT INTO publish_requests
    (id, workspace_id, document_path, revision, base_github_sha, requester_id, status, created_at, updated_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`)
    .bind(id, input.workspace, input.documentPath, input.revision, metadata.commitSha, user.id, timestamp, timestamp, timestamp).run()
  return (await getPublishRequest(db, id))!
}

export async function refreshPublishDeployment(db: D1Database, env: PublishEnv, input: PublishRequestRow): Promise<PublishRequestRow> {
  if (input.status !== 'publishing' || !input.githubCommitSha) return input
  const checkedAt = new Date().toISOString()
  try {
    const run = input.githubWorkflowRunId
      ? await getPagesWorkflowRun(env, input.githubWorkflowRunId)
      : await waitForPagesWorkflowRun(env, input.githubCommitSha, 1, 0)
    if (!run) {
      await db.prepare('UPDATE publish_requests SET deployment_status=?, deployment_checked_at=?, updated_at=? WHERE id=?')
        .bind(input.deploymentStatus ?? 'queued', checkedAt, checkedAt, input.id).run()
      return (await getPublishRequest(db, input.id))!
    }
    const status = normalizeWorkflowStatus(run)
    if (status === 'success') {
      await db.prepare(`UPDATE publish_requests SET status='published', github_workflow_run_id=?, deployment_status=?, deployment_url=?, deployment_error=NULL,
        deployment_checked_at=?, deployed_at=?, published_at=?, updated_at=? WHERE id=?`)
        .bind(run.id, status, run.htmlUrl ?? null, checkedAt, checkedAt, checkedAt, checkedAt, input.id).run()
    } else if (status === 'failure' || status === 'cancelled') {
      const message = `GitHub Pages workflow ${status}${run.htmlUrl ? `: ${run.htmlUrl}` : ''}`
      await db.prepare(`UPDATE publish_requests SET status='failed', github_workflow_run_id=?, deployment_status=?, deployment_url=?, deployment_error=?, error_message=?,
        deployment_checked_at=?, updated_at=? WHERE id=?`)
        .bind(run.id, status, run.htmlUrl ?? null, message, message, checkedAt, checkedAt, input.id).run()
    } else {
      await db.prepare(`UPDATE publish_requests SET github_workflow_run_id=?, deployment_status=?, deployment_url=?, deployment_checked_at=?, updated_at=? WHERE id=?`)
        .bind(run.id, status, run.htmlUrl ?? null, checkedAt, checkedAt, input.id).run()
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const code = cause instanceof GitHubPublishError ? cause.code : undefined
    if (code === 'GITHUB_ACTIONS_PERMISSION_FAILED') {
      await db.prepare(`UPDATE publish_requests SET status='failed', deployment_status='failure', deployment_error=?, error_message=?, deployment_checked_at=?, updated_at=? WHERE id=?`)
        .bind(message, message, checkedAt, checkedAt, input.id).run()
    } else {
      await db.prepare('UPDATE publish_requests SET deployment_error=?, deployment_checked_at=?, updated_at=? WHERE id=?')
        .bind(message, checkedAt, checkedAt, input.id).run()
    }
  }
  return (await getPublishRequest(db, input.id))!
}

export async function rejectPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, id: string, message: string): Promise<PublishRequestRow> {
  if (!isPublisher(env, user)) throw new Error('Publisher permission required')
  const request = await getPublishRequest(db, id)
  if (!request) throw new Error('Publish request not found')
  if (!['submitted', 'approved', 'conflict', 'failed'].includes(request.status)) throw new Error(`Cannot reject request in ${request.status} status`)
  const timestamp = new Date().toISOString()
  await db.prepare("UPDATE publish_requests SET status='rejected', review_by=?, review_message=?, updated_at=? WHERE id=?").bind(user.id, message || null, timestamp, id).run()
  return (await getPublishRequest(db, id))!
}

export async function retryPublishRequest(db: D1Database, env: PublishEnv, user: AuthUser, id: string): Promise<PublishRequestRow> {
  const request = await getPublishRequest(db, id)
  if (!request) throw new Error('Publish request not found')
  if (request.requesterId !== user.id && !isPublisher(env, user)) throw new Error('You can only retry your own publish request')
  if (!['failed', 'conflict', 'rejected'].includes(request.status)) throw new Error(`Cannot retry request in ${request.status} status`)
  const timestamp = new Date().toISOString()
  const metadata = await getRepositoryMetadataValue(env)
  await db.prepare(`UPDATE publish_requests SET status='submitted', base_github_sha=?, error_message=NULL, deployment_error=NULL,
    deployment_status=NULL, deployment_url=NULL, github_workflow_run_id=NULL, review_message=NULL, updated_at=?, submitted_at=? WHERE id=?`)
    .bind(metadata.commitSha, timestamp, timestamp, id).run()
  return (await getPublishRequest(db, id))!
}

export async function approveAndPublish(db: D1Database, env: PublishEnv, user: AuthUser, id: string, message?: string): Promise<PublishRequestRow> {
  if (!isPublisher(env, user)) throw new Error('Publisher permission required')
  const request = await getPublishRequest(db, id)
  if (!request) throw new Error('Publish request not found')
  if (!['submitted', 'approved', 'failed'].includes(request.status)) throw new Error(`Cannot approve request in ${request.status} status`)
  const document = await db.prepare('SELECT current_revision as revision FROM documents WHERE id=?').bind(`${request.workspaceId}:${request.documentPath}`).first<{ revision: number }>()
  if (!document || Number(document.revision) !== request.revision) {
    await db.prepare("UPDATE publish_requests SET status='conflict', error_message=?, updated_at=? WHERE id=?").bind('D1 document revision changed before publishing', new Date().toISOString(), id).run()
    throw new Error('Publish request revision conflict')
  }
  let currentGithubSha: string
  try {
    currentGithubSha = await getGitHubBranchSha(env)
  } catch (cause) {
    const messageText = cause instanceof GitHubPublishError ? cause.message : cause instanceof Error ? cause.message : String(cause)
    await db.prepare("UPDATE publish_requests SET status='failed', error_message=?, updated_at=? WHERE id=?").bind(messageText, new Date().toISOString(), id).run()
    throw cause
  }
  if (currentGithubSha !== request.baseGithubSha) {
    await db.prepare("UPDATE publish_requests SET status='conflict', error_message=?, updated_at=? WHERE id=?").bind(`GitHub main changed from ${request.baseGithubSha} to ${currentGithubSha}`, new Date().toISOString(), id).run()
    throw new Error('GitHub main changed before publishing')
  }
  const revision = await db.prepare('SELECT content FROM revisions WHERE document_id=? AND revision=?').bind(`${request.workspaceId}:${request.documentPath}`, request.revision).first<{ content: string }>()
  if (!revision) throw new Error('Requested D1 revision not found')
  const timestamp = new Date().toISOString()
  await db.prepare(`UPDATE publish_requests SET status='publishing', review_by=?, review_message=?, approved_at=?, deployment_status='queued',
    deployment_error=NULL, error_message=NULL, updated_at=? WHERE id=?`).bind(user.id, message || null, timestamp, timestamp, id).run()
  try {
    const published = await publishGitHubFile(env, request.documentPath, revision.content, `docs(${request.documentPath}): publish revision ${request.revision}`)
    await db.prepare(`UPDATE publish_requests SET github_commit_sha=?, base_github_sha=?, deployment_status='queued', updated_at=? WHERE id=?`)
      .bind(published.commitSha, published.commitSha, new Date().toISOString(), id).run()
    await dispatchPagesWorkflow(env)
    const run = await waitForPagesWorkflowRun(env, published.commitSha)
    if (run) {
      await db.prepare('UPDATE publish_requests SET github_workflow_run_id=?, deployment_status=?, deployment_url=?, deployment_error=NULL, deployment_checked_at=?, updated_at=? WHERE id=?')
        .bind(run.id, normalizeWorkflowStatus(run), run.htmlUrl ?? null, new Date().toISOString(), new Date().toISOString(), id).run()
    } else {
      await db.prepare("UPDATE publish_requests SET deployment_status='queued', deployment_error=?, deployment_checked_at=?, updated_at=? WHERE id=?")
        .bind('GitHub Pages workflow was dispatched; waiting for GitHub Actions to expose the run.', new Date().toISOString(), new Date().toISOString(), id).run()
    }
  } catch (cause) {
    const messageText = cause instanceof GitHubPublishError ? cause.message : cause instanceof Error ? cause.message : String(cause)
    await db.prepare("UPDATE publish_requests SET status='failed', deployment_status='failure', deployment_error=?, error_message=?, updated_at=? WHERE id=?").bind(messageText, messageText, new Date().toISOString(), id).run()
    throw cause
  }
  return refreshPublishDeployment(db, env, (await getPublishRequest(db, id))!)
}
