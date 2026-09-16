import { create } from 'zustand';
import { apiClient } from '../services/api';
import type { LocalUser, LocalUserSessionResponse } from '../types';

/**
 * 单一本机操作者：渲染层不再有登录与切换界面，启动时向后端要一个「本机操作者」会话即可。
 *
 * 刻意不再暴露 bootstrap / recover / switchUser / signOut —— 这些入口对应的界面已经移除，
 * 留着只会让人以为还有账号体系在运作。
 */
export interface LocalIdentityClient {
  setLocalSession(token: string | null): void;
  openLocalOperatorSession(): Promise<LocalUserSessionResponse>;
}

export interface OperatorState {
  currentUser: LocalUser | null;
  token: string | null;
  initialized: boolean;
  initialize(): Promise<void>;
}

export function createOperatorStore(client: LocalIdentityClient = apiClient) {
  let transitionQueue = Promise.resolve();
  const enqueueTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    const transition = transitionQueue.then(operation, operation);
    transitionQueue = transition.then(() => undefined, () => undefined);
    return transition;
  };

  return create<OperatorState>((set) => ({
    currentUser: null,
    token: null,
    initialized: false,

    initialize: () => enqueueTransition(async () => {
      try {
        const { session } = await client.openLocalOperatorSession();
        client.setLocalSession(session.token);
        set({ currentUser: session.user, token: session.token });
      } catch (error) {
        // 后端不可达时降级为「未就绪」，而不是把整个应用卡在初始化态：
        // 页面会提示本机操作者未就绪，后端恢复后重试即可。
        console.error('Failed to open the local operator session:', error);
        client.setLocalSession(null);
        set({ currentUser: null, token: null });
      }
      set({ initialized: true });
    }),
  }));
}

export const useOperatorStore = createOperatorStore();
