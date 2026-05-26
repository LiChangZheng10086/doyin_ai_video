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
  ppt_template: string | null
  video_path: string | null
  audio_path_output: string | null
  video_path_output: string | null
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

/** Build a download URL for a server-side file path. */
export function fileUrl(filePath: string | null | undefined): string {
  if (!filePath) return ''
  const filename = filePath.split('/').pop() || filePath.split('\\').pop() || ''
  return `/api/files/${encodeURIComponent(filename)}`
}

export default {
  createTask(data: {
    text_input?: string
    ppt_template?: string
    upload_only?: boolean
  }): Promise<Task> {
    return api.post('/tasks', data).then(r => r.data)
  },

  listTasks(page = 1, size = 20): Promise<TaskList> {
    return api.get('/tasks', { params: { page, size } }).then(r => r.data)
  },

  getTask(taskId: string): Promise<Task> {
    return api.get(`/tasks/${taskId}`).then(r => r.data)
  },

  startTask(taskId: string): Promise<any> {
    return api.post(`/tasks/${taskId}/start`).then(r => r.data)
  },

  confirmClean(taskId: string, cleanedText: string): Promise<Task> {
    return api.post('/tasks/confirm_clean', { task_id: taskId, cleaned_text: cleanedText }).then(r => r.data)
  },

  rejectClean(taskId: string): Promise<Task> {
    return api.post('/tasks/reject_clean', { task_id: taskId }).then(r => r.data)
  },

  confirmContent(taskId: string, slideContent: SlideContent[], speechText: string): Promise<Task> {
    return api.post('/tasks/confirm_content', {
      task_id: taskId,
      slide_content: slideContent,
      speech_text: speechText,
    }).then(r => r.data)
  },

  selectTemplate(taskId: string, template: string): Promise<Task> {
    return api.post('/tasks/select_template', { task_id: taskId, ppt_template: template }).then(r => r.data)
  },

  retryTask(taskId: string): Promise<any> {
    return api.post(`/tasks/${taskId}/retry`).then(r => r.data)
  },

  listTemplates(): Promise<{ templates: any[] }> {
    return api.get('/templates').then(r => r.data)
  },

  uploadVideo(taskId: string, file: File): Promise<any> {
    const form = new FormData()
    form.append('file', file)
    return api.post(`/tasks/upload_video/${taskId}`, form).then(r => r.data)
  },

  health(): Promise<any> {
    return api.get('/health').then(r => r.data)
  },
}
