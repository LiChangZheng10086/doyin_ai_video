import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

export interface Task {
  id: string
  title: string | null
  douyin_url: string | null
  status: string
  current_step: number
  raw_text: string | null
  cleaned_text: string | null
  slide_outline: any[] | null
  slide_content: any[] | null
  speech_text: string | null
  ppt_path: string | null
  error_message: string | null
  created_at: string
}

export interface TaskList {
  tasks: Task[]
  total: number
}

export interface SlideContent {
  title: string
  content: string
  notes: string
}

export default {
  // 创建任务：直接粘贴抖音分享文本或纯文案
  createTask(data: { text_input: string; ppt_template?: string }): Promise<Task> {
    return api.post('/tasks', data).then(r => r.data)
  },

  // 任务列表
  listTasks(page = 1, size = 20): Promise<TaskList> {
    return api.get('/tasks', { params: { page, size } }).then(r => r.data)
  },

  // 任务详情
  getTask(taskId: string): Promise<Task> {
    return api.get(`/tasks/${taskId}`).then(r => r.data)
  },

  // 开始任务
  startTask(taskId: string): Promise<any> {
    return api.post(`/tasks/${taskId}/start`).then(r => r.data)
  },

  // 确认清洗结果
  confirmClean(taskId: string, cleanedText: string): Promise<Task> {
    return api.post('/tasks/confirm_clean', { task_id: taskId, cleaned_text: cleanedText }).then(r => r.data)
  },

  // 确认内容
  confirmContent(taskId: string, slideContent: SlideContent[], speechText: string): Promise<Task> {
    return api.post('/tasks/confirm_content', {
      task_id: taskId,
      slide_content: slideContent,
      speech_text: speechText,
    }).then(r => r.data)
  },

  // 选择模板
  selectTemplate(taskId: string, template: string): Promise<Task> {
    return api.post('/tasks/select_template', { task_id: taskId, ppt_template: template }).then(r => r.data)
  },

  // 重试任务
  retryTask(taskId: string): Promise<any> {
    return api.post(`/tasks/${taskId}/retry`).then(r => r.data)
  },

  // 获取模板列表
  listTemplates(): Promise<{ templates: any[] }> {
    return api.get('/templates').then(r => r.data)
  },

  // 上传视频
  uploadVideo(taskId: string, file: File): Promise<any> {
    const form = new FormData()
    form.append('file', file)
    return api.post(`/tasks/upload_video/${taskId}`, form).then(r => r.data)
  },

  // 健康检查
  health(): Promise<any> {
    return api.get('/health').then(r => r.data)
  },
}
