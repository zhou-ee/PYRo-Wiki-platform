export const VSCODE_CALLBACK_AUTHORITY = 'pyro-wiki.pyro-wiki-vscode-extension'
export const VSCODE_CALLBACK_PATH = '/auth/callback'

export type CallbackParseResult =
  | { kind: 'ignore'; reason: 'authority' | 'path' }
  | { kind: 'missing-handoff' }
  | { kind: 'handoff'; value: string }

export function parseVscodeCallback(authority: string, path: string, query: string): CallbackParseResult {
  if (authority !== VSCODE_CALLBACK_AUTHORITY) return { kind: 'ignore', reason: 'authority' }
  if (path !== VSCODE_CALLBACK_PATH && !path.endsWith(VSCODE_CALLBACK_PATH)) return { kind: 'ignore', reason: 'path' }
  const handoff = new URLSearchParams(query).get('handoff')
  return handoff ? { kind: 'handoff', value: handoff } : { kind: 'missing-handoff' }
}
