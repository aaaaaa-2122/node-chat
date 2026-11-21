/**
 * dsh-agentbus · DeepSeek Harness plugin
 *
 * Bundles the agentbus skill + runtime. Responsibilities:
 *   1. Register the `agentbus` skill (SKILL.md, with $AGENTBUS_RUNTIME replaced
 *      by the bundled runtime directory).
 *   2. Register status / pending / ack / reply / send tools that wrap
 *      `node <runtime>/src/agentbus.js` — host-agnostic, no bash paths needed.
 *   3. Write runtime/config.json from plugin Config on load.
 *   4. Spawn the persistent daemon (`node src/daemon.js`) on load and kill it
 *      on unload, so the daemon holds the single chat connection.
 *
 * Mirror of @wxg-prc-cpg/browser-skill-dsh-plugin (register + tools pattern).
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SKILL_DIR = join(ROOT, 'skill')
const SKILL_MD = join(SKILL_DIR, 'SKILL.md')
const RUNTIME_DIR = join(ROOT, 'runtime')
const RUNTIME_SRC = join(RUNTIME_DIR, 'src')
const CONFIG_JSON = join(RUNTIME_DIR, 'config.json')
const DAEMON_JS = join(RUNTIME_SRC, 'daemon.js')
const AGENTBUS_JS = join(RUNTIME_SRC, 'agentbus.js')

export const name = '@local/dsh-agentbus'
export const inject = ['skills', 'tools']

export const Config = Schema.object({
  host: Schema.string().default('127.0.0.1').description('服务端地址（保持默认即可，除非对方不同）'),
  port: Schema.number().default(9099).description('服务端 TCP 端口'),
  user: Schema.string().description('登录账号（必填）'),
  pass: Schema.string().description('登录密码（必填）'),
  rooms: Schema.array(Schema.string()).default(['大厅', 'agents']).description('订阅的群聊房间'),
  dataDir: Schema.string().description('数据目录（token/pid/日志），相对 config.json；默认 ./data'),
  httpPort: Schema.number().default(9101).description('本地 HTTP 端口（daemon ↔ watchdog/agentbus）'),
  redeliverMs: Schema.number().default(300000).description('未确认消息重投间隔(ms)'),
  keepAliveMs: Schema.number().default(120000).description('心跳间隔(ms)'),
  wakeDm: Schema.boolean().default(true).description('私信是否触发唤醒'),
  wakeMention: Schema.boolean().default(true).description('被 @ 是否触发唤醒'),
})

/** Read the bundled SKILL.md and substitute the runtime placeholder. */
async function loadSkillContent() {
  const raw = await readFile(SKILL_MD, 'utf8')
  return raw.replaceAll('$AGENTBUS_RUNTIME', RUNTIME_DIR)
}

/** Merge defaults, write runtime/config.json (daemon + agentbus read this). */
async function writeConfig(config) {
  await mkdir(RUNTIME_DIR, { recursive: true })
  // The pre-built runtime/config.json is AUTHORITATIVE (user edits it directly).
  // Cordis `config` only fills values the file doesn't already define, so the
  // file's user/pass/rooms/http.port are never clobbered by Cordis defaults.
  let existing = {}
  try {
    existing = JSON.parse(await readFile(CONFIG_JSON, 'utf8'))
  } catch {
    /* first run: no config.json yet */
  }
  const merged = {
    host: existing.host ?? config.host ?? '127.0.0.1',
    port: existing.port ?? config.port ?? 9099,
    user: existing.user ?? config.user ?? '',
    pass: existing.pass ?? config.pass ?? '',
    rooms:
      existing.rooms && existing.rooms.length
        ? existing.rooms
        : config.rooms && config.rooms.length
          ? config.rooms
          : ['大厅', 'agents'],
    dataDir: existing.dataDir || config.dataDir || './data',
    wake: {
      dm: existing.wake?.dm ?? config.wakeDm ?? true,
      mention: existing.wake?.mention ?? config.wakeMention ?? true,
    },
    http: {
      host: existing.http?.host || config.httpHost || '127.0.0.1',
      port: existing.http?.port ?? config.httpPort ?? 9101,
    },
    redeliverMs: existing.redeliverMs ?? config.redeliverMs ?? 300000,
    keepAliveMs: existing.keepAliveMs ?? config.keepAliveMs ?? 120000,
  }
  await writeFile(CONFIG_JSON, JSON.stringify(merged, null, 2), 'utf8')
}

