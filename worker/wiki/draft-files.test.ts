import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { assertInside, baseName, draftName, fileSegment, MAX_DRAFT_NAME, MAX_SEGMENT, pageFileName, readerName, theirsName } from './draft-files'
import { inUse, listing, outside } from './draft-test-support'

const WIKI_NAME = 'Fabrikam Web.wiki'
const PREFIX = 'wiki/contoso/Fabrikam Web.wiki'
const CHECKLIST = `${PREFIX}/Release process/Checklist.md`
const EMOJI = '😀'
const HASHED = /~[0-9a-f]{8}\.md$/
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

async function withDirs(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const dirs = [await fs.mkdtemp(path.join(os.tmpdir(), 'draft-files-ws-')), await fs.mkdtemp(path.join(os.tmpdir(), 'draft-files-out-'))]
  try {
    await run(dirs[0], dirs[1])
  } finally {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
  }
}

test('fileSegment cleans one page name for every OS', () => {
  const cases: [string, string][] = [
    ['Q&A: what?', 'Q&A- what-'],
    ['a<b>c:d"e/f\\g|h?i*j', 'a-b-c-d-e-f-g-h-i-j'],
    ['tab\there\u0000nul\u007fdel\u0085next', 'tab-here-nul-del-next'],
    ['  many   spaces 　here  ', 'many spaces here'],
    ['...hidden..', 'hidden'],
    [' . Notes . ', 'Notes'],
    ['Release notes...', 'Release notes'],
    ['CON', '_CON'],
    ['con', '_con'],
    ['Com1.txt', '_Com1.txt'],
    ['NUL.tar.gz', '_NUL.tar.gz'],
    ['lpt9', '_lpt9'],
    ['aux.', '_aux'],
    ['PRN ', '_PRN'],
    ['COM0', 'COM0'],
    ['CONSOLE', 'CONSOLE'],
    ['LPT10', 'LPT10'],
    ['', '_'],
    ['.', '_'],
    ['..', '_'],
    ['   ', '_'],
    ['. .', '_'],
    ['a\uD800b', 'a-b'],
    ['Résumé', 'Résumé']
  ]
  for (const [text, expected] of cases) assert.equal(fileSegment(text), expected, JSON.stringify(text))
})

test('fileSegment cuts at 80 UTF-16 units, keeps surrogate pairs whole and trims what the cut leaves', () => {
  assert.equal(MAX_SEGMENT, 80)
  assert.equal(fileSegment('a'.repeat(300)), 'a'.repeat(80))
  assert.equal(fileSegment(EMOJI.repeat(150)), EMOJI.repeat(40))
  const odd = fileSegment(`a${EMOJI.repeat(150)}`)
  assert.equal(odd, `a${EMOJI.repeat(39)}`)
  assert.equal(odd.length, 79)
  assert.equal(LONE_SURROGATE.test(odd), false)
  assert.equal(fileSegment(`${'a'.repeat(79)} b${'c'.repeat(50)}`), 'a'.repeat(79), 'a space left at the cut is trimmed')
  assert.equal(fileSegment(`CON ${'.'.repeat(80)}x`), '_CON', 'a device name left by the cut is still prefixed')
  assert.equal(fileSegment(`CON.${'x'.repeat(90)}`), `_CON.${'x'.repeat(75)}`)
})

