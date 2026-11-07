const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bridge = require('../bridge')
const launcher = process.execPath
const statePath = '/example/state'
const state = { entries: { old: { redirect_to: 'pane' }, pane: { enabled: true } } }
const shell = (pty = 'pty-1') => ({ type: 'app:local-tab', tabTitle: 'Original',
    profile: { options: { command: '/bin/bash', args: ['--login'], restoreFromPTYID: pty } } })

test('migration binds exact PTY within nested layout, retaining order, titles and ratios', () => {
    const tokens = [{ type: 'app:split-tab', ratios: [0.3, 0.7], orientation: 'h',
        children: [shell('untouched'), { type: 'app:split-tab', children: [shell('target')] }] }]
    bridge.migrate(tokens, state, { bindings: { target: 'old' } }, statePath, launcher)
    assert.equal(tokens.length, 1)
    assert.deepEqual(tokens[0].ratios, [0.3, 0.7])
    assert.equal(tokens[0].children[0].profile.options.command, '/bin/bash')
    const pane = tokens[0].children[1].children[0]
    assert.deepEqual(pane.profile.options.args, ['attach', 'pane'])
    assert.equal(pane.profile.behaviorOnSessionEnd, 'keep')
    assert.equal(pane.tabTitle, 'Original')
    assert.deepEqual(bridge.manifest(tokens, statePath).panes, [{ key: 'pane', path: [0, 1, 0] }])
    const once = structuredClone(tokens)
    bridge.migrate(tokens, state, { bindings: { target: 'old' } }, statePath, launcher)
    assert.deepEqual(tokens, once)
})

test('unknown or disabled identities never rewrite shell commands', () => {
    for (const entries of [{}, { pane: { enabled: false } }]) {
        const token = shell(), before = structuredClone(token)
        bridge.bindToken(token, 'pane', { entries }, launcher)
        assert.deepEqual(token, before)
    }
    assert.equal(bridge.canonical('a', { entries: { a: { redirect_to: 'b' }, b: { redirect_to: 'a' } } }), null)
})

test('legacy OpenCode script stays intact and contributes its exact pane key', () => {
    const token = shell()
    token.profile.options.args = ['--login', `${statePath}/reconnect/opencode-law.sh`]
    const before = structuredClone(token)
    bridge.migrate([token], state, {}, statePath, launcher)
    assert.deepEqual(token, before)
    assert.equal(bridge.tokenKey(token, statePath), 'opencode-law')
    assert.equal(bridge.tokenKey(token, '/unrelated/state'), null)
})

function fixture (t, extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-bridge-test-'))
    t.after(() => fs.rmSync(root, { recursive: true }))
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state))
    const storage = {}
    class Recovery {
        enabled = true
        async getFullRecoveryToken (tab) { return structuredClone(tab.token) }
        async recoverTabs () { return JSON.parse(storage.tabsRecovery || '[]') }
        async saveTabs (tabs) { storage.tabsRecovery = JSON.stringify(await Promise.all(tabs.map(x => this.getFullRecoveryToken(x)))) }
    }
    class Terminal {
        ngOnInit () {}
        setSession (session) { this.session = session }
        initializeSession (columns, rows) { this.starts = (this.starts || 0) + 1; this.session = { resize: () => { this.resized = true } } }
    }
    bridge.install({
        core: { TabRecoveryService: Recovery },
        local: { TerminalTabComponent: Terminal },
        storage, statePath: root, launcher,
        ipc: { sendSync: () => 42 },
        lookupBindings: async () => ({ 42: 'pane' }),
        warning: message => { throw Error(message) },
        ...extra,
    })
    return { root, storage, Recovery, Terminal }
}

test('unfocused bound pane starts once without selecting or focusing a tab', t => {
    const { Terminal } = fixture(t)
    const tab = new Terminal()
    tab.profile = { options: { command: launcher, args: ['attach', 'pane'] } }
    tab.hasFocus = false
    tab.ngOnInit()
    assert.equal(tab.starts, 1)
    assert.equal(tab.profile.behaviorOnSessionEnd, 'keep')
    assert.equal(tab.profile.options.pauseAfterExit, true)
    tab.initializeSession(100, 30)
    assert.equal(tab.starts, 1)
    assert.equal(tab.resized, true)
    const ordinary = new Terminal()
    ordinary.profile = shell().profile
    ordinary.ngOnInit()
    assert.equal(ordinary.starts, undefined)
    assert.equal(ordinary.profile.behaviorOnSessionEnd, undefined)
})

