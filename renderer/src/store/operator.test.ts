import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperatorStore, type LocalIdentityClient } from './operator.js';
import type { LocalSession, LocalUser, LocalUserSessionResponse } from '../types/index.js';

const operator: LocalUser = {
  id: 'operator-1',
  displayName: '本机用户',
  role: 'admin',
  isActive: true,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const operatorSession: LocalSession = { token: 'operator-token', user: operator };

function identityClient(overrides: Partial<LocalIdentityClient> = {}): LocalIdentityClient {
  return {
    setLocalSession: () => undefined,
    openLocalOperatorSession: async (): Promise<LocalUserSessionResponse> => ({
      user: operator,
      session: operatorSession,
    }),
    ...overrides,
  };
}

test('initialize adopts the local operator session returned by the server', async () => {
  const tokens: Array<string | null> = [];
  const store = createOperatorStore(identityClient({
    setLocalSession: (token) => tokens.push(token),
  }));

  await store.getState().initialize();

  assert.equal(store.getState().initialized, true);
  assert.equal(store.getState().currentUser?.id, operator.id);
  assert.equal(store.getState().currentUser?.role, 'admin');
  assert.equal(store.getState().token, 'operator-token');
  assert.deepEqual(tokens, ['operator-token']);
});

test('initialize degrades to no current user when the auto session fails', async () => {
  const store = createOperatorStore(identityClient({
    openLocalOperatorSession: async () => {
      throw new Error('backend unreachable');
    },
  }));

  await store.getState().initialize();

  assert.equal(store.getState().initialized, true);
  assert.equal(store.getState().currentUser, null);
  assert.equal(store.getState().token, null);
});

test('initialize never touches browser storage', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('localStorage must not be read for a single local operator');
    },
  });

  try {
    const store = createOperatorStore(identityClient());

    await store.getState().initialize();

    assert.equal(store.getState().currentUser?.id, operator.id);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
