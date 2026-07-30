import type { RepositoryEnv } from './repository'
import { githubApiUrl, parseGitHubRepository } from './repository'

export class GitHubPublishError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = 'GitHubPublishError' }
}

const APP_TOKEN_TTL_MS = 9 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3
let installationTokenCache: { value: string; expiresAt: number } | undefined

function base64UrlBytes(value: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < value.length; offset += chunk) binary += String.fromCharCode(...value.subarray(offset, offset + chunk))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}
function base64UrlText(value: string): string { return base64UrlBytes(new TextEncoder().encode(value)) }
function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  return btoa(binary)
}
function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length)
  const bytes: number[] = []
  let value = length
  while (value > 0) { bytes.unshift(value & 0xff); value >>>= 8 }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}
function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])
  const version = Uint8Array.from([0x02, 0x01, 0x00])
  const octetLength = derLength(pkcs1.byteLength)
  const octet = new Uint8Array(1 + octetLength.byteLength + pkcs1.byteLength)
  octet[0] = 0x04
  octet.set(octetLength, 1)
  octet.set(pkcs1, 1 + octetLength.byteLength)
  const sequenceLength = derLength(version.byteLength + algorithm.byteLength + octet.byteLength)
  const result = new Uint8Array(1 + sequenceLength.byteLength + version.byteLength + algorithm.byteLength + octet.byteLength)
  let offset = 0
  result[offset++] = 0x30
  result.set(sequenceLength, offset); offset += sequenceLength.byteLength
  result.set(version, offset); offset += version.byteLength
  result.set(algorithm, offset); offset += algorithm.byteLength
  result.set(octet, offset)
  return result
}
function decodePem(value: string): Uint8Array {
  const normalized = value.replaceAll('\\n', '\n')
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(normalized)
  const body = normalized.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, '').replace(/-----END (?:RSA )?PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const decoded = Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
  return pkcs1 ? wrapPkcs1AsPkcs8(decoded) : decoded
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function appJwt(env: RepositoryEnv): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new GitHubPublishError('GitHub App publishing is not configured', 503, 'GITHUB_APP_NOT_CONFIGURED')
  const header = base64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const issuedAt = Math.floor(Date.now() / 1000) - 60
  const payload = base64UrlText(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: env.GITHUB_APP_ID }))
  const privateKeyBytes = decodePem(env.GITHUB_APP_PRIVATE_KEY)
  const privateKeyBuffer = new ArrayBuffer(privateKeyBytes.byteLength)
  new Uint8Array(privateKeyBuffer).set(privateKeyBytes)
  const key = await crypto.subtle.importKey('pkcs8', privateKeyBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signingBytes = new TextEncoder().encode(`${header}.${payload}`)
  const signingBuffer = new ArrayBuffer(signingBytes.byteLength)
  new Uint8Array(signingBuffer).set(signingBytes)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, signingBuffer)
  return `${header}.${payload}.${base64UrlBytes(new Uint8Array(signature))}`
}

async function rawGitHubRequest(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = new Headers(init.headers)
    headers.set('user-agent', 'PYRo-Wiki-Worker')
    headers.set('accept', 'application/vnd.github+json')
    return await fetch(url, { ...init, headers, signal: controller.signal })
  } finally { clearTimeout(timer) }
}

export async function getGitHubInstallationToken(env: RepositoryEnv): Promise<string> {
  return installationToken(env)
}

