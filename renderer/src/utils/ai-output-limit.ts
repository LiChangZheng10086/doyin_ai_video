export type OutputLimitMode = 'automatic' | 'custom';

export function toOutputLimitForm(maxOutputTokens?: number) {
  return maxOutputTokens === undefined
    ? { mode: 'automatic' as const, value: '8192' }
    : { mode: 'custom' as const, value: String(maxOutputTokens) };
}

export function parseOutputLimit(mode: OutputLimitMode, value: string) {
  if (mode === 'automatic') return undefined;
  if (!value.trim()) throw new Error('请输入输出 Token 上限');
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('输出 Token 上限必须为整数');
  if (parsed < 256) throw new Error('输出 Token 上限至少为 256');
  return parsed;
}
