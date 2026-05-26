import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { type Task, type SlideContent } from '@/api'

export const useTaskStore = defineStore('task', () => {
  const currentTask = ref<Task | null>(null)
  const taskList = ref<Task[]>([])
  const loading = ref(false)

  // SSE streaming state
  const streamingCleanerText = ref('')
  const streamingWriterText = ref('')

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let eventSource: EventSource | null = null

  // --- SSE ---

  function connectEvents(taskId: string) {
    disconnectEvents()

    streamingCleanerText.value = ''
    streamingWriterText.value = ''

    const es = new EventSource(`/api/tasks/${taskId}/events`)
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'agent_token') {
          if (data.agent === 'cleaner') {
            streamingCleanerText.value += data.content
          } else if (data.agent === 'writer') {
            streamingWriterText.value += data.content
          }
        } else if (data.type === 'agent_done') {
          if (data.agent === 'cleaner') {
            streamingCleanerText.value = ''
          } else if (data.agent === 'writer') {
            streamingWriterText.value = ''
          }
        } else if (data.type === 'stage_change' && data.status) {
          if (currentTask.value && currentTask.value.id === taskId) {
            currentTask.value = {
              ...currentTask.value,
              status: data.status,
              current_step: data.current_step ?? currentTask.value.current_step,
            }
          }
        } else if (data.type === 'error' && data.message) {
          if (currentTask.value && currentTask.value.id === taskId) {
            currentTask.value = {
              ...currentTask.value,
              status: 'failed',
              error_message: data.message,
            }
          }
        }
      } catch { /* ignore parse errors */ }
    }
    es.onerror = () => {
      es.close()
      eventSource = null
    }
    eventSource = es
  }

  function disconnectEvents() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  }

  // --- Polling ---

  function startPolling(taskId: string) {
    stopPolling()
    pollTimer = setInterval(async () => {
      try {
        const task = await api.getTask(taskId)
        currentTask.value = task
        if (task.status === 'completed' || task.status === 'failed') {
          stopPolling()
          disconnectEvents()
        }
      } catch { /* ignore */ }
    }, 2000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function fetchTasks(page = 1, size = 20) {
    loading.value = true
    try {
      const res = await api.listTasks(page, size)
      taskList.value = res.tasks
    } finally {
      loading.value = false
    }
  }

  async function fetchTask(id: string) {
    currentTask.value = await api.getTask(id)
  }

  async function createTask(data: {
    text_input?: string
    ppt_template?: string
    upload_only?: boolean
  }) {
    const task = await api.createTask(data)
    currentTask.value = task
    if (task.id) {
      connectEvents(task.id)
      startPolling(task.id)
    }
    return task
  }

  async function confirmClean(taskId: string, cleanedText: string) {
    streamingCleanerText.value = ''
    currentTask.value = await api.confirmClean(taskId, cleanedText)
    connectEvents(taskId)
    startPolling(taskId)
  }

  async function confirmContent(taskId: string, slides: SlideContent[], speech: string) {
    streamingWriterText.value = ''
    currentTask.value = await api.confirmContent(taskId, slides, speech)
    startPolling(taskId)
  }

  async function rejectClean(taskId: string) {
    streamingCleanerText.value = ''
    currentTask.value = await api.rejectClean(taskId)
    connectEvents(taskId)
    startPolling(taskId)
  }

  function statusText(status: string): string {
    const map: Record<string, string> = {
      waiting: '等待处理',
      downloading: '下载视频',
      transcribing: '转录文案',
      cleaning: 'AI 清洗',
      confirm_1: '等待确认清洗结果',
      writing: '生成内容',
      confirm_2: '等待确认内容',
      generating: '生成 PPT',
      generating_video: '生成视频',
      completed: '已完成',
      failed: '处理失败',
    }
    return map[status] || status
  }

  function statusPercent(status: string): number {
    const map: Record<string, number> = {
      waiting: 0,
      downloading: 10,
      transcribing: 25,
      cleaning: 40,
      confirm_1: 50,
      writing: 60,
      confirm_2: 75,
      generating: 85,
      generating_video: 92,
      completed: 100,
      failed: 100,
    }
    return map[status] || 0
  }

  return {
    currentTask,
    taskList,
    loading,
    streamingCleanerText,
    streamingWriterText,
    fetchTasks,
    fetchTask,
    createTask,
    confirmClean,
    confirmContent,
    rejectClean,
    connectEvents,
    disconnectEvents,
    statusText,
    statusPercent,
    stopPolling,
    startPolling,
  }
})