test('draftName nests the page under its org and wiki and caps long names with a hash', () => {
  assert.equal(draftName('contoso', WIKI_NAME, '/Release process/Checklist'), CHECKLIST)
  assert.equal(draftName('contoso', WIKI_NAME, '/../../etc/passwd'), `${PREFIX}/_/_/etc/passwd.md`)
  assert.equal(draftName('contoso', WIKI_NAME, '/Q&A: what?'), `${PREFIX}/Q&A- what-.md`)
  assert.equal(draftName('contoso', WIKI_NAME, '/CON'), `${PREFIX}/_CON.md`)
  assert.equal(draftName('contoso', WIKI_NAME, '/a//b/'), `${PREFIX}/a/_/b/_.md`)
  assert.equal(draftName('..', '.base', '/.theirs'), 'wiki/_/base/theirs.md', 'no org, wiki or page reaches .base or .theirs')

  const a80 = 'a'.repeat(80)
  const b80 = 'b'.repeat(80)
  const exact = draftName('w', 'w', `/${a80}/${b80}/${'c'.repeat(26)}`)
  assert.equal(exact.length, MAX_DRAFT_NAME)
  assert.equal(HASHED.test(exact), false, 'a name of exactly 200 keeps its form')

  const over = draftName('w', 'w', `/${a80}/${b80}/${'c'.repeat(27)}`)
  assert.equal(over.length, MAX_DRAFT_NAME)
  assert.match(over, HASHED)
  assert.equal(over.slice(0, -12), `wiki/w/w/${a80}/${b80}/${'c'.repeat(17)}`)

  const atSlash = draftName('w', 'w', `/${a80}/${b80}/${'c'.repeat(16)}/${'d'.repeat(40)}`)
  assert.equal(atSlash.slice(0, -12), `wiki/w/w/${a80}/${b80}/${'c'.repeat(16)}`, 'a trailing / left by the cut is trimmed')
  const atDot = draftName('w', 'w', `/${a80}/${b80}/${'c'.repeat(16)}. ${'d'.repeat(40)}`)
  assert.equal(atDot.slice(0, -12), `wiki/w/w/${a80}/${b80}/${'c'.repeat(16)}`, 'a trailing dot or space left by the cut is trimmed')
  const atPair = draftName('w', 'w', `/${a80}/${b80}/${'c'.repeat(16)}${EMOJI.repeat(20)}`)
  assert.equal(atPair.slice(0, -12), `wiki/w/w/${a80}/${b80}/${'c'.repeat(16)}`, 'the cut never splits a surrogate pair')
  assert.equal(LONE_SURROGATE.test(atPair), false)

  const deep = (last: string) => draftName('contoso', WIKI_NAME, `/${'Section '.repeat(9)}/${'Chapter '.repeat(9)}/${'Part '.repeat(14)}/${last}`)
  const first = deep('Appendix A')
  const second = deep('Appendix B')
  for (const name of [first, second]) {
    assert.ok(name.length <= MAX_DRAFT_NAME, `${name.length} units`)
    assert.match(name, HASHED)
    assert.ok(name.startsWith(`${PREFIX}/`))
  }
  assert.notEqual(first, second)
  assert.equal(first.slice(0, -12), second.slice(0, -12), 'they differ only by the hash')
  assert.equal(deep('Appendix A'), first, 'the name is stable')
})

test('readerName puts a page under wiki-read by the same rules, apart from its draft', () => {
  assert.equal(readerName('contoso', WIKI_NAME, '/Release process/Checklist'), 'wiki-read/contoso/Fabrikam Web.wiki/Release process/Checklist.md')
  assert.equal(readerName('contoso', WIKI_NAME, '/../../etc/passwd'), 'wiki-read/contoso/Fabrikam Web.wiki/_/_/etc/passwd.md')
  assert.equal(pageFileName('wiki', 'contoso', WIKI_NAME, '/Q&A: what?'), draftName('contoso', WIKI_NAME, '/Q&A: what?'))

  const deep = `/${'Section '.repeat(9)}/${'Chapter '.repeat(9)}/${'Part '.repeat(14)}/Appendix A`
  const read = readerName('contoso', WIKI_NAME, deep)
  assert.ok(read.length <= MAX_DRAFT_NAME, `${read.length} units`)
  assert.match(read, HASHED)
  assert.ok(read.startsWith('wiki-read/contoso/Fabrikam Web.wiki/'))
  assert.equal(read.slice(-12), draftName('contoso', WIKI_NAME, deep).slice(-12), 'the hash names the page, not the folder')
})

test('baseName and theirsName sit beside the drafts where no page can reach', () => {
  assert.equal(baseName(CHECKLIST), 'wiki/.base/contoso/Fabrikam Web.wiki/Release process/Checklist.md')
  assert.equal(theirsName(CHECKLIST), 'wiki/.theirs/contoso/Fabrikam Web.wiki/Release process/Checklist.md')
  const theirsOfX = theirsName(draftName('contoso', WIKI_NAME, '/X'))
  const pageXTheirs = draftName('contoso', WIKI_NAME, '/X.theirs')
  assert.equal(theirsOfX, `wiki/.theirs/contoso/Fabrikam Web.wiki/X.md`)
  assert.equal(pageXTheirs, `${PREFIX}/X.theirs.md`)
  assert.notEqual(theirsOfX.toLowerCase(), pageXTheirs.toLowerCase())
})

test('assertInside answers the path under the real workspace and creates nothing', async () => {
  await withDirs(async workspace => {
    const root = await fs.realpath(workspace)
    const expected = path.join(root, '.orca-ado', 'wiki', 'contoso', 'Fabrikam Web.wiki', 'Release process', 'Checklist.md')
    assert.equal(await assertInside(fs, workspace, CHECKLIST), expected)
    assert.deepEqual(await fs.readdir(workspace), [], 'nothing is created')

    await fs.mkdir(path.join(workspace, '.orca-ado', 'wiki', 'contoso'), { recursive: true })
    assert.equal(await assertInside(fs, workspace, CHECKLIST), expected, 'part of the way exists')
    await fs.mkdir(path.dirname(expected), { recursive: true })
    await fs.writeFile(expected, 'draft\n')
    assert.equal(await assertInside(fs, workspace, CHECKLIST), expected, 'the whole way and the file exist')

    const linked = `${workspace}-link`
    await fs.symlink(workspace, linked)
    try {
      assert.equal(await assertInside(fs, linked, CHECKLIST), expected, 'a linked workspace path resolves to the real one')
    } finally {
      await fs.unlink(linked)
    }
  })
})

