import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperatorStore, type LocalIdentityClient } from './operator.js';
import type { LocalSession, LocalUser } from '../types/index.js';

const publisher: LocalUser = {
  id: 'publisher-1',
  displayName: '发布员',
  role: 'publisher',
  isActive: true,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const recoveredAdmin: LocalUser = {
  id: 'admin-recovered',
  displayName: '新管理员',
  role: 'admin',
  isActive: true,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const recoveredSession: LocalSession = { token: 'recovered-token', user: recoveredAdmin };

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function identityClient(overrides: Partial<LocalIdentityClient> = {}): LocalIdentityClient {
  return {
    setLocalSession: () => undefined,
    getLocalUsers: async () => ({ users: [publisher], needsBootstrap: false }),
    bootstrapLocalAdmin: async () => ({ user: recoveredAdmin, session: recoveredSession }),
    recoverLocalIdentity: async () => ({ user: recoveredAdmin, session: recoveredSession }),
    openLocalSession: async () => ({ session: { token: 'publisher-token', user: publisher } }),
    closeLocalSession: async () => undefined,
    createLocalUser: async () => ({ user: publisher }),
    updateLocalUser: async () => ({ user: publisher }),
    resetLocalUserPin: async () => undefined,
    ...overrides,
  };
}

test('recovery atomically adopts its response without opening another session', async () => {
  let openSessionCalls = 0;
  const sessionChanges: Array<string | null> = [];
  const store = createOperatorStore(identityClient({
    setLocalSession: (token) => sessionChanges.push(token),
    openLocalSession: async () => {
      openSessionCalls += 1;
      return { session: { token: 'unexpected-token', user: publisher } };
    },
  }), memoryStorage({ 'douyin-ai-video.last-publisher-id': publisher.id }));

  await store.getState().recover('重置本地用户', '新管理员', '654321');

  assert.equal(openSessionCalls, 0);
  assert.deepEqual(store.getState().users, [recoveredAdmin]);
  assert.equal(store.getState().currentUser, recoveredAdmin);
  assert.equal(store.getState().token, recoveredSession.token);
  assert.equal(store.getState().needsBootstrap, false);
  assert.equal(store.getState().initialized, true);
  assert.deepEqual(sessionChanges, [recoveredSession.token]);
});

test('initialization remains unresolved when saved publisher restoration fails', async () => {
  const store = createOperatorStore(identityClient({
    openLocalSession: async () => { throw new Error('network unavailable'); },
  }), memoryStorage({ 'douyin-ai-video.last-publisher-id': publisher.id }));

  await assert.rejects(() => store.getState().initialize(), /network unavailable/);

  assert.equal(store.getState().initialized, false);
  assert.equal(store.getState().currentUser, null);
  assert.equal(store.getState().token, null);
});
