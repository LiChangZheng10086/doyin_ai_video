<template>
  <div style="max-width: 900px; margin: 0 auto;">
    <!-- 新建任务 -->
    <el-card shadow="never" style="margin-bottom: 20px;">
      <template #header>
        <span style="font-weight: 600;">新建任务</span>
      </template>

      <el-form label-position="top">
        <el-radio-group v-model="inputMode" style="margin-bottom: 16px;">
          <el-radio value="url">粘贴分享链接</el-radio>
          <el-radio value="upload">上传视频</el-radio>
          <el-radio value="text">纯文案模式</el-radio>
        </el-radio-group>

        <template v-if="inputMode === 'url'">
          <el-input v-model="textInput" type="textarea" :rows="4"
            placeholder="从抖音复制分享文本粘贴到这里，例如：&#10;4.12 a@A.gO iCH:/ 02/02 强烈推荐6个自用skill... https://v.douyin.com/xxxxx/ 复制此链接，打开Dou音搜索，直接观看视频！" />
          <div style="font-size: 12px; color: #909399; margin-top: 4px;">会自动提取链接和标题，不用手动清理</div>
        </template>

        <template v-if="inputMode === 'upload'">
          <el-upload
            drag
            :auto-upload="false"
            :on-change="handleFileChange"
            accept=".mp4,.mov,.avi,.mkv"
          >
            <el-icon style="font-size: 48px; color: #409eff;"><UploadFilled /></el-icon>
            <div style="margin-top: 8px;">拖拽或点击上传视频文件</div>
          </el-upload>
        </template>

        <template v-if="inputMode === 'text'">
          <el-input v-model="textInput" type="textarea" :rows="6"
            placeholder="直接粘贴视频文案内容，跳过下载和转录步骤" />
        </template>

        <div style="margin-top: 16px;">
          <el-button type="primary" size="large" @click="handleCreate" :loading="loading">
            🎯 开始处理
          </el-button>
        </div>
      </el-form>
    </el-card>

    <!-- 当前任务进度 -->
    <el-card v-if="store.currentTask" shadow="never" style="margin-bottom: 20px;">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 600;">当前任务</span>
          <el-tag :type="statusTagType(store.currentTask.status)">
            {{ store.statusText(store.currentTask.status) }}
          </el-tag>
        </div>
      </template>

      <div>
        <div v-if="store.currentTask.title" style="margin-bottom: 16px; color: #606266;">
          {{ store.currentTask.title }}
        </div>

        <!-- 进度条 -->
        <el-progress :percentage="store.statusPercent(store.currentTask.status)" :status="progressStatus" />

        <!-- 步骤列表 -->
        <div style="margin-top: 20px;">
          <div v-for="step in steps" :key="step.key" class="step-item"
            :class="{ active: step.key === currentStepKey, done: step.done }">
            <el-icon v-if="step.done" color="#67c23a"><CircleCheckFilled /></el-icon>
            <el-icon v-else-if="step.key === currentStepKey" color="#409eff" class="is-loading"><Loading /></el-icon>
            <el-icon v-else color="#c0c4cc"><Ongoing /></el-icon>
            <span style="margin-left: 8px;">{{ step.label }}</span>
          </div>
        </div>

        <!-- 转录文案面板 -->
        <el-collapse v-if="store.currentTask.raw_text" style="margin-top: 16px;">
          <el-collapse-item title="📝 转录文案" name="raw_text">
            <div style="white-space: pre-wrap; font-size: 13px; line-height: 1.6; color: #303133; max-height: 300px; overflow-y: auto;">
              {{ store.currentTask.raw_text }}
            </div>
          </el-collapse-item>
        </el-collapse>

        <!-- 流式 AI 清洗输出 -->
        <div v-if="showStreamingCleaner" style="margin-top: 16px;">
          <h4 style="margin-bottom: 8px;">🧹 AI 清洗中...</h4>
          <div style="background: #f5f7fa; border: 1px solid #e4e7ed; border-radius: 8px; padding: 16px; max-height: 300px; overflow-y: auto; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">
            {{ store.streamingCleanerText }}
            <span class="streaming-cursor">▊</span>
          </div>
        </div>

        <!-- 流式内容生成输出 -->
        <div v-if="showStreamingWriter" style="margin-top: 16px;">
          <h4 style="margin-bottom: 8px;">✍️ 正在生成 PPT 内容...</h4>
          <div style="background: #f5f7fa; border: 1px solid #e4e7ed; border-radius: 8px; padding: 16px; max-height: 300px; overflow-y: auto; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">
            {{ store.streamingWriterText }}
            <span class="streaming-cursor">▊</span>
          </div>
        </div>

        <!-- 确认节点 -->
        <el-divider v-if="showConfirmClean" />

        <div v-if="showConfirmClean" style="margin-top: 16px;">
          <h4>✏️ 确认清洗结果</h4>
          <el-input v-model="editCleanedText" type="textarea" :rows="8" style="margin-top: 8px;" />
          <div style="margin-top: 12px; display: flex; gap: 12px;">
            <el-button @click="handleRejectClean">↩ 退回修改</el-button>
            <el-button type="primary" @click="handleConfirmClean">✓ 确认，继续</el-button>
          </div>
        </div>

        <div v-if="showConfirmContent" style="margin-top: 16px;">
          <h4>✏️ 确认 PPT 内容</h4>
          <div v-for="(slide, idx) in editSlides" :key="idx" style="margin-bottom: 16px; padding: 12px; border: 1px solid #e4e7ed; border-radius: 8px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <strong>{{ slide.title }}</strong>
              <el-tag size="small">第 {{ idx + 1 }} 页</el-tag>
            </div>
            <el-input v-model="slide.content" type="textarea" :rows="4" />
          </div>
          <el-button type="primary" @click="handleConfirmContent">✓ 确认，生成 PPT</el-button>
        </div>

        <!-- 视频播放 -->
        <div v-if="store.currentTask.status === 'completed' && store.currentTask.video_path_output" style="margin-top: 20px;">
          <h4 style="margin-bottom: 8px;">🎬 生成视频</h4>
          <video
            :src="videoUrl"
            controls
            style="width: 100%; border-radius: 8px; background: #000;"
            preload="metadata"
          ></video>
        </div>

        <!-- 完成后下载 -->
        <div v-if="store.currentTask.status === 'completed'" style="margin-top: 20px;">
          <el-button type="success" @click="handleDownload">📥 下载全部</el-button>
        </div>

        <!-- 失败重试 -->
        <div v-if="store.currentTask.status === 'failed'" style="margin-top: 16px;">
          <el-alert :title="store.currentTask.error_message || '处理失败'" type="error" show-icon style="margin-bottom: 12px;" />
          <el-button @click="handleRetry">🔄 重试</el-button>
        </div>
      </div>
    </el-card>

    <!-- 上传后触发 -->
    <el-card v-if="showUploadVideo" shadow="never" style="margin-bottom: 20px;">
      <template #header><span style="font-weight: 600;">上传视频</span></template>
      <p>自动下载失败，请手动上传视频文件继续：</p>
      <el-upload
        :auto-upload="false"
        :on-change="handleManualUpload"
        accept=".mp4,.mov,.avi,.mkv"
      >
        <el-button type="primary">📤 选择视频文件</el-button>
      </el-upload>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { UploadFilled, CircleCheckFilled, Loading } from '@element-plus/icons-vue'
