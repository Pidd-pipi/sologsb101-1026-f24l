<script setup lang="ts">
/** /appointments 到厂预约与容量承诺：采收量先占发酵罐，总预留不超剩余容量 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, RefreshLeft } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import {
  db,
  type AppointmentRow,
  type BatchRow,
  type ParcelRow,
  type TankRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useAppointmentStore } from '@/stores/appointmentStore'
import { APPOINTMENT_STATES, createEmptyAppointment, type Appointment } from '@/types/appointment'
import { computeTankCapacity, shortageOf } from '@/utils/appointment'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useAppointmentStore()

const { rows: appointments, ready } = useIdbTable<AppointmentRow>(() => db.appointments, {
  compare: (a, b) => a.tankId.localeCompare(b.tankId) || a.seq - b.seq || a.createdAt - b.createdAt
})
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'states', label: '预约状态', options: APPOINTMENT_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'parcelIds', label: '地块', options: parcels.value.map((item) => ({ label: item.name, value: item.id })) }
])

/** 每罐容量台账 */
const tankCaps = computed(() =>
  tanks.value.map((tank) => computeTankCapacity(tank, batches.value, appointments.value))
)

function parcelName(parcelId: string): string {
  return parcels.value.find((item) => item.id === parcelId)?.name ?? '未绑定地块'
}

