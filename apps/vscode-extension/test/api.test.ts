import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/sync/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('ApiClient', () => {
  it('retries transient GET failures with backoff', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return calls === 1 ? new Response(JSON.stringify({ error: 'busy' }), { status: 503 }) : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await expect(new ApiClient('https://example.test', 'wiki').health()).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('refreshes once after an unauthorized response', async () => {
    const auth = { getAccessToken: vi.fn().mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token'), refresh: vi.fn().mockResolvedValue('new-token') }
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return seen.length === 1 ? new Response(JSON.stringify({ error: 'expired' }), { status: 401 }) : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await expect(new ApiClient('https://example.test', 'wiki', auth).health()).resolves.toEqual({ ok: true })
    expect(auth.refresh).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['Bearer old-token', 'Bearer new-token'])
  })

  it('checkpoints the whole workspace before creating a publish batch', async () => {
    let requestedUrl = ''
    let requestedMethod = ''
    globalThis.fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? 'GET'
      return new Response(JSON.stringify({ ok: true, workspaceId: 'wiki', manifestCount: 2, documentPaths: ['a.md', 'b.md'] }), { status: 200 })
    }) as typeof fetch
    await expect(new ApiClient('https://example.test', 'wiki').checkpointWorkspace()).resolves.toMatchObject({ manifestCount: 2, documentPaths: ['a.md', 'b.md'] })
    expect(requestedUrl).toBe('https://example.test/workspace-collaboration/wiki?checkpoint=1')
    expect(requestedMethod).toBe('POST')
  })

  it('marks a checkpoint as a complete local manifest only when requested', async () => {
    let requestedUrl = ''
    globalThis.fetch = vi.fn(async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ ok: true, workspaceId: 'wiki', manifestCount: 2, documentPaths: ['a.md', 'b.md'] }), { status: 200 })
    }) as typeof fetch
    await new ApiClient('https://example.test', 'wiki').checkpointWorkspace(true)
    expect(requestedUrl).toBe('https://example.test/workspace-collaboration/wiki?checkpoint=1&fullManifest=1')
  })

  it('does not retry a non-idempotent PUT after a network failure', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline') })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(new ApiClient('https://example.test', 'wiki').putDocument('a.md', 'x', 0)).rejects.toMatchObject({ message: 'Network request failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