test('saving a managed process in an ordinary shell records its exact pane identity', async t => {
    const { Recovery, root, storage } = fixture(t)
    await new Recovery().saveTabs([{ token: shell() }])
    const saved = JSON.parse(storage.tabsRecovery)[0]
    assert.equal(saved.profile.options.command, launcher)
    assert.deepEqual(saved.profile.options.args, ['attach', 'pane'])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tabby-layout.json'))).panes, [{ key: 'pane', path: [0] }])
    assert.equal(fs.statSync(path.join(root, 'tabby-layout.json')).mode & 0o777, 0o600)
})

test('pending migration executes before Tabby constructs recovered tabs', async t => {
    const { Recovery, root, storage } = fixture(t)
    storage.tabsRecovery = JSON.stringify([shell('target')])
    fs.writeFileSync(path.join(root, 'tabby-pending-bindings.json'), JSON.stringify({ bindings: { target: 'old' } }))
    const recovered = await new Recovery().recoverTabs()
    assert.equal(recovered[0].profile.options.agentSessionKey, 'pane')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'tabby-layout-before-binding.json')))[0].profile.options.command, '/bin/bash')
})

test('launch snapshot survives later autosaves and preserves terminal scrollback privately', async t => {
    const { Recovery, root, storage } = fixture(t, { includeScrollback: true })
    const token = shell('target')
    token.savedState = 'private terminal scrollback'
    storage.tabsRecovery = JSON.stringify([{ type: 'app:split-tab', savedState: 'nested scrollback',
        ratios: [1], children: [token] }])
    const recovery = new Recovery()
    await recovery.recoverTabs()
    await recovery.saveTabs([])
    const files = fs.readdirSync(path.join(root, 'layout-snapshots'))
    assert.equal(files.length, 1)
    const file = path.join(root, 'layout-snapshots', files[0])
    const snapshot = JSON.parse(fs.readFileSync(file))
    assert.equal(snapshot.tabs.length, 1)
    assert.equal(snapshot.tabs[0].children[0].profile.options.restoreFromPTYID, 'target')
    assert.equal(snapshot.tabs[0].children[0].savedState, 'private terminal scrollback')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tabby-latest-snapshot.json'))).tabs, [])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('legacy explicitly bound script also keeps its tab after the session ends', t => {
    const { Terminal, root } = fixture(t)
    const tab = new Terminal()
    tab.profile = { behaviorOnSessionEnd: 'auto', options: { command: '/bin/bash',
        args: ['--login', path.join(root, 'reconnect/opencode-law.sh')] } }
    tab.ngOnInit()
    assert.equal(tab.profile.behaviorOnSessionEnd, 'keep')
    assert.equal(tab.profile.options.pauseAfterExit, true)
})

test('terminal output is not recorded unless logging is enabled', t => {
    const { Terminal, root } = fixture(t, { logTerminalOutput: false })
    const session = {
        middleware: { outputToTerminal$: { subscribe: () => { throw Error('should not subscribe') } } },
        destroyed$: { subscribe: () => {} },
    }
    const tab = new Terminal()
    tab.setSession(session)
    assert.equal(fs.existsSync(path.join(root, 'terminal-logs')), false)
})

