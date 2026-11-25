'use strict';

/**
 * 轻量聊天 agent —— 三个能力（零第三方依赖，作为 node-chat 的插件模块）：
 *   1. watch  — 挂 watchdog 监听群聊（收到 @ 唤醒）
 *   2. speak  — 按预设人格 + 群聊上下文，调 LLM 生成回复并发到群里
 *   3. mail   — 用与邮箱验证码相同的 SMTP 配置，发邮件给指定用户
 * 验证码由服务端 mailer 直接发送，不经过本 agent。
 *
 * CLI:
 *   node src/index.js                # 默认 = watch
 *   node src/index.js watch          # 监听群聊
 *   node src/index.js speak "问题"  # 单次发言（调试）
 *   node src/index.js mail a@b.com "主题" "正文"
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ChatConn = require('../../agentbus/src/conn');
const llm = require('./llm');
const mailer = require('./mailer');

function loadConfig() {
  const p = process.env.AGENT_CONFIG || path.join(__dirname, '..', 'config.json');
  const example = path.join(__dirname, '..', 'config.example.json');
  const file = fs.existsSync(p) ? p : example;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function textOf(data) {
  return (data && (data.text || (data.message && data.message.text))) || '';
}

class ChatAgent extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.conn = null;
    this.context = []; // 最近群聊上下文
    this.room = (cfg.chat.rooms || ['大厅'])[0];
    this.me = cfg.chat.user;
  }

  /** 能力 1 的基础：连接聊天（复用加密 NDJSON 连接层） */
  async connect() {
    const c = this.cfg.chat;
    this.conn = new ChatConn({
      host: c.host, port: c.port, user: c.user, pass: c.pass,
      secure: c.secure !== false,
      pinFile: path.join(__dirname, '..', 'data', 'pin.json'),
    });
    this.conn.on('message', (data, type) => this._onMessage(data, type));
    this.conn.on('close', () => this.emit('close'));
    await this.conn.connect();
    for (const r of (c.rooms || [])) {
      if (r !== this.room) this.conn.send('join', { room: r });
    }
    return this;
  }

  _onMessage(data, type) {
    const from = data.from;
    const text = textOf(data);
    const room = data.room || this.room;
    if (!text) return;
    // 记录上下文（只记当前群、非自己发的）
    if (room === this.room && from !== this.me) {
      this.context.push(from + ': ' + text);
      const lim = (this.cfg.wake && this.cfg.wake.contextLimit) || 20;
      if (this.context.length > lim) this.context.shift();
    }
    // 收到 @ 自己 → 唤醒（交给宿主/调用方决定何时 speak）
    const mentioned = text.includes('@' + this.me);
    if (mentioned && from !== this.me) {
      this.emit('wake', { from, room, text });
    }
  }

  /** 能力 2：按人格 + 上下文生成回复并发到群 */
  async speak(question, room) {
    const l = this.cfg.llm || {};
    const answer = await llm.complete(l, {
      persona: l.persona,
      context: this.context.slice(-((this.cfg.wake && this.cfg.wake.contextLimit) || 20)),
      question,
    });
    const target = room || this.room;
    if (!this.conn) throw new Error('未连接');
    const prefix = (this.cfg.wake && this.cfg.wake.replyPrefix) || '';
    this.conn.send('group', { room: target, text: prefix + answer });
    return answer;
  }

  /** 能力 3：用同一 SMTP 配置发邮件给指定用户（验证码不走这里） */
  async mail(to, subject, text) {
    return mailer.sendTo(this.cfg.smtp, { to, subject, text });
  }

  /** 能力 1：挂 watchdog 监听群聊，收到 @ 自动生成人格化回复 */
  async watch() {
    if (!this.conn) await this.connect();
    this.on('wake', async ({ from, room, text }) => {
      try {
        await this.speak('（' + from + ' 在群里说）' + text, room);
      } catch (e) {
        this.emit('error', e);
      }
    });
    return this;
  }

  close() { if (this.conn) this.conn.close(); }
}

module.exports = { ChatAgent, loadConfig };

// ---- CLI ----
if (require.main === module) {
  (async () => {
    const cfg = loadConfig();
    const agent = new ChatAgent(cfg);
    const [cmd, ...args] = process.argv.slice(2);
    const action = cmd || 'watch';
    try {
      if (action === 'mail') {
        const [to, subject, ...rest] = args;
        const r = await agent.mail(to, subject, rest.join(' '));
        console.log('邮件已发送:', JSON.stringify(r));
        agent.close();
      } else if (action === 'speak') {
        await agent.connect();
        const a = await agent.speak(args.join(' '));
        console.log('已发言:', a);
        agent.close();
      } else if (action === 'watch') {
        await agent.watch();
        console.log('agent 已上线监听群聊:', cfg.chat.user + '@' + cfg.chat.host + ':' + cfg.chat.port);
      } else {
        console.error('用法: node src/index.js [watch|speak <文本>|mail <收件人> <主题> <正文>]');
        process.exit(2);
      }
    } catch (e) {
      console.error('✖', e.message);
      process.exit(1);
    }
  })();
}
