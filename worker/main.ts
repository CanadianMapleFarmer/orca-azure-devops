import type { OrcaWorkerApi } from 'orca/worker'
import manifest from '../orca-plugin.json' with { type: 'json' }

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  orca.panels.handle('plugin.ping', () => ({ version: manifest.version }))
}
