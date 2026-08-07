export interface SkillProgressEvent {
  stage?: string;
  message?: string;
  progress?: number;
  total?: number;
  current?: number;
  itemLabel?: string;
  itemId?: string;
  generates?: Record<string, boolean>;
  templates?: Array<{ name: string; topic: string }>;
  totalTasks?: number;
  success?: boolean;
  skillName?: string;
  skillPath?: string;
  generated?: string[];
  allGenerated?: string[];
  skillType?: string;
  error?: string;
}

export function parseSkillProgressLine(line: string): SkillProgressEvent | null {
  if (!line.trim()) return null;

  let event: SkillProgressEvent;
  try {
    event = JSON.parse(line) as SkillProgressEvent;
  } catch {
    return null;
  }

  if (event.error) {
    throw new Error(event.error);
  }
  return event;
}
