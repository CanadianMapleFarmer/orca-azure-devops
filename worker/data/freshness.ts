export const FRESHNESS = {
  boardConfig: 3_600_000,
  typeStates: 3_600_000,
  projects: 3_600_000,
  wikis: 600_000,
  prActive: 120_000,
  checksRunning: 120_000,
  checksIdle: 1_800_000,
  prWorkItems: 600_000,
  prWorkItemsClosed: 3_600_000,
  boardView: 30_000
} as const

export const MAX_ENTRIES = {
  workItems: 5000,
  prs: 2000,
  prChecks: 2000,
  prWorkItems: 2000,
  builds: 500,
  timelines: 100,
  runChips: 200,
  boardConfigs: 20,
  typeStates: 100,
  projects: 4,
  wikis: 1
} as const
