import { FormEvent, useState } from 'react';
import { AlertCircle, ArrowLeft, KeyRound, RotateCcw, ShieldCheck } from 'lucide-react';
import { useOperatorStore } from '../store/operator';
import { localIdentityErrorMessage, validateAdminSetup } from '../utils/localUsers';

type FieldErrors = Record<string, string>;

interface LocalUserSetupProps {
  recoveryOnly?: boolean;
  onClose?: () => void;
  onRecoveryComplete?: () => void;
}

export function LocalUserSetup({ recoveryOnly = false, onClose, onRecoveryComplete }: LocalUserSetupProps) {
  const bootstrap = useOperatorStore((state) => state.bootstrap);
  const recover = useOperatorStore((state) => state.recover);
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [recoveryName, setRecoveryName] = useState('');
  const [recoveryPin, setRecoveryPin] = useState('');
  const [recoveryPinConfirmation, setRecoveryPinConfirmation] = useState('');
  const [recoveryErrors, setRecoveryErrors] = useState<FieldErrors>({});
  const [recoverySubmitError, setRecoverySubmitError] = useState('');
  const [isRecovering, setIsRecovering] = useState(false);

  const handleBootstrap = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateAdminSetup(displayName, pin, confirmation);
    if (validation) {
      setErrors(validation);
      return;
    }

    setErrors({});
    setSubmitError('');
    setIsSubmitting(true);
    try {
      await bootstrap(displayName.trim(), pin);
    } catch (error) {
      setSubmitError(localIdentityErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateAdminSetup(recoveryName, recoveryPin, recoveryPinConfirmation);
    const nextErrors: FieldErrors = validation ?? {};
    if (recoveryConfirmation !== '重置本地用户') {
      nextErrors.recoveryConfirmation = '请准确输入“重置本地用户”以确认恢复';
    }
    if (Object.keys(nextErrors).length > 0) {
      setRecoveryErrors(nextErrors);
      return;
    }

    setRecoveryErrors({});
    setRecoverySubmitError('');
    setIsRecovering(true);
    try {
      await recover('重置本地用户', recoveryName.trim(), recoveryPin);
      onRecoveryComplete?.();
    } catch (error) {
      setRecoverySubmitError(localIdentityErrorMessage(error));
    } finally {
      setIsRecovering(false);
    }
  };

  return (
    <main className="min-h-screen bg-tech-bg px-4 py-8 sm:flex sm:items-center sm:justify-center sm:p-8">
      <section className="mx-auto w-full max-w-md rounded-lg border border-tech-border bg-tech-surface shadow-sm">
        <div className="border-b border-tech-border px-5 py-5 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-tech-blue">
              <ShieldCheck size={22} aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-tech-text">{recoveryOnly ? '恢复本地管理员' : '创建本地管理员'}</h1>
              <p className="mt-1 text-sm leading-6 text-tech-muted">{recoveryOnly ? '通过确认文本重置本地用户与管理员 PIN。' : '本地管理员仅用于本机创作与发布操作，不会创建线上账号。'}</p>
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-tech-muted transition hover:bg-tech-bg hover:text-tech-text"
              >
                <ArrowLeft size={16} aria-hidden="true" />
                返回
              </button>
            )}
          </div>
        </div>

        {!recoveryOnly && <form onSubmit={handleBootstrap} className="space-y-4 px-5 py-5 sm:px-6 sm:py-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-tech-text" htmlFor="local-admin-name">管理员姓名</label>
            <input
              id="local-admin-name"
              aria-label="管理员姓名"
              autoComplete="name"
              autoFocus
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-invalid={Boolean(errors.displayName)}
              aria-describedby={errors.displayName ? 'local-admin-name-error' : undefined}
              className="w-full rounded-lg border border-tech-border bg-tech-surface px-3 py-2.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
            />
            {errors.displayName && <p id="local-admin-name-error" className="mt-1 text-xs text-red-600">{errors.displayName}</p>}
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-tech-text" htmlFor="local-admin-pin">管理员 PIN</label>
            <input
              id="local-admin-pin"
              aria-label="管理员 PIN"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              aria-invalid={Boolean(errors.pin)}
              aria-describedby={errors.pin ? 'local-admin-pin-error' : undefined}
              className="w-full rounded-lg border border-tech-border bg-tech-surface px-3 py-2.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
            />
            {errors.pin && <p id="local-admin-pin-error" className="mt-1 text-xs text-red-600">{errors.pin}</p>}
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-tech-text" htmlFor="local-admin-pin-confirmation">确认 PIN</label>
            <input
              id="local-admin-pin-confirmation"
              aria-label="确认 PIN"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={Boolean(errors.confirmation)}
              aria-describedby={errors.confirmation ? 'local-admin-pin-confirmation-error' : undefined}
              className="w-full rounded-lg border border-tech-border bg-tech-surface px-3 py-2.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
            />
            {errors.confirmation && <p id="local-admin-pin-confirmation-error" className="mt-1 text-xs text-red-600">{errors.confirmation}</p>}
          </div>
          {submitError && <FormError message={submitError} />}
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-tech-blue px-4 py-2.5 text-sm font-medium text-white transition hover:bg-tech-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            <KeyRound size={16} aria-hidden="true" />
            {isSubmitting ? '正在创建...' : '创建本地管理员'}
          </button>
        </form>}

        <div className="border-t border-tech-border px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={() => setIsRecoveryOpen((open) => !open)}
            aria-expanded={isRecoveryOpen}
            className="inline-flex items-center gap-2 text-sm font-medium text-tech-muted transition hover:text-tech-text"
          >
            <RotateCcw size={16} aria-hidden="true" />
            重置本地用户
          </button>
          {isRecoveryOpen && (
            <form onSubmit={handleRecovery} className="mt-4 space-y-4 border-t border-tech-border pt-4">
              <p className="text-sm leading-6 text-tech-muted">此操作会替换当前本地用户，并结束现有会话。</p>
              <RecoveryField label="确认文本" inputId="local-recovery-confirmation" value={recoveryConfirmation} onChange={setRecoveryConfirmation} error={recoveryErrors.recoveryConfirmation} />
              <RecoveryField label="新管理员姓名" inputId="local-recovery-name" value={recoveryName} onChange={setRecoveryName} error={recoveryErrors.displayName} autoComplete="name" />
              <RecoveryField label="新管理员 PIN" inputId="local-recovery-pin" value={recoveryPin} onChange={setRecoveryPin} error={recoveryErrors.pin} type="password" />
              <RecoveryField label="确认新 PIN" inputId="local-recovery-pin-confirmation" value={recoveryPinConfirmation} onChange={setRecoveryPinConfirmation} error={recoveryErrors.confirmation} type="password" />
              {recoverySubmitError && <FormError message={recoverySubmitError} />}
              <button
                type="submit"
                disabled={isRecovering}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-tech-border px-4 py-2.5 text-sm font-medium text-tech-text transition hover:bg-tech-bg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RotateCcw size={16} aria-hidden="true" />
                {isRecovering ? '正在重置...' : '确认重置本地用户'}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

type RecoveryFieldProps = {
  label: string;
  inputId: string;
  value: string;
  onChange(value: string): void;
  error?: string;
  type?: 'text' | 'password';
  autoComplete?: string;
};

function RecoveryField({ label, inputId, value, onChange, error, type = 'text', autoComplete }: RecoveryFieldProps) {
  const errorId = `${inputId}-error`;
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-tech-text" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type={type}
        inputMode={type === 'password' ? 'numeric' : undefined}
        autoComplete={autoComplete ?? (type === 'password' ? 'new-password' : undefined)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className="w-full rounded-lg border border-tech-border bg-tech-surface px-3 py-2.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
      />
      {error && <p id={errorId} className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
