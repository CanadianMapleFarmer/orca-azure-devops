import { existsSync, readdirSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { createAzCliProvider, createAzProfiles } from './auth/azcli'
import { registerWorkHandlers } from './boards/handlers'
import { createBoardsService } from './boards/service'
import { createConnections, type StorePort } from './connections'
import { registerOrgHandlers } from './org-handlers'
import { createRunActions } from './pipelines/actions'
import { registerPipelineHandlers } from './pipelines/handlers'
import { createNotifier } from './pipelines/notify'
import { fileInside, gitRemotes, openRunFile, type OpenFileDeps } from './pipelines/open-file'
import { createPressure } from './pipelines/pressure'
import { openRun } from './pipelines/run-file'
import { createRunViews } from './pipelines/run-views'
import { createPipelinesService } from './pipelines/service'
import { approvalShareSource } from './pipelines/share-source'
import { watchPipelineSettings } from './pipelines/settings'
import { createRunSignals } from './pipelines/signals'
import { createWatchList } from './pipelines/watched'
import { createScheduler, realClock } from './poll/scheduler'
import { createPrActions } from './prs/actions'
import { registerPrHandlers } from './prs/handlers'
import { createPrsService } from './prs/service'
import { watchPrSettings } from './prs/settings'
import { prShareSource } from './prs/share-source'
import { createReviewActions } from './reviews/actions'
import { checkoutPr } from './reviews/checkout'
import { registerReviewHandlers } from './reviews/handlers'
import { createReviews } from './reviews/service'
import { createChannelStore } from './share/channels'
import { channelDestination, copyDestination, reviewersDestination } from './share/destinations'
import { registerShareHandlers } from './share/handlers'
import { createShareService } from './share/service'
import { createStatusBar, statusText } from './status-bar'
import { createClipboard, spawnWithInput } from './sys/clipboard'
import { findExecutable } from './sys/find-executable'
import { runCommand, stopAllCommands } from './sys/run'
import { registerVisibilityHandler } from './visibility-handler'
import { createDrafts } from './wiki/drafts'
import { registerWikiHandlers } from './wiki/handlers'
import { createPublisher } from './wiki/publish'
import { createWikiService } from './wiki/service'
import { createArm } from './workspace/arm'
import type { HostCall } from './workspace/focused'
import { registerWorkspaceHandlers } from './workspace/handlers'

const SHUTDOWN = { killAfterMs: 1_500, withinMs: 1_900 }

let stopPolling = () => {}

export function deactivate(): Promise<void> {
  stopPolling()
  return stopAllCommands(SHUTDOWN)
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const activatedAt = Date.now()
  const home = os.homedir()
  const bar = createStatusBar(state => void orca.host.call('statusBar.update', { id: 'status', ...state }).catch(() => {}))
  const log = (message: string) => orca.log(message)
  const prSettings = await watchPrSettings(orca.settings, log)
  const pipelineSettings = await watchPipelineSettings(orca.settings, log)

  const store: StorePort = {
    get: async <T,>(key: string) => (await orca.storage.get(key)) as T | null,
    set: (key, value) => orca.storage.set(key, value as JsonValue)
  }

  const connections = createConnections({
    store,
    secrets: orca.secrets,
    az: async () => {
      const override = await orca.settings.get('azPath')
      const azPath = findExecutable('az', { override: typeof override === 'string' ? override : undefined, pathEnv: process.env.PATH })
      return azPath ? createAzCliProvider({ azPath, run: runCommand, home, fs }) : null
    },
    azProfiles: createAzProfiles({ home, fs }),
    fetch: globalThis.fetch,
    post: orgs => {
      orca.panels.post('orgs.changed', { orgs })
      bar.setOrgs(orgs)
      boards.onOrgs(orgs)
      prs.onOrgs(orgs)
      pipelines.onOrgs(orgs)
      runViews.onOrgs(orgs)
      reviews.onOrgs(orgs)
      wiki.onOrgs(orgs)
    },
    connectFailed: failure => orca.panels.post('orgs.connectFailed', failure),
    now: Date.now
  })
  const scheduler = createScheduler(realClock)
  const pressure = createPressure(Date.now)
  const http = pressure.wrapByOrg(connections.http)
  const boards = createBoardsService({
    http,
    orgs: () => connections.list(),
    store,
    scheduler,
    post: snapshot => orca.panels.post('work.changed', snapshot),
    postBoard: change => orca.panels.post('work.boardChanged', change),
    now: Date.now
  })
  const prs = createPrsService({
    http,
    orgs: () => connections.list(),
    scheduler,
    autoComplete: () => prSettings.autoComplete(),
    post: snapshot => orca.panels.post('prs.changed', snapshot),
    counts: (org, count) => bar.setCount(org, 'toReview', count),
    now: Date.now
  })
  const notifier = createNotifier({
    show: n => orca.host.call('notifications.show', n),
    prefs: () => pipelineSettings.notify(),
    since: activatedAt,
    log
  })
  const pipelines = createPipelinesService({
    http: connections.http,
    orgs: () => connections.list(),
    scheduler,
    watchList: createWatchList(store),
    pressure,
    signals: createRunSignals({ bar, notifier, now: Date.now }),
    post: snapshot => orca.panels.post('runs.changed', snapshot),
    now: Date.now
  })
  const runViews = createRunViews({
    http: connections.http,
    orgs: () => connections.list(),
    scheduler,
    pressure,
    watched: (org, buildId) => pipelines.isWatched(org, buildId),
    changed: change => orca.panels.post('runs.viewChanged', change),
    now: Date.now
  })
  const reviews = createReviews({ http, orgs: () => connections.list(), now: Date.now })
  const reviewActions = createReviewActions({
    http,
    reviews,
    me: org => prs.me(org),
    after: org => void prs.reloadFresh(org).catch(() => {})
  })
  const wiki = createWikiService({ http, orgs: () => connections.list(), now: Date.now })
  const prActions = createPrActions({ http, prs, settings: prSettings })
  const runActions = createRunActions({
    http,
    me: org => pipelines.me(org),
    after: (org, buildId) => {
      void pipelines.reloadFresh(org).catch(() => {})
      runViews.refreshNow(org, buildId)
    }
  })
  const clipboard = createClipboard({
    platform: process.platform,
    env: process.env,
    find: name => findExecutable(name, { pathEnv: process.env.PATH }),
    spawn: spawnWithInput,
    uid: process.getuid?.() ?? -1,
    home,
    exists: existsSync,
    list: dir => readdirSync(dir),
    log
  })
  const channels = createChannelStore({ store, secrets: orca.secrets, newId: () => crypto.randomUUID(), now: Date.now, log })
  const share = createShareService({
    http,
    store,
    channels,
    fetch: globalThis.fetch,
    orgs: () => connections.list(),
    sources: { pr: prShareSource(http, prs, prSettings), approval: approvalShareSource(pipelines, pipelineSettings) },
    destinations: [copyDestination(clipboard), channelDestination(channels, globalThis.fetch), reviewersDestination(http)],
    log
  })
  stopPolling = () => {
    scheduler.dispose()
    prs.dispose()
    pipelines.dispose()
    runViews.dispose()
  }
  await connections.resetInterrupted()

  const call: HostCall = (method, params) => orca.host.call(method as never, params as never)
  const gitPath = findExecutable('git', { pathEnv: process.env.PATH })
  const remotes = gitRemotes(runCommand, gitPath, Date.now)
  const arm = createArm(Date.now)
  const openFileDeps: OpenFileDeps = {
    call,
    gitAvailable: gitPath !== null,
    remotes,
    log,
    isFileInside: fileInside(fs)
  }
  await registerWorkspaceHandlers(orca, { boards, store, call, arm })
  orca.panels.handle('plugin.ping', () => ({ version: manifest.version }))
  registerOrgHandlers(orca, connections)
  registerWorkHandlers(orca, { boards, http, call })
  registerPrHandlers(orca, { prs, actions: prActions })
  registerReviewHandlers(orca, {
    reviews,
    actions: reviewActions,
    checkout: key => checkoutPr({ call, remotes, arm, pullRequest: input => reviews.pullRequest(input), log }, key)
  })
  const drafts = createDrafts({ store, fs, call, wiki, now: Date.now, log })
  registerWikiHandlers(orca, { wiki, drafts, publisher: createPublisher({ http, drafts, wiki, now: Date.now }) })
  registerPipelineHandlers(orca, {
    pipelines,
    actions: runActions,
    views: runViews,
    openRun: input => openRun({ call, fs, now: Date.now }, input),
    openFile: input => openRunFile(openFileDeps, input)
  })
  registerShareHandlers(orca, share)
  registerVisibilityHandler(orca, { boards, prs, pipelines, runViews })
  orca.commands.register('status', async () => statusText(await connections.list(), bar.counts()))
  const orgs = await connections.list()
  boards.onOrgs(orgs)
  prs.onOrgs(orgs)
  pipelines.onOrgs(orgs)
  runViews.onOrgs(orgs)
  reviews.onOrgs(orgs)
  wiki.onOrgs(orgs)
  bar.setOrgs(orgs)
}
