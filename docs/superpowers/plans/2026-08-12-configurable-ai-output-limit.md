# Configurable AI Output Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each AI configuration use automatic output sizing or a user-defined Token limit for AI washing and storyboard generation, with immediate runtime effect and actionable truncation errors.

**Architecture:** Add optional `maxOutputTokens?: number` to the existing AI configuration types and carry it through Electron/HTTP configuration into `AiRuntimeConfig` and `OpenAiScriptCleanerOptions`. `OpenAiScriptCleaner` becomes the single request-policy boundary: missing values omit `max_tokens`, while custom values are sent by both washing and storyboard calls. The Settings page derives an `automatic | custom` form mode without persisting a second mode field.

**Tech Stack:** TypeScript, Electron IPC, Express, React 19, OpenAI-compatible Chat Completions API, Node test runner.

## Global Constraints

- Missing `maxOutputTokens` means automatic mode and must omit `max_tokens` from creative requests.
- Custom values must be integers greater than or equal to 256; the application imposes no artificial maximum.
- The setting applies only to AI washing and storyboard generation in this change.
- Connection tests keep their independent `max_tokens: 5` request.
- DeepSeek-only request fields remain restricted to the DeepSeek provider.
- Existing configuration files require no migration and must remain readable.
- Configuration edits must affect the next AI step without restarting Electron.

---

### Task 1: Make AI request output limits configurable

**Files:**
- Modify: `src/lib/ai-cleaner.ts`
- Modify: `src/lib/ai-cleaner.test.ts`

**Interfaces:**
- Consumes: `OpenAiScriptCleanerOptions.maxOutputTokens?: number`
- Produces: `OpenAiScriptCleaner` requests that omit or send `max_tokens` consistently and produce mode-aware truncation messages.

- [ ] **Step 1: Write failing tests for automatic and custom request limits**

Add these local fixtures before the tests so every response passes the existing content validators:

```ts
function cleanInput() {
  return { topic: "AI 内容生产", transcriptText: "原始转录", draft: draft() };
}

function validCleanPayload() {
  return {
    title: "内容生产方法",
    summary: "核心内容",
    hook: "先找准核心问题",
    key_points: ["核心内容"],
    clean_script: "核心内容",
    short_video_script: "核心内容".repeat(46),
    cover_title: "内容生产方法",
    tags: ["内容生产"],
    quality_notes: []
  };
}

function validShots() {
  return Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    duration: index < 4 ? 7 : 6,
    shot_type: index === 0 ? "hook" : index === 7 ? "summary" : "explain",
    layout: index === 0 ? "kinetic-title" : index === 7 ? "summary-stack" : "concept-map",
    headline: `要点${index + 1}`,
    caption_lines: ["核心内容"],
    visual_items: [{ label: "输入" }, { label: "输出" }],
    source_key_points: [0],
    transition: "cut",
    pacing: "medium"
  }));
}

function installResponseQueue(
  cleaner: OpenAiScriptCleaner,
  requests: Array<Record<string, unknown>>,
  responses: unknown[]
) {
  (cleaner as any).client = {
    chat: { completions: { create: async (request: Record<string, unknown>) => {
      requests.push(request);
      return responses.shift();
    } } }
  };
}
```

Then add request-capture tests covering both methods:

```ts
test("OpenAiScriptCleaner omits max_tokens in automatic mode", async () => {
  const cleaner = new OpenAiScriptCleaner({ apiKey: "test", model: "model" });
  const requests: Array<Record<string, unknown>> = [];
  installResponseQueue(cleaner, requests, [
    { choices: [{ message: { content: JSON.stringify(validCleanPayload()) } }] },
    { choices: [{ message: { content: JSON.stringify({ target_duration: 60, shots: validShots() }) } }] }
  ]);

  await cleaner.clean(cleanInput());
  await cleaner.planShortVideo!({ ...draft(), keyPoints: ["核心内容"], shortVideoScript: "核心内容" });

  assert.equal(requests[0].max_tokens, undefined);
  assert.equal(requests[1].max_tokens, undefined);
});

test("OpenAiScriptCleaner sends the configured max output tokens", async () => {
  const cleaner = new OpenAiScriptCleaner({
    apiKey: "test",
    model: "model",
    maxOutputTokens: 8192
  });
  const requests: Array<Record<string, unknown>> = [];
  installResponseQueue(cleaner, requests, [
    { choices: [{ message: { content: JSON.stringify(validCleanPayload()) } }] },
    { choices: [{ message: { content: JSON.stringify({ target_duration: 60, shots: validShots() }) } }] }
  ]);

  await cleaner.clean(cleanInput());
  await cleaner.planShortVideo!({ ...draft(), keyPoints: ["核心内容"], shortVideoScript: "核心内容" });

  assert.equal(requests[0].max_tokens, 8192);
  assert.equal(requests[1].max_tokens, 8192);
});
```