async function installationToken(env: RepositoryEnv): Promise<string> {
  if (!env.GITHUB_INSTALLATION_ID) throw new GitHubPublishError('GitHub App installation is not configured', 503, 'GITHUB_APP_NOT_CONFIGURED')
  if (installationTokenCache && installationTokenCache.expiresAt > Date.now()) return installationTokenCache.value
  const jwt = await appJwt(env)
  const response = await rawGitHubRequest(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` } })
  if (!response.ok) throw new GitHubPublishError(`GitHub App token request returned HTTP ${response.status}`, response.status, 'GITHUB_APP_TOKEN_FAILED')
  const data = await response.json() as { token?: string; expires_at?: string }
  if (!data.token) throw new GitHubPublishError('GitHub App did not return an installation token', 502, 'GITHUB_APP_TOKEN_FAILED')
  installationTokenCache = { value: data.token, expiresAt: Math.min(Date.parse(data.expires_at || '') || Date.now() + APP_TOKEN_TTL_MS, Date.now() + APP_TOKEN_TTL_MS) - 30_000 }
  return data.token
}

async function githubRequest(url: string, env: RepositoryEnv, init: RequestInit, retryable = true): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= (retryable ? MAX_ATTEMPTS : 1); attempt += 1) {
    try {
      const token = await installationToken(env)
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${token}`)
      const response = await rawGitHubRequest(url, { ...init, headers })
      if (response.ok || !retryable || (response.status < 500 && response.status !== 429) || attempt === MAX_ATTEMPTS) return response
      lastError = new GitHubPublishError(`GitHub API returned HTTP ${response.status}`, response.status)
    } catch (error) { lastError = error }
    await sleep(300 * 2 ** (attempt - 1))
  }
  throw lastError instanceof Error ? lastError : new GitHubPublishError('GitHub API request failed', 502)
}

export function extractGitHubBranchSha(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const value = data as { commit?: { sha?: unknown }; object?: { sha?: unknown } }
  if (typeof value.commit?.sha === 'string' && value.commit.sha) return value.commit.sha
  if (typeof value.object?.sha === 'string' && value.object.sha) return value.object.sha
  return undefined
}

export async function getGitHubBranchSha(env: RepositoryEnv): Promise<string> {
  const repository = parseGitHubRepository(env)
  const response = await githubRequest(githubApiUrl(repository, `/branches/${encodeURIComponent(repository.branch)}`), env, {}, true)
  if (!response.ok) throw new GitHubPublishError(`GitHub branch lookup returned HTTP ${response.status}`, response.status, 'GITHUB_BRANCH_LOOKUP_FAILED')
  const data = await response.json()
  const sha = extractGitHubBranchSha(data)
  if (!sha) throw new GitHubPublishError('GitHub branch lookup did not return commit.sha', 502, 'GITHUB_BRANCH_LOOKUP_FAILED')
  return sha
}

export async function readGitHubFile(env: RepositoryEnv, documentPath: string): Promise<string> {
  const repository = parseGitHubRepository(env)
  const encodedPath = documentPath.split('/').map(encodeURIComponent).join('/')
  const response = await githubRequest(githubApiUrl(repository, `/contents/${encodedPath}?ref=${encodeURIComponent(repository.branch)}`), env, {}, true)
  if (!response.ok) throw new GitHubPublishError(`GitHub file read returned HTTP ${response.status}`, response.status, 'GITHUB_FILE_READ_FAILED')
  const data = await response.json() as { content?: string; encoding?: string }
  if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new GitHubPublishError(`GitHub file is not readable: ${documentPath}`, 502, 'GITHUB_FILE_READ_FAILED')
  const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, '')), (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export async function readGitHubFileOptional(env: RepositoryEnv, documentPath: string): Promise<string | undefined> {
  try { return await readGitHubFile(env, documentPath) }
  catch (error) { if (error instanceof GitHubPublishError && error.status === 404) return undefined; throw error }
}

async function getGitHubFileSha(env: RepositoryEnv, repository: ReturnType<typeof parseGitHubRepository>, documentPath: string): Promise<string | undefined> {
  const encodedPath = documentPath.split('/').map(encodeURIComponent).join('/')
  const response = await githubRequest(githubApiUrl(repository, `/contents/${encodedPath}?ref=${encodeURIComponent(repository.branch)}`), env, {}, true)
  if (response.status === 404) return undefined
  if (!response.ok) throw new GitHubPublishError(`GitHub file lookup returned HTTP ${response.status}`, response.status, 'GITHUB_FILE_LOOKUP_FAILED')
  const data = await response.json() as { type?: string; sha?: string }
  if (data.type && data.type !== 'file') throw new GitHubPublishError(`GitHub path is not a file: ${documentPath}`, 422, 'GITHUB_FILE_LOOKUP_FAILED')
  if (!data.sha) throw new GitHubPublishError(`GitHub file lookup did not return a SHA for ${documentPath}`, 502, 'GITHUB_FILE_LOOKUP_FAILED')
  return data.sha
}

export interface GitHubWorkflowRun {
  id: string
  status: string
  conclusion?: string
  headSha?: string
  htmlUrl?: string
}

function workflowRun(value: { id?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown; html_url?: unknown }): GitHubWorkflowRun | undefined {
  if (typeof value.id !== 'number' && typeof value.id !== 'string') return undefined
  return {
    id: String(value.id),
    status: typeof value.status === 'string' ? value.status : 'unknown',
    conclusion: typeof value.conclusion === 'string' ? value.conclusion : undefined,
    headSha: typeof value.head_sha === 'string' ? value.head_sha : undefined,
    htmlUrl: typeof value.html_url === 'string' ? value.html_url : undefined
  }
}

export function normalizeWorkflowStatus(run: GitHubWorkflowRun): 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'unknown' {
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'success'
    if (run.conclusion === 'cancelled' || run.conclusion === 'skipped' || run.conclusion === 'timed_out') return 'cancelled'
    return 'failure'
  }
  if (run.status === 'queued' || run.status === 'requested' || run.status === 'waiting' || run.status === 'pending') return 'queued'
  if (run.status === 'in_progress') return 'in_progress'
  return 'unknown'
}

