import type {
  CreatePublishingPackageInput,
  NoteImageSource,
  PublishingPreview,
  ToutiaoPublishOptions,
} from '../types';

/**
 * 创建头条文章包的纯逻辑：默认选项、即时校验、封面阻塞原因、请求体组装。
 *
 * 放在 utils 里而不是组件里，是因为这些是**用户可见行为** —— 标题下限、正文上限、
 * 「封面必填」、以及「没预览完就不许发请求」都必须能被断言守住，组件只负责渲染。
 *
 * 字数规则的**真源仍在服务端**（`TOUTIAO_ARTICLE_LIMITS`）：上限数字由预览接口下发，
 * 创建时服务端会按同一口径重新校验。
 */

/**
 * 作品声明的选项。**取值必须与头条发布页上的文案逐字一致** ——
 * 执行器是「按精确文案点击」来勾选声明项的，改一个字就点不上（会明确报错、不会静默跳过）。
 */
export const TOUTIAO_DECLARATIONS = [
  { value: '取材网络', label: '取材网络' },
  { value: '引用站内', label: '引用站内' },
  { value: '个人观点，仅供参考', label: '个人观点' },
  { value: '引用AI', label: '引用 AI' },
  { value: '虚构演绎，故事经历', label: '虚构演绎' },
  { value: '投资观点，仅供参考', label: '投资观点' },
  { value: '健康医疗分享，仅供参考', label: '健康医疗' },
] as const;

/** 发布选项的默认值：**微头条同步默认关闭**（平台默认勾选，不关就会多发一条内容）。 */
export function defaultToutiaoOptions(): ToutiaoPublishOptions {
  return { firstPublish: false, declarations: [], crossPostWeitoutiao: false };
}

/** 声明是**集合语义**：点一下加入、再点一下移除，顺序不影响结果。 */
export function toggleDeclaration(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
}

export interface ToutiaoArticleLimits {
  titleMin: number;
  titleMax: number;
  bodyChars: number;
}

/** 标题/正文的即时校验（服务端在创建时会按同一口径再校验一遍）。 */
export function toutiaoArticleFieldErrors(
  title: string,
  body: string,
  limits: ToutiaoArticleLimits,
): string[] {
  const errors: string[] = [];
  const titleLength = [...title.trim()].length;
  const bodyLength = [...body.trim()].length;

  if (titleLength === 0) errors.push('标题不能为空');
  else if (titleLength < limits.titleMin) errors.push(`标题至少 ${limits.titleMin} 字，当前 ${titleLength} 字`);
  else if (titleLength > limits.titleMax) errors.push(`标题当前 ${titleLength} 字，最多 ${limits.titleMax} 字`);

  if (bodyLength === 0) errors.push('正文不能为空');
  else if (bodyLength > limits.bodyChars) {
    errors.push(`正文当前 ${bodyLength} 字，最多 ${limits.bodyChars} 字`);
  }
  return errors;
}

export interface ToutiaoCoverBlockerInput {
  source: NoteImageSource;
  /** 该作品已生成的场景静帧数量。 */
  framesCount: number;
  /** 素材库里可选的图片总数。 */
  libraryCount: number;
  /** 素材库单选是否已选。 */
  hasSelection: boolean;
}

/**
 * 封面阻塞原因；`null` 表示已就绪。
 *
 * 与图文包的关键差别：**头条封面必填**，所以「静帧一张都没有」是**阻塞**，
 * 而图文包的静帧缺失只是降级（沿用既有口径）。
 */
export function getToutiaoCoverBlocker(input: ToutiaoCoverBlockerInput): string | null {
  if (input.source === 'frames') {
    return input.framesCount === 0
      ? '这个作品还没有场景静帧，无法作为头条封面：请先生成视频，或改用素材库选一张'
      : null;
  }
  if (input.libraryCount === 0) return '素材库里还没有图片，请先到「素材」页上传';
  if (!input.hasSelection) return '请选择一张素材库图片作为封面（头条封面必填，只支持单图）';
  return null;
}

export interface BuildToutiaoArticleInputArgs {
  sourceJobId: string;
  /** 交付包标题（作品标题），与文章标题是两回事。 */
  title: string;
  /** 最近一次预览；它携带创建时必须回传的 `previewRevision`。 */
  preview?: PublishingPreview;
  articleTitle: string;
  articleBody: string;
  options: ToutiaoPublishOptions;
  source: NoteImageSource;
  coverAssetId?: string;
}

/**
 * 组装创建请求。
 *
 * `previewRevision` 是服务端的硬约束（缺失 400 / 不一致 409），所以没有预览就直接抛错，
 * 而不是发出一个注定被拒的请求。文章文案**只走包级 `articleCopy`**：平台任务文案由服务端
 * 同步生成，避免两处各写一份后漂移。
 */
export function buildToutiaoArticleInput(
  args: BuildToutiaoArticleInputArgs,
): CreatePublishingPackageInput {
  const revision = args.preview?.previewRevision;
  if (!revision) throw new Error('文章预览尚未完成');

  const articleCopy = { title: args.articleTitle.trim(), body: args.articleBody.trim() };
  return {
    sourceJobId: args.sourceJobId,
    previewRevision: revision,
    title: args.title,
    contentType: 'article',
    articleCopy,
    toutiaoOptions: {
      firstPublish: args.options.firstPublish,
      declarations: [...args.options.declarations],
      crossPostWeitoutiao: args.options.crossPostWeitoutiao,
    },
    imageSource: args.source,
    // 静帧来源绝不能带素材 id（服务端会直接 400）
    ...(args.source === 'library' && args.coverAssetId ? { imageAssetIds: [args.coverAssetId] } : {}),
    platforms: [
      {
        platform: 'toutiao',
        copy: { title: articleCopy.title, description: articleCopy.body, hashtags: [] },
      },
    ],
  };
}
