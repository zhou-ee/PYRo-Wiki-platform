import * as vscode from 'vscode'
import { removePendingSyncItem, upsertPendingSyncItem, type NewPendingSyncItem, type PendingSyncItem } from './queueLogic'

export type { PendingSyncItem } from './queueLogic'

const QUEUE_KEY = 'pyroWiki.syncQueue'

export async function pendingSyncItems(context: vscode.ExtensionContext): Promise<PendingSyncItem[]> {
  return context.workspaceState.get<PendingSyncItem[]>(QUEUE_KEY, [])
}

export async function enqueueSync(context: vscode.ExtensionContext, item: NewPendingSyncItem): Promise<void> {
  const current = await pendingSyncItems(context)
  await context.workspaceState.update(QUEUE_KEY, upsertPendingSyncItem(current, item, new Date().toISOString()))
}

export async function removeSync(context: vscode.ExtensionContext, id: string): Promise<void> {
  const current = await pendingSyncItems(context)
  await context.workspaceState.update(QUEUE_KEY, removePendingSyncItem(current, id))
}

export async function pendingSyncCount(context: vscode.ExtensionContext): Promise<number> {
  return (await pendingSyncItems(context)).length
}
