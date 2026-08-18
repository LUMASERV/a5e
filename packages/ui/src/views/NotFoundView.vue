<template>
  <div style="display: flex; align-items: center; justify-content: center; height: 100vh">
    <el-result icon="warning" title="404" sub-title="Page not found">
      <template #extra>
        <el-button type="primary" @click="$router.push('/')">Go home</el-button>
      </template>
    </el-result>
  </div>
</template>
