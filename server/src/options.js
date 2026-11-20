'use strict';

/**
 * 极简命令行参数解析器（零依赖）。
 * 用法：
 *   const parser = createParser(['user', 'password']);
 *   const { opts, positional } = parser(argv);
 * 支持 --key value、--key=value、-u value 形式。
 */
function createParser(valueFlags = []) {
  const valueSet = new Set(valueFlags);
  return function parse(argv = []) {
    const opts = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith('--')) {
        const body = arg.slice(2);
        const eq = body.indexOf('=');
        if (eq !== -1) {
          opts[body.slice(0, eq)] = body.slice(eq + 1);
        } else if (valueSet.has(body)) {
          opts[body] = argv[++i];
        } else {
          opts[body] = true;
        }
      } else if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
        const body = arg.slice(1);
        if (valueSet.has(body)) opts[body] = argv[++i];
        else opts[body] = true;
      } else {
        positional.push(arg);
      }
    }
    return { opts, positional };
  };
}

module.exports = { createParser };
