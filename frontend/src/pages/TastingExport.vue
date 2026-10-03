<script setup lang="ts">
/** /tasting 品评调配与批次档案导出：同批次多次品评并列对比 + 本地结构版本查看与 JSON 导入导出 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Download, Plus, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import {
  db,
  countAll,
  exportSnapshot,
  importSnapshot,
  resetDatabase,
  DB_NAME,
  DB_SCHEMA_VERSION,
  type BatchRow,
  type ParcelRow,
  type TastingRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { TASTING_VERDICTS, createEmptyTasting, type Tasting } from '@/types/tasting'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { buildBatchArchive, downloadJson, parseArchive, serializeArchive } from '@/utils/export'
import { filtersToQuery } from '@/utils/query'
import { ROW_REVISION } from '@/utils/db'

const route = useRoute()
const router = useRouter()

const { rows: tastings, ready } = useIdbTable<TastingRow>(() => db.tastings, {
  compare: (a, b) => b.date.localeCompare(a.date)
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches, {
  compare: (a, b) => b.harvestDate.localeCompare(a.harvestDate)
})
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const filters = ref<FilterModel>({ keyword: '', verdicts: [] })

const selects: FilterSelectConfig[] = [
  { key: 'verdicts', label: '结论', options: TASTING_VERDICTS.map((item) => ({ label: item, value: item })) }
]

function batchLabel(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate}`
}

const filtered = computed(() => {
  const keyword = String(filters.value.keyword ?? '').trim().toLowerCase()
  const verdicts = Array.isArray(filters.value.verdicts) ? filters.value.verdicts : []
  return tastings.value.filter((item) => {
    const label = `${batchLabel(item.batchId)} ${item.aroma} ${item.tannin} ${item.acidity}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (verdicts.length > 0 && !verdicts.includes(item.verdict)) return false
    return true
  })
})

/** 同批次多次品评并列对比：按批次分组 */
const grouped = computed(() => {
  const map = new Map<string, TastingRow[]>()
  filtered.value.forEach((item) => {
    const list = map.get(item.batchId) ?? []
    list.push(item)
    map.set(item.batchId, list)
  })
  return Array.from(map.entries()).map(([batchId, list]) => ({
    batchId,
    label: batchLabel(batchId),
    items: list.sort((a, b) => a.date.localeCompare(b.date))
  }))
})

const summary = computed(() => {
  const list = tastings.value
  const bottling = list.filter((item) => item.verdict === '可直接装瓶').length
  return {
    total: list.length,
    pending: list.filter((item) => item.verdict === '待定').length,
    blend: list.filter((item) => item.verdict === '需调配').length,
    bottling,
    bottlingRatio: list.length > 0 ? Math.round((bottling / list.length) * 100) : 0
  }
})

/* ------------------------------ 品评录入 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Tasting, 'id'>>(createEmptyTasting())

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  aroma: [{ required: true, message: '请填写香气描述', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyTasting())
  if (batches.value.length > 0) form.batchId = batches.value[0].id
  dialogVisible.value = true
}

function openEdit(row: TastingRow): void {
  editingId.value = row.id
  Object.assign(form, {
    batchId: row.batchId,
    date: row.date,
    aroma: row.aroma,
    tannin: row.tannin,
    acidity: row.acidity,
    verdict: row.verdict
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const now = Date.now()
  if (editingId.value) {
    await db.tastings.update(editingId.value, { ...form, updatedAt: now } as never)
    ElMessage.success('品评记录已更新')
  } else {
    await db.tastings.put({
      ...form,
      id: `tasting-${now.toString(36)}`,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    ElMessage.success('品评记录已保存')
  }
  dialogVisible.value = false
}

async function remove(row: TastingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除 ${row.date} 的品评记录？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await db.tastings.delete(row.id)
  ElMessage.success('品评记录已删除')
}

/* ------------------------------ 档案导出 ------------------------------ */
const archiveBatchId = ref<string>('')
const archivePreview = ref<string>('')

