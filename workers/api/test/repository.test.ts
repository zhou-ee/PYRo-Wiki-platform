import { describe, expect, it } from 'vitest'
import { githubArchiveUrl, parseGitHubRepository } from '../src/repository'

describe('GitHub repository proxy configuration', () => {
  it('parses the configured repository and branch', () => {
    const repository = parseGitHubRepository({ PYRO_GITHUB_REPOSITORY_URL: 'https://github.com/zhou-ee/PYRo-Wiki.git', PYRO_GITHUB_BRANCH: 'main' })
    expect(repository.owner).toBe('zhou-ee')
    expect(repository.repo).toBe('PYRo-Wiki')
    expect(repository.branch).toBe('main')
    expect(githubArchiveUrl(repository)).toContain('codeload.github.com/zhou-ee/PYRo-Wiki/tar.gz/main')
  })

  it('rejects non-GitHub repository URLs', () => {
    expect(() => parseGitHubRepository({ PYRO_GITHUB_REPOSITORY_URL: 'https://example.com/wiki' })).toThrow(/github.com/)
  })
})
