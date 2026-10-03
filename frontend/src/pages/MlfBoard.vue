<script setup lang="ts">
/** /mlf 苹果酸乳酸发酵跟踪：录入苹果酸下降并判定结束、联动批次状态 */
import { computed, onMounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type MlfRow, type ParcelRow, type ReadingRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useMlfStore } from '@/stores/mlfStore'
import { MALIC_DONE_THRESHOLD, MALIC_START_G, MLF_STATES } from '@/types/mlf'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useMlfStore()

const { rows: mlfs, ready } = useIdbTable<MlfRow>(() => db.mlfs)
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: readings } = useIdbTable<ReadingRow>(() => db.readings)

const selects: FilterSelectConfig[] = [
  { key: 'states', label: '苹乳状态', options: MLF_STATES.map((item) => ({ label: item, value: item })) }
]

function batchOf(batchId: string): BatchRow | null {
  return batches.value.find((item) => item.id === batchId) ?? null
}

function batchLabel(batchId: string): string {
  const batch = batchOf(batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate}`
}

/** 该批次在苹乳期间的平均温度，用于判定苹乳是否具备条件 */
function avgTemp(batchId: string): string {
  const rows = readings.value.filter((row) => row.batchId === batchId)
  if (rows.length === 0) return '—'
  return `${(rows.reduce((sum, row) => sum + row.tempC, 0) / rows.length).toFixed(1)} ℃`
}

/** 批次尚未建立苹乳记录时的候选列表 */
const candidates = computed(() =>
  batches.value
    .filter((batch) => batch.state !== '已出罐' && !mlfs.value.some((mlf) => mlf.batchId === batch.id))
    .map((batch) => ({ batch, label: batchLabel(batch.id) }))
)

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return mlfs.value.filter((mlf) => {
    const label = `${batchLabel(mlf.batchId)} ${mlf.state}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (states.length > 0 && !states.includes(mlf.state)) return false
    return true
  })
})

const summary = computed(() => {
  const running = mlfs.value.filter((item) => item.state === '进行中').length
  const done = mlfs.value.filter((item) => item.state === '已完成').length
  const avgMalic =
    mlfs.value.length > 0
      ? Number((mlfs.value.reduce((sum, item) => sum + item.malicG, 0) / mlfs.value.length).toFixed(2))
      : 0
  return {
    total: mlfs.value.length,
    running,
    done,
    notStarted: mlfs.value.filter((item) => item.state === '未启动').length,
    avgMalic,
    doneRatio: mlfs.value.length > 0 ? Math.round((done / mlfs.value.length) * 100) : 0
  }
})

/* ------------------------------ 录入苹果酸 ------------------------------ */
const malicInputs = reactive<Record<string, number>>({})

function malicValueOf(mlf: MlfRow): number {
  if (malicInputs[mlf.id] === undefined) malicInputs[mlf.id] = mlf.malicG
  return malicInputs[mlf.id]
}

async function submitMalic(mlf: MlfRow): Promise<void> {
  const value = malicValueOf(mlf)
  if (Number.isNaN(value) || value < 0) {
    ElMessage.warning('请填写有效的苹果酸值（g/L）')
    return
  }
  const done = await store.recordMalic(mlf, value)
  ElMessage[done ? 'success' : 'info'](
    done ? `苹果酸已降至 ${value} g/L，判定苹乳结束并联动批次状态` : '苹果酸值已更新'
  )
}

async function start(mlf: MlfRow): Promise<void> {
  await store.startMlf(mlf.batchId, mlf)
  ElMessage.success('苹乳发酵已启动，批次状态置为「苹乳发酵」')
}

async function startForBatch(batchId: string): Promise<void> {
  await store.startMlf(batchId)
  ElMessage.success('苹乳发酵已启动')
}

async function finish(mlf: MlfRow): Promise<void> {
  await store.finishMlf(mlf)
  ElMessage.success('苹乳发酵已手动结束')
}

