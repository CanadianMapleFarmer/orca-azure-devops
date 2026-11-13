import type { BoardScreen } from './document'
import type { Panel } from './panel'

export function closePanelFirst(panel: Pick<Panel, 'close'>, screen: BoardScreen): BoardScreen {
  return {
    ...screen,
    board: ref => {
      panel.close()
      screen.board(ref)
    },
    picker: picked => {
      panel.close()
      screen.picker(picked)
    }
  }
}
