/** Shared prose count for generation feedback and live editing; headings are excluded. */
export function articleLengthFeedback(draft: { sections: Array<{ paragraphs: string[] }> }, requirement = '') {
  const count = Array.from(draft.sections.flatMap(section => section.paragraphs).join('').replace(/\s/gu, '')).length;
  // Free-form requirements remain editorial instructions; never infer hard limits from unrelated numbers.
  const range = requirement.trim().match(/^(\d+)\s*字?\s*[-–—~～至到]\s*(\d+)\s*字?$/u);
  const min = Number(range?.[1]), max = Number(range?.[2]);
  const bounded = !!range && Number.isSafeInteger(min) && Number.isSafeInteger(max) && min > 0 && max >= min;
  const withinRange = bounded ? count >= min && count <= max : undefined;
  const message = `正文${count}字（含标点，不含空白、标题与小标题）` + (bounded
    ? `，要求${min}～${max}字${withinRange ? '，字数符合范围' : '，尚未达到字数范围'}`
    : requirement.trim() ? '；期望字数为自由描述，请人工核对。填写“1200～1600字”可自动检查范围' : '；未设置字数范围');
  return { count, withinRange, message };
}
