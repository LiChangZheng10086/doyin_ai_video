import { create } from 'zustand';
import { apiClient } from '../services/api';
import type { LocalSession, LocalUser, LocalUserResponse, LocalUserRole, LocalUsersResponse, LocalUserSessionResponse, LocalSessionResponse } from '../types';
import { findRestorablePublisher } from '../utils/localUsers';

const LAST_PUBLISHER_ID_KEY = 'douyin-ai-video.last-publisher-id';

export interface LocalIdentityClient {
  setLocalSession(token: string | null): void;
  getLocalUsers(): Promise<LocalUsersResponse>;
  bootstrapLocalAdmin(displayName: string, pin: string): Promise<LocalUserSessionResponse>;
  recoverLocalIdentity(confirmation: string, displayName: string, pin: string): Promise<LocalUserSessionResponse>;
  openLocalSession(userId: string, pin?: string): Promise<LocalSessionResponse>;
  closeLocalSession(): Promise<void>;
  createLocalUser(input: { displayName: string; role: LocalUserRole; pin?: string }): Promise<LocalUserResponse>;
  updateLocalUser(id: string, input: { displayName?: string; role?: LocalUserRole; isActive?: boolean; pin?: string }): Promise<LocalUserResponse>;
  resetLocalUserPin(id: string, pin: string): Promise<void>;
}

export interface OperatorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OperatorState {
  users: LocalUser[];
  currentUser: LocalUser | null;
  token: string | null;
  needsBootstrap: boolean;
  initialized: boolean;
  initialize(): Promise<void>;
  bootstrap(displayName: string, pin: string): Promise<void>;
  recover(confirmation: string, displayName: string, pin: string): Promise<void>;
  switchUser(userId: string, pin?: string): Promise<void>;
  signOut(): Promise<void>;
  refreshUsers(): Promise<void>;
  syncUser(user: LocalUser): void;
}

function browserStorage(): OperatorStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function replaceUser(users: LocalUser[], user: LocalUser): LocalUser[] {
  const index = users.findIndex((candidate) => candidate.id === user.id);
  if (index < 0) return [...users, user];
  return users.map((candidate) => candidate.id === user.id ? user : candidate);
}

function readStorage(storage: OperatorStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(storage: OperatorStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Browser storage can fail in private contexts or when quota is exhausted.
  }
}

function removeStorage(storage: OperatorStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Browser storage cleanup must not block a local session transition.
  }
}

export function createOperatorStore(client: LocalIdentityClient = apiClient, storage: OperatorStorage | null = browserStorage()) {
  let transitionQueue = Promise.resolve();
  const enqueueTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    const transition = transitionQueue.then(operation, operation);
    transitionQueue = transition.then(() => undefined, () => undefined);
    return transition;
  };

  const applySession = (session: LocalSession, set: (state: Partial<OperatorState>) => void, get: () => OperatorState) => {
    client.setLocalSession(session.token);
    set({
      users: replaceUser(get().users, session.user),
      currentUser: session.user,
      token: session.token,
    });
    syncPublisherPersistence(session.user);
  };

  const syncPublisherPersistence = (user: LocalUser) => {
    if (user.role === 'publisher' && user.isActive) {
      writeStorage(storage, LAST_PUBLISHER_ID_KEY, user.id);
    } else {
      removeStorage(storage, LAST_PUBLISHER_ID_KEY);
    }
  };

  const clearCurrentSession = (set: (state: Partial<OperatorState>) => void) => {
    client.setLocalSession(null);
    set({ currentUser: null, token: null });
    removeStorage(storage, LAST_PUBLISHER_ID_KEY);
  };

  return create<OperatorState>((set, get) => ({
    users: [],
    currentUser: null,
    token: null,
    needsBootstrap: false,
    initialized: false,

    initialize: () => enqueueTransition(async () => {
      const result = await client.getLocalUsers();
      set({ users: result.users, needsBootstrap: result.needsBootstrap });

      const publisher = findRestorablePublisher(result.users, readStorage(storage, LAST_PUBLISHER_ID_KEY));
      if (!publisher) {
        removeStorage(storage, LAST_PUBLISHER_ID_KEY);
        set({ initialized: true });
        return;
      }

      const { session } = await client.openLocalSession(publisher.id);
      applySession(session, set, get);
      set({ initialized: true });
    }),

    bootstrap: (displayName, pin) => enqueueTransition(async () => {
      const { user, session } = await client.bootstrapLocalAdmin(displayName, pin);
      client.setLocalSession(session.token);
      set({ users: [user], currentUser: session.user, token: session.token, needsBootstrap: false, initialized: true });
      removeStorage(storage, LAST_PUBLISHER_ID_KEY);
    }),

    recover: (confirmation, displayName, pin) => enqueueTransition(async () => {
      const { user, session } = await client.recoverLocalIdentity(confirmation, displayName, pin);
      client.setLocalSession(session.token);
      set({
        users: [user],
        currentUser: session.user,
        token: session.token,
        needsBootstrap: false,
        initialized: true,
      });
      removeStorage(storage, LAST_PUBLISHER_ID_KEY);
    }),

    switchUser: (userId, pin) => enqueueTransition(async () => {
      const { session } = await client.openLocalSession(userId, pin);
      applySession(session, set, get);
    }),

    signOut: () => enqueueTransition(async () => {
      try {
        await client.closeLocalSession();
      } catch {
        // Local cleanup still completes when the server cannot be reached.
      } finally {
        client.setLocalSession(null);
        set({ currentUser: null, token: null });
        removeStorage(storage, LAST_PUBLISHER_ID_KEY);
      }
    }),

    refreshUsers: async () => {
      const result = await client.getLocalUsers();
      const currentUser = get().currentUser;
      const refreshedCurrentUser = currentUser
        ? result.users.find((user) => user.id === currentUser.id)
        : undefined;
      set({
        users: result.users,
        needsBootstrap: result.needsBootstrap,
      });
      if (currentUser && (!refreshedCurrentUser || !refreshedCurrentUser.isActive)) {
        clearCurrentSession(set);
        return;
      }
      if (refreshedCurrentUser) {
        set({ currentUser: refreshedCurrentUser });
        syncPublisherPersistence(refreshedCurrentUser);
      }
    },

    syncUser: (user) => {
      const currentUser = get().currentUser;
      set({ users: replaceUser(get().users, user) });
      if (currentUser?.id !== user.id) return;
      if (!user.isActive) {
        clearCurrentSession(set);
        return;
      }
      set({ currentUser: user });
      syncPublisherPersistence(user);
    },
  }));
}

export const useOperatorStore = createOperatorStore();
