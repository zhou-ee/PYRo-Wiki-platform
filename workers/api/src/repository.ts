import { getGitHubInstallationToken } from './github'
export interface RepositoryEnv {
  PYRO_GITHUB_REPOSITORY_URL?: string
  PYRO_GITHUB_BRANCH?: string
  GITHUB_TOKEN?: string
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
  GITHUB_INSTALLATION_ID?: string
}

export interface GitHubRepositoryRef {
  repositoryUrl: string
  owner: string
  repo: string
  branch: string
}

export interface RepositoryMetadata {
  repositoryUrl: string
  branch: string
  commitSha: string
  commitUrl?: string
  updatedAt?: string
}

const DEFAULT_REPOSITORY_URL = 'https://github.com/zhou-ee/PYRo-Wiki'
const DEFAULT_BRANCH = 'main'
const UPSTREAM_TIMEOUT_MS = 15_000
const MAX_UPSTREAM_ATTEMPTS = 3
const METADATA_CACHE_MS = 30_000
let metadataCache: { key: string; expiresAt: number; value: RepositoryMetadata } | undefined

export function parseGitHubRepository(env: RepositoryEnv): GitHubRepositoryRef {
  const repositoryUrl = (env.PYRO_GITHUB_REPOSITORY_URL || DEFAULT_REPOSITORY_URL).replace(/\/$/, '')
  const parsed = new URL(repositoryUrl)
  if (parsed.hostname.toLowerCase() !== 'github.com') throw new Error('PYRO_GITHUB_REPOSITORY_URL must point to github.com')
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) throw new Error('PYRO_GITHUB_REPOSITORY_URL must include owner and repository name')
  const repo = segments[1].replace(/\.git$/, '')
  if (!segments[0] || !repo) throw new Error('GitHub repository owner and name are required')
  return { repositoryUrl, owner: segments[0], repo, branch: env.PYRO_GITHUB_BRANCH || DEFAULT_BRANCH }
}

export function githubArchiveUrl(repository: GitHubRepositoryRef): string {
  return `https://codeload.github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tar.gz/${encodeURIComponent(repository.branch)}`
}

export function githubApiUrl(repository: GitHubRepositoryRef, suffix: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}${suffix}`
}

async function upstreamHeaders(env: RepositoryEnv): Promise<Headers> {
  const headers = new Headers({ accept: 'application/vnd.github+json', 'user-agent': 'PYRo-Wiki-Worker' })
  if (env.GITHUB_TOKEN) headers.set('authorization', `Bearer ${env.GITHUB_TOKEN}`)
  else if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID) {
    headers.set('authorization', `Bearer ${await getGitHubInstallationToken(env)}`)
  }
  return headers
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}

async function fetchUpstream(url: string, env: RepositoryEnv, accept: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const headers = await upstreamHeaders(env)
      headers.set('accept', accept)
      const response = await fetch(url, { headers, signal: controller.signal })
      if (response.ok || response.status < 500 || attempt === MAX_UPSTREAM_ATTEMPTS) return response
      lastError = new Error(`GitHub upstream returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
  }
  throw lastError instanceof Error ? lastError : new Error('GitHub upstream request failed')
}

export async function getRepositoryMetadataValue(env: RepositoryEnv): Promise<RepositoryMetadata> {
  let repository: GitHubRepositoryRef
  try { repository = parseGitHubRepository(env) } catch (cause) { throw new Error(cause instanceof Error ? cause.message : 'Invalid GitHub repository configuration') }
  const key = `${repository.owner}/${repository.repo}@${repository.branch}`
  if (metadataCache && metadataCache.key === key && metadataCache.expiresAt > Date.now()) return metadataCache.value
  const upstream = await fetchUpstream(githubApiUrl(repository, `/branches/${encodeURIComponent(repository.branch)}`), env, 'application/vnd.github+json')
  if (!upstream.ok) throw new Error(`GitHub repository metadata returned HTTP ${upstream.status}`)
  const data = await upstream.json() as { object?: { sha?: string; url?: string }; commit?: { sha?: string; url?: string; html_url?: string; author?: { date?: string }; committer?: { date?: string } } }
  const commitSha = data.commit?.sha || data.object?.sha
  if (!commitSha) throw new Error('GitHub repository metadata did not include a commit SHA')
  const value: RepositoryMetadata = { repositoryUrl: repository.repositoryUrl, branch: repository.branch, commitSha, commitUrl: data.commit?.html_url || data.commit?.url || data.object?.url, updatedAt: data.commit?.committer?.date || data.commit?.author?.date }
  metadataCache = { key, expiresAt: Date.now() + METADATA_CACHE_MS, value }
  return value
}
export async function fetchRepositoryMetadata(env: RepositoryEnv): Promise<Response> {
  try {
    const value = await getRepositoryMetadataValue(env)
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30, s-maxage=60', 'access-control-allow-origin': '*' } })
  } catch (cause) {
    return errorResponse(cause instanceof Error ? cause.message : 'GitHub repository metadata request failed', 502)
  }
}
export async function fetchRepositoryArchive(env: RepositoryEnv): Promise<Response> {
  let repository: GitHubRepositoryRef
  try { repository = parseGitHubRepository(env) } catch (cause) { return errorResponse(cause instanceof Error ? cause.message : 'Invalid GitHub repository configuration', 500) }
  try {
    const upstream = await fetchUpstream(githubArchiveUrl(repository), env, 'application/vnd.github+json')
    if (!upstream.ok || !upstream.body) return errorResponse(`GitHub repository archive returned HTTP ${upstream.status}`, 502)
    const headers = new Headers(upstream.headers)
    headers.set('content-type', 'application/gzip')
    headers.set('cache-control', 'public, max-age=60, s-maxage=300')
    headers.set('access-control-allow-origin', '*')
    headers.set('access-control-allow-headers', 'content-type, authorization')
    headers.set('x-pyro-repository-ref', repository.branch)
    return new Response(upstream.body, { status: 200, headers })
  } catch (cause) {
    return errorResponse(cause instanceof Error ? cause.message : 'GitHub repository archive request failed', 502)
  }
}

export { DEFAULT_BRANCH, DEFAULT_REPOSITORY_URL }
