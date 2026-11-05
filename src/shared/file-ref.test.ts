import { assert, test } from 'orca/testing'
import type { FileRef } from './pipelines'
import { fileRefOf } from './file-ref'

const ref = (path: string, line: number | null, column: number | null = null): FileRef => ({ path, line, column })

test('fileRefOf finds MSBuild, tsc, Go, Python, Docker and Helm template references', () => {
  assert.deepEqual(
    fileRefOf('/home/vsts/work/1/s/src/Api/Program.cs(42,17): error CS1002: ; expected'),
    ref('/home/vsts/work/1/s/src/Api/Program.cs', 42, 17)
  )
  assert.deepEqual(
    fileRefOf("src/app.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'."),
    ref('src/app.ts', 3, 5)
  )
  assert.deepEqual(fileRefOf('./cmd/main.go:12:3: undefined: x'), ref('./cmd/main.go', 12, 3))
  assert.deepEqual(fileRefOf('  File "app/main.py", line 7, in <module>'), ref('app/main.py', 7))
  assert.deepEqual(fileRefOf('Dockerfile:14'), ref('Dockerfile', 14))
  assert.deepEqual(
    fileRefOf('Error: template: chart/templates/deployment.yaml:23:20: executing "chart/templates/deployment.yaml" at <.Values.image.tag>: nil pointer'),
    ref('chart/templates/deployment.yaml', 23, 20)
  )
})

test('fileRefOf strips a timestamp and a marker before matching', () => {
  const expected = ref('/home/vsts/work/1/s/src/Api/Program.cs', 42, 17)
  const message = '/home/vsts/work/1/s/src/Api/Program.cs(42,17): error CS1002: ; expected [/home/vsts/work/1/s/src/Api/Api.csproj]'
  assert.deepEqual(fileRefOf(`2026-11-05T08:09:39.9000000Z ${message}`), expected)
  assert.deepEqual(fileRefOf(`2026-11-05T08:09:39.9000000Z ##[error]${message}`), expected)
  assert.deepEqual(fileRefOf(`##[error]${message}`), expected)
  assert.deepEqual(fileRefOf(`2026-11-05T08:09:39+02:00 ##[warning] ${message}`), expected)
  assert.deepEqual(fileRefOf('2026-11-05T08:09:39Z ##[error]./cmd/main.go:12:3: undefined: x'), ref('./cmd/main.go', 12, 3))
})

test('fileRefOf reads a compiler reference with or without a column, with spaces and backslashes kept', () => {
  assert.deepEqual(fileRefOf('src/Program.cs(42): error CS1002: ; expected'), ref('src/Program.cs', 42))
  assert.deepEqual(fileRefOf('src/Program.cs(42, 17): warning CS8618: Non-nullable property'), ref('src/Program.cs', 42, 17))
  assert.deepEqual(
    fileRefOf('C:\\a\\1\\s\\src\\Api\\Program.cs(42,17): error CS1002: ; expected'),
    ref('C:\\a\\1\\s\\src\\Api\\Program.cs', 42, 17)
  )
  assert.deepEqual(
    fileRefOf('C:\\Program Files\\app\\a.cs(3,4): error CS0103: The name does not exist'),
    ref('C:\\Program Files\\app\\a.cs', 3, 4)
  )
  assert.deepEqual(fileRefOf('Api.csproj(0,0): error MSB4018: The task failed'), ref('Api.csproj', null, null))
})

test('fileRefOf reads path:line[:col] forms', () => {
  assert.deepEqual(fileRefOf('src/app/main.go:12'), ref('src/app/main.go', 12))
  assert.deepEqual(fileRefOf('C:\\src\\app\\main.go:12:3: undefined: x'), ref('C:\\src\\app\\main.go', 12, 3))
  assert.deepEqual(fileRefOf('src\\app\\main.go:12: missing return'), ref('src\\app\\main.go', 12))
  assert.deepEqual(fileRefOf('Dockerfile.prod:3'), ref('Dockerfile.prod', 3))
  assert.deepEqual(fileRefOf('failed at docker/Dockerfile:7 while copying'), ref('docker/Dockerfile', 7))
  assert.deepEqual(fileRefOf('    at Object.<anonymous> (/app/src/index.js:10:15)'), ref('/app/src/index.js', 10, 15))
  assert.deepEqual(fileRefOf('see src/a.ts:12.'), ref('src/a.ts', 12))
  assert.deepEqual(fileRefOf('node_modules/@types/node/index.d.ts:55:3 - error TS2300'), ref('node_modules/@types/node/index.d.ts', 55, 3))
})

test('fileRefOf reads a Python traceback frame and keeps a Windows path as written', () => {
  assert.deepEqual(fileRefOf('File "C:\\work\\app\\main.py", line 7, in run'), ref('C:\\work\\app\\main.py', 7))
  assert.deepEqual(fileRefOf('File "/usr/lib/python 3/site.py", line 12'), ref('/usr/lib/python 3/site.py', 12))
})

test('fileRefOf tries the compiler form before path:line and path:line before Python', () => {
  assert.deepEqual(fileRefOf('src/a.ts(3,5): error TS1005: see other.ts:9:1'), ref('src/a.ts', 3, 5))
  assert.deepEqual(fileRefOf('File "a.py", line 3 imported from b.go:9'), ref('b.go', 9))
})

test('fileRefOf ignores URLs and plain text', () => {
  const none = [
    '',
    '   ',
    'Build FAILED.',
    'https://example.com:8080/a.js',
    'see https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4512:12 for details',
    'http://localhost:3000/app.js:10:5',
    'Elapsed 00:00:12.34',
    'started at 10:30:45',
    'listening on localhost:3000',
    'connecting to 10.0.0.1:8080',
    'pulling registry.example.com:5000/contoso/web-app:latest',
    'version v1.2.3:45',
    'Dockerfile',
    'a.ts:',
    'src/a.ts: no line here',
    'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
    '2026-11-05T08:09:38.8120000Z ##[section]Starting: Build and push image',
    '12:30:45 PM'
  ]
  for (const text of none) assert.equal(fileRefOf(text), null, text)
  assert.deepEqual(fileRefOf('error in src/a.ts:3:5 see https://example.com/docs:9'), ref('src/a.ts', 3, 5))
})

test('fileRefOf does not take a line number that is too long to be one', () => {
  assert.equal(fileRefOf('src/a.ts:1234567890123'), null)
  assert.deepEqual(fileRefOf('src/a.ts:123456789'), ref('src/a.ts', 123456789))
})

test('fileRefOf stays fast on a very long line', () => {
  assert.equal(fileRefOf('a('.repeat(150_000)), null)
  assert.equal(fileRefOf('x'.repeat(300_000)), null)
  assert.equal(fileRefOf(`${'y '.repeat(150_000)}src/a.ts:3`), null)
})