test('assertInside refuses a symlink or a non-folder at any level, and names that climb out', async () => {
  const plants: [string, (workspace: string, outside: string) => Promise<void>][] = [
    ['.orca-ado is a symlink', (workspace, outside) => fs.symlink(outside, path.join(workspace, '.orca-ado'))],
    [
      '.orca-ado/wiki is a symlink',
      async (workspace, outside) => {
        await fs.mkdir(path.join(workspace, '.orca-ado'))
        await fs.symlink(outside, path.join(workspace, '.orca-ado', 'wiki'))
      }
    ],
    [
      'a deeper folder is a symlink to a folder inside the workspace',
      async workspace => {
        await fs.mkdir(path.join(workspace, '.orca-ado', 'wiki'), { recursive: true })
        await fs.mkdir(path.join(workspace, 'docs'))
        await fs.symlink(path.join(workspace, 'docs'), path.join(workspace, '.orca-ado', 'wiki', 'contoso'))
      }
    ],
    [
      'the file is a symlink',
      async (workspace, outside) => {
        const file = path.join(workspace, '.orca-ado', ...CHECKLIST.split('/'))
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(path.join(outside, 'secret.md'), 'secret\n')
        await fs.symlink(path.join(outside, 'secret.md'), file)
      }
    ],
    ['.orca-ado is a file', workspace => fs.writeFile(path.join(workspace, '.orca-ado'), 'not a folder\n')]
  ]
  for (const [label, plant] of plants) {
    await withDirs(async (workspace, outsideDir) => {
      await plant(workspace, outsideDir)
      const before = [await listing(workspace), await listing(outsideDir)]
      await assert.rejects(assertInside(fs, workspace, CHECKLIST), outside(label))
      assert.deepEqual([await listing(workspace), await listing(outsideDir)], before, label)
    })
  }
  await withDirs(async workspace => {
    for (const bad of ['../outside.md', 'wiki/../../outside.md', '/etc/passwd', 'wiki//x.md', 'wiki/./x.md', '', 'wiki\\..\\..\\x.md']) {
      await assert.rejects(assertInside(fs, workspace, bad), outside(bad))
    }
  })
})

test('assertInside says a draft path is in use when a folder stands where the file goes, or a file where a folder goes', async () => {
  const plants: [string, string, (workspace: string) => Promise<void>][] = [
    [
      'the file is a folder',
      'contoso/Fabrikam Web.wiki/Release process/Checklist.md',
      workspace => fs.mkdir(path.join(workspace, '.orca-ado', ...CHECKLIST.split('/')), { recursive: true }).then(() => {})
    ],
    [
      'a folder on the way is a file',
      'contoso/Fabrikam Web.wiki/Release process',
      async workspace => {
        const wiki = path.join(workspace, '.orca-ado', ...PREFIX.split('/'))
        await fs.mkdir(wiki, { recursive: true })
        await fs.writeFile(path.join(wiki, 'Release process'), 'a draft\n')
      }
    ]
  ]
  for (const [label, taken, plant] of plants) {
    await withDirs(async (workspace, outsideDir) => {
      await plant(workspace)
      const before = [await listing(workspace), await listing(outsideDir)]
      await assert.rejects(assertInside(fs, workspace, CHECKLIST), inUse(label, taken))
      assert.deepEqual([await listing(workspace), await listing(outsideDir)], before, label)
    })
  }
  await withDirs(async workspace => {
    await fs.mkdir(path.join(workspace, '.orca-ado'))
    await fs.writeFile(path.join(workspace, '.orca-ado', 'wiki'), 'not a folder\n')
    await assert.rejects(assertInside(fs, workspace, CHECKLIST), outside('.orca-ado/wiki is a file, so the draft folder itself is missing'))
  })
})

test('assertInside accepts a folder spelled in another case on a case-insensitive volume', async () => {
  await withDirs(async (workspace, outsideDir) => {
    const wiki = path.join(workspace, '.orca-ado', 'wiki')
    await fs.mkdir(path.join(wiki, 'Docs'), { recursive: true })
    const caseInsensitive = await fs.lstat(path.join(wiki, 'docs')).then(() => true, () => false)
    if (!caseInsensitive) return
    const root = await fs.realpath(workspace)
    assert.equal(await assertInside(fs, workspace, 'wiki/docs/x.md'), path.join(root, '.orca-ado', 'wiki', 'docs', 'x.md'))
    await fs.symlink(outsideDir, path.join(wiki, 'Linked'))
    await assert.rejects(assertInside(fs, workspace, 'wiki/linked/x.md'), outside('a symlink spelled in another case'))
  })
})