function tankCode(tankId: string): string {
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

function capOf(tankId: string) {
  return tankCaps.value.find((cap) => cap.tankId === tankId)
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const parcelIds = Array.isArray(store.filters.parcelIds) ? store.filters.parcelIds : []
  return appointments.value.filter((apt) => {
    const label = `${parcelName(apt.parcelId)} ${tankCode(apt.tankId)} ${apt.state} ${apt.note}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (states.length > 0 && !states.includes(apt.state)) return false
    if (parcelIds.length > 0 && !parcelIds.includes(apt.parcelId)) return false
    return true
  })
})

const totals = computed(() => {
  const reserved = appointments.value.filter((a) => a.state === '预约中')
  return {
    total: appointments.value.length,
    reservedCount: reserved.length,
    reservedVolume: reserved.reduce((s, a) => s + a.volumeL, 0),
    reviewCount: appointments.value.filter((a) => a.state === '待复核').length,
    bookedCount: appointments.value.filter((a) => a.state === '已入罐').length,
    remainingVolume: tankCaps.value.reduce((s, c) => s + c.remainingL, 0)
  }
})

/* ------------------------------ 新建 / 编辑预约 ------------------------------ */
const dialogVisible = ref(false)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Appointment, 'id' | 'seq' | 'commitmentVersion' | 'batchId' | 'reviewReason'>>(
  createEmptyAppointment()
)

const rules: FormRules = {
  parcelId: [{ required: true, message: '请选择地块', trigger: 'change' }],
  tankId: [{ required: true, message: '请选择发酵罐', trigger: 'change' }],
  volumeL: [{ required: true, message: '请填写预约量', trigger: 'blur' }]
}

/** 可选罐位：非清洗中且还有剩余容量 */
const bookableTanks = computed(() =>
  tanks.value.filter((tank) => {
    const cap = capOf(tank.id)
    return cap?.bookable
  })
)

/** 当前选中罐的剩余可约量 */
const selectedTankRemaining = computed(() => {
  if (!form.tankId) return null
  const cap = capOf(form.tankId)
  return cap ? cap.remainingL : null
})

/** 当前选中罐按填写量的差量 */
const selectedShortage = computed(() => {
  if (!form.tankId || !form.volumeL) return 0
  const cap = capOf(form.tankId)
  return cap ? shortageOf(cap, form.volumeL) : 0
})

function openCreate(): void {
  Object.assign(form, createEmptyAppointment())
  const parcelFromQuery = typeof route.query.parcelId === 'string' ? route.query.parcelId : ''
  if (parcelFromQuery) form.parcelId = parcelFromQuery
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const result = await store.book({ ...form })
    if (result.ok) {
      ElMessage.success(`已占住罐 ${tankCode(result.appointment.tankId)}，排队序号 ${result.appointment.seq}`)
      dialogVisible.value = false
    } else {
      ElMessage.error(`${result.reason}，已保留草稿，可调整后重试`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '写入失败，已保留草稿')
  }
}

/* ------------------------------ 草稿重试 ------------------------------ */
async function retryDraft(): Promise<void> {
  try {
    const result = await store.retryDraft()
    if (result.ok) {
      ElMessage.success(`已占住罐 ${tankCode(result.appointment.tankId)}，排队序号 ${result.appointment.seq}`)
    } else {
      ElMessage.error(`${result.reason}，草稿已更新`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败，草稿已保留')
  }
}

function discardDraft(): void {
  store.discardDraft()
  ElMessage.info('草稿已放弃')
}

/* ------------------------------ 预约操作 ------------------------------ */
async function cancel(apt: AppointmentRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认取消预约 ${apt.id}？取消后释放已占容量。`, '取消确认', {
      type: 'warning',
      confirmButtonText: '确认取消'
    })
  } catch {
    return
  }
  await store.cancel(apt.id)
  ElMessage.success('预约已取消，容量已释放')
}

async function rebook(apt: AppointmentRow): Promise<void> {
  // 待复核预约重新提交：用原数据再占一次
  try {
    const result = await store.book({
      parcelId: apt.parcelId,
      tankId: apt.tankId,
      harvestDate: apt.harvestDate,
      volumeL: apt.volumeL,
      note: apt.note
    })
    if (result.ok) {
      ElMessage.success(`已占住罐 ${tankCode(result.appointment.tankId)}，排队序号 ${result.appointment.seq}`)
    } else {
      ElMessage.error(`${result.reason}，仍排不下`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  }
}

async function openConvert(apt: AppointmentRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `预约量 ${apt.volumeL}L，可修改实际入罐量与糖度。`,
      `预约入罐 · ${parcelName(apt.parcelId)}`,
      {
        confirmButtonText: '确认入罐',
        cancelButtonText: '取消',
        inputValue: String(apt.volumeL),
        inputPattern: /^\d+(\.\d+)?$/,
        inputErrorMessage: '请填写大于 0 的数字'
      }
    )
    const volumeL = Number(value)
    if (!Number.isFinite(volumeL) || volumeL <= 0) {
      ElMessage.warning('入罐量必须大于 0')
      return
    }
    const result = await store.convert(apt.id, {
      harvestDate: apt.harvestDate,
      volumeL,
      brix: 23
    })
    if (result.overCapacity) {
      ElMessage.warning(`实际入罐超罐容量，已重算排队，排不下的预约退回复核`)
    } else {
      ElMessage.success('预约已入罐，罐位置为「在用」')
    }
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
        <h2 class="page__title">到厂预约与容量承诺</h2>
        <p class="page__subtitle">
          采收队还在路上，先按地块采收量占住发酵罐；总预留不超剩余容量，先提交的占住，排不下的退回复核。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建预约</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="预约总数" :value="totals.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="预约中" :value="totals.reservedCount" suffix="条" icon="Grid" tone="warning" />
      <StatBadge label="已预留" :value="totals.reservedVolume" suffix="L" icon="Histogram" tone="info" />
      <StatBadge label="待复核" :value="totals.reviewCount" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="剩余可约" :value="totals.remainingVolume" suffix="L" icon="DataLine" tone="success" />
    </div>

    <!-- 容量不足 / 写入失败草稿条 -->
    <el-alert
      v-if="store.hasDraft && store.draft"
      type="error"
      show-icon
      closable
      class="draft-alert"
      @close="discardDraft"
    >
      <template #title>
        <div class="draft-alert__title">
          <span>预约未占住{{ store.draft.shortageL > 0 ? `，差 ${store.draft.shortageL} 升` : '' }}</span>
          <span class="muted">
            （地块 {{ parcelName(store.draft.parcelId) }} · 罐 {{ tankCode(store.draft.tankId) }} ·
            {{ store.draft.volumeL }}L）
          </span>
        </div>
      </template>
      <div class="draft-alert__body">
        <span>{{ store.draft.reason }}</span>
        <el-button size="small" type="primary" :icon="RefreshLeft" :loading="store.busy" @click="retryDraft">
          重试占住
        </el-button>
      </div>
    </el-alert>

    <el-row :gutter="16">
      <el-col :span="15">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>预约清单（{{ filtered.length }} / {{ appointments.length }}）</span>
              <span class="muted">同一罐先提交的占住，排队序号小的优先</span>
            </div>
          </template>

          <FilterBar
            :model-value="store.filters"
            :selects="selects"
            keyword-placeholder="搜索地块 / 罐号 / 状态…"
            @update:model-value="onFilterChange"
            @reset="store.resetFilters()"
          />

          <EmptyPanel
            v-if="ready && filtered.length === 0"
            title="暂无预约"
            description="采收队在途时先建一条预约，把罐位容量占住。"
            create-text="新建预约"
            @create="openCreate"
          />

          <el-table v-else :data="filtered" stripe border class="mt">
            <el-table-column prop="seq" label="排队" width="70" align="right">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ row.seq }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="地块" min-width="140">
              <template #default="{ row }">{{ parcelName(row.parcelId) }}</template>
            </el-table-column>
            <el-table-column label="罐号" width="100">
              <template #default="{ row }">{{ tankCode(row.tankId) }}</template>
            </el-table-column>
            <el-table-column prop="harvestDate" label="到厂日期" width="110" />
            <el-table-column prop="volumeL" label="预约量(L)" width="100" align="right" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag
                  :type="row.state === '预约中' ? 'warning' : row.state === '待复核' ? 'danger' : row.state === '已入罐' ? 'success' : 'info'"
                  size="small"
                  effect="light"
                >
                  {{ row.state }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="差量 / 原因" min-width="160">
              <template #default="{ row }">
                <span v-if="row.state === '待复核'" class="text-danger">{{ row.reviewReason }}</span>
                <span v-else-if="row.state === '已入罐'" class="muted">已转批次</span>
                <span v-else-if="row.state === '已取消'" class="muted">—</span>
                <span v-else class="muted">占住中</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.state === '预约中'" link type="success" size="small" @click="openConvert(row)">
                  入罐
                </el-button>
                <el-button v-if="row.state === '待复核'" link type="primary" size="small" @click="rebook(row)">
                  重试
                </el-button>
                <el-button v-if="row.state === '预约中'" link type="danger" size="small" @click="cancel(row)">
                  取消
                </el-button>
                <span v-if="row.state !== '预约中'" class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="9">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>罐位容量台账</span>
              <span class="muted">实际 + 预留 ≤ 容量</span>
            </div>
          </template>
          <el-table :data="tankCaps" stripe border size="small">
            <el-table-column label="罐号" width="90">
              <template #default="{ row }">{{ tankCode(row.tankId) }}</template>
            </el-table-column>
            <el-table-column prop="capacityL" label="容量" width="80" align="right" />
            <el-table-column prop="actualL" label="实际" width="80" align="right" />
            <el-table-column prop="reservedL" label="预留" width="80" align="right" />
            <el-table-column label="剩余" width="80" align="right">
              <template #default="{ row }">
                <span :class="{ 'text-danger': row.remainingL <= 0 }">{{ row.remainingL }}</span>
              </template>
            </el-table-column>
            <el-table-column label="利用率" min-width="120">
              <template #default="{ row }">
                <el-progress
                  :percentage="row.utilization"
                  :stroke-width="8"
                  :color="row.utilization > 90 ? '#c0392b' : row.utilization > 70 ? '#d68910' : '#1e8449'"
                />
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" title="新建到厂预约" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="地块" prop="parcelId">
          <el-select v-model="form.parcelId" class="full" placeholder="选择地块">
            <el-option v-for="item in parcels" :key="item.id" :label="`${item.name}（${item.variety}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发酵罐" prop="tankId">
          <el-select v-model="form.tankId" class="full" placeholder="仅列出可预约罐位">
            <el-option
              v-for="item in bookableTanks"
              :key="item.id"
              :label="`${item.code} · 剩余 ${capOf(item.id)?.remainingL ?? 0}L / ${item.capacityL}L`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="到厂日期">
          <el-date-picker v-model="form.harvestDate" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="预约量(L)" prop="volumeL">
          <el-input-number v-model="form.volumeL" :min="10" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="采收队在途、预计到厂时间等" />
        </el-form-item>
      </el-form>

      <el-alert
        v-if="selectedTankRemaining !== null"
        type="info"
        :closable="false"
        show-icon
        class="mb"
        :title="`罐 ${tankCode(form.tankId)} 剩余可约 ${selectedTankRemaining}L`"
      />
      <el-alert
        v-if="selectedShortage > 0"
        type="error"
        :closable="false"
        show-icon
        class="mb"
        :title="`容量不足，差 ${selectedShortage}L；提交后将保留草稿，可调整后重试`"
      />

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="store.busy" @click="submit">确认预约</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 12px;
}

.text-danger {
  color: #c0392b;
  font-weight: 600;
}

.draft-alert {
  margin-bottom: 14px;
}

.draft-alert__title {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-weight: 600;
}

.draft-alert__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
}
</style>
