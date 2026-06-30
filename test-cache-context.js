'use strict';

// 上下文感知缓存测试 - 验证用户列出的 5 个场景
const cache = require('./js/utils/relay-response-cache');
const assert = require('assert');

function test(name, fn) {
  try {
    fn();
    console.log('  \x1b[32mPASS\x1b[0m ' + name);
  } catch (err) {
    console.log('  \x1b[31mFAIL\x1b[0m ' + name + ' :: ' + (err.message || err));
    process.exitCode = 1;
  }
}

function makeReadToolCall(path) {
  return {
    id: 'call_1',
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ path }) },
  };
}

function makeWriteToolCall(path, content) {
  return {
    id: 'call_2',
    type: 'function',
    function: { name: 'write', arguments: JSON.stringify({ path, content }) },
  };
}

function makePatchEditToolCall(path, oldStr, newStr, id = 'call_6') {
  return {
    id,
    type: 'function',
    function: { name: 'patchedit', arguments: JSON.stringify({ path, old_string: oldStr, new_string: newStr }) },
  };
}

function makeGrepToolCall(pattern) {
  return {
    id: 'call_3',
    type: 'function',
    function: { name: 'grep', arguments: JSON.stringify({ pattern }) },
  };
}

function makeShellToolCall(cmd) {
  return {
    id: 'call_4',
    type: 'function',
    function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) },
  };
}

function makeFetchToolCall(url) {
  return {
    id: 'call_5',
    type: 'function',
    function: { name: 'webfetch', arguments: JSON.stringify({ url }) },
  };
}

console.log('=== 场景测试 ===');