Reuse the existing valid wash payload and eight-shot fixtures rather than weakening response validation.

- [ ] **Step 2: Write failing tests for truncation guidance**

Add a helper that returns a length-limited non-streaming response:

```ts
function cleanerReturningFinishReasonLength(maxOutputTokens?: number) {
  const cleaner = new OpenAiScriptCleaner({
    apiKey: "test",
    model: "model",
    maxOutputTokens
  });
  (cleaner as any).client = {
    chat: { completions: { create: async () => ({
      choices: [{ finish_reason: "length", message: { content: "{\"title\":" } }]
    }) } }
  };
  return cleaner;
}
```

```ts
test("automatic truncation points to the model or gateway limit", async () => {
  const cleaner = cleanerReturningFinishReasonLength();
  await assert.rejects(
    cleaner.clean(cleanInput()),
    /达到模型或中转服务的输出上限/
  );
});

test("custom truncation reports the configured limit", async () => {
  const cleaner = cleanerReturningFinishReasonLength(8192);
  await assert.rejects(
    cleaner.clean(cleanInput()),
    /当前设置的 8192 Tokens 上限/
  );
});
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
node --import tsx --test src/lib/ai-cleaner.test.ts
```

Expected: the automatic washing request still contains `2400`, custom mode is ignored, and truncation messages do not identify the limit source.

- [ ] **Step 4: Implement the request policy**

Extend the options and cleaner state:

```ts
export interface OpenAiScriptCleanerOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  thinkingMode?: "enabled" | "disabled";
  provider?: AiProvider;
  maxOutputTokens?: number;
}

private readonly maxOutputTokens?: number;
```

Assign `options.maxOutputTokens` in the constructor. Replace the wash call's hard-coded `2400` and the storyboard call's `undefined` with `this.maxOutputTokens`.

Add a single truncation helper used by streaming and non-streaming responses:

```ts
private outputLimitError() {
  return this.maxOutputTokens === undefined
    ? new Error("AI 输出达到模型或中转服务的输出上限，请在设置中尝试自定义更高上限，并确认服务商支持该值。")
    : new Error(`AI 输出达到当前设置的 ${this.maxOutputTokens} Tokens 上限，请在设置中提高上限或改为自动。`);
}
```

- [ ] **Step 5: Run the focused tests and verify success**

Run:

```bash
node --import tsx --test src/lib/ai-cleaner.test.ts
```

Expected: all AI cleaner tests pass.

- [ ] **Step 6: Commit the request-policy change**

```bash
git add src/lib/ai-cleaner.ts src/lib/ai-cleaner.test.ts
git commit -m "fix: make creative AI output limits configurable"
```

---

### Task 2: Persist and resolve the limit in Electron

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/utils/ai-config.ts`
- Modify: `electron/utils/ai-config.test.ts`
- Modify: `electron/handlers/config-handler.ts`
- Modify: `electron/server.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: optional `AIKeyConfig.maxOutputTokens` from Electron configuration.
- Produces: `AiRuntimeConfig.maxOutputTokens?: number` and dynamically resolved `OpenAiScriptCleanerOptions.maxOutputTokens?: number`; update changes accept `number | null` so `null` clears a custom value.

- [ ] **Step 1: Write failing validation and merge tests**

Add to `electron/utils/ai-config.test.ts`:

