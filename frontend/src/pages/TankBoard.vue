<script setup lang="ts">
/** /tanks 发酵罐容量配置与罐位状态看板：按材质与温控方式筛选并校验占用冲突 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, updateBatchRow, recomputeReservationQueues, type BatchRow, type ParcelRow, type ReservationRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTankStore } from '@/stores/tankStore'
import {
  TANK_MATERIALS,
  TANK_STATES,
  TANK_TEMP_CONTROLS,
  createEmptyTank,
  type Tank,
  type TankState
} from '@/types/tank'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'
import { summarizeTank } from '@/utils/commitment'

const route = useRoute()
const router = useRouter()
const store = useTankStore()

const { rows: tanks, ready } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: reservations } = useIdbTable<ReservationRow>(() => db.reservations)

const selects: FilterSelectConfig[] = [
  { key: 'materials', label: '材质', options: TANK_MATERIALS.map((item) => ({ label: item, value: item })) },
  { key: 'tempControls', label: '温控', options: TANK_TEMP_CONTROLS.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '罐位', options: TANK_STATES.map((item) => ({ label: item, value: item })) }
]

/** 占用该罐的在罐批次 */
function occupancyOf(tankId: string): BatchRow | null {
  return store.occupancyOf(tankId, batches.value)
}

function batchLabel(batch: BatchRow | null): string {
  if (!batch) return '—'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.volumeL}L`
}

/** 该罐的容量承诺汇总：实际在罐 / 已承诺预留 / 剩余可承诺 */
function commitmentOf(tank: TankRow): ReturnType<typeof summarizeTank> {
  return summarizeTank(tank, batches.value, reservations.value)
}

/** 该罐占容量的预约（已承诺 / 排队中），排队序号一并展示 */
function reservationsOn(tank: TankRow): ReservationRow[] {
  return reservations.value
    .filter((item) => item.tankId === tank.id && (item.status === '已承诺' || item.status === '排队中'))
    .sort((a, b) => a.seq - b.seq || a.submittedAt - b.submittedAt)
}

function reservationLabel(row: ReservationRow): string {
  const parcel = parcels.value.find((item) => item.id === row.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${row.forecastVolumeL}L`
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const materials = Array.isArray(store.filters.materials) ? store.filters.materials : []
  const tempControls = Array.isArray(store.filters.tempControls) ? store.filters.tempControls : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return tanks.value.filter((tank) => {
    const label = `${tank.code} ${tank.material} ${tank.tempControl} ${tank.state}`
    if (keyword && !label.toLowerCase().includes(keyword)) return false
    if (materials.length > 0 && !materials.includes(tank.material)) return false
    if (tempControls.length > 0 && !tempControls.includes(tank.tempControl)) return false
    if (states.length > 0 && !states.includes(tank.state)) return false
    return true
  })
})

