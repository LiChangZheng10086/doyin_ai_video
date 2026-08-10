import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  KeyRound,
  Pencil,
  ShieldCheck,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import { apiClient } from '../services/api';
import { useOperatorStore } from '../store/operator';
import type { LocalUser, LocalUserRole } from '../types';
import {
  canManageUsers,
  createLocalUserMutationLock,
  localIdentityErrorMessage,
  runLocalUserMutation,
} from '../utils/localUsers';

type NewUserForm = {
  displayName: string;
  role: LocalUserRole;
  pin: string;
  pinConfirmation: string;
};

type PinAction = {
  kind: 'promote' | 'reset';
  user: LocalUser;
};

type MutationRequest<T> = {
  targetUserId?: string;
  mutate(): Promise<T>;
  applySavedValue(value: T): void;
  savedUserId(value: T): string;
  onFailure(message: string): void;
};

const emptyNewUserForm = (): NewUserForm => ({
  displayName: '',
  role: 'publisher',
  pin: '',
  pinConfirmation: '',
});

const roleLabels: Record<LocalUserRole, string> = {
  admin: '管理员',
  publisher: '发布者',
};

export function LocalUsersSettings() {
  const users = useOperatorStore((state) => state.users);
  const currentUser = useOperatorStore((state) => state.currentUser);
  const refreshUsers = useOperatorStore((state) => state.refreshUsers);
  const syncUser = useOperatorStore((state) => state.syncUser);
  const isAdmin = canManageUsers(currentUser);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState<NewUserForm>(emptyNewUserForm);
  const [createError, setCreateError] = useState('');
  const [isMutating, setIsMutating] = useState(false);
  const [mutatingUserId, setMutatingUserId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowWarnings, setRowWarnings] = useState<Record<string, string>>({});
  const [renamingUserId, setRenamingUserId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pinAction, setPinAction] = useState<PinAction | null>(null);
  const [pin, setPin] = useState('');
  const [pinConfirmation, setPinConfirmation] = useState('');
  const [pinError, setPinError] = useState('');
  const [loadError, setLoadError] = useState('');
  const mutationLockRef = useRef(createLocalUserMutationLock());
  const pinModalRootRef = useRef<HTMLDivElement>(null);
  const pinDialogRef = useRef<HTMLFormElement>(null);
  const pinTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void refreshUsers().catch((error) => {
      if (mounted) setLoadError(localIdentityErrorMessage(error, '本地用户列表加载失败'));
    });
    return () => {
      mounted = false;
    };
  }, [refreshUsers]);

  const dismissPinAction = useCallback(() => {
    setPinAction(null);
    setPin('');
    setPinConfirmation('');
    setPinError('');
  }, []);

  useEffect(() => {
    if (!pinAction) return;
    const modalRoot = pinModalRootRef.current;
    const dialog = pinDialogRef.current;
    if (!modalRoot || !dialog) return;

    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot)
      .map((element) => ({
        element,
        ariaHidden: element.getAttribute('aria-hidden'),
        inert: element.inert,
      }));
    background.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });

    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !mutationLockRef.current.locked) {
        event.preventDefault();
        event.stopPropagation();
        dismissPinAction();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      background.forEach(({ element, ariaHidden, inert }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      pinTriggerRef.current?.focus();
      pinTriggerRef.current = null;
    };
  }, [dismissPinAction, pinAction]);

  const executeMutation = async <T,>(request: MutationRequest<T>): Promise<void> => {
    await mutationLockRef.current.run(async () => {
      setIsMutating(true);
      setMutatingUserId(request.targetUserId ?? null);
      if (request.targetUserId) {
        setRowErrors((current) => ({ ...current, [request.targetUserId!]: '' }));
        setRowWarnings((current) => ({ ...current, [request.targetUserId!]: '' }));
      }

      try {
        const outcome = await runLocalUserMutation(
          request.mutate,
          request.applySavedValue,
          refreshUsers
        );
        if (outcome.status === 'failed') {
          request.onFailure(localIdentityErrorMessage(outcome.error, '用户信息更新失败'));
          return;
        }
        if (outcome.refreshError) {
          const userId = request.savedUserId(outcome.value);
          setRowWarnings((current) => ({ ...current, [userId]: '已保存，但列表刷新失败' }));
        }
      } finally {
        setIsMutating(false);
        setMutatingUserId(null);
      }
    });
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutationLockRef.current.locked) return;
    const displayName = newUser.displayName.trim();
    if (!displayName) {
      setCreateError('请输入用户姓名');
      return;
    }
    if (newUser.role === 'admin') {
      const validationError = validatePinPair(newUser.pin, newUser.pinConfirmation);
      if (validationError) {
        setCreateError(validationError);
        return;
      }
    }

    setCreateError('');
    await executeMutation({
      mutate: () => apiClient.createLocalUser({
        displayName,
        role: newUser.role,
        ...(newUser.role === 'admin' ? { pin: newUser.pin } : {}),
      }),
      applySavedValue: ({ user }) => {
        syncUser(user);
        setNewUser(emptyNewUserForm());
        setIsCreateOpen(false);
      },
      savedUserId: ({ user }) => user.id,
      onFailure: setCreateError,
    });
  };

  const startRename = (user: LocalUser) => {
    setRowErrors((current) => ({ ...current, [user.id]: '' }));
    setRenamingUserId(user.id);
    setRenameValue(user.displayName);
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>, user: LocalUser) => {
    event.preventDefault();
    if (mutationLockRef.current.locked) return;
    const displayName = renameValue.trim();
    if (!displayName) {
      setRowErrors((current) => ({ ...current, [user.id]: '请输入用户姓名' }));
      return;
    }
    await executeMutation({
      targetUserId: user.id,
      mutate: () => apiClient.updateLocalUser(user.id, { displayName }),
      applySavedValue: ({ user: savedUser }) => {
        syncUser(savedUser);
        setRenamingUserId(null);
        setRenameValue('');
      },
      savedUserId: ({ user: savedUser }) => savedUser.id,
      onFailure: (message) => setRowErrors((current) => ({ ...current, [user.id]: message })),
    });
  };

  const handleActiveChange = async (user: LocalUser) => {
    if (mutationLockRef.current.locked) return;
    if (user.isActive && user.id === currentUser?.id && currentUser.role === 'admin') return;
    if (user.isActive && !window.confirm(`确定要停用“${user.displayName}”吗？`)) return;
    await executeMutation({
      targetUserId: user.id,
      mutate: () => apiClient.updateLocalUser(user.id, { isActive: !user.isActive }),
      applySavedValue: ({ user: savedUser }) => syncUser(savedUser),
      savedUserId: ({ user: savedUser }) => savedUser.id,
      onFailure: (message) => setRowErrors((current) => ({ ...current, [user.id]: message })),
    });
  };

  const handleRoleChange = async (user: LocalUser) => {
    if (mutationLockRef.current.locked) return;
    if (user.role === 'publisher') {
      openPinAction({ kind: 'promote', user });
      return;
    }

    const confirmed = window.confirm(
      `确定要将“${user.displayName}”改为发布者吗？确认后将移除该用户的管理员 PIN。`
    );
    if (!confirmed) return;
    await executeMutation({
      targetUserId: user.id,
      mutate: () => apiClient.updateLocalUser(user.id, { role: 'publisher' }),
      applySavedValue: ({ user: savedUser }) => syncUser(savedUser),
      savedUserId: ({ user: savedUser }) => savedUser.id,
      onFailure: (message) => setRowErrors((current) => ({ ...current, [user.id]: message })),
    });
  };

  const openPinAction = (action: PinAction) => {
    if (mutationLockRef.current.locked) return;
    pinTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRowErrors((current) => ({ ...current, [action.user.id]: '' }));
    setPinAction(action);
    setPin('');
    setPinConfirmation('');
    setPinError('');
  };

  const closePinAction = () => {
    if (!mutationLockRef.current.locked) dismissPinAction();
  };

  const handlePinAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pinAction || mutationLockRef.current.locked) return;
    const validationError = validatePinPair(pin, pinConfirmation);
    if (validationError) {
      setPinError(validationError);
      return;
    }

    setPinError('');
    const userId = pinAction.user.id;
    const onFailure = (message: string) => {
      setPinError(message);
      setRowErrors((current) => ({ ...current, [userId]: message }));
    };
    if (pinAction.kind === 'promote') {
      await executeMutation({
        targetUserId: userId,
        mutate: () => apiClient.updateLocalUser(userId, { role: 'admin', pin }),
        applySavedValue: ({ user }) => {
          syncUser(user);
          dismissPinAction();
        },
        savedUserId: ({ user }) => user.id,
        onFailure,
      });
      return;
    }

    await executeMutation({
      targetUserId: userId,
      mutate: () => apiClient.resetLocalUserPin(userId, pin),
      applySavedValue: dismissPinAction,
      savedUserId: () => userId,
      onFailure,
    });
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 rounded-lg border border-tech-border bg-tech-surface p-5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-tech-blue">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-lg font-semibold text-tech-text">本地用户</h3>
            <p className="mt-1 text-sm text-tech-muted">
              {isAdmin ? '管理本机操作者及其角色。' : '查看本机操作者；用户管理需要管理员权限。'}
            </p>
          </div>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              setNewUser(emptyNewUserForm());
              setCreateError('');
              setIsCreateOpen(true);
            }}
            disabled={isMutating}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition hover:bg-tech-blue-dark"
          >
            <UserPlus size={16} aria-hidden="true" />
            新建用户
          </button>
        )}
      </div>

      {loadError && <InlineError message={loadError} />}

      {isAdmin && isCreateOpen && (
        <form onSubmit={handleCreate} className="space-y-4 rounded-lg border border-tech-border bg-tech-surface p-5">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-semibold text-tech-text">新建用户</h4>
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              disabled={isMutating}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-tech-muted transition hover:bg-tech-bg hover:text-tech-text"
              aria-label="关闭新建用户表单"
              title="关闭"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="用户姓名" inputId="new-local-user-name">
              <input
                id="new-local-user-name"
                autoComplete="name"
                value={newUser.displayName}
                onChange={(event) => setNewUser((current) => ({ ...current, displayName: event.target.value }))}
                className={inputClassName}
              />
            </FormField>
            <FormField label="角色" inputId="new-local-user-role">
              <select
                id="new-local-user-role"
                value={newUser.role}
                onChange={(event) => setNewUser((current) => ({
                  ...current,
                  role: event.target.value as LocalUserRole,
                  pin: '',
                  pinConfirmation: '',
                }))}
                className={inputClassName}
              >
                <option value="publisher">发布者</option>
                <option value="admin">管理员</option>
              </select>
            </FormField>
            {newUser.role === 'admin' && (
              <>
                <PinField
                  label="管理员 PIN"
                  inputId="new-local-user-pin"
                  value={newUser.pin}
                  onChange={(value) => setNewUser((current) => ({ ...current, pin: value }))}
                />
                <PinField
                  label="确认 PIN"
                  inputId="new-local-user-pin-confirmation"
                  value={newUser.pinConfirmation}
                  onChange={(value) => setNewUser((current) => ({ ...current, pinConfirmation: value }))}
                />
              </>
            )}
          </div>
          {createError && <InlineError message={createError} />}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              disabled={isMutating}
              className="rounded-lg px-4 py-2 text-sm font-medium text-tech-muted transition hover:bg-tech-bg hover:text-tech-text disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isMutating}
              className="inline-flex items-center gap-2 rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition hover:bg-tech-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              <UserPlus size={16} aria-hidden="true" />
              {isMutating ? '正在创建...' : '创建用户'}
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {users.map((user) => {
          const isCurrent = user.id === currentUser?.id;
          const isBusy = mutatingUserId === user.id;
          const cannotDisableCurrentAdmin = isCurrent && currentUser?.role === 'admin' && user.isActive;
          return (
            <div key={user.id} aria-busy={isBusy} className="rounded-lg border border-tech-border bg-tech-surface p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="break-words font-semibold text-tech-text">{user.displayName}</h4>
                    <span className={`rounded px-2 py-1 text-xs font-medium ${
                      user.role === 'admin' ? 'bg-blue-50 text-tech-blue' : 'bg-tech-bg text-tech-muted'
                    }`}>
                      {roleLabels[user.role]}
                    </span>
                    <span className={`rounded px-2 py-1 text-xs font-medium ${
                      user.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {user.isActive ? '已启用' : '已停用'}
                    </span>
                    {isCurrent && (
                      <span className="inline-flex items-center gap-1 rounded bg-purple-50 px-2 py-1 text-xs font-medium text-tech-purple">
                        <Check size={13} aria-hidden="true" />
                        当前操作者
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-tech-muted">更新于 {formatDate(user.updatedAt)}</p>
                </div>

                {isAdmin && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => startRename(user)}
                      disabled={isMutating}
                      className={secondaryButtonClassName}
                    >
                      <Pencil size={15} aria-hidden="true" />
                      重命名
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRoleChange(user)}
                      disabled={isMutating}
                      className={secondaryButtonClassName}
                    >
                      <ShieldCheck size={15} aria-hidden="true" />
                      {user.role === 'admin' ? '改为发布者' : '设为管理员'}
                    </button>
                    {user.role === 'admin' && (
                      <button
                        type="button"
                        onClick={() => openPinAction({ kind: 'reset', user })}
                        disabled={isMutating}
                        className={secondaryButtonClassName}
                      >
                        <KeyRound size={15} aria-hidden="true" />
                        重置 PIN
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleActiveChange(user)}
                      disabled={isMutating || cannotDisableCurrentAdmin}
                      title={cannotDisableCurrentAdmin ? '当前管理员会话中不能停用自己的用户' : user.isActive ? '停用用户' : '启用用户'}
                      className={user.isActive ? dangerButtonClassName : secondaryButtonClassName}
                    >
                      {user.isActive ? <UserX size={15} aria-hidden="true" /> : <UserCheck size={15} aria-hidden="true" />}
                      {user.isActive ? '停用' : '启用'}
                    </button>
                  </div>
                )}
              </div>

              {isAdmin && renamingUserId === user.id && (
                <form onSubmit={(event) => void handleRename(event, user)} className="mt-4 flex flex-col gap-2 border-t border-tech-border pt-4 sm:flex-row">
                  <label className="sr-only" htmlFor={`rename-local-user-${user.id}`}>用户姓名</label>
                  <input
                    id={`rename-local-user-${user.id}`}
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    className={`${inputClassName} sm:max-w-sm`}
                  />
                  <button type="submit" disabled={isMutating} className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition hover:bg-tech-blue-dark disabled:opacity-60">
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingUserId(null)}
                    disabled={isMutating}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-tech-muted transition hover:bg-tech-bg hover:text-tech-text disabled:opacity-60"
                  >
                    取消
                  </button>
                </form>
              )}
              {rowErrors[user.id] && <div className="mt-4"><InlineError message={rowErrors[user.id]} /></div>}
              {rowWarnings[user.id] && <div className="mt-4"><InlineWarning message={rowWarnings[user.id]} /></div>}
            </div>
          );
        })}
      </div>

      {pinAction && createPortal(
        <div ref={pinModalRootRef} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            ref={pinDialogRef}
            onSubmit={handlePinAction}
            role="dialog"
            aria-modal="true"
            aria-labelledby="local-user-pin-action-title"
            aria-describedby="local-user-pin-action-description"
            tabIndex={-1}
            className="w-full max-w-sm rounded-lg border border-tech-border bg-tech-surface shadow-xl"
          >
            <div className="border-b border-tech-border px-5 py-4">
              <div className="flex items-center gap-2 text-tech-text">
                <KeyRound size={18} className="text-tech-blue" aria-hidden="true" />
                <h4 id="local-user-pin-action-title" className="font-semibold">
                  {pinAction.kind === 'promote' ? '设置新管理员 PIN' : '重置管理员 PIN'}
                </h4>
              </div>
              <p id="local-user-pin-action-description" className="mt-1 text-sm text-tech-muted">{pinAction.user.displayName}</p>
            </div>
            <div className="space-y-4 px-5 py-5">
              <PinField label="新 PIN" inputId="local-user-new-pin" value={pin} onChange={setPin} />
              <PinField label="确认新 PIN" inputId="local-user-new-pin-confirmation" value={pinConfirmation} onChange={setPinConfirmation} />
              {pinError && <InlineError message={pinError} />}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closePinAction}
                  disabled={isMutating}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-tech-muted transition hover:bg-tech-bg hover:text-tech-text disabled:opacity-60"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isMutating}
                  className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition hover:bg-tech-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isMutating ? '正在保存...' : '确认保存'}
                </button>
              </div>
            </div>
          </form>
        </div>,
        document.body
      )}
    </section>
  );
}

function FormField({ label, inputId, children }: { label: string; inputId: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-tech-text" htmlFor={inputId}>{label}</label>
      {children}
    </div>
  );
}

function PinField({
  label,
  inputId,
  value,
  onChange,
}: {
  label: string;
  inputId: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <FormField label={label} inputId={inputId}>
      <input
        id={inputId}
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClassName}
      />
    </FormField>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function InlineWarning({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800" role="status">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function validatePinPair(pin: string, confirmation: string): string | null {
  if (!/^\d{6,12}$/.test(pin)) return 'PIN 必须为 6 至 12 位数字';
  if (pin !== confirmation) return '两次 PIN 不一致';
  return null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

const inputClassName = 'w-full rounded-lg border border-tech-border bg-tech-surface px-3 py-2.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100';
const secondaryButtonClassName = 'inline-flex items-center gap-1.5 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text transition hover:border-tech-blue hover:text-tech-blue disabled:cursor-not-allowed disabled:opacity-50';
const dangerButtonClassName = 'inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50';
