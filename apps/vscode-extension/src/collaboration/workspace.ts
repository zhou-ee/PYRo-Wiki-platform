import * as vscode from 'vscode'
import type { CollaborationMember, CollaborationSnapshot } from './client'

export type CollaborationSource = { state: CollaborationSnapshot; onDidChange: vscode.Event<CollaborationSnapshot> }

export type CollaborationNode = { kind: 'status' | 'member' | 'event'; label: string; detail?: string }

export class CollaborationProvider implements vscode.TreeDataProvider<CollaborationNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CollaborationNode | undefined | null | void>()
  private readonly disposables: vscode.Disposable[]

  constructor(private readonly client: CollaborationSource) {
    this.disposables = [this.emitter, client.onDidChange(() => this.refresh())]
  }

  readonly onDidChangeTreeData = this.emitter.event

  getTreeItem(node: CollaborationNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)
    item.description = node.detail
    item.iconPath = new vscode.ThemeIcon(node.kind === 'event' ? 'history' : node.kind === 'member' ? 'account' : node.label.includes('Connected') ? 'radio-tower' : 'broadcast')
    return item
  }

  getChildren(): CollaborationNode[] {
    const state = this.client.state
    const nodes: CollaborationNode[] = [{ kind: 'status', label: this.statusLabel(state.status), detail: state.documentPath ?? 'No collaboration document' }]
    if (state.members.length) {
      nodes.push({ kind: 'status', label: `Online users: ${state.members.filter((member) => member.status === 'online').length}`, detail: `${state.members.length} room member(s)` })
      nodes.push(...state.members.map((member) => this.memberNode(member)))
    }
    if (state.error) nodes.push({ kind: 'status', label: 'Error', detail: state.error })
    if (state.events.length) {
      nodes.push({ kind: 'event', label: 'Recent Events' })
      nodes.push(...state.events.map((event) => ({ kind: 'event' as const, label: event })))
    }
    return nodes
  }

  refresh(): void { this.emitter.fire() }

  private memberNode(member: CollaborationMember): CollaborationNode {
    const status = member.status === 'online' ? 'Online' : member.status === 'reconnecting' ? 'Reconnecting' : 'Offline'
    return { kind: 'member', label: `${status}: ${member.name}`, detail: member.documentPath || 'No active document' }
  }

  private statusLabel(status: CollaborationSnapshot['status']): string {
    return status.charAt(0).toUpperCase() + status.slice(1)
  }

  dispose(): void { for (const disposable of this.disposables) disposable.dispose() }
}