const totals = computed(() => {
  const totalCapacity = tanks.value.reduce((sum, tank) => sum + tank.capacityL, 0)
  const usedCapacity = tanks.value
    .filter((tank) => occupancyOf(tank.id) !== null)
    .reduce((sum, tank) => sum + tank.capacityL, 0)
  return {
    tankCount: tanks.value.length,
    totalCapacity,
    usedCapacity,
    usageRatio: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0,
    freeCount: tanks.value.filter((tank) => tank.state === '空闲').length
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Tank, 'id'>>(createEmptyTank())

const rules: FormRules = {
  code: [{ required: true, message: '请填写罐号', trigger: 'blur' }],
  capacityL: [{ required: true, message: '请填写容量', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyTank())
  dialogVisible.value = true
}

function openEdit(tank: TankRow): void {
  editingId.value = tank.id
  Object.assign(form, {
    code: tank.code,
    material: tank.material,
    capacityL: tank.capacityL,
    tempControl: tank.tempControl,
    state: tank.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (editingId.value) {
    await store.updateTank(editingId.value, { ...form })
    ElMessage.success('罐位配置已更新')
  } else {
    await store.createTank({ ...form })
    ElMessage.success('发酵罐已建档')
  }
  dialogVisible.value = false
}

async function remove(tank: TankRow): Promise<void> {
  const occupied = occupancyOf(tank.id)
  if (occupied) {
    ElMessage.warning(`罐 ${tank.code} 正被批次占用，请先出罐或改绑其它罐位`)
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除发酵罐「${tank.code}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteTank(tank.id)
  ElMessage.success('发酵罐已删除')
}

async function changeState(tank: TankRow, next: TankState): Promise<void> {
  try {
    await store.changeState(tank, next)
    ElMessage.success(`罐 ${tank.code} 已置为「${next}」`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '操作失败')
  }
}

/** 为该罐分配一个在罐批次（真实占用冲突校验） */
async function assignBatch(tank: TankRow): Promise<void> {
  const candidates = batches.value.filter((batch) => batch.state !== '已出罐' && batch.tankId !== tank.id)
  if (candidates.length === 0) {
    ElMessage.info('暂无待分配的在罐批次')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt(
      `可分配批次：\n${candidates.map((batch) => `${batch.id}（${batchLabel(batch)}）`).join('\n')}`,
      `为罐 ${tank.code} 分配批次`,
      { inputPlaceholder: '粘贴批次 id', confirmButtonText: '分配', cancelButtonText: '取消' }
    )
    const picked = candidates.find((batch) => batch.id === value.trim())
    if (!picked) {
      ElMessage.error('批次 id 不存在，请重新选择')
      return
    }
    await store.ensureAssignable(tank.id, picked.id)
    await store.updateTank(tank.id, { state: '在用' })
    await updateBatchRow(picked.id, { tankId: tank.id })
    // 批次改绑改变实际容量占用：统一重算预约排队
    await recomputeReservationQueues()
    ElMessage.success('罐位已分配')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.warning(error.message)
  }
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
        <h2 class="page__title">发酵罐容量配置与罐位看板</h2>
        <p class="page__subtitle">罐位「在用」由入罐批次绑定后自动置位；重复分配会被拦截并列出占用批次。</p>
      </div>
      <div>
        <el-button @click="router.push(ROUTES.reservations)">到厂预约</el-button>
        <el-button @click="router.push(ROUTES.batches)">去入罐登记</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增发酵罐</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="罐总数" :value="totals.tankCount" suffix="个" icon="Grid" tone="primary" />
      <StatBadge label="空闲罐位" :value="totals.freeCount" suffix="个" icon="Files" tone="success" />
      <StatBadge label="总容量" :value="totals.totalCapacity" suffix="L" icon="Histogram" tone="info" />
      <StatBadge label="已占用容量" :value="totals.usedCapacity" suffix="L" icon="DataLine" tone="warning" />
      <StatBadge label="罐容利用率" :value="totals.usageRatio" :percent="totals.usageRatio" show-percent tone="danger" icon="PieChart" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索罐号 / 材质 / 温控…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>罐位清单（{{ filtered.length }} / {{ tanks.length }}）</span>
          <span class="muted">占用冲突校验：同一在罐批次不可占用两个罐位</span>
        </div>
      </template>

      <EmptyPanel
        v-if="ready && filtered.length === 0"
        title="没有匹配的发酵罐"
        description="新增一个发酵罐，或调整材质 / 温控 / 罐位筛选。"
        create-text="新增发酵罐"
        @create="openCreate"
      />

      <el-table v-else :data="filtered" stripe border>
        <el-table-column prop="code" label="罐号" width="110" />
        <el-table-column prop="material" label="材质" width="110" />
        <el-table-column prop="capacityL" label="容量(L)" width="110" align="right" />
        <el-table-column prop="tempControl" label="温控方式" width="110" />
        <el-table-column label="罐位状态" width="130">
          <template #default="{ row }">
            <StageTag :value="row.state" />
          </template>
        </el-table-column>
        <el-table-column label="占用批次" min-width="180">
          <template #default="{ row }">
            <span v-if="occupancyOf(row.id)">{{ batchLabel(occupancyOf(row.id)) }}</span>
            <span v-else class="muted">未占用</span>
          </template>
        </el-table-column>
        <el-table-column label="容量承诺（L）" min-width="220">
          <template #default="{ row }">
            <div class="commit">
              <span>容量 {{ row.capacityL }}</span>
              <span class="muted">在罐 {{ commitmentOf(row).actualL }}</span>
              <span class="muted">预留 {{ commitmentOf(row).reservedL }}</span>
              <el-tag
                size="small"
                :type="commitmentOf(row).freeL < 0 ? 'danger' : commitmentOf(row).freeL === 0 ? 'warning' : 'success'"
                effect="plain"
              >
                可承诺余 {{ commitmentOf(row).freeL }}
              </el-tag>
            </div>
            <div v-if="reservationsOn(row).length > 0" class="commit-list">
              <el-tag
                v-for="item in reservationsOn(row)"
                :key="item.id"
                size="small"
                :type="item.status === '排队中' ? 'info' : 'success'"
                effect="plain"
                class="commit-tag"
              >
                #{{ item.seq }} {{ reservationLabel(item) }} · {{ item.status }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.state === '在用'" @click="assignBatch(row)">分配批次</el-button>
            <el-button
              v-if="row.state !== '清洗中'"
              link
              type="warning"
              :disabled="occupancyOf(row.id) !== null"
              @click="changeState(row, '清洗中')"
            >
              转清洗
            </el-button>
            <el-button v-else link type="success" @click="changeState(row, '空闲')">清洗完成</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑发酵罐' : '新增发酵罐'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="罐号" prop="code">
          <el-input v-model="form.code" placeholder="如：F-05" />
        </el-form-item>
        <el-form-item label="材质">
          <el-radio-group v-model="form.material">
            <el-radio-button v-for="item in TANK_MATERIALS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="容量(L)" prop="capacityL">
          <el-input-number v-model="form.capacityL" :min="50" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="温控方式">
          <el-select v-model="form.tempControl" class="full">
            <el-option v-for="item in TANK_TEMP_CONTROLS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="罐位状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in TANK_STATES" :key="item" :label="item" :value="item" />
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

.commit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.commit-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.commit-tag {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
