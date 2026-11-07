'use strict'

// Native conversation recovery: no supervisor, shell eval or "latest" lookup.
const fs = require('fs')
const path = require('path')
const os = require('os')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_KEYS = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']
const FLAGS = {
    codex: {
        value: ['--model', '-m', '--profile', '-p', '--sandbox', '-s', '--ask-for-approval', '-a', '--add-dir', '--enable', '--disable', '--local-provider'],
        switch: ['--search', '--no-alt-screen', '--no-daemon', '--oss', '--strict-config', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo'],
    },
    claude: {
        value: ['--model', '--effort', '--permission-mode', '--agent', '--add-dir'],
        switch: ['--chrome', '--no-chrome', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
    },
}

function invocation (argv) {
    if (!Array.isArray(argv) || !argv.length) return null
    let command = argv[0], prefix = [], name = path.basename(command).replace(/\.exe$/i, '')
    if (/^node(?:js)?$/.test(name) && typeof argv[1] === 'string') {
        if (/@anthropic-ai[\\/]claude-code[\\/]cli\.js$/.test(argv[1])) name = 'claude'
        else if (/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/.test(argv[1])) name = 'codex'
        else return null
        prefix = [argv[1]]
    }
    if (!FLAGS[name]) return null
    return { kind: name, command, prefix, args: argv.slice(1 + prefix.length) }
}

function resumeArgs (kind, args, id) {
    if (!UUID.test(id || '') || !FLAGS[kind]) return null
    const kept = [], rules = FLAGS[kind]
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (typeof arg !== 'string') return null
        if (['exec', 'review', 'app-server', 'mcp', 'login', 'logout', 'auth', 'update', 'install', 'agents', 'attach', 'remote-control', '--help', '-h', '--version', '-V', '--print'].includes(arg) || (kind === 'claude' && arg === '-p')) return null
        if (kind === 'codex' && arg === 'resume') {
            if (args[i + 1] && !args[i + 1].startsWith('-')) i++
            continue
        }
        if (kind === 'claude' && ['--resume', '-r', '--session-id'].includes(arg)) {
            if (args[i + 1] && !args[i + 1].startsWith('-')) i++
            continue
        }
        if (['--last', '--all'].includes(arg) || (kind === 'claude' && ['--continue', '-c'].includes(arg))) continue
        const equal = arg.indexOf('=')
        const flag = equal > 0 ? arg.slice(0, equal) : arg
        if (rules.value.includes(flag)) {
            const value = equal > 0 ? arg.slice(equal + 1) : args[++i]
            if (!value || value.startsWith('-')) return null
            kept.push(flag, value)
        } else if (rules.switch.includes(arg)) kept.push(arg)
        else if (kind === 'codex' && ['-c', '--config'].includes(flag)) {
            const value = equal > 0 ? arg.slice(equal + 1) : args[++i]
            // Preserve ordinary UI configuration, not inline credentials/hooks.
            if (!/^(check_for_update_on_startup|model_reasoning_effort)=(?:true|false|"(?:low|medium|high|xhigh|max)")$/.test(value || '')) return null
            kept.push(flag, value)
        } else if (arg.startsWith('-')) return null
        // Positional initial prompts already belong to the native conversation.
    }
    return [...kept, ...(kind === 'codex' ? ['resume', id] : ['--resume', id])]
}

function explicitID ({ kind, args }) {
    const ids = []
    for (let i = 0; i < args.length - 1; i++) {
        if ((kind === 'codex' && args[i] === 'resume') || (kind === 'claude' && ['--resume', '-r', '--session-id'].includes(args[i]))) {
            if (UUID.test(args[i + 1])) ids.push(args[i + 1])
        }
    }
    return new Set(ids).size === 1 ? ids[0] : null
}

function safeEnvironment (env = {}) {
    return Object.fromEntries(ENV_KEYS.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
}

function fromProfile (token) {
    const options = token.profile?.options || {}
    const call = invocation([options.command || '', ...(options.args || [])])
    if (!call) return null
    const id = explicitID(call), args = resumeArgs(call.kind, call.args, id)
    return args ? { kind: call.kind, id, command: call.command, args: [...call.prefix, ...args], cwd: options.cwd, env: safeEnvironment(options.env) } : null
}

async function firstJSON (file, whole = false) {
    let handle
    try {
        handle = await fs.promises.open(file, 'r')
        const buffer = Buffer.alloc(65536)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        return JSON.parse(whole ? text : text.split('\n')[0])
    } catch { return null } finally { await handle?.close() }
}

function createDetector ({ procRoot = '/proc', platform = process.platform, home = os.homedir(), uid = process.getuid?.() } = {}) {
    let inventory, inventoryAt = 0
    const processTree = async () => {
        if (inventory && Date.now() - inventoryAt < 1000) return inventory
        inventoryAt = Date.now()
        inventory = (async () => {
            const rows = new Map()
            for (const name of await fs.promises.readdir(procRoot)) {
                if (!/^\d+$/.test(name)) continue
                try {
                    const dir = path.join(procRoot, name)
                    if (uid != null && (await fs.promises.stat(dir)).uid !== uid) continue
                    const stat = (await fs.promises.readFile(path.join(dir, 'stat'), 'utf8')).split(') ').slice(1).join(') ').split(' ')
                    rows.set(Number(name), { pid: Number(name), ppid: Number(stat[1]), start: stat[19], dir })
                } catch {}
            }
            return rows
        })()
        return inventory
    }
    async function readProcess (info) {
        try {
            const argv = (await fs.promises.readFile(path.join(info.dir, 'cmdline'), 'utf8')).split('\0').filter(Boolean)
            const call = invocation(argv)
            if (!call) return null
            const processEnv = Object.fromEntries((await fs.promises.readFile(path.join(info.dir, 'environ'), 'utf8')).split('\0').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]))
            const env = safeEnvironment(processEnv)
            const cwd = await fs.promises.readlink(path.join(info.dir, 'cwd'))
            if (!path.isAbsolute(call.command)) {
                const choices = call.command.includes('/') ? [path.resolve(cwd, call.command)] : (processEnv.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, call.command))
                const resolved = choices.find(file => {
                    try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
                })
                call.command = resolved || await fs.promises.readlink(path.join(info.dir, 'exe'))
            }
            return { ...info, ...call, env, cwd }
        } catch { return null }
    }
    async function identity (proc, rows) {
        if (proc.kind === 'claude') {
            const root = proc.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
            const meta = await firstJSON(path.join(root, 'sessions', `${proc.pid}.json`), true)
            if (meta?.kind === 'interactive' && String(meta.procStart) === proc.start && UUID.test(meta.sessionId)) return meta.sessionId
        }
        // Only files held by this pane's process (or its own private app-server).
        // Never inspect a shared daemon or pick a conversation by modification time.
        const owners = [proc, ...[...rows.values()].filter(row => row.ppid === proc.pid)]
        const ids = new Set()
        for (const owner of owners) {
            if (owner.pid !== proc.pid) {
                const child = await readProcess(owner)
                if (!child || child.kind !== proc.kind || !child.args.includes('app-server')) continue
            }
            let fds
            try { fds = await fs.promises.readdir(path.join(owner.dir, 'fd')) } catch { continue }
            for (const fd of fds) {
                try {
                    const file = await fs.promises.readlink(path.join(owner.dir, 'fd', fd))
                    if (!file.endsWith('.jsonl')) continue
                    if (proc.kind === 'codex' && file.includes('/sessions/')) {
                        const meta = await firstJSON(file), p = meta?.payload
                        if (meta?.type !== 'session_meta' || !UUID.test(p?.id)) continue
                        if (p.source && typeof p.source === 'object' && 'subagent' in p.source) continue
                        if (p.session_id && p.session_id !== p.id) continue
                        ids.add(p.id)
                    } else if (proc.kind === 'claude' && file.includes('/projects/')) {
                        const id = path.basename(file, '.jsonl'), meta = await firstJSON(file)
                        if (UUID.test(id) && meta?.sessionId === id) ids.add(id)
                    }
                } catch {}
            }
        }
        if (ids.size > 1) return null
        return [...ids][0] || explicitID(proc)
    }
    return async function detect (ptyPID) {
        if (platform !== 'linux' || !Number.isInteger(ptyPID) || ptyPID <= 0) return null
        try {
            const rows = await processTree(), descendants = new Set([ptyPID])
            for (let depth = 0; depth < 32; depth++) {
                let added = false
                for (const row of rows.values()) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); added = true }
                if (!added) break
            }
            if (descendants.size > 128) return null
            const candidates = []
            for (const pid of descendants) {
                const proc = rows.has(pid) && await readProcess(rows.get(pid))
                if (proc && resumeArgs(proc.kind, proc.args, '00000000-0000-4000-8000-000000000001')) candidates.push(proc)
            }
            // The npm Codex entrypoint stays alive above its native binary.
            // Treat that wrapper and binary as one interactive CLI.
            const interactive = candidates.filter(proc => !proc.prefix.length || !candidates.some(child => child.ppid === proc.pid && child.kind === proc.kind && !child.prefix.length))
            const top = interactive.filter(proc => {
                let ppid = proc.ppid
                for (let depth = 0; depth < 32 && rows.has(ppid); depth++) {
                    if (interactive.some(other => other.pid === ppid)) return false
                    ppid = rows.get(ppid).ppid
                }
                return true
            })
            if (top.length !== 1) return null
            const proc = top[0], id = await identity(proc, rows)
            const args = resumeArgs(proc.kind, proc.args, id)
            if (!args) return null
            return { kind: proc.kind, id, command: proc.command, args: [...proc.prefix, ...args], cwd: proc.cwd, env: proc.env }
        } catch { return null }
    }
}

function bindNative (token, entry) {
    if (!entry || !UUID.test(entry.id || '') || !Array.isArray(entry.args)) return token
    token.profile = { ...token.profile, behaviorOnSessionEnd: 'keep', options: {
        ...token.profile.options, command: entry.command, args: entry.args,
        cwd: entry.cwd || token.profile.options?.cwd,
        env: { ...token.profile.options?.env, ...safeEnvironment(entry.env) }, pauseAfterExit: true,
    } }
    delete token.profile.options.agentSessionKey
    return token
}

module.exports = { invocation, resumeArgs, explicitID, fromProfile, createDetector, bindNative, safeEnvironment }
