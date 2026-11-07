'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const run = promisify(execFile)
const KEY = /^[a-z0-9-]{1,80}$/
const native = require('./native')

function executable (file) {
    try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return true } catch { return false }
}

function readJSON (file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function atomicJSON (file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.pending`
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
        fs.renameSync(temporary, file)
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
}

function defaultLauncher () {
    return process.env.AGENT_SESSIONS_LAUNCHER || path.join(os.homedir(), '.local/bin/agent-sessions')
}

function defaultStatePath () {
    if (process.env.AGENT_SESSIONS_STATE) return process.env.AGENT_SESSIONS_STATE
    const agent = path.join(os.homedir(), '.local/state/agent-sessions')
    if (fs.existsSync(path.join(agent, 'state.json'))) return agent
    return path.join(os.homedir(), '.local/state/tabby-agent-recovery')
}

function canonical (key, state) {
    const seen = new Set()
    while (KEY.test(key || '') && !seen.has(key)) {
        seen.add(key)
        const entry = state.entries?.[key]
        if (!entry) return null
        if (!entry.redirect_to) return key
        key = entry.redirect_to
    }
    return null
}

function tokenKey (token, statePath, launcher) {
    if (token.type !== 'app:local-tab') return null
    const options = token.profile?.options || {}
    if (KEY.test(options.agentSessionKey || '')) return options.agentSessionKey
    const args = options.args || []
    launcher ||= defaultLauncher()
    if (options.command === launcher && args.length === 2 && args[0] === 'attach' && KEY.test(args[1] || '')) return args[1]
    const script = args.length === 2 && args[0] === '--login' ? args[1] : null
    if (typeof script === 'string' && path.dirname(script) === path.join(statePath, 'reconnect')) {
        const key = path.basename(script, '.sh')
        if (script.endsWith('.sh') && KEY.test(key)) return key
    }
    return null
}

function bindToken (token, key, state, launcher) {
    key = canonical(key, state)
    if (!key || state.entries[key].enabled === false || !executable(launcher)) return token
    token.profile = { ...token.profile, behaviorOnSessionEnd: 'keep', options: {
        ...token.profile.options,
        command: launcher,
        args: ['attach', key],
        agentSessionKey: key,
        pauseAfterExit: true,
    } }
    return token
}

function walk (tokens, visit, prefix = []) {
    tokens.forEach((token, index) => {
        const location = [...prefix, index]
        if (token.type === 'app:local-tab') visit(token, location)
        if (Array.isArray(token.children)) walk(token.children, visit, location)
    })
}

function migrate (tokens, state, pending, statePath, launcher) {
    walk(tokens, token => {
        const pty = token.profile?.options?.restoreFromPTYID
        const key = pending.bindings?.[pty] || tokenKey(token, statePath, launcher)
        if (key) bindToken(token, key, state, launcher)
    })
    return tokens
}

function manifest (tokens, statePath, launcher) {
    const panes = []
    walk(tokens, (token, location) => {
        const key = tokenKey(token, statePath, launcher)
        if (key) panes.push({ key, path: location })
    })
    return { version: 1, saved_at: new Date().toISOString(), panes }
}

function layoutOnly (tokens) {
    return tokens.map(({ savedState, children, profile, ...token }) => ({
        ...token, ...(profile ? { profile: { ...profile, options: { ...profile.options, env: native.safeEnvironment(profile.options?.env) } } } : {}),
        ...(Array.isArray(children) ? { children: layoutOnly(children) } : {}),
    }))
}

function install ({
    core, local, ipc, storage, statePath, launcher, lookupBindings,
    logTerminalOutput, includeScrollback = process.env.TABBY_AGENT_RECOVERY_SCROLLBACK === '1',
    detectNative = native.createDetector(), warning = console.warn,
} = {}) {
    statePath ||= defaultStatePath()
    launcher ||= defaultLauncher()
    if (logTerminalOutput == null) logTerminalOutput = process.env.TABBY_AGENT_RECOVERY_LOG === '1'
    const recovery = core.TabRecoveryService.prototype
    if (recovery.agentRecoveryInstalled) return
    recovery.agentRecoveryInstalled = true
    const state = () => readJSON(path.join(statePath, 'state.json'), { entries: {} })
    let cache, cachedAt = 0
    const bindings = () => {
        if (!lookupBindings && !executable(launcher)) return Promise.resolve({})
        if (!cache || Date.now() - cachedAt > 1000) {
            cachedAt = Date.now()
            cache = (lookupBindings ? lookupBindings() : run(launcher, ['pane-bindings'], { timeout: 2500, maxBuffer: 65536 })
                .then(x => JSON.parse(x.stdout)))
                .catch(() => { warning('agent-recovery: pane lookup unavailable; keeping saved bindings'); return {} })
        }
        return cache
    }

    const getToken = recovery.getFullRecoveryToken
    recovery.getFullRecoveryToken = async function (tab, options) {
        const token = await getToken.call(this, tab, options)
        if (token?.type !== 'app:local-tab') return token
        try {
            const pty = token.profile?.options?.restoreFromPTYID
            const pid = pty && ipc.sendSync('pty:get-pid', pty)
            const key = (pid && (await bindings())[String(pid)]) || tokenKey(token, statePath, launcher)
            if (key && canonical(key, state()) && executable(launcher)) bindToken(token, key, state(), launcher)
            else native.bindNative(token, (pid && await detectNative(Number(pid))) || native.fromProfile(token))
            if (token.profile?.behaviorOnSessionEnd === 'keep' &&
                (native.fromProfile(token) || tokenKey(token, statePath, launcher))) {
                // Keep the newly identified pane now, not only after its next restart.
                const { restoreFromPTYID, ...options } = token.profile.options
                tab.profile = { ...token.profile, options }
                if (tab.session) tab.session.pauseAfterExit = true
            }
        } catch {
            warning('agent-recovery: could not refresh a pane binding; preserving its profile')
        }
        return token
    }

    const recoverTabs = recovery.recoverTabs
    let launchSnapshotSaved = false
    recovery.recoverTabs = async function (...args) {
        if (storage.tabsRecovery) {
            try {
                const pending = readJSON(path.join(statePath, 'tabby-pending-bindings.json'), {})
                const before = storage.tabsRecovery
                const original = JSON.parse(before)
                if (!launchSnapshotSaved && Array.isArray(original) && original.length) {
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
                    atomicJSON(path.join(statePath, 'layout-snapshots', `${stamp}-${process.pid}.json`), {
                        version: 1, saved_at: new Date().toISOString(), tabs: includeScrollback ? original : layoutOnly(original),
                    })
                    const snapshots = path.join(statePath, 'layout-snapshots')
                    fs.readdirSync(snapshots).filter(name => /^\d{4}-.*\.json$/.test(name)).sort().slice(0, -20).forEach(name => fs.unlinkSync(path.join(snapshots, name)))
                    launchSnapshotSaved = true
                }
                const tokens = migrate(original, state(), pending, statePath, launcher)
                const after = JSON.stringify(tokens)
                if (before !== after) {
                    const backup = path.join(statePath, 'tabby-layout-before-binding.json')
                    if (!fs.existsSync(backup)) atomicJSON(backup, includeScrollback ? JSON.parse(before) : layoutOnly(JSON.parse(before)))
                    storage.tabsRecovery = after
                }
                atomicJSON(path.join(statePath, 'tabby-layout.json'), manifest(tokens, statePath, launcher))
            } catch {
                warning('agent-recovery: layout migration unavailable; leaving original recovery intact')
            }
        }
        return recoverTabs.apply(this, args)
    }

    const saveTabs = recovery.saveTabs
    recovery.saveTabs = async function (...args) {
        await saveTabs.apply(this, args)
        if (this.enabled && storage.tabsRecovery) {
            try {
                const tokens = JSON.parse(storage.tabsRecovery)
                atomicJSON(path.join(statePath, 'tabby-layout.json'), manifest(tokens, statePath, launcher))
                atomicJSON(path.join(statePath, 'tabby-latest-snapshot.json'), {
                    version: 1, saved_at: new Date().toISOString(), tabs: includeScrollback ? tokens : layoutOnly(tokens),
                })
            } catch {
                warning('agent-recovery: could not checkpoint pane manifest')
            }
        }
    }

    const terminal = local.TerminalTabComponent.prototype
    if (logTerminalOutput) {
        const setSession = terminal.setSession
        if (setSession) {
            terminal.setSession = function (session, ...args) {
                if (!session) return setSession.call(this, session, ...args)
                try {
                    const dir = path.join(statePath, 'terminal-logs')
                    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
                    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
                    const stream = fs.createWriteStream(path.join(dir, `${id}.ansi`), { flags: 'wx', mode: 0o600 })
                    stream.on('error', () => warning('agent-recovery: terminal output log unavailable'))
                    atomicJSON(path.join(dir, `${id}.json`), {
                        started_at: new Date().toISOString(), title: this.title || '',
                        cwd: this.profile?.options?.cwd || null,
                        key: tokenKey({ type: 'app:local-tab', profile: this.profile }, statePath, launcher),
                    })
                    const subscription = session.middleware.outputToTerminal$.subscribe(data => stream.write(data))
                    session.destroyed$.subscribe(() => { subscription.unsubscribe(); stream.end() })
                } catch {
                    warning('agent-recovery: terminal output log unavailable')
                }
                return setSession.call(this, session, ...args)
            }
        }
    }
    const onInit = terminal.ngOnInit
    terminal.ngOnInit = function (...args) {
        const token = { type: 'app:local-tab', profile: this.profile }
        const key = tokenKey(token, statePath, launcher)
        const bound = (key && state().entries[key]?.enabled !== false) || native.fromProfile(token)
        if (bound) {
            this.profile.behaviorOnSessionEnd = 'keep'
            this.profile.options.pauseAfterExit = true
        }
        onInit.apply(this, args)
        if (!bound || this.session) return
        const initialize = this.initializeSession
        initialize.call(this, this.size?.columns || 80, this.size?.rows || 24)
        const started = this.session
        this.initializeSession = function (columns, rows) {
            this.initializeSession = initialize
            if (this.session === started && started) {
                started.resize(columns, rows)
                return
            }
            return initialize.call(this, columns, rows)
        }
    }
}

module.exports = {
    install, canonical, tokenKey, bindToken, walk, migrate, manifest, layoutOnly,
    defaultLauncher, defaultStatePath, executable,
}