async function remove(mlf: MlfRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除苹乳记录会把批次状态退回「酒精发酵」，是否继续？', '删除确认', {
      type: 'warning'
    })
  } catch {
    return
  }
  await store.deleteMlf(mlf)
  ElMessage.success('苹乳记录已删除')
}

/** 存在在罐批次但还没有苹乳记录时，创建一条未启动记录 */
async function createPlaceholder(batchId: string): Promise<void> {
  const now = Date.now()
  await db.mlfs.put({
    id: `mlf-${now.toString(36)}`,
    batchId,
    startDate: '',
    endDate: '',
    malicG: MALIC_START_G,
    state: '未启动',
    revision: 1,
    createdAt: now,
    updatedAt: now
  })
  ElMessage.success('已建立苹乳跟踪记录')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">苹果酸乳酸发酵跟踪</h2>
        <p class="page__subtitle">
          苹果酸低于 {{ MALIC_DONE_THRESHOLD }} g/L 自动判定苹乳结束，并联动批次状态与后续作业。
        </p>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="苹乳记录" :value="summary.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="进行中" :value="summary.running" suffix="条" icon="Histogram" tone="warning" />
      <StatBadge label="已完成" :value="summary.done" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="未启动" :value="summary.notStarted" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="平均苹果酸" :value="summary.avgMalic" suffix="g/L" icon="TrendCharts" tone="danger" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索地块 / 苹乳状态…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card v-if="candidates.length > 0" shadow="never">
      <template #header>
        <div class="card-title">
          <span>待建苹乳跟踪的在罐批次（{{ candidates.length }}）</span>
          <span class="muted">酒精发酵结束后即可启动苹乳</span>
        </div>
      </template>
      <div class="candidate-row">
        <el-tag v-for="item in candidates" :key="item.batch.id" closable @close="createPlaceholder(item.batch.id)">
          {{ item.label }}
          <el-button link type="primary" size="small" @click="startForBatch(item.batch.id)">启动苹乳</el-button>
        </el-tag>
      </div>
    </el-card>

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="暂无苹乳记录"
      description="在罐批次酒精发酵结束后，启动苹果酸乳酸发酵并逐次录入苹果酸值。"
      :show-create="false"
    />

    <el-table v-else :data="filtered" stripe border>
      <el-table-column label="批次" min-width="200">
        <template #default="{ row }">
          <div>{{ batchLabel(row.batchId) }}</div>
          <div class="muted">平均温度 {{ avgTemp(row.batchId) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="批次状态" width="130">
        <template #default="{ row }">
          <StageTag :value="batchOf(row.batchId)?.state ?? '未知'" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="苹乳状态" width="120">
        <template #default="{ row }">
          <StageTag :value="row.state" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="进度" width="180">
        <template #default="{ row }">
          <el-progress :percentage="store.progressOf(row)" :stroke-width="8" />
        </template>
      </el-table-column>
      <el-table-column prop="startDate" label="启动日期" width="120">
        <template #default="{ row }">{{ row.startDate || '—' }}</template>
      </el-table-column>
      <el-table-column prop="endDate" label="结束日期" width="120">
        <template #default="{ row }">{{ row.endDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="苹果酸录入" width="230">
        <template #default="{ row }">
          <div class="malic-cell">
            <el-input-number
              :model-value="malicValueOf(row)"
              :min="0"
              :max="10"
              :step="0.1"
              :precision="2"
              size="small"
              @update:model-value="(value: number | undefined) => (malicInputs[row.id] = value ?? 0)"
            />
            <el-button size="small" type="primary" @click="submitMalic(row)">记一笔</el-button>
          </div>
          <div class="muted">当前 {{ row.malicG }} g/L</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '未启动'" link type="primary" size="small" @click="start(row)">启动</el-button>
          <el-button v-if="row.state === '进行中'" link type="success" size="small" @click="finish(row)">结束</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.candidate-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.malic-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
