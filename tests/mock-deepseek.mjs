// Minimal OpenAI/DeepSeek-compatible chat completions server used by the
// rootfs tests: streams a fixed reply as SSE so the guest's undici fetch path
// (WebAssembly-less llhttp polyfill) is exercised end to end.
//
// Usage: node tests/mock-deepseek.mjs [port]   (default 3199)
import http from 'node:http';

const port = Number(process.argv[2] ?? 3199);
const REPLY = 'MOCK-REPLY-7f3a: hello from the mock DeepSeek server';
// With --tool <name>, the first completion asks for that tool and the second
// reports what came back, so a whole tool round trip can be tested headlessly.
// --tool-args '<json>' supplies its arguments (default '{}').
const toolFlag = process.argv.indexOf('--tool');
const TOOL = toolFlag > 0 ? process.argv[toolFlag + 1] : null;
// Tools with required parameters (health_query's `metric`) need real arguments.
const argsFlag = process.argv.indexOf('--tool-args');
const TOOL_ARGS = argsFlag > 0 ? process.argv[argsFlag + 1] : '{}';


// Anthropic-compatible Messages API (what dsh >= 0.2.x speaks): POST /v1/messages.
// SSE framing mirrors https://docs.anthropic.com/en/api/messages-streaming.
function sse(res, events) {
  for (const [type, data] of events) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function toolResultText(result) {
  const c = result?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' ? (b.text ?? JSON.stringify(b)) : String(b))).join(' ');
  return JSON.stringify(c ?? '');
}

function messagesHandler(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
  const model = payload.model ?? 'deepseek-chat';
  const id = 'msg_mock_1';
  const messages = payload.messages ?? [];
  const tools = payload.tools ?? [];
  const lastToolResult = (() => {
    for (const m of [...messages].reverse()) {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
      for (const b of blocks) if (b && b.type === 'tool_result') return b;
    }
    return null;
  })();
  const offers = tools.some((t) => (t.name ?? t.function?.name) === TOOL);
  if (TOOL) {
    console.log('[mock] tools offered:', tools.map((t) => t.name ?? t.function?.name).join(', ') || '(none)');
    if (lastToolResult) console.log('[mock] tool result:', JSON.stringify(lastToolResult).slice(0, 400));
  }
  const wantTool = TOOL && !lastToolResult && offers;
  let text = REPLY;
  if (TOOL) {
    const observed = lastToolResult ? toolResultText(lastToolResult) : '(no tool result)';
    text = `TOOL-RESULT-BEGIN ${observed.slice(0, 800)} TOOL-RESULT-END`;
  }

  if (payload.stream === false) {
    const content = wantTool
      ? [{ type: 'tool_use', id: 'toolu_mock_1', name: TOOL, input: JSON.parse(TOOL_ARGS) }]
      : [{ type: 'text', text }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, type: 'message', role: 'assistant', model, content,
      stop_reason: wantTool ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 20, output_tokens: 12 },
    }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } }],
  ]);
  if (wantTool) {
    sse(res, [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: TOOL, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: TOOL_ARGS } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
    res.end();
    return;
  }
  sse(res, [['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]]);
  const words = text.split(' ');
  let i = 0;
  const timer = setInterval(() => {
    if (i < words.length) {
      sse(res, [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + words[i++] } }]]);
      return;
    }
    clearInterval(timer);
    sse(res, [
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 24 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
    res.end();
  }, 20);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url.includes('/v1/messages')) {
      messagesHandler(req, res, body); return;
    }
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
      res.writeHead(404); res.end('not found'); return;
    }
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const id = 'chatcmpl-mock';
    const model = payload.model ?? 'deepseek-chat';
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created: 1700000000, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

    // Tool mode: first turn asks for the tool, later turns quote its result.
    if (TOOL) {
      const messages = payload.messages ?? [];
      console.log('[mock] tools offered:', (payload.tools ?? []).map((t) => t.function?.name ?? t.name).join(', ') || '(none)');
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      if (lastTool) console.log('[mock] tool message:', JSON.stringify(lastTool).slice(0, 400));
      const toolResult = [...messages].reverse().find((m) => m.role === 'tool');
      const offers = (payload.tools ?? []).some((t) => (t.function?.name ?? t.name) === TOOL);
      // Ask for the tool until its result comes back in the conversation, so
      // repeated runs against one mock process behave identically.
      if (!toolResult && offers) {
        const call = { index: 0, id: 'call_mock_1', type: 'function', function: { name: TOOL, arguments: TOOL_ARGS } };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(chunk({ role: 'assistant', content: '', tool_calls: [call] }));
        res.write(chunk({}, 'tool_calls'));
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1700000000, model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const observed = typeof toolResult?.content === 'string' ? toolResult.content : JSON.stringify(toolResult?.content ?? {});
      const text = `TOOL-RESULT-BEGIN ${observed.slice(0, 800)} TOOL-RESULT-END`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(chunk({ role: 'assistant', content: '' }));
      for (const word of text.split(' ')) res.write(chunk({ content: word + ' ' }));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (payload.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: 1700000000, model,
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(chunk({ role: 'assistant', content: '' }));
    const words = REPLY.split(' ');
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        res.write(chunk({ content: (i ? ' ' : '') + words[i++] }));
      } else {
        clearInterval(timer);
        res.write(chunk({}, 'stop'));
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1700000000, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 20);
  });
});

// Bind all interfaces when asked (--lan), so a device on the same network can
// reach it for on-device end-to-end tests; loopback only by default.
const host = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  console.log(`mock-deepseek listening on http://${host}:${port}`);
});