// 场景1：读文件 + 分析 → 应命中（幂等工具）
test('1. 读文件+分析: 命中 tool_cache', () => {
  cache.clear();
  const messages1 = [
    { role: 'user', content: '读 foo.js' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('foo.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '文件内容 foo.js 的代码' },
    { role: 'user', content: '分析这段代码' },
  ];
  const keys1 = cache.buildCacheKeys('deepseek-v4', messages1, { phase: 'upstream' });
  assert.ok(keys1.fuzzy, '应该生成 fuzzy key');
  assert.ok(keys1.ultra, '应该生成 ultra key');
  cache.set(keys1, { text: '这是 foo.js 的分析结果', reasoning: '', upstreamError: '', toolCalls: [], model: 'deepseek-v4' });

  // 第二次同样对话（可能在不同会话）
  const keys2 = cache.buildCacheKeys('deepseek-v4', messages1, { phase: 'upstream' });
  const hit = cache.get(keys2);
  assert.ok(hit, '应该命中缓存');
  assert.strictEqual(hit.entry.text, '这是 foo.js 的分析结果');
  assert.strictEqual(hit.layer, 'exact');
});

// 场景2：写文件 + 确认 → exact 不缓存，但 fuzzy/ultra 可缓存（文件编辑类放宽）
test('2. 写文件+确认: exact 不缓存，fuzzy 放宽', () => {
  cache.clear();
  const messages = [
    { role: 'user', content: '写配置到 config.json' },
    { role: 'assistant', content: '', tool_calls: [makeWriteToolCall('config.json', '{"k":1}')] },
    { role: 'tool', tool_call_id: 'call_2', content: '写入成功' },
    { role: 'user', content: '确认' },
  ];
  const keys = cache.buildCacheKeys('deepseek-v4', messages, { phase: 'upstream' });
  assert.strictEqual(keys.exact, null, 'exact 仍应为 null（含 write 副作用工具）');
  // fuzzy/ultra 放宽：文件编辑类不再阻断，指纹分段后只剩 "U:确认"
  assert.ok(keys.fuzzy, 'fuzzy 应生成（文件编辑类放宽）');
  assert.ok(keys.ultra, 'ultra 应生成');
});

// 场景3：纯对话 → 命中 fuzzy/ultra
test('3. 纯对话: 命中 fuzzy/ultra', () => {
  cache.clear();
  const messages = [{ role: 'user', content: '你好' }];
  const keys = cache.buildCacheKeys('gpt-4', messages, { phase: 'upstream' });
  assert.ok(keys.fuzzy);
  assert.ok(keys.ultra);
  cache.set(keys, { text: '你好！', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });
  const hit = cache.get(keys);
  assert.ok(hit);
  assert.strictEqual(hit.entry.text, '你好！');
});

// 场景4：查询天气+出行建议 → 命中（幂等 webfetch）
test('4. 查询天气+出行: 命中 tool_cache', () => {
  cache.clear();
  const messages = [
    { role: 'user', content: '今天天气怎么样' },
    { role: 'assistant', content: '', tool_calls: [makeFetchToolCall('https://weather.example.com/today')] },
    { role: 'tool', tool_call_id: 'call_5', content: '北京 25°C 晴' },
    { role: 'user', content: '给我出行建议' },
  ];
  const keys1 = cache.buildCacheKeys('claude-3.5', messages, { phase: 'upstream' });
  assert.ok(keys1.fuzzy, 'fuzzy 应生成');
  assert.ok(keys1.ultra, 'ultra 应生成');
  cache.set(keys1, { text: '今天晴朗适合户外活动', reasoning: '', upstreamError: '', toolCalls: [], model: 'claude-3.5' });

  // 换模型问同样问题 → ultra 兜底
  const keys2 = cache.buildCacheKeys('gpt-4', messages, { phase: 'upstream' });
  const hit = cache.get(keys2);
  assert.ok(hit, '跨模型应该 ultra 命中');
  assert.strictEqual(hit.layer, 'ultra');
});

// 场景5：数据库查询+分析 → 命中（shell 执行 SQL 视为副作用？）
// 注意：SQL 查询经 shell 工具执行，按当前策略 shell 是副作用，不缓存
// 这是保守但安全的做法——shell 可能执行任何命令
test('5. 数据库查询+分析: shell 视为副作用不缓存', () => {
  cache.clear();
  const messages = [
    { role: 'user', content: '查询用户表' },
    { role: 'assistant', content: '', tool_calls: [makeShellToolCall('psql -c "SELECT * FROM users"')] },
    { role: 'tool', tool_call_id: 'call_4', content: '100 rows' },
    { role: 'user', content: '分析' },
  ];
  const keys = cache.buildCacheKeys('deepseek-v4', messages, { phase: 'upstream' });
  assert.strictEqual(keys.fuzzy, null, 'shell 是副作用，fuzzy 应为 null');
  assert.strictEqual(keys.ultra, null, 'ultra 应为 null');
});

console.log('');
console.log('=== Deepseek 缺陷验证 ===');

// 缺陷1：多轮对话（无工具）应能命中
test('D1. 多轮对话(无工具)应生成 fuzzy/ultra', () => {
  cache.clear();
  const messages = [
    { role: 'user', content: '什么是微服务' },
    { role: 'assistant', content: '微服务是...' },
    { role: 'user', content: '它的缺点呢' },
  ];
  const keys = cache.buildCacheKeys('gpt-4', messages, { phase: 'upstream' });
  assert.ok(keys.fuzzy, '多轮无工具应生成 fuzzy');
  assert.ok(keys.ultra, '多轮无工具应生成 ultra');
  // 验证指纹含完整对话
  cache.set(keys, { text: '缺点包括...', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });
  const hit = cache.get(keys);
  assert.ok(hit);
});

// 缺陷2：_set 不应重置 hits
test('D2. _set 重写同 key 保留 hits', () => {
  cache.clear();
  const keys = cache.buildCacheKeys('gpt-4', [{ role: 'user', content: '热点问题' }], { phase: 'upstream' });
  cache.set(keys, { text: '答案v1', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });
  // 模拟多次命中
  for (let i = 0; i < 5; i++) {
    cache.get(keys);
  }
  const hit1 = cache.get(keys);
  assert.ok(hit1.entry.hits >= 5, 'hits 应该 >= 5, 实际=' + hit1.entry.hits);
  // 重写
  cache.set(keys, { text: '答案v2', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });
  const hit2 = cache.get(keys);
  assert.ok(hit2.entry.hits >= 5, '重写后 hits 应保留 >= 5, 实际=' + hit2.entry.hits);
  assert.strictEqual(hit2.entry.text, '答案v2');
});

// 缺陷3：reasoning 参数不同应生成不同 exact key
test('D3. reasoning 参数不同 → exact key 不同', () => {
  cache.clear();
  const messages = [{ role: 'user', content: '写诗' }];
  const k1 = cache.buildCacheKeys('gpt-4', messages, { phase: 'upstream', disableReasoning: false, reasoningEffort: 'high' });
  const k2 = cache.buildCacheKeys('gpt-4', messages, { phase: 'upstream', disableReasoning: false, reasoningEffort: 'low' });
  const k3 = cache.buildCacheKeys('gpt-4', messages, { phase: 'upstream', disableReasoning: true });
  assert.notStrictEqual(k1.exact, k2.exact, '不同 reasoning effort 应有不同 exact');
  assert.notStrictEqual(k1.exact, k3.exact, '禁用 reasoning 应有不同 exact');
  assert.notStrictEqual(k2.exact, k3.exact, 'low vs 禁用 应有不同 exact');
  // fuzzy/ultra 不应受 reasoning 影响（同问题跨模型应能命中）
  assert.strictEqual(k1.fuzzy, k2.fuzzy, 'fuzzy 不应受 reasoning 影响');
  assert.strictEqual(k1.ultra, k2.ultra, 'ultra 不应受 reasoning 影响');
});

test('Agent 阶段 initial/post_tool 应启用 fuzzy/ultra', () => {
  cache.clear();
  const messages = [{ role: 'user', content: '继续优化缓存' }];
  const initialKeys = cache.buildCacheKeys('deepseek-v4', messages, { phase: 'initial' });
  const postToolKeys = cache.buildCacheKeys('deepseek-v4', messages, { phase: 'post_tool_2_recover_1' });
  assert.ok(initialKeys.fuzzy, 'initial 应生成 fuzzy key');
  assert.ok(initialKeys.ultra, 'initial 应生成 ultra key');
  assert.ok(postToolKeys.fuzzy, 'post_tool 应生成 fuzzy key');
  assert.strictEqual(initialKeys.fuzzy, postToolKeys.fuzzy, '同上下文 fuzzy 应一致');
  assert.strictEqual(initialKeys.ultra, postToolKeys.ultra, '同上下文 ultra 应一致');
  assert.notStrictEqual(initialKeys.exact, postToolKeys.exact, '不同 phase 归一化后 exact 仍应区分');
});

console.log('');
console.log('=== 工具分类边界测试 ===');

test('T1. 幂等工具列表', () => {
  const { _internal } = cache;
  assert.ok(_internal.isIdempotentTool('read'));
  assert.ok(_internal.isIdempotentTool('Read'));
  assert.ok(_internal.isIdempotentTool('READ'));
  assert.ok(_internal.isIdempotentTool('ls'));
  assert.ok(_internal.isIdempotentTool('grep'));
  assert.ok(_internal.isIdempotentTool('web_fetch'));
  assert.ok(_internal.isIdempotentTool('webfetch'));
  assert.ok(_internal.isIdempotentTool('web_search'));
  assert.ok(_internal.isIdempotentTool('list_mcp_resources'));
});

test('T2. 副作用工具列表', () => {
  const { _internal } = cache;
  assert.ok(_internal.isSideEffectTool('shell'));
  assert.ok(_internal.isSideEffectTool('Shell'));
  assert.ok(_internal.isSideEffectTool('write'));
  assert.ok(_internal.isSideEffectTool('Edit'));
  assert.ok(_internal.isSideEffectTool('str_replace'));
  assert.ok(_internal.isSideEffectTool('strreplace'));
  assert.ok(_internal.isSideEffectTool('delete'));
  assert.ok(_internal.isSideEffectTool('task'));
  assert.ok(_internal.isSideEffectTool('mcp'));
});

test('T3. 未知工具按副作用处理（保守）', () => {
  const { _internal } = cache;
  assert.ok(_internal.isSideEffectTool('custom_tool') === false, '不在副作用列表');
  assert.ok(_internal.isIdempotentTool('custom_tool') === false, '不在幂等列表');
  // 实际 hasSideEffectTools 中：未知工具会被视为副作用
  const messages = [{
    role: 'assistant',
    content: '',
    tool_calls: [{ id: '1', type: 'function', function: { name: 'custom_unknown', arguments: '{}' } }],
  }];
  assert.ok(_internal.hasSideEffectTools(messages), '未知工具应视为副作用');
});

test('T4. 上下文指纹：不同文件路径不命中', () => {
  cache.clear();
  const msgs1 = [
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('a.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '内容A' },
    { role: 'user', content: '分析' },
  ];
  const msgs2 = [
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('b.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '内容B' },
    { role: 'user', content: '分析' },
  ];
  const k1 = cache.buildCacheKeys('gpt-4', msgs1, { phase: 'upstream' });
  const k2 = cache.buildCacheKeys('gpt-4', msgs2, { phase: 'upstream' });
  assert.notStrictEqual(k1.fuzzy, k2.fuzzy, '不同文件应不同 fuzzy key');
  assert.notStrictEqual(k1.ultra, k2.ultra, '不同文件应不同 ultra key');
});

test('T5. 上下文指纹：相同文件路径+相同问题 → 命中', () => {
  cache.clear();
  const msgs = [
    { role: 'user', content: '读 foo.js' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('foo.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '代码内容' },
    { role: 'user', content: '分析' },
  ];
  const k1 = cache.buildCacheKeys('gpt-4', msgs, { phase: 'upstream' });
  cache.set(k1, { text: '分析结果', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });
  // 另一次会话相同操作
  const k2 = cache.buildCacheKeys('gpt-4', msgs, { phase: 'upstream' });
  const hit = cache.get(k2);
  assert.ok(hit, '相同对话流应命中');
});

test('T6. shell + 幂等工具混合：shell 使整段不缓存', () => {
  cache.clear();
  const msgs = [
    { role: 'user', content: '执行命令并读取' },
    { role: 'assistant', content: '', tool_calls: [
      makeShellToolCall('npm install'),
      makeReadToolCall('package.json'),
    ] },
    { role: 'tool', tool_call_id: 'call_4', content: 'ok' },
    { role: 'tool', tool_call_id: 'call_1', content: 'pkg' },
    { role: 'user', content: '分析' },
  ];
  const keys = cache.buildCacheKeys('gpt-4', msgs, { phase: 'upstream' });
  assert.strictEqual(keys.fuzzy, null, '含 shell 应不生成 fuzzy');
  assert.strictEqual(keys.ultra, null);
  assert.strictEqual(keys.exact, null);
});

console.log('');
console.log('=== 分段指纹测试（文件编辑类放宽） ===');

// 核心场景：PatchEdit 后 Read 同一文件，应能命中缓存
test('S1. PatchEdit后Read: 分段指纹命中', () => {
  cache.clear();
  // 第一轮对话：user → PatchEdit → Read → user(分析)
  const msgs1 = [
    { role: 'user', content: '优化这段代码' },
    { role: 'assistant', content: '', tool_calls: [makePatchEditToolCall('foo.js', 'old', 'new', 'call_pe1')] },
    { role: 'tool', tool_call_id: 'call_pe1', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('foo.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '新内容' },
    { role: 'user', content: '分析' },
  ];
  const keys1 = cache.buildCacheKeys('gpt-4', msgs1, { phase: 'upstream' });
  assert.ok(keys1.fuzzy, 'fuzzy 应生成（PatchEdit 是文件编辑类，不阻断）');
  assert.ok(keys1.ultra, 'ultra 应生成');
  assert.strictEqual(keys1.exact, null, 'exact 仍为 null（含副作用工具）');
  cache.set(keys1, { text: '分析结果', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });

  // 第二轮对话：不同上下文，但 PatchEdit 之后的部分（Read foo.js + 分析）相同
  const msgs2 = [
    { role: 'user', content: '另一个任务' },
    { role: 'assistant', content: '', tool_calls: [makePatchEditToolCall('bar.js', 'x', 'y', 'call_pe2')] },
    { role: 'tool', tool_call_id: 'call_pe2', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('foo.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '新内容' },
    { role: 'user', content: '分析' },
  ];
  const keys2 = cache.buildCacheKeys('gpt-4', msgs2, { phase: 'upstream' });
  assert.strictEqual(keys2.fuzzy, keys1.fuzzy, '分段指纹应相同（PatchEdit 之后的部分一致）');
  const hit = cache.get(keys2);
  assert.ok(hit, '应命中缓存');
  assert.strictEqual(hit.entry.text, '分析结果');
});

// PatchEdit 后 Read 不同文件，不应命中
test('S2. PatchEdit后Read不同文件: 不命中', () => {
  cache.clear();
  const msgs1 = [
    { role: 'user', content: '优化' },
    { role: 'assistant', content: '', tool_calls: [makePatchEditToolCall('a.js', 'o', 'n', 'call_pe1')] },
    { role: 'tool', tool_call_id: 'call_pe1', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('a.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '内容A' },
    { role: 'user', content: '分析' },
  ];
  const msgs2 = [
    { role: 'user', content: '优化' },
    { role: 'assistant', content: '', tool_calls: [makePatchEditToolCall('b.js', 'o', 'n', 'call_pe2')] },
    { role: 'tool', tool_call_id: 'call_pe2', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('b.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '内容B' },
    { role: 'user', content: '分析' },
  ];
  const k1 = cache.buildCacheKeys('gpt-4', msgs1, { phase: 'upstream' });
  const k2 = cache.buildCacheKeys('gpt-4', msgs2, { phase: 'upstream' });
  assert.notStrictEqual(k1.fuzzy, k2.fuzzy, '不同文件 Read 应不同 fuzzy');
});

// 无文件编辑工具时，指纹应取完整对话（向后兼容）
test('S3. 无文件编辑: 完整指纹（向后兼容）', () => {
  cache.clear();
  const msgs = [
    { role: 'user', content: '读 foo.js' },
    { role: 'assistant', content: '', tool_calls: [makeReadToolCall('foo.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: '代码内容' },
    { role: 'user', content: '分析' },
  ];
  const k1 = cache.buildCacheKeys('gpt-4', msgs, { phase: 'upstream' });
  cache.set(k1, { text: '分析结果', reasoning: '', upstreamError: '', toolCalls: [], model: 'gpt-4' });
  const hit = cache.get(k1);
  assert.ok(hit, '无文件编辑时应正常命中（完整指纹）');
});

// findLastFileEditToolResultIndex 单元测试
test('S4. findLastFileEditToolResultIndex 定位', () => {
  const { _internal } = cache;
  // 无编辑工具
  assert.strictEqual(_internal.findLastFileEditToolResultIndex([
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [makeReadToolCall('a.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: 'x' },
  ]), -1, '无编辑工具应返回 -1');
  // 有编辑工具
  assert.strictEqual(_internal.findLastFileEditToolResultIndex([
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [makePatchEditToolCall('a.js', 'o', 'n', 'call_pe')] },
    { role: 'tool', tool_call_id: 'call_pe', content: 'ok' },
    { role: 'assistant', tool_calls: [makeReadToolCall('a.js')] },
    { role: 'tool', tool_call_id: 'call_1', content: 'x' },
  ]), 2, '应返回编辑工具结果的索引 2');
});

console.log('');
console.log('=== 总结 ===');
const stats = cache.getStats();
console.log('cache entries:', stats.entries, 'hits:', stats.totalHits);
console.log(process.exitCode ? '\x1b[31m有失败用例\x1b[0m' : '\x1b[32m全部通过\x1b[0m');