async function previewArchive(): Promise<void> {
  if (!archiveBatchId.value) {
    ElMessage.warning('请先选择要导出的批次')
    return
  }
  const archive = await buildBatchArchive(archiveBatchId.value)
  archivePreview.value = serializeArchive(archive)
  ElMessage.success('批次档案已生成，可下载或复制')
}

async function exportArchive(): Promise<void> {
  if (!archiveBatchId.value) {
    ElMessage.warning('请先选择要导出的批次')
    return
  }
  const archive = await buildBatchArchive(archiveBatchId.value)
  downloadJson(`批次档案-${archiveBatchId.value}.json`, serializeArchive(archive))
  ElMessage.success('批次档案已下载')
}

/* --------------------------- 整库版本与导入导出 --------------------------- */
const dbCounts = ref<Record<string, number>>({})

async function refreshCounts(): Promise<void> {
  dbCounts.value = await countAll()
}

async function exportLibrary(): Promise<void> {
  const snapshot = await exportSnapshot()
  downloadJson(`gbwinetank-备份-${snapshot.exportedAt.slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2))
  ElMessage.success('本地库已导出为 JSON')
}

async function importLibrary(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('粘贴本地库 JSON 备份内容后确认导入（将覆盖现有数据）', '导入备份', {
      inputType: 'textarea',
      confirmButtonText: '确认导入'
    })
    const parsed = parseArchive(value)
    if (!Array.isArray((parsed as unknown as { parcels?: unknown[] }).parcels)) {
      throw new Error('缺少 parcels 数组字段，不是本应用的备份文件')
    }
    await importSnapshot(parsed as unknown as Awaited<ReturnType<typeof exportSnapshot>>)
    await refreshCounts()
    ElMessage.success('备份已导入')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(`导入失败：${error.message}`)
  }
}

async function resetDemo(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空本地库并重新灌入演示数据，是否继续？', '重置确认', { type: 'warning' })
  } catch {
    return
  }
  await resetDatabase()
  await refreshCounts()
  ElMessage.success('已重置为演示数据')
}

function onFilterChange(next: FilterModel): void {
  filters.value = next
}

onMounted(async () => {
  await refreshCounts()
  if (typeof route.query.verdicts === 'string') {
    filters.value.verdicts = route.query.verdicts.split(',')
  }
  if (typeof route.query.keyword === 'string') filters.value.keyword = route.query.keyword
  if (batches.value.length > 0) archiveBatchId.value = batches.value[0].id
})

watch(
  filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(
  () => tastings.value.length,
  () => {
    void refreshCounts()
  }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">品评调配与批次档案</h2>
        <p class="page__subtitle">
          同批次多次品评并列对比，择优结论汇总进批次档案；本地库 {{ DB_NAME }}（结构版本 v{{ DB_SCHEMA_VERSION }}）。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增品评</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="品评记录" :value="summary.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待定" :value="summary.pending" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="需调配" :value="summary.blend" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="可直接装瓶" :value="summary.bottling" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="可装瓶占比" :value="summary.bottlingRatio" :percent="summary.bottlingRatio" show-percent icon="PieChart" tone="danger" />
    </div>

    <FilterBar
      :model-value="filters"
      :selects="selects"
      keyword-placeholder="搜索批次 / 香气 / 单宁 / 酸度…"
      @update:model-value="onFilterChange"
      @reset="filters = { keyword: '', verdicts: [] }"
    />

    <EmptyPanel
      v-if="ready && grouped.length === 0"
      title="暂无品评记录"
      description="为在罐或已出罐批次录入品评结论，同批次可多次并列对比。"
      create-text="新增品评"
      @create="openCreate"
    />

    <div v-else class="group-list">
      <el-card v-for="group in grouped" :key="group.batchId" shadow="never">
        <template #header>
          <div class="card-title">
            <span>{{ group.label }}</span>
            <span class="muted">共 {{ group.items.length }} 次品评 · 批次 {{ group.batchId }}</span>
          </div>
        </template>
        <div class="compare-row">
          <div v-for="item in group.items" :key="item.id" class="compare-card">
            <div class="compare-card__head">
              <span>{{ item.date }}</span>
              <el-tag
                size="small"
                :type="item.verdict === '可直接装瓶' ? 'success' : item.verdict === '需调配' ? 'warning' : 'info'"
              >
                {{ item.verdict }}
              </el-tag>
            </div>
            <dl>
              <dt>香气</dt>
              <dd>{{ item.aroma }}</dd>
              <dt>单宁</dt>
              <dd>{{ item.tannin || '—' }}</dd>
              <dt>酸度</dt>
              <dd>{{ item.acidity || '—' }}</dd>
            </dl>
            <div class="compare-card__actions">
              <el-button link type="primary" size="small" @click="openEdit(item)">编辑</el-button>
              <el-button link type="danger" size="small" @click="remove(item)">删除</el-button>
            </div>
          </div>
        </div>
      </el-card>
    </div>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>批次档案导出</span><span class="muted">JSON 单批次归档</span></div>
          </template>
          <el-select v-model="archiveBatchId" class="full" placeholder="选择批次">
            <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
          </el-select>
          <div class="btn-row">
            <el-button :icon="Download" @click="previewArchive">生成预览</el-button>
            <el-button type="primary" :icon="Download" @click="exportArchive">下载批次档案</el-button>
          </div>
          <el-input v-model="archivePreview" type="textarea" :rows="8" readonly placeholder="档案预览会显示在这里" />
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>本地结构版本与整库备份</span>
              <span class="muted">IndexedDB · {{ DB_NAME }}</span>
            </div>
          </template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="库名">{{ DB_NAME }}</el-descriptions-item>
            <el-descriptions-item label="结构版本">v{{ DB_SCHEMA_VERSION }}</el-descriptions-item>
            <el-descriptions-item label="地块/罐">{{ dbCounts.parcels ?? 0 }} / {{ dbCounts.tanks ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="批次/读数">{{ dbCounts.batches ?? 0 }} / {{ dbCounts.readings ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="作业/苹乳">{{ dbCounts.operations ?? 0 }} / {{ dbCounts.mlfs ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="品评">{{ dbCounts.tastings ?? 0 }}</el-descriptions-item>
          </el-descriptions>
          <div class="btn-row">
            <el-button :icon="Download" @click="exportLibrary">导出整库 JSON</el-button>
            <el-button :icon="Upload" @click="importLibrary">导入备份</el-button>
            <el-button type="danger" plain @click="resetDemo">重置演示数据</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑品评记录' : '新增品评记录'" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" class="full" placeholder="选择批次">
            <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="品评日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="香气" prop="aroma">
          <el-input v-model="form.aroma" type="textarea" :rows="2" placeholder="如果香、花香、橡木…" />
        </el-form-item>
        <el-form-item label="单宁">
          <el-input v-model="form.tannin" type="textarea" :rows="2" placeholder="如紧实、柔顺…" />
        </el-form-item>
        <el-form-item label="酸度">
          <el-input v-model="form.acidity" type="textarea" :rows="2" placeholder="如明亮、偏低…" />
        </el-form-item>
        <el-form-item label="结论">
          <el-radio-group v-model="form.verdict">
            <el-radio-button v-for="item in TASTING_VERDICTS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
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

.group-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.compare-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.compare-card {
  flex: 1 1 240px;
  padding: 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
}

.compare-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
}

.compare-card dl {
  display: grid;
  grid-template-columns: 46px 1fr;
  gap: 4px 8px;
  margin: 0;
  font-size: 13px;
}

.compare-card dt {
  color: #8c8479;
}

.compare-card dd {
  margin: 0;
}

.compare-card__actions {
  margin-top: 8px;
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
</style>