```ts
test("normalizeMaxOutputTokens keeps valid custom values", () => {
  assert.equal(normalizeMaxOutputTokens(8192), 8192);
});

test("normalizeMaxOutputTokens treats an empty value as automatic", () => {
  assert.equal(normalizeMaxOutputTokens(undefined), undefined);
});

test("normalizeMaxOutputTokens rejects invalid custom values", () => {
  assert.throws(() => normalizeMaxOutputTokens(255), /至少为 256/);
  assert.throws(() => normalizeMaxOutputTokens(1024.5), /整数/);
});

test("mergeAiKeyChanges clears a previous custom limit", () => {
  const merged = mergeAiKeyChanges({
    name: "DeepSeek",
    provider: "deepseek",
    apiKey: "secret",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    maxOutputTokens: 8192
  }, {
    name: "DeepSeek",
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    maxOutputTokens: null
  });
  assert.equal(merged.maxOutputTokens, undefined);
});
```

- [ ] **Step 2: Run the Electron utility test and verify failure**

Run:

```bash
node --import tsx --test electron/utils/ai-config.test.ts
```

Expected: `normalizeMaxOutputTokens` and the new field do not exist.

- [ ] **Step 3: Add Electron configuration types and validation**

Update `EditableAiKey`, `AIKeyConfig` and add inputs with:

```ts
maxOutputTokens?: number;
```

Define the edit payload separately so it can explicitly clear a persisted value:

```ts
export type EditableAiKeyChanges = Omit<EditableAiKey, "apiKey" | "maxOutputTokens"> & {
  apiKey?: string;
  maxOutputTokens?: number | null;
};
```

Add:

```ts
export function normalizeMaxOutputTokens(value?: number) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error("输出 Token 上限必须为整数");
  if (value < 256) throw new Error("输出 Token 上限至少为 256");
  return value;
}
```

Call it from `mergeAiKeyChanges()` and `normalizeAiKey()` so both add and edit paths enforce the rule. In `mergeAiKeyChanges()`, map `null` to `undefined`; preserve the existing blank-secret behavior.

- [ ] **Step 4: Propagate the value through the dynamic runtime resolver**

Extend `AiRuntimeConfig` in `src/app.ts`:

```ts
export interface AiRuntimeConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
  maxOutputTokens?: number;
}
```

Pass `maxOutputTokens` through `staticCleanerOptions`, `RuntimeScriptCleaner`, and Electron's `resolveAiConfig()` result. The dynamic resolver must read the value from the latest config on every step.

- [ ] **Step 5: Run focused tests and type checks**

Run:

```bash
node --import tsx --test electron/utils/ai-config.test.ts src/lib/ai-cleaner.test.ts
npm run check:backend
npm run build:electron
```

Expected: tests pass and both TypeScript projects compile.

- [ ] **Step 6: Commit the Electron configuration path**

```bash
git add electron/preload.ts electron/utils/ai-config.ts electron/utils/ai-config.test.ts electron/handlers/config-handler.ts electron/server.ts src/app.ts
git commit -m "feat: persist AI output limits per model"
```

---

### Task 3: Keep standalone HTTP configuration behavior aligned

**Files:**
- Modify: `src/lib/config-server.ts`
- Create: `src/lib/config-server.test.ts`

**Interfaces:**
- Consumes: HTTP AI key payload field `maxOutputTokens?: number`.
- Produces: persisted, validated `AIKeyConfig.maxOutputTokens?: number` with the same semantics as Electron; HTTP PUT accepts `null` to clear the field.

- [ ] **Step 1: Write failing route tests**

Export the pure normalization boundary and test it directly without touching the user's real configuration file:

```ts
test("normalizeMaxOutputTokens accepts automatic and custom modes", () => {
  assert.equal(normalizeMaxOutputTokens(undefined), undefined);
  assert.equal(normalizeMaxOutputTokens(16384), 16384);
});

test("normalizeMaxOutputTokens rejects invalid HTTP configuration", () => {
  assert.throws(() => normalizeMaxOutputTokens(0), /至少为 256/);
  assert.throws(() => normalizeMaxOutputTokens(512.25), /整数/);
});

test("resolveUpdatedMaxOutputTokens distinguishes omitted and cleared values", () => {
  assert.equal(resolveUpdatedMaxOutputTokens(8192, {}), 8192);
  assert.equal(resolveUpdatedMaxOutputTokens(8192, { maxOutputTokens: null }), undefined);
  assert.equal(resolveUpdatedMaxOutputTokens(undefined, { maxOutputTokens: 16384 }), 16384);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test src/lib/config-server.test.ts
```

Expected: the new type and normalization export do not exist.

