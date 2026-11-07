const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const native = require('../native')
const ID = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-native-test-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const procRoot = path.join(root, 'proc'), home = path.join(root, 'home')
    fs.mkdirSync(procRoot); fs.mkdirSync(home)
    function proc(pid, ppid, argv, env = {}) {
        const dir = path.join(procRoot, String(pid))
        fs.mkdirSync(path.join(dir, 'fd'), { recursive: true })
        const stat = ['S', String(ppid), ...Array(17).fill('0'), '12345']
        fs.writeFileSync(path.join(dir, 'stat'), `${pid} (fixture) ${stat.join(' ')}`)
        fs.writeFileSync(path.join(dir, 'cmdline'), argv.join('\0') + '\0')
        fs.writeFileSync(path.join(dir, 'environ'), Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\0'))
        fs.symlinkSync(home, path.join(dir, 'cwd'))
        fs.symlinkSync(argv[0], path.join(dir, 'exe'))
        return dir
    }
    function transcript(pid, id = ID, payload = {}) {
        const file = path.join(home, '.codex', 'sessions', `${id}.jsonl`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli', ...payload } }) + '\n')
        fs.symlinkSync(file, path.join(procRoot, String(pid), 'fd', id))
    }
    proc(100, 1, ['/bin/bash'])
    return { root, home, procRoot, proc, transcript, detect: native.createDetector({ procRoot, home, platform: 'linux' }) }
}

test('resume uses an exact identity, preserves chosen CLI options and drops the initial prompt', () => {
    assert.deepEqual(native.resumeArgs('codex', ['-m', 'my-model', '--sandbox=workspace-write', 'original prompt'], ID), ['-m', 'my-model', '--sandbox', 'workspace-write', 'resume', ID])
    assert.deepEqual(native.resumeArgs('claude', ['--model', 'sonnet', '--continue'], ID), ['--model', 'sonnet', '--resume', ID])
    assert.equal(native.resumeArgs('codex', ['--last'], null), null)
    assert.equal(native.resumeArgs('claude', ['--resume', 'search text'], null), null)
})

test('headless jobs and unknown or secret-bearing options are never replayed', () => {
    for (const args of [['exec', 'task'], ['app-server'], ['--config', 'api_key="secret"'], ['--unrecognized', 'value']]) assert.equal(native.resumeArgs('codex', args, ID), null)
    for (const args of [['-p', 'task'], ['--print'], ['--mcp-config', 'private.json']]) assert.equal(native.resumeArgs('claude', args, ID), null)
})

test('explicit profiles recover without a daemon on every platform', () => {
    const token = { profile: { options: { command: '/usr/bin/codex', args: ['resume', ID], cwd: '/work', env: { CODEX_HOME: '/config', API_KEY: 'secret' } } } }
    const entry = native.fromProfile(token)
    assert.equal(entry.id, ID)
    assert.deepEqual(entry.env, { CODEX_HOME: '/config' })
    assert.equal(native.fromProfile({ profile: { options: { command: 'codex', args: ['resume', '--last'] } } }), null)
})

test('fresh Codex conversation is found only among the exact pane descendants', async t => {
    const f = fixture(t)
    f.proc(101, 100, ['/usr/bin/codex', '--no-daemon', 'original task'], { CODEX_HOME: '/config', API_KEY: 'secret' })
    f.transcript(101)
    f.proc(201, 200, ['/usr/bin/codex']); f.transcript(201, SECOND)
    const entry = await f.detect(100)
    assert.equal(entry.id, ID)
    assert.deepEqual(entry.args, ['--no-daemon', 'resume', ID])
    assert.deepEqual(entry.env, { CODEX_HOME: '/config' })
    assert.equal(entry.cwd, f.home)
    assert.equal(await f.detect(999), null)
})

test('own private app-server may hold the transcript; a shared daemon is not searched', async t => {
    const f = fixture(t)
    f.proc(101, 100, ['/usr/bin/codex'])
    f.proc(102, 101, ['/usr/bin/codex', 'app-server']); f.transcript(102)
    assert.equal((await f.detect(100)).id, ID)
    assert.equal(await f.detect(102), null)
})

test('ambiguous conversations and subagent transcripts never select the last session', async t => {
    const f = fixture(t)
    f.proc(101, 100, ['/usr/bin/codex']); f.transcript(101); f.transcript(101, SECOND)
    assert.equal(await f.detect(100), null)
    const other = fixture(t)
    other.proc(101, 100, ['/usr/bin/codex']); other.transcript(101, ID, { source: { subagent: 'review' } })
    assert.equal(await other.detect(100), null)
})

test('two independent interactive agents in one pane do not get an arbitrary binding', async t => {
    const f = fixture(t)
    f.proc(101, 100, ['/usr/bin/codex', 'resume', ID])
    f.proc(102, 100, ['/usr/bin/claude', '--resume', SECOND])
    assert.equal(await f.detect(100), null)
})

test('Claude registry verifies process start to reject reused PIDs', async t => {
    const f = fixture(t)
    const config = path.join(f.home, '.claude')
    f.proc(101, 100, ['/usr/bin/claude'], { CLAUDE_CONFIG_DIR: config })
    fs.mkdirSync(path.join(config, 'sessions'), { recursive: true })
    const file = path.join(config, 'sessions', '101.json')
    fs.writeFileSync(file, JSON.stringify({ kind: 'interactive', procStart: '12345', sessionId: ID }, null, 2))
    assert.equal((await f.detect(100)).id, ID)
    fs.writeFileSync(file, JSON.stringify({ kind: 'interactive', procStart: 'old-pid', sessionId: ID }))
    assert.equal(await f.detect(100), null)
})

test('a current live transcript takes precedence over an old resume argument', async t => {
    const f = fixture(t)
    f.proc(101, 100, ['/usr/bin/codex', 'resume', SECOND]); f.transcript(101)
    assert.equal((await f.detect(100)).id, ID)
})

test('Node CLI wrappers preserve their executable and script', async t => {
    const f = fixture(t)
    const script = '/node_modules/@openai/codex/bin/codex.js'
    f.proc(101, 100, ['/usr/bin/node', script, 'resume', ID])
    const entry = await f.detect(100)
    assert.equal(entry.command, '/usr/bin/node')
    assert.deepEqual(entry.args, [script, 'resume', ID])
})

test('unsupported platforms leave automatic detection to Tabby', async () => {
    assert.equal(await native.createDetector({ platform: 'darwin' })(100), null)
})

test('npm Codex wrapper resolves the native child that owns the current transcript', async t => {
    const f = fixture(t)
    f.proc(101, 100, ['/usr/bin/node', '/node_modules/@openai/codex/bin/codex.js'])
    f.proc(102, 101, ['/vendor/codex']); f.transcript(102)
    const entry = await f.detect(100)
    assert.equal(entry.id, ID)
    assert.equal(entry.command, '/vendor/codex')
})

test('explicitly chosen permission flags are preserved, never added by default', () => {
    assert.deepEqual(native.resumeArgs('claude', ['--dangerously-skip-permissions'], ID), ['--dangerously-skip-permissions', '--resume', ID])
    assert.deepEqual(native.resumeArgs('codex', [], ID), ['resume', ID])
})