test('terminal output is recorded privately without recording keyboard input', async t => {
    const { Terminal, root } = fixture(t, { logTerminalOutput: true })
    let output, destroyed, unsubscribed = false
    const session = {
        middleware: { outputToTerminal$: { subscribe: fn => { output = fn; return { unsubscribe: () => { unsubscribed = true } } } } },
        destroyed$: { subscribe: fn => { destroyed = fn } },
    }
    const tab = new Terminal()
    tab.title = 'Test pane'
    tab.profile = shell().profile
    tab.setSession(session)
    output(Buffer.from('terminal output\n'))
    destroyed()
    const dir = path.join(root, 'terminal-logs')
    let name
    for (let n = 0; n < 100; n++) {
        name = fs.readdirSync(dir).find(item => item.endsWith('.ansi'))
        if (name && fs.statSync(path.join(dir, name)).size) break
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    const log = path.join(dir, name)
    assert.equal(fs.readFileSync(log, 'utf8'), 'terminal output\n')
    assert.equal(fs.statSync(log).mode & 0o777, 0o600)
    assert.equal(unsubscribed, true)
})

test('a missing launcher never replaces a working legacy reconnect script', () => {
    const token = shell()
    token.profile.options.args = ['--login', `${statePath}/reconnect/pane.sh`]
    const before = structuredClone(token)
    bridge.migrate([token], state, {}, statePath, '/not-installed/agent-sessions')
    assert.deepEqual(token, before)
})

test('native recovery works in a clean installation with no external state or launcher', async t => {
    const id = '11111111-1111-4111-8111-111111111111'
    const { Recovery, storage, root, Terminal } = fixture(t, {
        launcher: '/not-installed/agent-sessions', lookupBindings: undefined,
        detectNative: async pid => { assert.equal(pid, 42); return { id, kind: 'codex', command: '/usr/bin/codex', args: ['resume', id], cwd: '/work', env: {} } },
    })
    fs.unlinkSync(path.join(root, 'state.json'))
    await new Recovery().saveTabs([{ token: shell() }])
    const saved = JSON.parse(storage.tabsRecovery)[0]
    assert.equal(saved.profile.options.command, '/usr/bin/codex')
    assert.deepEqual(saved.profile.options.args, ['resume', id])
    const tab = new Terminal()
    tab.profile = saved.profile
    tab.ngOnInit()
    assert.equal(tab.starts, 1)
    tab.initializeSession(90, 20)
    assert.equal(tab.starts, 1)
})

test('default snapshots omit scrollback and credential environment, including nested panes', async t => {
    const { Recovery, root, storage } = fixture(t)
    const token = shell()
    token.savedState = 'secret output'
    token.profile.options.env = { API_KEY: 'secret-key', CODEX_HOME: '/config' }
    storage.tabsRecovery = JSON.stringify([{ type: 'app:split-tab', savedState: 'parent output', children: [token] }])
    const recovery = new Recovery()
    await recovery.recoverTabs()
    await recovery.saveTabs([{ token }])
    for (const file of [path.join(root, 'tabby-latest-snapshot.json'), ...fs.readdirSync(path.join(root, 'layout-snapshots')).map(f => path.join(root, 'layout-snapshots', f))]) {
        const data = fs.readFileSync(file, 'utf8')
        assert.equal(data.includes('secret'), false)
        assert.equal(data.includes('savedState'), false)
        assert.equal(data.includes('/config'), true)
    }
    assert.equal(JSON.parse(storage.tabsRecovery)[0].savedState, 'secret output')
})

test('launch snapshots are bounded to twenty files and unrelated files survive pruning', async t => {
    const { Recovery, root, storage } = fixture(t)
    const dir = path.join(root, 'layout-snapshots')
    fs.mkdirSync(dir)
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `2020-01-${String(i + 1).padStart(2, '0')}.json`), '{}')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep')
    storage.tabsRecovery = JSON.stringify([shell()])
    await new Recovery().recoverTabs()
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 20)
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'keep')
})

test('newly detected panes keep their recovery command even if the process later exits', async t => {
    const id = '11111111-1111-4111-8111-111111111111'
    const { Recovery } = fixture(t, { launcher: '/missing', lookupBindings: undefined,
        detectNative: async () => ({ id, command: '/usr/bin/codex', args: ['resume', id], env: {} }) })
    const tab = { token: shell(), profile: shell().profile, session: { pauseAfterExit: false } }
    await new Recovery().getFullRecoveryToken(tab)
    assert.equal(tab.profile.behaviorOnSessionEnd, 'keep')
    assert.deepEqual(tab.profile.options.args, ['resume', id])
    assert.equal(tab.session.pauseAfterExit, true)
    assert.equal(tab.profile.options.restoreFromPTYID, undefined)
})
