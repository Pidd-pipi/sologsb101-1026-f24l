<script setup lang="ts">
/**
 * StageTag：按酒精发酵 / 苹乳发酵 / 已出罐渲染底色与图标。
 * 同时兼容作业状态（计划 / 已完成）、苹乳状态（未启动 / 进行中 / 已完成）
 * 与发酵阶段（起酵 / 主发酵 / 后发酵 / 结束），被罐位看板、作业编排页、苹乳跟踪页消费。
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import {
  CircleCheck,
  Clock,
  Grape,
  Loading,
  Remove,
  Sunny,
  Timer
} from '@element-plus/icons-vue'

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info'

interface StageStyle {
  tone: Tone
  icon: Component
  color: string
}

const props = withDefaults(
  defineProps<{
    /** 状态文案，直接按文案映射配色 */
    value: string
    /** 尺寸 */
    size?: 'default' | 'small' | 'large'
    /** 是否显示图标 */
    showIcon?: boolean
  }>(),
  { size: 'default', showIcon: true }
)

const STYLES: Record<string, StageStyle> = {
  酒精发酵: { tone: 'warning', icon: Grape, color: '#c9863c' },
  苹乳发酵: { tone: 'primary', icon: Loading, color: '#8e6bbf' },
  已出罐: { tone: 'success', icon: CircleCheck, color: '#3f8f6b' },
  计划: { tone: 'info', icon: Clock, color: '#7a8b99' },
  已完成: { tone: 'success', icon: CircleCheck, color: '#3f8f6b' },
  未启动: { tone: 'info', icon: Remove, color: '#9aa5ad' },
  进行中: { tone: 'warning', icon: Timer, color: '#c9863c' },
  起酵: { tone: 'primary', icon: Grape, color: '#8e6bbf' },
  主发酵: { tone: 'warning', icon: Sunny, color: '#c9863c' },
  后发酵: { tone: 'success', icon: Timer, color: '#3f8f6b' },
  结束: { tone: 'info', icon: CircleCheck, color: '#7a8b99' },
  空闲: { tone: 'success', icon: CircleCheck, color: '#3f8f6b' },
  在用: { tone: 'warning', icon: Grape, color: '#c9863c' },
  清洗中: { tone: 'info', icon: Timer, color: '#7a8b99' }
}

const style = computed<StageStyle>(
  () => STYLES[props.value] ?? { tone: 'info', icon: Remove, color: '#9aa5ad' }
)
</script>

<template>
  <el-tag :type="style.tone" :size="size" effect="light" round class="stage-tag">
    <el-icon v-if="showIcon" class="stage-tag__icon"><component :is="style.icon" /></el-icon>
    <span>{{ value }}</span>
  </el-tag>
</template>

<style scoped>
.stage-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.stage-tag__icon {
  font-size: 13px;
}
</style>
