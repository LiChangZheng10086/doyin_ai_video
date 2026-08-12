import assert from "node:assert/strict";
import { test } from "node:test";
import { JobStepEventHub } from "./job-step-events.js";

test("JobStepEventHub publishes ordered events and replays only events after the cursor", () => {
  const hub = new JobStepEventHub();
  const live: number[] = [];
  const unsubscribe = hub.subscribe("job-1", "clean", (event) => live.push(event.id));

  const started = hub.publish("job-1", "clean", { type: "started", model: "deepseek-chat" });
  const preview = hub.publish("job-1", "clean", { type: "preview", delta: "你", text: "你", model: "deepseek-chat" });
  unsubscribe();
  hub.publish("job-1", "clean", { type: "preview", delta: "好", text: "你好", model: "deepseek-chat" });

  const replayed: Array<{ id: number; text?: string }> = [];
  hub.subscribe("job-1", "clean", (event) => replayed.push({ id: event.id, text: event.text }), preview.id);

  assert.deepEqual(live, [started.id, preview.id]);
  assert.deepEqual(replayed, [{ id: 3, text: "你好" }]);
});

test("JobStepEventHub bounds history and resets stale previews for a new run", () => {
  const hub = new JobStepEventHub(3);
  hub.publish("job-1", "generate_video_prompts", { type: "started" });
  hub.publish("job-1", "generate_video_prompts", { type: "preview", delta: "1", text: "1" });
  hub.publish("job-1", "generate_video_prompts", { type: "preview", delta: "2", text: "12" });
  hub.publish("job-1", "generate_video_prompts", { type: "preview", delta: "3", text: "123" });

  const bounded: number[] = [];
  hub.subscribe("job-1", "generate_video_prompts", (event) => bounded.push(event.id));
  assert.deepEqual(bounded, [2, 3, 4]);

  const nextRun = hub.publish("job-1", "generate_video_prompts", { type: "started" });
  const reset: Array<{ id: number; text?: string }> = [];
  hub.subscribe("job-1", "generate_video_prompts", (event) => reset.push({ id: event.id, text: event.text }));

  assert.equal(nextRun.id, 1);
  assert.deepEqual(reset, [{ id: 1, text: undefined }]);
});

test("JobStepEventHub isolates a broken subscriber from the running AI step", () => {
  const hub = new JobStepEventHub();
  const received: string[] = [];
  hub.subscribe("job-1", "clean", () => { throw new Error("browser disconnected"); });
  hub.subscribe("job-1", "clean", (event) => received.push(event.type));

  assert.doesNotThrow(() => hub.publish("job-1", "clean", { type: "preview", text: "内容" }));
  assert.deepEqual(received, ["preview"]);
});
