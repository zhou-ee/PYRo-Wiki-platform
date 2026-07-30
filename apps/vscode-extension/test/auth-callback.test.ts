import { describe, expect, it } from 'vitest'
import { parseVscodeCallback, VSCODE_CALLBACK_AUTHORITY } from '../src/auth/callback'

describe('VS Code Feishu callback parsing', () => {
  it('accepts the registered callback authority and path', () => {
    expect(parseVscodeCallback(VSCODE_CALLBACK_AUTHORITY, '/auth/callback', 'handoff=abc%20123')).toEqual({ kind: 'handoff', value: 'abc 123' })
  })

  it('accepts a nested callback path but rejects other paths', () => {
    expect(parseVscodeCallback(VSCODE_CALLBACK_AUTHORITY, '/pyro/auth/callback', 'handoff=abc')).toEqual({ kind: 'handoff', value: 'abc' })
    expect(parseVscodeCallback(VSCODE_CALLBACK_AUTHORITY, '/auth/other', 'handoff=abc')).toEqual({ kind: 'ignore', reason: 'path' })
  })

  it('rejects unexpected authorities and missing handoff values', () => {
    expect(parseVscodeCallback('other.extension', '/auth/callback', 'handoff=abc')).toEqual({ kind: 'ignore', reason: 'authority' })
    expect(parseVscodeCallback(VSCODE_CALLBACK_AUTHORITY, '/auth/callback', 'state=abc')).toEqual({ kind: 'missing-handoff' })
  })

  it('decodes query parameters using URLSearchParams', () => {
    expect(parseVscodeCallback(VSCODE_CALLBACK_AUTHORITY, '/auth/callback', 'handoff=a%2Bb%3D%3D').kind).toBe('handoff')
  })
})
