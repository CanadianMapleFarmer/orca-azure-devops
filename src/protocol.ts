import type { RunActionResult, RunsSnapshot } from './shared/pipelines'
import type { PrKey, PrSnapshot, RowResult } from './shared/prs'
import type { Channel, ShareKind, SharePrefsView, ShareRequest, ShareResult } from './shared/share/types'
import type { ConnectFailure, ConnectionMethod, Identity, OrgStatus } from './shared/types'
import type { BoardConfig, MoveTarget, WorkComment, WorkItemDetails, WorkItemSummary, WorkSnapshot } from './shared/work'
declare module 'orca' {
  interface PluginRequests {
    'plugin.ping': { input: {}; output: { version: string } }
    'orgs.list': { input: {}; output: OrgStatus[] }
    'orgs.connect': { input: { orgInput: string; method: ConnectionMethod; pat?: string }; output: OrgStatus }
    'orgs.cancel': { input: { org: string }; output: OrgStatus }
    'orgs.signOut': { input: { org: string }; output: OrgStatus }
    'orgs.remove': { input: { org: string }; output: { ok: true } }
    'ado.projects': { input: { org: string }; output: { id: string; name: string }[] }
    'ado.teams': { input: { org: string; projectId: string }; output: { id: string; name: string }[] }
    'orgs.setBoards': { input: { org: string; projectId: string; teamId: string }; output: OrgStatus }
    'orgs.setCodeProjects': { input: { org: string; projects: 'all' | string[] }; output: OrgStatus }
    'work.snapshot': { input: { org: string }; output: WorkSnapshot }
    'work.refresh': { input: { org: string }; output: WorkSnapshot }
    'work.details': { input: { org: string; id: number }; output: WorkItemDetails }
    'work.move': {
      input: { org: string; id: number; rev: number; to: MoveTarget; board?: { teamId: string; boardId: string } }
      output: WorkItemSummary
    }
    'work.comment': { input: { org: string; id: number; text: string }; output: WorkComment }
    'work.linkPr': {
      input: { org: string; id: number; rev: number; prUrl: string; board?: { teamId: string; boardId: string } }
      output: WorkItemSummary
    }
    'work.board': {
      input: { org: string; projectId: string; teamId: string; boardId?: string; everyone: boolean }
      output: { board: BoardConfig; items: WorkItemSummary[]; message?: string; stale?: boolean }
    }
    'work.boards': { input: { org: string; projectId: string; teamId: string }; output: { id: string; name: string }[] }
    'work.openBoard': { input: { org: string }; output: { opened: boolean; message?: string } }
    'work.dismissNudge': { input: { org: string; itemId: number; prId: number }; output: { ok: true } }
    'work.nudgeRules': {
      input: { org: string; teamId: string; rules?: { branch: string; column: string }[] }
      output: { rules: { branch: string; column: string }[] }
    }
    'work.startWorkspace': { input: { org: string; id: number }; output: { branch: string; armedUntil: number } }
    'work.cancelWorkspace': { input: {}; output: { ok: true } }
    'work.startAgent': { input: { org: string; id: number }; output: { launched: boolean; message?: string } }
    'ui.visibility': {
      input: { surface: 'work' | 'board' | 'prs' | 'pipelines'; org: string; visible: boolean; board?: { teamId: string; boardId: string } }
      output: { ok: true }
    }
    'prs.snapshot': { input: { org: string }; output: PrSnapshot }
    'prs.refresh': { input: { org: string }; output: PrSnapshot }
    'prs.approve': { input: { org: string; prs: PrKey[] }; output: { results: RowResult[] } }
    'prs.autoComplete': { input: { org: string; prs: PrKey[] }; output: { results: RowResult[] } }
    'runs.snapshot': { input: { org: string }; output: RunsSnapshot }
    'runs.refresh': { input: { org: string }; output: RunsSnapshot }
    'runs.watch': { input: { org: string; projectId: string; buildId: number; watched: boolean }; output: RunsSnapshot }
    'runs.decide': {
      input: { org: string; projectId: string; approvalId: string; decision: 'approved' | 'rejected'; comment: string }
      output: RunActionResult
    }
    'runs.retryStage': { input: { org: string; projectId: string; buildId: number; stageId: string }; output: RunActionResult }
    'runs.cancel': { input: { org: string; projectId: string; buildId: number }; output: RunActionResult }
    'share.prefs': { input: { org: string; kind: ShareKind }; output: SharePrefsView }
    'share.send': { input: ShareRequest; output: { results: ShareResult[] } }
    'share.people': { input: { org: string; query: string; groups: boolean }; output: Identity[] }
    'share.channels': { input: {}; output: Channel[] }
    'share.addChannel': { input: { name: string; url: string }; output: Channel }
    'share.replaceChannel': { input: { id: string; url: string }; output: Channel }
    'share.removeChannel': { input: { id: string }; output: { ok: true } }
    'share.testChannel': { input: { id: string }; output: ShareResult }
  }
  interface PluginPanelEvents {
    'orgs.changed': { orgs: OrgStatus[] }
    'orgs.connectFailed': ConnectFailure
    'work.changed': WorkSnapshot
    'work.boardChanged': { org: string; teamId: string; boardId: string }
    'prs.changed': PrSnapshot
    'runs.changed': RunsSnapshot
  }
}