import { useTaskStore } from '@/stores/task'
import type { SlideContent } from '@/api'
import api from '@/api'

const store = useTaskStore()
const loading = ref(false)

const inputMode = ref<'url' | 'upload' | 'text'>('url')
const textInput = ref('')
const selectedFile = ref<File | null>(null)

// 编辑态
const editCleanedText = ref('')
const editSlides = ref<SlideContent[]>([])

const steps = computed(() => {
  const s = store.currentTask
  if (!s) return []
  return [
    { key: 'downloading', label: '📥 下载视频', done: s.status !== 'downloading' && s.current_step > 0 },
    { key: 'transcribing', label: '🎙️ 转录文案', done: s.current_step > 1 },
    { key: 'cleaning', label: '🧹 AI 清洗', done: s.current_step > 2 },
    { key: 'writing', label: '✍️ 生成内容', done: s.current_step > 4 },
    { key: 'generating', label: '📊 生成 PPT', done: s.current_step > 5 },
    { key: 'generating_video', label: '🎬 生成视频', done: s.current_step > 6 },
    { key: 'completed', label: '✅ 完成', done: s.status === 'completed' },
  ]
})

const currentStepKey = computed(() => {
  const s = store.currentTask
  if (!s) return ''
  if (s.current_step === 2 || s.status === 'confirm_1') return 'cleaning'
  if (s.current_step === 4 || s.status === 'confirm_2') return 'writing'
  return s.status
})

