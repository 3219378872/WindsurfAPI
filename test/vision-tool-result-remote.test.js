// Vision on the DEVIN_CONNECT path: images returned inside an Anthropic
// tool_result (Claude Code Read on an image file, screenshot MCP tools) and
// remote http(s) image URLs both used to be dropped before the wire build.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { inlineRemoteImages } from '../src/image.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };

async function translate(body) {
  let captured = null;
  await handleMessages({ model: 'claude-opus-4-8', max_tokens: 64, ...body }, {
    handleChatCompletions: async (b) => {
      captured = b;
      return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } };
    },
  });
  return captured;
}

function wireImageCount(messages) {
  const proto = buildGetChatMessageRequest({ token: 't', model: 'claude-opus-4-8-medium', messages, nativeToolCall: true });
  return proto.toString('latin1').split(PNG.slice(0, 16)).length - 1;
}

describe('tool_result images', () => {
  it('hoists tool_result images into the following user message and onto the wire', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: 'read the screenshot' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.png' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }, IMG] }] },
      ],
    });
    const toolIdx = body.messages.findIndex((m) => m.role === 'tool');
    const tool = body.messages[toolIdx];
    assert.equal(typeof tool.content, 'string', 'tool message stays text-only');
    assert.match(tool.content, /\[image: image\/png — attached in the next user message\]/);
    const next = body.messages[toolIdx + 1];
    assert.equal(next.role, 'user');
    assert.deepEqual(next.content.map((p) => p.type), ['image_url', 'text']);
    assert.equal(next.content[0].image_url.url, `data:image/png;base64,${PNG}`);
    assert.match(next.content[1].text, /returned by tool result toolu_1/);
    assert.equal(wireImageCount(body.messages), 1);
  });

  it('keeps the user\'s own text and images after the hoisted tool images', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Shot', input: {} }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [IMG] },
          IMG,
          { type: 'text', text: 'compare these' },
        ] },
      ],
    });
    const user = body.messages.at(-1);
    assert.deepEqual(user.content.map((p) => p.type), ['image_url', 'image_url', 'text']);
    assert.match(user.content[2].text, /toolu_2[\s\S]*compare these/);
    assert.equal(wireImageCount(body.messages), 2);
  });

  it('leaves text-only tool results unchanged', async () => {
    const body = await translate({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'text', text: 'done' }] }] },
      ],
    });
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.equal(body.messages.at(-1).content, 'done');
  });
});

describe('inlineRemoteImages', () => {
  const remote = (url) => [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: 'x' }] }];

  it('returns the same array when there is no remote image', async () => {
    const msgs = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }];
    assert.equal(await inlineRemoteImages(msgs), msgs);
  });

  it('replaces a remote URL with a data URI', async () => {
    const out = await inlineRemoteImages(remote('https://example.com/a.png'), {
      fetchImpl: async () => ({ base64_data: PNG, mime_type: 'image/png' }),
    });
    assert.equal(out[0].content[0].image_url.url, `data:image/png;base64,${PNG}`);
    assert.equal(wireImageCount(out), 1);
  });

  it('turns a failed fetch into a text note instead of dropping it', async () => {
    const out = await inlineRemoteImages(remote('https://example.com/a.png'), {
      fetchImpl: async () => { throw new Error('boom'); },
    });
    assert.deepEqual(out[0].content, [{ type: 'text', text: '[image not loaded: boom]' }, { type: 'text', text: 'x' }]);
  });

  it('caps the number of remote fetches per request', async () => {
    let calls = 0;
    const msgs = [{ role: 'user', content: Array.from({ length: 3 }, () => ({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } })) }];
    const out = await inlineRemoteImages(msgs, { max: 2, fetchImpl: async () => { calls++; return { base64_data: PNG, mime_type: 'image/png' }; } });
    assert.equal(calls, 2);
    assert.match(out[0].content[2].text, /more than 2 remote images/);
  });
});
