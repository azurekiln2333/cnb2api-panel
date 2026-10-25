import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey, SessionAffinity } from '../src/session-affinity.mjs';

const payload = {
  model: 'test-model',
  system: 'Be helpful',
  messages: [{ role: 'user', content: 'first question' }],
};

test('session fingerprints prefer explicit IDs, separate models, and ignore growing history', () => {
  const key = sessionKey({ 'x-session-id': 'conversation-a' }, payload);
  assert.equal(
    key,
    sessionKey(
      { 'x-session-id': 'conversation-a' },
      {
        ...payload,
        messages: [{ role: 'user', content: 'another turn' }],
      },
    ),
  );
  assert.notEqual(
    key,
    sessionKey({ 'x-session-id': 'conversation-b' }, payload),
  );
  assert.notEqual(
    key,
    sessionKey(
      { 'x-session-id': 'conversation-a' },
      { ...payload, model: 'other' },
    ),
  );
  assert.equal(
    key,
    sessionKey({ 'x-conversation-id': 'conversation-a' }, payload),
  );
  assert.equal(
    key,
    sessionKey({}, { ...payload, metadata: { session_id: 'conversation-a' } }),
  );
  assert.equal(
    key,
    sessionKey(
      {},
      { ...payload, metadata: { conversation_id: 'conversation-a' } },
    ),
  );
  assert.equal(
    key,
    sessionKey(
      {},
      {
        ...payload,
        metadata: {
          user_id: JSON.stringify({
            user_id: 'user',
            session_id: 'conversation-a',
          }),
        },
      },
    ),
  );
  const uuid = '12345678-1234-1234-1234-123456789abc';
  assert.equal(
    sessionKey({ 'x-session-id': uuid }, payload),
    sessionKey(
      {},
      {
        ...payload,
        metadata: { user_id: `user_abc_account__session_${uuid}` },
      },
    ),
  );
});

test('fallback uses full first user content and stable system prefix, never a generic user identity', () => {
  const key = sessionKey({}, payload);
  assert.equal(
    key,
    sessionKey(
      {},
      {
        ...payload,
        temperature: 0.5,
        messages: [
          ...payload.messages,
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'next' },
        ],
      },
    ),
  );
  assert.equal(
    key,
    sessionKey({}, { ...payload, metadata: { user_id: 'one-user' } }),
  );
  assert.notEqual(
    key,
    sessionKey({}, { ...payload, system: 'different instruction' }),
  );
  assert.notEqual(
    key,
    sessionKey(
      {},
      { ...payload, messages: [{ role: 'user', content: 'different' }] },
    ),
  );
  for (const content of ['x'.repeat(4096) + 'a', 'data:image/png;base64,a']) {
    assert.notEqual(
      sessionKey({}, { ...payload, messages: [{ role: 'user', content }] }),
      sessionKey(
        {},
        {
          ...payload,
          messages: [{ role: 'user', content: content.slice(0, -1) + 'b' }],
        },
      ),
    );
  }
  assert.equal(sessionKey({}, { model: 'test-model', messages: [] }), null);
  assert.match(key, /^[a-f0-9]{64}$/);
});

test('bindings expire after idle time, refresh on reuse, and evict least recently used sessions', () => {
  let now = 0;
  const affinity = new SessionAffinity({
    now: () => now,
    idleTtlMs: 100,
    maxEntries: 2,
  });
  affinity.bind('first', 'a');
  now = 50;
  assert.equal(affinity.get('first'), 'a');
  affinity.bind('second', 'b');
  now = 75;
  assert.equal(affinity.get('first'), 'a');
  affinity.bind('third', 'c');
  assert.equal(affinity.bindings.size, 2);
  assert.equal(affinity.get('second'), null);
  now = 150;
  assert.equal(affinity.get('first'), 'a');
  now = 175;
  assert.equal(affinity.get('third'), null);
  now = 250;
  assert.equal(affinity.get('first'), null);
  affinity.bind('stale', 'a');
  now = 350;
  affinity.bind('fresh', 'b');
  assert.equal(affinity.bindings.size, 1);
  affinity.forget('fresh', 'a');
  assert.equal(affinity.get('fresh'), 'b');
  affinity.forget('fresh', 'b');
  assert.equal(affinity.get('fresh'), null);
});