- [ ] **Step 3: Implement the standalone configuration field**

Add `maxOutputTokens?: number` to `AIKeyConfig` and make `normalizeMaxOutputTokens()` enforce the same integer/minimum rules. Add a pure update resolver used by PUT:

```ts
export function resolveUpdatedMaxOutputTokens(
  existing: number | undefined,
  changes: { maxOutputTokens?: number | null }
) {
  if (!Object.prototype.hasOwnProperty.call(changes, "maxOutputTokens")) return existing;
  return normalizeMaxOutputTokens(changes.maxOutputTokens ?? undefined);
}
```

Normalize the field in both POST and PUT paths:

```ts
const normalizedLimit = normalizeMaxOutputTokens(keyInput.maxOutputTokens);
const newKey: AIKeyConfig = {
  ...keyInput,
  ...(normalizedLimit === undefined ? {} : { maxOutputTokens: normalizedLimit }),
  baseURL: normalizeBaseURL(keyInput.baseURL) || defaultBaseURL(keyInput.provider),
  id,
  isActive: config.aiKeys.length === 0,
  isValid: true,
  lastTested: result.testedAt
};
```

When PUT receives `maxOutputTokens: null`, remove the previous field. When the property is absent, retain the existing value. This distinction must use `Object.prototype.hasOwnProperty.call(changes, "maxOutputTokens")`. Do not change the connection-test request.

- [ ] **Step 4: Run standalone tests and backend checks**

Run:

```bash
node --import tsx --test src/lib/config-server.test.ts
npm run check:backend
```

Expected: tests and backend type checking pass.

- [ ] **Step 5: Commit the standalone path**

```bash
git add src/lib/config-server.ts src/lib/config-server.test.ts
git commit -m "feat: support AI output limits in HTTP config"
```

---

### Task 4: Add automatic/custom controls to Settings

**Files:**
- Create: `renderer/src/utils/ai-output-limit.ts`
- Create: `renderer/src/utils/ai-output-limit.test.ts`
- Modify: `renderer/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `AIKeyConfig.maxOutputTokens?: number`.
- Produces: `AIKeyForm.maxOutputMode: "automatic" | "custom"`, `AIKeyForm.maxOutputTokens: string`, add payload `maxOutputTokens?: number`, and edit payload `maxOutputTokens: number | null`.

- [ ] **Step 1: Write failing form conversion tests**

Create `renderer/src/utils/ai-output-limit.test.ts`:

```ts
test("missing values map to automatic mode", () => {
  assert.deepEqual(toOutputLimitForm(undefined), {
    mode: "automatic",
    value: "8192"
  });
});

test("custom values round-trip to the API payload", () => {
  assert.deepEqual(toOutputLimitForm(16384), {
    mode: "custom",
    value: "16384"
  });
  assert.equal(parseOutputLimit("custom", "16384"), 16384);
});

test("automatic mode clears a previous value", () => {
  assert.equal(parseOutputLimit("automatic", "16384"), undefined);
});

test("invalid custom form values return a readable error", () => {
  assert.throws(() => parseOutputLimit("custom", ""), /请输入/);
  assert.throws(() => parseOutputLimit("custom", "255"), /至少为 256/);
  assert.throws(() => parseOutputLimit("custom", "1024.5"), /整数/);
});
```

- [ ] **Step 2: Run the utility test and verify failure**

Run:

```bash
node --import tsx --test renderer/src/utils/ai-output-limit.test.ts
```

Expected: the utility module does not exist.

- [ ] **Step 3: Implement the form conversion utility**

Create:

```ts
export type OutputLimitMode = "automatic" | "custom";

export function toOutputLimitForm(maxOutputTokens?: number) {
  return maxOutputTokens === undefined
    ? { mode: "automatic" as const, value: "8192" }
    : { mode: "custom" as const, value: String(maxOutputTokens) };
}

export function parseOutputLimit(mode: OutputLimitMode, value: string) {
  if (mode === "automatic") return undefined;
  if (!value.trim()) throw new Error("请输入输出 Token 上限");
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("输出 Token 上限必须为整数");
  if (parsed < 256) throw new Error("输出 Token 上限至少为 256");
  return parsed;
}
```

- [ ] **Step 4: Integrate the setting into add/edit/save flows**

Extend local Settings types:

```ts
interface AIKeyConfig {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  isActive: boolean;
  isValid?: boolean;
  lastTested?: string;
  maxOutputTokens?: number;
}

