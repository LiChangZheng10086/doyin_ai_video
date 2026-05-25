<template>
  <div id="app-root">
    <el-container style="min-height: 100vh;">
      <el-header style="padding: 0 20px; background: #1a1a2e; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <h1 style="color: #fff; font-size: 18px; margin: 0;">🎬 AI 视频二创工具</h1>
        </div>
        <el-menu mode="horizontal" :ellipsis="false" router style="border: none; background: transparent;"
          active-text-color="#409eff">
          <el-menu-item index="/" style="color: #fff;">新建任务</el-menu-item>
          <el-menu-item index="/history" style="color: #fff;">历史记录</el-menu-item>
        </el-menu>
      </el-header>
      <el-main style="background: #f5f7fa; padding: 20px;">
        <router-view />
      </el-main>
    </el-container>
  </div>
</template>

<script setup lang="ts">
</script>
