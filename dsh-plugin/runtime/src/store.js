'use strict';

/**
 * 持久层：一条只追加的 ledger + 一份水位。
 *
 * 设计约束（这几条是这个模块存在的全部理由）：
 *  1. 按消息 id 幂等 —— 重连后历史补投是常态，同一条不能执行两次
 *  2. 水位只前进不后退 —— 断线重连靠它补空窗
 *  3. 每条记录带状态 —— pending / acked / done，进程崩了重启还能接着处理
 */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.ledgerPath = path.join(dir, 'ledger.jsonl');
    this.statePath = path.join(dir, 'state.json');
    this.entries = new Map(); // id -> entry
    this.order = []; // 按写入顺序的 id
    this.state = { cursorTs: 0, backlogSeenTs: 0, lastWakeAt: 0 };
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });

    // 首次运行（没有 state.json）时标记出来：daemon 会把水位定在「现在」，
    // 避免第一次启动就把服务端历史里几百条老消息当成新消息灌给 agent
    this.fresh = !fs.existsSync(this.statePath);

    if (!this.fresh) {
      try {
        const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        this.state = Object.assign(this.state, s);
      } catch (e) {
        /* 状态损坏就当空的，ledger 还在 */
      }
    }

    if (!fs.existsSync(this.ledgerPath)) return;

    const raw = fs.readFileSync(this.ledgerPath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e;
      try {
        e = JSON.parse(t);
      } catch (err) {
        continue; // 断电写了半行，跳过
      }
      if (!e || !e.id) continue;
      if (!this.entries.has(e.id)) this.order.push(e.id);
      this.entries.set(e.id, e);
    }
  }

  /** 返回 true 表示是新记录，false 表示重复（调用方据此跳过） */
  add(entry) {
    if (this.entries.has(entry.id)) {
      // 已存在：允许补全缺失字段（例如先落盘后补 status），但不覆盖既有状态
      const old = this.entries.get(entry.id);
      if (!old.status && entry.status) {
        old.status = entry.status;
        this._append(old);
      }
      return false;
    }
    this.entries.set(entry.id, entry);
    this.order.push(entry.id);
    this._append(entry);
    if (entry.ts > this.state.cursorTs) this.state.cursorTs = entry.ts;
    return true;
  }

  _append(entry) {
    fs.appendFileSync(this.ledgerPath, JSON.stringify(entry) + '\n');
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  /** 状态迁移都会重写一行（后写覆盖前写，load 时后者赢） */
  setStatus(id, status, extra) {
    const e = this.entries.get(id);
    if (!e) return null;
    e.status = status;
    if (extra) Object.assign(e, extra);
    this._append(e);
    return e;
  }

  markDelivered(ids) {
    const now = Date.now();
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      e.deliveredAt = now;
      e.attempts = (e.attempts || 0) + 1;
      this._append(e);
    }
  }

  /** 可投递的唤醒消息：未处理，且没投过或投过太久（崩溃恢复） */
  pickDeliverable(redeliverMs, sinceTs) {
    const now = Date.now();
    const out = [];
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (!e || e.status !== 'pending' || !e.wake) continue;
      if (e.ts < (sinceTs || 0)) continue;
      if (e.deliveredAt && now - e.deliveredAt < redeliverMs) continue;
      out.push(e);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.slice(0, 20);
  }

  pendingList() {
    const out = [];
    for (const id of this.order) {
      const e = this.entries.get(id);
      if (e && e.status === 'pending') out.push(e);
    }
    return out;
  }

  /** 落盘但没唤醒的消息 —— 只在唤醒时给摘要，避免把上下文灌满 */
  backlog(sinceTs, limit) {
    const out = [];
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.entries.get(this.order[i]);
      if (!e || e.wake) continue;
      if (e.ts < (sinceTs || 0)) continue;
      out.push(e);
    }
    return {
      count: out.length,
      recent: out.slice(0, limit || 5).map((e) => ({
        id: e.id,
        ts: e.ts,
        from: e.from,
        where: e.room || e.to,
        text: short(e.text, 80),
      })),
    };
  }

  saveState() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  bumpCursor(ts) {
    if (ts > this.state.cursorTs) {
      this.state.cursorTs = ts;
      this.saveState();
    }
  }
}

function short(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = Store;