function actionsPermissionError(status: number, detail = ''): GitHubPublishError {
  const suffix = detail ? `: ${detail.slice(0, 300)}` : ''
  return new GitHubPublishError(`GitHub Actions workflow request returned HTTP ${status}${suffix}`, status, status === 401 || status === 403 ? 'GITHUB_ACTIONS_PERMISSION_FAILED' : 'GITHUB_ACTIONS_FAILED')
}

export async function dispatchPagesWorkflow(env: RepositoryEnv): Promise<void> {
  const repository = parseGitHubRepository(env)
  const response = await githubRequest(githubApiUrl(repository, '/actions/workflows/deploy.yml/dispatches'), env, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: repository.branch })
  }, false)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) throw new GitHubPublishError('GitHub App lacks workflow dispatch permission', response.status, 'GITHUB_ACTIONS_PERMISSION_FAILED')
    throw actionsPermissionError(response.status, detail)
  }
}

export async function waitForPagesWorkflowRun(env: RepositoryEnv, headSha: string, attempts = 5, delayMs = 500): Promise<GitHubWorkflowRun | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await findPagesWorkflowRun(env, headSha)
    if (run) return run
    if (attempt + 1 < attempts) await sleep(delayMs)
  }
  return undefined
}

export async function findPagesWorkflowRun(env: RepositoryEnv, headSha: string): Promise<GitHubWorkflowRun | undefined> {
  const repository = parseGitHubRepository(env)
  const response = await githubRequest(githubApiUrl(repository, `/actions/workflows/deploy.yml/runs?branch=${encodeURIComponent(repository.branch)}&event=workflow_dispatch&per_page=20`), env, {}, true)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) throw new GitHubPublishError('GitHub App lacks workflow run read permission', response.status, 'GITHUB_ACTIONS_PERMISSION_FAILED')
    throw actionsPermissionError(response.status, detail)
  }
  const data = await response.json() as { workflow_runs?: Array<{ id?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown; html_url?: unknown }> }
  return (data.workflow_runs ?? []).map((value) => workflowRun(value)).filter((value): value is GitHubWorkflowRun => Boolean(value)).find((value) => value.headSha === headSha)
}

export async function getPagesWorkflowRun(env: RepositoryEnv, id: string): Promise<GitHubWorkflowRun> {
  const repository = parseGitHubRepository(env)
  const response = await githubRequest(githubApiUrl(repository, `/actions/runs/${encodeURIComponent(id)}`), env, {}, true)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) throw new GitHubPublishError('GitHub App lacks workflow run read permission', response.status, 'GITHUB_ACTIONS_PERMISSION_FAILED')
    throw actionsPermissionError(response.status, detail)
  }
  const value = workflowRun(await response.json() as { id?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown; html_url?: unknown })
  if (!value) throw new GitHubPublishError('GitHub Actions response did not include a workflow run', 502, 'GITHUB_ACTIONS_FAILED')
  return value
}