/** Run one agentbus CLI command, return parsed stdout + exit code. */
function runAgentbus(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise) => {
    // Point agentbus at the plugin's runtime/config.json explicitly so it always
    // talks to the same daemon the plugin spawned (regardless of cwd).
    const argv = ['--config', CONFIG_JSON, ...args]
    const child = spawn(process.execPath, [AGENTBUS_JS, ...argv], {
      cwd: RUNTIME_DIR,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: -1, stdout, stderr: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

function toolResult(value) {
  return [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ]
}

const TOOLS = [
  defineTool({
    name: 'agentbus.status',
    description: '查询 agentbus 守护进程状态：在不在、连没连上服务端、订阅了哪些房间。返回 JSON。',
    parameters: {},
    output: { schema: { type: 'json' } },
    isConcurrencySafe: () => true,
    async execute() {
      const r = await runAgentbus(['status'])
      if (!r.ok) throw new Error(`agentbus status 失败 (exit ${r.code}): ${r.stderr || r.stdout}`)
      return toolResult(r.stdout)
    },
  }),
  defineTool({
    name: 'agentbus.pending',
    description: '查看有没有漏处理的来信（未 ack 的消息）。返回 JSON，空则无待办。',
    parameters: {},
    output: { schema: { type: 'json' } },
    isConcurrencySafe: () => true,
    async execute() {
      const r = await runAgentbus(['pending'])
      if (!r.ok) throw new Error(`agentbus pending 失败 (exit ${r.code}): ${r.stderr || r.stdout}`)
      return toolResult(r.stdout)
    },
  }),
  defineTool({
    name: 'agentbus.ack',
    description: '确认（已读）一条消息，不回信。用于 wake 中已处理但无需回复的消息。',
    parameters: {
      id: { type: 'string', description: '要确认的消息 id（来自 wake 或 pending）' },
    },
    output: { schema: { type: 'json' } },
    isConcurrencySafe: () => true,
    async execute(args) {
      const r = await runAgentbus(['ack', String(args.id)])
      if (!r.ok) throw new Error(`agentbus ack 失败 (exit ${r.code}): ${r.stderr || r.stdout}`)
      return toolResult(r.stdout)
    },
  }),
  defineTool({
    name: 'agentbus.reply',
    description: '回复一条消息（必须携带原消息 id，reply 或 ack 二选一，每个 wake 都要有归宿）。',
    parameters: {
      id: { type: 'string', description: '要回复的消息 id（来自 wake）' },
      text: { type: 'string', description: '回复内容' },
    },
    output: { schema: { type: 'json' } },
    isConcurrencySafe: () => true,
    async execute(args) {
      const r = await runAgentbus(['reply', String(args.id), String(args.text)])
      if (!r.ok) throw new Error(`agentbus reply 失败 (exit ${r.code}): ${r.stderr || r.stdout}`)
      return toolResult(r.stdout)
    },
  }),
  defineTool({
    name: 'agentbus.send',
    description: '主动发一条消息到房间或私聊。二选一：room 或 to。',
    parameters: {
      room: { type: 'string', description: '目标房间名（与 to 互斥）' },
      to: { type: 'string', description: '目标用户（与 room 互斥）' },
      text: { type: 'string', description: '消息内容' },
    },
    output: { schema: { type: 'json' } },
    isConcurrencySafe: () => true,
    async execute(args) {
      const argv = ['send']
      if (args.room) argv.push('--room', String(args.room))
      if (args.to) argv.push('--to', String(args.to))
      argv.push(String(args.text ?? ''))
      const r = await runAgentbus(argv)
      if (!r.ok) throw new Error(`agentbus send 失败 (exit ${r.code}): ${r.stderr || r.stdout}`)
      return toolResult(r.stdout)
    },
  }),
]

export function apply(ctx, config = {}, options = {}) {
  const disposers = []
  let daemonChild = null

  // 1. write config.json from plugin Config
  writeConfig(config).catch((err) => {
    console.warn(`[${name}] failed to write ${CONFIG_JSON}:`, err)
  })

  // 2. register the skill
  const registerSkill = async () => {
    const skills = ctx.get('skills')
    if (skills == null || typeof skills.register !== 'function') return () => {}
    const content = await loadSkillContent()
    return skills.register({
      name: 'agentbus',
      description:
        '当需要让 agent 通过 agentbus 信箱接收和回复消息、或搭建 agent 之间的协同通道时使用。触发词：agentbus、信箱、唤醒 agent、@ 我、收到私信、多 agent 协同、watchdog。',
      content,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    })
  }

  // 3. register tools
  for (const tool of TOOLS) {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      console.warn(`[${name}] failed to register tool ${tool.name}:`, err)
    }
  }

  // 4. spawn daemon on load, kill on unload
  const startDaemon = () => {
    if (daemonChild && daemonChild.exitCode === null) return
    daemonChild = spawn(process.execPath, [DAEMON_JS, '--config', CONFIG_JSON], {
      cwd: RUNTIME_DIR,
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    })
    daemonChild.on('error', (err) => console.warn(`[${name}] daemon spawn error:`, err))
  }

  // skill registration is async; wire teardown to cover both
  ctx.effect(() => {
    registerSkill().then((dispose) => {
      if (typeof dispose === 'function') disposers.push(dispose)
    })
    startDaemon()
    return () => {
      if (daemonChild && daemonChild.exitCode === null) {
        try { daemonChild.kill() } catch { /* already gone */ }
        daemonChild = null
      }
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* ignore */ }
      }
    }
  })

  return
}