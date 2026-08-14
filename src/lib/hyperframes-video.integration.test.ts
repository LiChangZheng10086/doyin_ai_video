import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HyperframesVideoGenerator } from "./hyperframes-video.js";
import type { ScriptAsset, ShotLayout, ShotType } from "../types.js";

const runIntegration = process.env.RUN_HYPERFRAMES_INTEGRATION === "1";

test("real HyperFrames validates snapshots and renders the Shot V2 composition", { skip: !runIntegration, timeout: 1_100_000 }, async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hyperframes-real-"));
  const layouts: ShotLayout[] = [
    "kinetic-title", "comparison", "concept-map", "process-flow",
    "metric", "concept-map", "summary-stack", "kinetic-title"
  ];
  const types: ShotType[] = ["hook", "problem", "explain", "process", "proof", "explain", "summary", "cta"];
  const durations = [6, 7, 7, 7, 7, 6, 6, 6];
  const script: ScriptAsset = {
    sourceUrl: "https://example.com/video",
    topic: "六步建立内容系统",
    rawText: "建立目标，拆分流程，定义素材，组织表达，验证质量，形成复盘。",
    cleanScript: "先建立目标，再拆分流程，然后定义素材并组织表达，最后验证质量形成复盘。",
    shortVideoScript: "先用明确目标锁定内容方向，再把任务拆成可以执行的流程。每一步都要定义输入素材和输出标准，通过概念关系组织表达，用检查指标验证质量，最后把结果沉淀成下一次可复用的方法。",
    voiceoverScript: "先建立目标，再拆分流程，然后验证结果。",
    coverTitle: "六步建立内容系统",
    tags: ["内容系统"],
    summary: "从目标到复盘建立稳定内容流程。",
    keyPoints: ["明确目标", "拆分流程", "定义素材", "组织表达", "验证质量", "复盘方法"],
    sceneList: [],
    status: "ready",
    planVersion: 2,
    targetDuration: 60,
    shortVideoShots: layouts.map((layout, index) => ({
      index: index + 1,
      duration: durations[index],
      shotType: types[index],
      layout,
      headline: ["别急着开始", "没有目标会怎样", "先看清关系", "把流程逐步建立", "验证是否达标", "让表达更清楚", "六步收束成系统", "从下一条开始"][index],
      supportingText: "每个镜头只表达一个关键结论",
      captionLines: [["先确定方向", "再开始创作"], ["目标不清", "返工就会增加"], ["输入连接方法", "方法导向结果"], ["目标到素材", "再到验证"], ["标准逐项通过", "结果才算完成"], ["关系清晰", "内容更容易理解"], ["目标流程素材", "表达验证复盘"], ["用系统替代运气", "稳定完成内容"]][index],
      visualItems: [
        { label: ["目标", "混乱", "输入", "目标", "通过", "关系", "目标", "开始"][index], value: index === 4 ? "6/6" : undefined, tone: index === 1 ? "danger" : "primary" },
        { label: ["结果", "清晰", "方法", "素材", "检查", "层级", "验证", "持续"][index], tone: "success" },
        { label: ["行动", "稳定", "输出", "复盘", "完成", "结论", "复盘", "复用"][index], tone: "muted" }
      ],
      sourceKeyPoints: index < 6 ? [index] : [0, 5],
      subject: "内部视觉主体",
      action: "内部动作说明",
      cameraMotion: "内部镜头说明",
      visualLayers: [],
      caption: "观众字幕",
      emphasisWords: ["重点"],
      transition: ["flash", "push", "wipe", "zoom", "match-cut", "cut", "push", "flash"][index] as ScriptAsset["shortVideoShots"][number]["transition"],
      pacing: index === 0 ? "fast" : "medium",
      narration: "内部口播稿"
    }))
  };
  const generator = new HyperframesVideoGenerator({
    storageRoot,
    packageSpec: "hyperframes@0.7.108",
    ffprobeBinary: "ffprobe"
  });

  const result = await generator.generate(script, "integration");

  assert.equal(result.duration, 52);
  assert.ok((await stat(result.videoPath)).size > 0);
});
