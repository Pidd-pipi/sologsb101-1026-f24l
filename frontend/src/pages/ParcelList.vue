<script setup lang="ts">
/** /parcels 地块与品种台账：新建地块、按品种与朝向筛选、回显在罐批次数与累计入罐量 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type ParcelRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useParcelStore } from '@/stores/parcelStore'
import { PARCEL_ASPECTS, PARCEL_VARIETIES, createEmptyParcel, type Parcel } from '@/types/parcel'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useParcelStore()

const { rows: parcels, ready } = useIdbTable<ParcelRow>(() => db.parcels, {
  compare: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)

const selects: FilterSelectConfig[] = [
  { key: 'varieties', label: '品种', options: PARCEL_VARIETIES.map((item) => ({ label: item, value: item })) },
  { key: 'aspects', label: '朝向', options: PARCEL_ASPECTS.map((item) => ({ label: item, value: item })) }
]

/** 单个地块的在罐批次数与累计入罐量 */
function statsOf(parcelId: string): { activeCount: number; totalVolumeL: number } {
  const related = batches.value.filter((batch) => batch.parcelId === parcelId)
  return {
    activeCount: related.filter((batch) => batch.state !== '已出罐').length,
    totalVolumeL: related.reduce((sum, batch) => sum + batch.volumeL, 0)
  }
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const varieties = Array.isArray(store.filters.varieties) ? store.filters.varieties : []
  const aspects = Array.isArray(store.filters.aspects) ? store.filters.aspects : []
  return parcels.value.filter((parcel) => {
    if (keyword && !`${parcel.name} ${parcel.variety} ${parcel.aspect}`.toLowerCase().includes(keyword)) return false
    if (varieties.length > 0 && !varieties.includes(parcel.variety)) return false
    if (aspects.length > 0 && !aspects.includes(parcel.aspect)) return false
    return true
  })
})

const totals = computed(() => {
  const activeBatches = batches.value.filter((batch) => batch.state !== '已出罐')
  return {
    parcelCount: parcels.value.length,
    activeBatchCount: activeBatches.length,
    totalVolumeL: batches.value.reduce((sum, batch) => sum + batch.volumeL, 0),
    avgBrix:
      batches.value.length > 0
        ? Number((batches.value.reduce((sum, batch) => sum + batch.brix, 0) / batches.value.length).toFixed(1))
        : 0,
    activeTankRatio:
      parcels.value.length > 0 ? Math.round((activeBatches.length / Math.max(1, batches.value.length)) * 100) : 0
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Parcel, 'id'>>(createEmptyParcel())

const rules: FormRules = {
  name: [{ required: true, message: '请填写地块名称', trigger: 'blur' }],
  variety: [{ required: true, message: '请选择品种', trigger: 'change' }],
  areaMu: [{ required: true, message: '请填写面积', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyParcel())
  dialogVisible.value = true
}

function openEdit(parcel: ParcelRow): void {
  editingId.value = parcel.id
  Object.assign(form, {
    name: parcel.name,
    variety: parcel.variety,
    areaMu: parcel.areaMu,
    vineAge: parcel.vineAge,
    aspect: parcel.aspect
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (editingId.value) {
    await store.updateParcel(editingId.value, { ...form })
    ElMessage.success('地块已更新')
    dialogVisible.value = false
    return
  }
  const id = await store.createParcel({ ...form })
  dialogVisible.value = false
  ElMessage.success('地块已建档')
  try {
    await ElMessageBox.confirm('是否立即用该地块开一批入罐批次？', '继续操作', {
      confirmButtonText: '去入罐',
      cancelButtonText: '稍后',
      type: 'success'
    })
    await router.push({ path: ROUTES.batches, query: { parcelId: id } })
  } catch {
    // 用户选择稍后，无需处理
  }
}

async function remove(parcel: ParcelRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除地块「${parcel.name}」会同时删除其下全部批次与读数/作业/苹乳/品评记录，是否继续？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await store.deleteParcel(parcel.id)
  ElMessage.success('地块及其下级记录已删除')
}

function openBatch(parcel: ParcelRow): void {
  void router.push({ path: ROUTES.batches, query: { parcelId: parcel.id } })
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
        <h2 class="page__title">地块与品种台账</h2>
        <p class="page__subtitle">建地块与品种 → 配置发酵罐 → 入罐批次；同一地块可跨年份多次入罐。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建地块</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="地块数" :value="totals.parcelCount" suffix="块" icon="Grid" tone="primary" />
      <StatBadge label="在罐批次" :value="totals.activeBatchCount" suffix="批" icon="Files" tone="warning" />
      <StatBadge label="累计入罐" :value="totals.totalVolumeL" suffix="L" icon="Histogram" tone="success" />
      <StatBadge label="平均入罐糖度" :value="totals.avgBrix" suffix="°Bx" icon="TrendCharts" tone="info" />
      <StatBadge
        label="在罐占比"
        :value="totals.activeTankRatio"
        :percent="totals.activeTankRatio"
        show-percent
        icon="PieChart"
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索地块名称 / 品种 / 朝向…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>地块清单（{{ filtered.length }} / {{ parcels.length }}）</span>
          <span class="muted">筛选条件已同步到地址栏，可直接分享链接</span>
        </div>
      </template>

      <EmptyPanel
        v-if="ready && filtered.length === 0"
        title="还没有匹配的地块"
        description="新建一块葡萄地，或调整品种 / 朝向筛选条件。"
        create-text="新建地块"
        @create="openCreate"
      />

      <el-table v-else :data="filtered" stripe border>
        <el-table-column prop="name" label="地块名称" min-width="150" />
        <el-table-column prop="variety" label="品种" width="110" />
        <el-table-column prop="areaMu" label="面积(亩)" width="100" align="right" />
        <el-table-column prop="vineAge" label="树龄(年)" width="100" align="right" />
        <el-table-column prop="aspect" label="朝向" width="90" />
        <el-table-column label="在罐批次" width="110" align="right">
          <template #default="{ row }">
            <el-tag :type="statsOf(row.id).activeCount > 0 ? 'warning' : 'info'" effect="plain">
              {{ statsOf(row.id).activeCount }} 批
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="累计入罐" width="120" align="right">
          <template #default="{ row }">{{ statsOf(row.id).totalVolumeL }} L</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openBatch(row)">开入罐</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑地块' : '新建地块'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="地块名称" prop="name">
          <el-input v-model="form.name" placeholder="如：东坡三号地" />
        </el-form-item>
        <el-form-item label="品种" prop="variety">
          <el-select v-model="form.variety" class="full" placeholder="选择品种">
            <el-option v-for="item in PARCEL_VARIETIES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="面积(亩)" prop="areaMu">
          <el-input-number v-model="form.areaMu" :min="0.1" :max="500" :step="0.5" />
        </el-form-item>
        <el-form-item label="树龄(年)">
          <el-input-number v-model="form.vineAge" :min="1" :max="80" />
        </el-form-item>
        <el-form-item label="朝向">
          <el-radio-group v-model="form.aspect">
            <el-radio-button v-for="item in PARCEL_ASPECTS" :key="item" :value="item">{{ item }}</el-radio-button>
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
</style>