type AIKeyForm = {
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  maxOutputMode: OutputLimitMode;
  maxOutputTokens: string;
};
```

New forms default to `{ maxOutputMode: "automatic", maxOutputTokens: "8192" }`. Editing uses `toOutputLimitForm(key.maxOutputTokens)`. Before test/add/update, call `parseOutputLimit()` and show validation failures in the existing `ResultBanner`. Add/test payloads omit an automatic value; update payloads convert the automatic result to `maxOutputTokens: null` so both IPC and JSON transport can clear an old value.

- [ ] **Step 5: Add the segmented control and numeric input**

After the model field, render a two-option segmented control using text buttons:

```tsx
<FormField label="创作输出 Token 上限">
  <div className="inline-flex rounded-lg border border-tech-border bg-tech-bg p-1">
    {(["automatic", "custom"] as const).map((mode) => (
      <button
        key={mode}
        type="button"
        onClick={() => setNewKey({ ...newKey, maxOutputMode: mode })}
        className={mode === newKey.maxOutputMode ? activeModeClass : inactiveModeClass}
      >
        {mode === "automatic" ? "自动" : "自定义"}
      </button>
    ))}
  </div>
  {newKey.maxOutputMode === "custom" && (
    <input
      type="number"
      min={256}
      step={1}
      value={newKey.maxOutputTokens}
      onChange={(event) => setNewKey({ ...newKey, maxOutputTokens: event.target.value })}
      className={inputClassName}
    />
  )}
  <p className="mt-2 text-xs leading-5 text-tech-muted">
    仅用于 AI 洗稿和生成分镜。自动模式不由应用限制；自定义值最终仍受模型和中转服务限制。
  </p>
</FormField>
```

Display `输出上限：自动` or a locale-formatted custom value on each saved configuration card.

- [ ] **Step 6: Run frontend tests and build**

Run:

```bash
node --import tsx --test renderer/src/utils/ai-output-limit.test.ts
npm run check:renderer
npm run build:renderer
```

Expected: utility tests pass, TypeScript has no errors, and Vite builds successfully.

- [ ] **Step 7: Commit the Settings UI**

```bash
git add renderer/src/utils/ai-output-limit.ts renderer/src/utils/ai-output-limit.test.ts renderer/src/pages/SettingsPage.tsx
git commit -m "feat: let users configure AI output limits"
```

---

### Task 5: Verify cross-runtime behavior and finish

**Files:**
- Modify only if verification exposes a defect in files from Tasks 1-4.

**Interfaces:**
- Consumes: completed configurable output-limit implementation.
- Produces: verified Electron and standalone builds with no unrelated files included.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
npm run check
npm test
npm run build:backend
npm run build:renderer
npm run build:electron
```

Expected: all commands exit successfully.

- [ ] **Step 2: Inspect request and configuration invariants**

Run:

```bash
rg -n "max_tokens: 2400|maxOutputTokens|max_tokens" src electron renderer/src
```

Expected:

- AI washing contains no hard-coded `2400`.
- Connection tests still contain `max_tokens: 5`.
- `maxOutputTokens` reaches Electron resolver, `AiRuntimeConfig`, cleaner options, standalone config and Settings.
- Skills and publishing calls retain their existing independent budgets.

- [ ] **Step 3: Manually verify the running application**

In Settings:

1. Edit the current AI configuration and confirm old configurations show `自动`.
2. Save automatic mode and run AI washing; confirm the request no longer reports the application 2400 Token limit.
3. Save custom `8192`, retry AI washing, and confirm it begins without restarting.
4. Reopen Settings and confirm `8192` is preserved.
5. Enter `255` and confirm the form blocks saving with the minimum-value message.
6. Switch back to automatic and confirm the saved card reads `输出上限：自动`.

- [ ] **Step 4: Review the final diff and repository status**

Run:

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors; only the pre-existing untracked `.superpowers/` directory may remain outside commits.

- [ ] **Step 5: Handle verification findings within their owning task**

If verification exposes a defect, return to the task that owns the affected behavior, add a regression test there, implement the smallest correction, rerun that task's focused command, and commit the exact files named by that task. If no defect is found, do not create an empty commit.
