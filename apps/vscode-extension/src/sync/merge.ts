export interface MergeResult {
  content: string
  conflicts: number
}

function conflictBlock(common: string, local: string, remote: string): string {
  return `<<<<<<< LOCAL\n${local}\n||||||| COMMON\n${common}\n=======\n${remote}\n>>>>>>> REMOTE`
}

/**
 * Performs a conservative line-oriented three-way merge. When all variants
 * retain the same line shape, independent line edits are merged precisely;
 * structural edits fall back to one explicit conflict block rather than
 * silently dropping content.
 */
export function mergeThreeWay(common: string, local: string, remote: string): MergeResult {
  if (local === remote) return { content: local, conflicts: 0 }
  if (local === common) return { content: remote, conflicts: 0 }
  if (remote === common) return { content: local, conflicts: 0 }

  const commonLines = common.split('\n')
  const localLines = local.split('\n')
  const remoteLines = remote.split('\n')
  if (commonLines.length !== localLines.length || commonLines.length !== remoteLines.length) {
    return { content: conflictBlock(common, local, remote), conflicts: 1 }
  }

  const merged: string[] = []
  let conflicts = 0
  for (let index = 0; index < commonLines.length; index += 1) {
    const baseLine = commonLines[index]
    const localLine = localLines[index]
    const remoteLine = remoteLines[index]
    if (localLine === remoteLine) merged.push(localLine)
    else if (localLine === baseLine) merged.push(remoteLine)
    else if (remoteLine === baseLine) merged.push(localLine)
    else {
      conflicts += 1
      merged.push('<<<<<<< LOCAL', localLine, '||||||| COMMON', baseLine, '=======', remoteLine, '>>>>>>> REMOTE')
    }
  }
  return { content: merged.join('\n'), conflicts }
}
