<script setup lang="ts">
/** /operations 倒罐与压帽作业编排：按日期排序、拖拽调序并指派操作人 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Rank } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type OperationRow, type ParcelRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useOperationStore } from '@/stores/operationStore'
import { OPERATION_STATES, OPERATION_TYPES, createEmptyOperation, type Operation } from '@/types/operation'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useOperationStore()

const { rows: operations, ready } = useIdbTable<OperationRow>(() => db.operations, {
  compare: (a, b) => a.seq - b.seq || a.date.localeCompare(b.date)
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const selects: FilterSelectConfig[] = [
  { key: 'types', label: '作业类型', options: OPERATION_TYPES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '状态', options: OPERATION_STATES.map((item) => ({ label: item, value: item })) }
]

function batchLabel(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate}`
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const types = Array.isArray(store.filters.types) ? store.filters.types : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const scoped = store.currentBatchId
    ? operations.value.filter((item) => item.batchId === store.currentBatchId)
    : operations.value
  return scoped
    .filter((item) => {
      const label = `${item.type} ${item.operator} ${batchLabel(item.batchId)}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (types.length > 0 && !types.includes(item.type)) return false
      if (states.length > 0 && !states.includes(item.state)) return false
      return true
    })
    .sort((a, b) => a.seq - b.seq)
})

const summary = computed(() => ({
  total: filtered.value.length,
  planned: filtered.value.filter((item) => item.state === '计划').length,
  done: filtered.value.filter((item) => item.state === '已完成').length,
  totalMinutes: filtered.value.reduce((sum, item) => sum + item.durationMin, 0)
}))

/* ------------------------------ 拖拽调序 ------------------------------ */
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(index: number): void {
  dragIndex.value = index
}

function onDragOver(index: number): void {
  overIndex.value = index
}

async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || from === index) return
  await store.move(filtered.value, from, index)
  ElMessage.success('作业顺序已更新并写回本地库')
}

/** 上下移按钮：无鼠标拖拽时的等价操作 */
async function moveBy(index: number, offset: number): Promise<void> {
  await store.move(filtered.value, index, index + offset)
}

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Operation, 'id' | 'seq'>>(createEmptyOperation())

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyOperation())
  if (store.currentBatchId) form.batchId = store.currentBatchId
  dialogVisible.value = true
}

function openEdit(row: OperationRow): void {
  editingId.value = row.id
  Object.assign(form, {
    batchId: row.batchId,
    type: row.type,
    date: row.date,
    durationMin: row.durationMin,
    operator: row.operator,
    state: row.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingId.value) {
      await store.updateOperation(editingId.value, { ...form })
      ElMessage.success('作业已更新')
    } else {
      await store.createOperation({ ...form })
      ElMessage.success('作业已排入队列')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function finish(row: OperationRow): Promise<void> {
  await store.finish(row.id)
  ElMessage.success('作业已完成，批次最近作业时间已回写')
}

async function remove(row: OperationRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的「${row.type}」作业？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.deleteOperation(row.id)
  ElMessage.success('作业已删除')
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
        <h2 class="page__title">倒罐与压帽作业编排</h2>
        <p class="page__subtitle">按日期排班并拖拽调整先后顺序；标记完成后自动回写批次的最近作业时间。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增作业</el-button>
    </div>

    <el-card shadow="never">
      <div class="metric-row">
        <el-tag type="info" effect="plain">作业 {{ summary.total }} 条</el-tag>
        <el-tag type="warning" effect="plain">计划中 {{ summary.planned }}</el-tag>
        <el-tag type="success" effect="plain">已完成 {{ summary.done }}</el-tag>
        <el-tag effect="plain">合计工时 {{ summary.totalMinutes }} 分钟</el-tag>
        <el-select v-model="store.currentBatchId" clearable placeholder="全部批次" class="batch-filter" @change="store.select(store.currentBatchId)">
          <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
        </el-select>
      </div>
    </el-card>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索作业类型 / 操作人 / 批次…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有排定的作业"
      description="为在罐批次添加倒罐 / 压帽 / 淋皮作业，然后用拖拽排出执行顺序。"
      create-text="新增作业"
      @create="openCreate"
    />

    <div v-else class="op-list">
      <div
        v-for="(row, index) in filtered"
        :key="row.id"
        class="op-item"
        :class="{ 'is-dragging': dragIndex === index, 'is-over': overIndex === index }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="dragIndex = null"
      >
        <el-icon class="drag-handle"><Rank /></el-icon>
        <div class="op-item__seq">#{{ index + 1 }}</div>
        <div class="op-item__body">
          <div class="op-item__title">
            <strong>{{ row.type }}</strong>
            <StageTag :value="row.state" size="small" />
            <el-tag size="small" effect="plain">{{ row.durationMin }} 分钟</el-tag>
          </div>
          <div class="op-item__meta">
            {{ row.date }} · 操作人 {{ row.operator }} · {{ batchLabel(row.batchId) }}
          </div>
        </div>
        <div class="op-item__actions">
          <el-button link size="small" :disabled="index === 0" @click="moveBy(index, -1)">上移</el-button>
          <el-button link size="small" :disabled="index === filtered.length - 1" @click="moveBy(index, 1)">下移</el-button>
          <el-button v-if="row.state === '计划'" link type="success" size="small" @click="finish(row)">完成</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑作业' : '新增作业'" width="540px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" class="full" placeholder="选择批次">
            <el-option
              v-for="item in batches.filter((batch) => batch.state !== '已出罐')"
              :key="item.id"
              :label="batchLabel(item.id)"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="item in OPERATION_TYPES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="时长(分钟)">
          <el-input-number v-model="form.durationMin" :min="5" :max="600" :step="5" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：陈岩" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in OPERATION_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.batch-filter {
  width: 240px;
  margin-left: auto;
}

.op-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.op-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--wine-border);
  border-left: 4px solid #b9688a;
  border-radius: 10px;
}

.op-item.is-dragging {
  opacity: 0.45;
}

.op-item.is-over {
  border-top: 2px dashed #b9688a;
}

.op-item__seq {
  width: 38px;
  font-weight: 700;
  color: #8a3b56;
  font-variant-numeric: tabular-nums;
}

.op-item__body {
  flex: 1;
}

.op-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.op-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.op-item__actions {
  display: flex;
  align-items: center;
}
</style>
