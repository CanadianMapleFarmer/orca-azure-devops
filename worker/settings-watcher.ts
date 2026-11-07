import type { OrcaWorkerApi } from 'orca/worker'
import { SETTINGS_READ_FAILED } from './messages'

export async function watchSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<() => Record<string, unknown>> {
  let values: Record<string, unknown> = {}
  const refresh = async () => {
    values = await settings.get().catch(() => {
      log(SETTINGS_READ_FAILED)
      return values
    })
  }
  await refresh()
  settings.onDidChange(() => void refresh())
  return () => values
}

export function settingOn(values: () => Record<string, unknown>, key: string): boolean {
  const value = values()[key]
  return typeof value === 'boolean' ? value : true
}
