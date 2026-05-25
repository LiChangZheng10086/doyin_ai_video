<template>
  <div style="max-width: 900px; margin: 0 auto;">
    <el-card shadow="never">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 600;">历史记录</span>
          <el-button size="small" @click="refresh">🔄 刷新</el-button>
        </div>
      </template>

      <el-table :data="store.taskList" v-loading="store.loading" stripe style="width: 100%">
        <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)">{{ store.statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            {{ formatTime(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="viewTask(row.id)">查看</el-button>
            <el-button v-if="row.status === 'failed'" size="small" type="warning" @click="retryTask(row.id)">
              重试
            </el-button>
            <el-button v-if="row.status === 'completed'" size="small" type="success">
              下载
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="store.taskList.length === 0 && !store.loading" style="text-align: center; padding: 40px; color: #909399;">
        暂无任务记录，去创建一个吧 🎬
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTaskStore } from '@/stores/task'
import api from '@/api'

const store = useTaskStore()
const router = useRouter()

onMounted(() => {
  refresh()
})

function refresh() {
  store.fetchTasks()
}

function formatTime(t: string) {
  if (!t) return '-'
  const d = new Date(t)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function statusTag(status: string) {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

function viewTask(id: string) {
  router.push('/')
}

async function retryTask(id: string) {
  await api.retryTask(id)
  refresh()
}
</script>
