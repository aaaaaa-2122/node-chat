'use strict';

/**
 * 邮件能力：复用服务端 server/src/mailer.js 的 SMTP 客户端（同一套邮箱配置）。
 * 注意：邮箱验证码由服务端 mailer 直接发送，不经过这个 agent；这里只发普通消息。
 */
const path = require('path');
const base = require('../../server/src/mailer');

function resolveConfig(cfg) {
  return base.resolveConfig(cfg || {});
}

/** 发一封普通邮件给指定邮箱；to 必填。未配置 SMTP 时抛错（不像验证码那样降级到日志）。 */
async function sendTo(cfg, { to, subject, text }) {
  const conf = resolveConfig(cfg);
  if (!base.isConfigured(conf)) throw new Error('SMTP 未配置，无法发邮件');
  if (!to) throw new Error('缺少收件邮箱');
  return base.send(conf, {
    from: conf.from,
    to,
    subject: subject || '(Node Chat 通知)',
    text: text || '',
  });
}

module.exports = { sendTo, resolveConfig, isConfigured: base.isConfigured };