export async function publishGitHubFile(env: RepositoryEnv, documentPath: string, content: string, message: string): Promise<{ commitSha: string; branch: string }> {
  const repository = parseGitHubRepository(env)
  const encodedPath = documentPath.split('/').map(encodeURIComponent).join('/')
  const sha = await getGitHubFileSha(env, repository, documentPath)
  const payload: { message: string; content: string; branch: string; sha?: string } = { message, content: base64Text(content), branch: repository.branch }
  if (sha) payload.sha = sha
  const response = await githubRequest(githubApiUrl(repository, `/contents/${encodedPath}`), env, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }, false)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new GitHubPublishError(`GitHub file publish returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`, response.status, 'GITHUB_PUBLISH_FAILED')
  }
  const data = await response.json() as { commit?: { sha?: string } }
  if (!data.commit?.sha) throw new GitHubPublishError('GitHub publish did not return a commit SHA', 502, 'GITHUB_PUBLISH_FAILED')
  return { commitSha: data.commit.sha, branch: repository.branch }
}

export interface GitHubWorkspaceFile {
  path: string
  content?: string
  deleted?: boolean
}

export async function publishGitHubWorkspace(env: RepositoryEnv, files: GitHubWorkspaceFile[], message: string): Promise<{ commitSha: string; branch: string }> {
  const repository = parseGitHubRepository(env)
  const parentSha = await getGitHubBranchSha(env)
  const commitResponse = await githubRequest(githubApiUrl(repository, `/git/commits/${encodeURIComponent(parentSha)}`), env, {}, true)
  if (!commitResponse.ok) throw new GitHubPublishError(`GitHub base commit lookup returned HTTP ${commitResponse.status}`, commitResponse.status, 'GITHUB_PUBLISH_FAILED')
  const commitData = await commitResponse.json() as { tree?: { sha?: string } }
  if (!commitData.tree?.sha) throw new GitHubPublishError('GitHub base commit did not include a tree SHA', 502, 'GITHUB_PUBLISH_FAILED')
  const tree = files.map((file) => file.deleted
    ? { path: file.path, mode: '100644', type: 'blob', sha: null }
    : { path: file.path, mode: '100644', type: 'blob', content: file.content ?? '' })
  const treeResponse = await githubRequest(githubApiUrl(repository, '/git/trees'), env, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_tree: commitData.tree.sha, tree })
  }, false)
  if (!treeResponse.ok) throw new GitHubPublishError(`GitHub tree creation returned HTTP ${treeResponse.status}`, treeResponse.status, 'GITHUB_PUBLISH_FAILED')
  const treeData = await treeResponse.json() as { sha?: string }
  if (!treeData.sha) throw new GitHubPublishError('GitHub tree creation did not return a SHA', 502, 'GITHUB_PUBLISH_FAILED')
  const newCommitResponse = await githubRequest(githubApiUrl(repository, '/git/commits'), env, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, tree: treeData.sha, parents: [parentSha] })
  }, false)
  if (!newCommitResponse.ok) throw new GitHubPublishError(`GitHub commit creation returned HTTP ${newCommitResponse.status}`, newCommitResponse.status, 'GITHUB_PUBLISH_FAILED')
  const newCommit = await newCommitResponse.json() as { sha?: string }
  if (!newCommit.sha) throw new GitHubPublishError('GitHub commit creation did not return a SHA', 502, 'GITHUB_PUBLISH_FAILED')
  const refResponse = await githubRequest(githubApiUrl(repository, `/git/refs/heads/${encodeURIComponent(repository.branch)}`), env, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.sha, force: false })
  }, false)
  if (!refResponse.ok) throw new GitHubPublishError(`GitHub branch update returned HTTP ${refResponse.status}`, refResponse.status, 'GITHUB_PUBLISH_FAILED')
  return { commitSha: newCommit.sha, branch: repository.branch }
}
