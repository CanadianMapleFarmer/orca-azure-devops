import type { OrcaWorkerApi } from 'orca/worker'
import type { ShareService } from './service'

export function registerShareHandlers(orca: OrcaWorkerApi, share: ShareService): void {
  orca.panels.handle('share.prefs', input => share.prefs(input.org, input.kind))
  orca.panels.handle('share.send', input => share.send(input))
  orca.panels.handle('share.people', input => share.people(input))
  orca.panels.handle('share.channels', () => share.channels.list())
  orca.panels.handle('share.addChannel', input => share.channels.add(input.name, input.url))
  orca.panels.handle('share.replaceChannel', input => share.channels.replace(input.id, input.url))
  orca.panels.handle('share.removeChannel', async input => {
    await share.channels.remove(input.id)
    return { ok: true as const }
  })
  orca.panels.handle('share.testChannel', input => share.test(input.id))
}