const showConfirmClean = computed(() => store.currentTask?.status === 'confirm_1')
const showConfirmContent = computed(() => store.currentTask?.status === 'confirm_2')
const showUploadVideo = computed(() => store.currentTask?.status === 'failed' && !store.currentTask?.video_path)

const showStreamingCleaner = computed(() =>
  store.currentTask?.status === 'cleaning' && store.streamingCleanerText.length > 0
)
const showStreamingWriter = computed(() =>
  store.currentTask?.status === 'writing' && store.streamingWriterText.length > 0
)

// 预填充编辑字段
watch(() => store.currentTask, (task) => {
  if (task?.cleaned_text && task.status === 'confirm_1') {
    editCleanedText.value = task.cleaned_text
  }
  if (task?.slide_content && task.status === 'confirm_2') {
    editSlides.value = JSON.parse(JSON.stringify(task.slide_content))
  }
}, { immediate: true })

const progressStatus = computed(() => {
  const s = store.currentTask?.status
  if (s === 'failed') return 'exception'
  if (s === 'completed') return 'success'
  return ''
})

function statusTagType(status: string) {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

const videoUrl = computed(() => {
  if (!store.currentTask?.video_path_output) return ''
  const filename = store.currentTask.video_path_output.split('/').pop()
  return `http://localhost:8000/api/files/${filename}`
})

function handleFileChange(file: any) {
  selectedFile.value = file.raw
}

async function handleCreate() {
  loading.value = true
  try {
    const task = await store.createTask({
      text_input: textInput.value,
      ppt_template: 'tech_blue',
    })

    // 上传模式
    if (inputMode.value === 'upload' && selectedFile.value) {
      await api.uploadVideo(task.id, selectedFile.value)
      // 刷新任务获取最新状态
      await store.fetchTask(task.id)
    }
  } finally {
    loading.value = false
  }
}

async function handleConfirmClean() {
  if (!store.currentTask) return
  await store.confirmClean(store.currentTask.id, editCleanedText.value)
}

function handleRejectClean() {
  // 退回让 AI 重新清洗
  if (!store.currentTask) return
  store.currentTask.status = 'cleaning'
  store.currentTask.current_step = 2
}

async function handleConfirmContent() {
  if (!store.currentTask) return
  await store.confirmContent(store.currentTask.id, editSlides.value, store.currentTask.speech_text || '')
}

function handleDownload() {
  const task = store.currentTask
  if (!task) return

  // Download PPT
  if (task.ppt_path) {
    const a = document.createElement('a')
    a.href = `http://localhost:8000/api/files/${task.ppt_path.split('/').pop()}`
    a.download = ''
    a.click()
  }

  // Download audio
  if (task.audio_path_output) {
    const a = document.createElement('a')
    a.href = `http://localhost:8000/api/files/${task.audio_path_output.split('/').pop()}`
    a.download = ''
    a.click()
  }

  // Download video
  if (task.video_path_output) {
    const a = document.createElement('a')
    a.href = `http://localhost:8000/api/files/${task.video_path_output.split('/').pop()}`
    a.download = ''
    a.click()
  }
}

async function handleRetry() {
  if (!store.currentTask) return
  await api.retryTask(store.currentTask.id)
  await store.fetchTask(store.currentTask.id)
}

async function handleManualUpload(file: any) {
  if (!store.currentTask) return
  await api.uploadVideo(store.currentTask.id, file.raw)
  await store.fetchTask(store.currentTask.id)
}
</script>

<style scoped>
.step-item {
  display: flex;
  align-items: center;
  padding: 8px 0;
  color: #c0c4cc;
  font-size: 14px;
}
.step-item.active {
  color: #409eff;
  font-weight: 600;
}
.step-item.done {
  color: #67c23a;
}
.is-loading {
  animation: rotating 1.5s linear infinite;
}
.streaming-cursor {
  animation: blink 1s step-end infinite;
  color: #409eff;
}
@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes blink {
  50% { opacity: 0; }
}
</style>
