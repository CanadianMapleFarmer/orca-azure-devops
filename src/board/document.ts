import type { EditorDocument, EditorDocumentApi } from 'orca/frame'
import { boardFileText, parseBoardRef, type BoardRef } from './ref'

export interface BoardScreen {
  board(ref: BoardRef): void
  picker(picked: (ref: BoardRef) => Promise<void>): void
  note(text: string): void
  readFailed(): void
}

const READ_ONLY = "This file is read-only, so this board won't be remembered."
const NOT_SAVED = "Couldn't write this board into the file, so it won't be remembered."

export async function followDocument(doc: EditorDocumentApi, screen: BoardScreen): Promise<void> {
  let shownText: string | null = null

  function show(text: string): void {
    if (text === shownText) return
    shownText = text
    const ref = parseBoardRef(text)
    if (ref) screen.board(ref)
    else screen.picker(pick)
  }

  async function pick(ref: BoardRef): Promise<void> {
    const text = boardFileText(ref)
    shownText = text
    screen.board(ref)
    const note = await remember(doc, text)
    if (note === null) show(text)
    else if (shownText === text) screen.note(note)
  }

  const first = await doc.get().catch(() => null)
  if (first) show(textOf(first))
  else screen.readFailed()
  doc.onDidChange(next => show(textOf(next)))
}

async function remember(doc: EditorDocumentApi, text: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { version } = await doc.get()
      await doc.applyEdit({ baseVersion: version, content: { kind: 'text', text } })
      return null
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'not_permitted') return READ_ONLY
      if (code !== 'conflict') return NOT_SAVED
    }
  }
  return NOT_SAVED
}

function textOf(doc: EditorDocument): string {
  return doc.content.kind === 'text' ? doc.content.text : ''
}
