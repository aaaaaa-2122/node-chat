'use strict';

/** LLM 调用：OpenAI 兼容 chat/completions，Node 18+ 原生 fetch，零依赖。 */
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function complete(cfg, { persona, context, question }) {
  const endpoint = cfg.endpoint || DEFAULT_ENDPOINT;
  const messages = [
    { role: 'system', content: persona || '你是一个友善、简明的群聊助手。' },
  ];
  if (context && context.length) {
    messages.push({ role: 'system', content: '最近的群聊上下文：\n' + context.join('\n') });
  }
  messages.push({ role: 'user', content: question });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (cfg.apiKey || ''),
    },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      messages,
      max_tokens: cfg.maxTokens || 300,
      temperature: cfg.temperature == null ? 0.7 : cfg.temperature,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('LLM ' + res.status + ': ' + t.slice(0, 300));
  }
  const json = await res.json();
  const choice = json && json.choices && json.choices[0];
  const msg = choice && choice.message;
  // 推理模型（如 Hy4-flash）：放在 reasoning 里的思考可能先于 content，
  // max_tokens 不足时 content 为空、finish_reason=length。优先 content，为空则回退 reasoning。
  let content = msg && (msg.content || msg.reasoning);
  if ((!content || !String(content).trim()) && msg && msg.reasoning) content = msg.reasoning;
  if (!content || !String(content).trim()) {
    const reason = choice && choice.finish_reason;
    throw new Error('LLM 返回空内容' + (reason ? ' (finish_reason=' + reason + '，可尝试增大 max_tokens)' : ''));
  }
  return String(content).trim();
}

module.exports = { complete };
