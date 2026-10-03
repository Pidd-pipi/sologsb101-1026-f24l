<script setup lang="ts">
/** /reservations 到厂预约与容量承诺：电话抢罐、先到先得、草稿差量、排队重算、失败重试 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import {
  db,
  getCommitmentVersion,
  type BatchRow,
  type ParcelRow,
  type PendingWriteRow,
  type ReservationRow,
  type TankRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useReservationStore, type ReservationDraftForm } from '@/stores/reservationStore'
import { createEmptyReservation, RESERVATION_STATUSES, RESERVATION_ARRIVABLE_STATUSES } from '@/types/reservation'
import { today } from '@/utils/uuid'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { summarizeTank } from '@/utils/commitment'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useReservationStore()

const { rows: reservations, ready } = useIdbTable<ReservationRow>(() => db.reservations, {
  compare: (a, b) => b.submittedAt - a.submittedAt
})
const { rows: pendingWrites } = useIdbTable<PendingWriteRow>(() => db.pendingWrites)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)

const commitmentVersion = ref(0)

const selects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'resvStatuses',
    label: '状态',
    options: RESERVATION_STATUSES.map((item) => ({ label: item, value: item }))
  },
  { key: 'tankIds', label: '罐号', options: tanks.value.map((item) => ({ label: item.code, value: item.id })) }
])

function parcelName(id: string): string {
  return parcels.value.find((item) => item.id === id)?.name ?? '未知地块'
}

function parcelVariety(id: string): string {
  return parcels.value.find((item) => item.id === id)?.variety ?? ''
}

function tankCode(id: string): string {
  if (!id) return '—'
  return tanks.value.find((item) => item.id === id)?.code ?? '未知罐'
}

function tankById(id: string): TankRow | undefined {
  return tanks.value.find((item) => item.id === id)
}

/** 该罐的容量承诺汇总 */
function summaryOf(tankId: string) {
  const tank = tankById(tankId)
  if (!tank) return { actualL: 0, reservedL: 0, freeL: 0, overbooked: false, capacityL: 0 }
  return { ...summarizeTank(tank, batches.value, reservations.value), capacityL: tank.capacityL }
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const statuses = Array.isArray(store.filters.resvStatuses) ? store.filters.resvStatuses : []
  const tankIds = Array.isArray(store.filters.tankIds) ? store.filters.tankIds : []
  return reservations.value.filter((item) => {
    const label =
      `${parcelName(item.parcelId)} ${parcelVariety(item.parcelId)} ${tankCode(item.tankId)} ${item.contact} ${item.note} ${item.status}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (statuses.length > 0 && !statuses.includes(item.status)) return false
    if (tankIds.length > 0 && !tankIds.includes(item.tankId)) return false
    return true
  })
})

const totals = computed(() => {
  const live = reservations.value.filter((item) => item.status !== '已取消' && item.status !== '已入罐')
  return {
    total: reservations.value.length,
    committed: reservations.value.filter((item) => item.status === '已承诺').length,
    queued: reservations.value.filter((item) => item.status === '排队中').length,
    drafts: reservations.value.filter((item) => item.status === '草稿').length,
    review: reservations.value.filter((item) => item.status === '待复核').length,
    pendingWrites: pendingWrites.value.length,
    reservedL: live
      .filter((item) => item.status === '已承诺' || item.status === '排队中')
      .reduce((sum, item) => sum + item.forecastVolumeL, 0)
  }
})

async function refreshVersion(): Promise<void> {
  commitmentVersion.value = await getCommitmentVersion()
}

/* ------------------------------ 新建 / 编辑预约 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<ReservationDraftForm>(createEmptyReservation())

const rules: FormRules = {
  parcelId: [{ required: true, message: '请选择地块', trigger: 'change' }],
  tankId: [{ required: true, message: '请选择发酵罐', trigger: 'change' }],
  forecastVolumeL: [{ required: true, message: '请填写预报采收量', trigger: 'blur' }],
  expectedAt: [{ required: true, message: '请选择预计到厂时间', trigger: 'change' }]
}

function openCreate(prefillTankId?: string): void {
  editingId.value = null
  Object.assign(form, createEmptyReservation())
  if (parcels.value.length > 0) form.parcelId = parcels.value[0].id
  if (prefillTankId) form.tankId = prefillTankId
  dialogVisible.value = true
}

function openEdit(row: ReservationRow): void {
  editingId.value = row.id
  Object.assign(form, {
    parcelId: row.parcelId,
    tankId: row.tankId,
    expectedAt: row.expectedAt,
    forecastVolumeL: row.forecastVolumeL,
    contact: row.contact,
    note: row.note
  })
  dialogVisible.value = true
}

/** 选罐后的实时抢罐预判（展示该罐已预留 / 剩余 / 本次差额）；编辑时排除自身 */
const preview = computed(() => {
  if (!form.tankId || !(form.forecastVolumeL > 0)) return null
  const tank = tankById(form.tankId)
  if (!tank) return null
  return store.previewCommit(tank, batches.value, reservations.value, form.forecastVolumeL, editingId.value ?? undefined)
})

const selectedTankSummary = computed(() => (form.tankId ? summaryOf(form.tankId) : null))

async function doSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const editing = editingId.value
  // 保留原始提交时刻：失败重试 / 草稿重新提交不改变先到先得顺序
  const original = editing ? reservations.value.find((item) => item.id === editing) : undefined
  try {
    const saved = await store.submit({ ...form }, editing ?? undefined, original?.submittedAt)
    if (saved.status === '已承诺') {
      ElMessage.success(`已占住罐 ${tankCode(saved.tankId)}，承诺生效（v${saved.commitmentVersion}）`)
    } else if (saved.status === '排队中') {
      ElMessage.warning(`罐位清洗中，已排队（第 ${saved.seq} 位），洗完按序承诺`)
    } else {
      ElMessage.warning(`容量不足，已留草稿，还差 ${-saved.shortfallL}L`)
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(`${error instanceof Error ? error.message : '提交失败'}；预约已留草稿，可在下方失败列表重试`)
    await refreshVersion()
  }
}

async function doSaveDraft(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const id = await store.saveDraft({ ...form }, editingId.value ?? undefined)
  ElMessage.success('草稿已保存，可稍后提交抢罐')
  dialogVisible.value = false
  editingId.value = id
}

async function resubmitDraft(row: ReservationRow): Promise<void> {
  try {
    const saved = await store.submit(
      {
        parcelId: row.parcelId,
        tankId: row.tankId,
        expectedAt: row.expectedAt,
        forecastVolumeL: row.forecastVolumeL,
        contact: row.contact,
        note: row.note
      },
      row.id,
      row.submittedAt
    )
    if (saved.status === '已承诺') ElMessage.success(`已占住罐 ${tankCode(saved.tankId)}（v${saved.commitmentVersion}）`)
    else if (saved.status === '排队中') ElMessage.warning(`罐位清洗中，已排队（第 ${saved.seq} 位）`)
    else ElMessage.warning(`仍差 ${-saved.shortfallL}L，继续保留草稿`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '重试失败，草稿与补偿仍保留')
  }
}

/* ------------------------------ 到厂登记 ------------------------------ */
const arrivalVisible = ref(false)
const arrivalRef = ref<FormInstance>()
const arrivalTarget = ref<ReservationRow | null>(null)
const arrivalForm = reactive<{ actualVolumeL: number; arrivedAt: string; actualBrix: number; force: boolean }>({
  actualVolumeL: 0,
  arrivedAt: today(),
  actualBrix: 23,
  force: false
})

function openArrival(row: ReservationRow): void {
  arrivalTarget.value = row
  arrivalForm.actualVolumeL = row.forecastVolumeL
  arrivalForm.arrivedAt = today()
  arrivalForm.actualBrix = 23
  arrivalForm.force = false
  arrivalVisible.value = true
}

const arrivalTankSummary = computed(() => (arrivalTarget.value ? summaryOf(arrivalTarget.value.tankId) : null))

async function doArrive(): Promise<void> {
  if (!arrivalTarget.value) return
  const valid = await arrivalRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const result = await store.arrive(
      {
        reservationId: arrivalTarget.value.id,
        actualVolumeL: arrivalForm.actualVolumeL,
        arrivedAt: arrivalForm.arrivedAt,
        actualBrix: arrivalForm.actualBrix
      },
      arrivalForm.force
    )
    if (result.outcome === 'overflow') {
      try {
        await ElMessageBox.confirm(
          `${result.reason}。是否仍强制入罐？强入后排不下的预约会自动退回「待复核」。`,
          '实际到厂超量',
          { type: 'warning', confirmButtonText: '强制入罐并重算', cancelButtonText: '返回改量' }
        )
      } catch {
        return
      }
      await store.arrive(
        {
          reservationId: arrivalTarget.value.id,
          actualVolumeL: arrivalForm.actualVolumeL,
          arrivedAt: arrivalForm.arrivedAt,
          actualBrix: arrivalForm.actualBrix
        },
        true
      )
    }
    ElMessage.success('到厂登记完成，批次已创建并已重算排队')
    arrivalVisible.value = false
  } catch (error) {
    ElMessage.error(`${error instanceof Error ? error.message : '到厂登记失败'}；动作已保留，可在失败列表重试`)
  }
}

/* ------------------------------ 取消 / 删除 / 重算 ------------------------------ */

async function cancel(row: ReservationRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`取消「${parcelName(row.parcelId)} → 罐 ${tankCode(row.tankId)}」的预约？`, '取消预约', {
      type: 'warning',
      confirmButtonText: '确认取消'
    })
  } catch {
    return
  }
  await store.cancel(row.id)
  ElMessage.success('预约已取消，预留容量已释放并重算')
}

async function remove(row: ReservationRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该预约单（含其失败补偿）？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.remove(row.id)
  ElMessage.success('预约单已删除')
}

async function recompute(): Promise<void> {
  const version = await store.recompute()
  commitmentVersion.value = version
  ElMessage.success(`排队已重算，当前承诺版本 v${version}`)
}

async function retryPending(pending: PendingWriteRow): Promise<void> {
  try {
    await store.retryPending(pending)
    ElMessage.success('重试成功，失败写入已完成')
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '重试仍失败，补偿记录已保留')
  }
}

async function dismissPending(pending: PendingWriteRow): Promise<void> {
  try {
    await ElMessageBox.confirm('放弃该失败写入？对应草稿仍会保留。', '放弃确认', { type: 'warning' })
  } catch {
    return
  }
  await store.dismissPending(pending.id)
  ElMessage.success('失败写入已放弃')
}

function pendingKindLabel(pending: PendingWriteRow): string {
  const reservation = reservations.value.find((item) => item.id === pending.reservationId)
  return `${pending.kind} · ${reservation ? parcelName(reservation.parcelId) : pending.reservationId}`
}

/* ------------------------------ 故障注入（演示失败重试） ------------------------------ */

async function toggleFaultCommit(value: boolean | string | number): Promise<void> {
  await store.toggleFault('commit', Boolean(value))
  ElMessage.success(Boolean(value) ? '已开启提交故障注入：下一次抢罐会失败并留草稿' : '已关闭提交故障注入')
}

async function toggleFaultArrive(value: boolean | string | number): Promise<void> {
  await store.toggleFault('arrive', Boolean(value))
  ElMessage.success(Boolean(value) ? '已开启到厂故障注入：下一次到厂登记会失败' : '已关闭到厂故障注入')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(async () => {
  store.applyQuery(route.query)
  await store.hydrateFaultFlags()
  await refreshVersion()
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(
  () => reservations.value.length,
  () => {
    void refreshVersion()
  }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">到厂预约与容量承诺</h2>
        <p class="page__subtitle">
          采收队还在路上，车间按电话先占罐：总预留不超剩余容量；同罐先提交的占住，后提交留草稿显示差多少升；
          超量 / 转清洗 / 取消后自动重算，排不下的退「待复核」。当前承诺版本 v{{ commitmentVersion }}
        </p>
      </div>
      <div>
        <el-button :icon="RefreshRight" @click="recompute">手动重算排队</el-button>
        <el-button @click="router.push(ROUTES.tanks)">罐位看板</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate()">电话新增预约</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="预约总数" :value="totals.total" suffix="单" icon="Files" tone="primary" />
      <StatBadge label="已承诺" :value="totals.committed" suffix="单" icon="Grid" tone="success" />
      <StatBadge label="排队中" :value="totals.queued" suffix="单" icon="DataLine" tone="info" />
      <StatBadge label="草稿" :value="totals.drafts" suffix="单" icon="Files" tone="warning" />
      <StatBadge label="待复核" :value="totals.review" suffix="单" icon="WarningFilled" tone="danger" />
      <StatBadge label="待重试写入" :value="totals.pendingWrites" suffix="条" icon="WarningFilled" tone="danger" />
    </div>

    <el-alert
      v-if="totals.pendingWrites > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb"
      title="存在写入失败但已保留的动作"
      description="预约与草稿没有丢，可逐条重试或放弃；重试成功后自动从列表消失。"
    />

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索地块 / 罐号 / 联系人 / 备注…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <!-- 失败写入补偿列表 -->
    <el-card v-if="pendingWrites.length > 0" shadow="never" class="mb">
      <template #header>
        <div class="card-title">
          <span><el-icon color="#c0392b"><WarningFilled /></el-icon> 失败写入（{{ pendingWrites.length }}）</span>
          <span class="muted">写库失败后保留的预约/草稿，可重试</span>
        </div>
      </template>
      <el-table :data="pendingWrites" stripe border>
        <el-table-column prop="kind" label="动作" width="120" />
        <el-table-column label="关联预约" min-width="220">
          <template #default="{ row }">{{ pendingKindLabel(row) }}</template>
        </el-table-column>
        <el-table-column prop="lastError" label="失败原因" min-width="240" show-overflow-tooltip />
        <el-table-column prop="attempts" label="尝试次数" width="90" align="right" />
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button link type="primary" @click="retryPending(row)">重试</el-button>
            <el-button link type="danger" @click="dismissPending(row)">放弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>预约队列（{{ filtered.length }} / {{ reservations.length }}）</span>
          <span class="muted">先到先得 · 已承诺/排队中挂账容量 · 草稿与待复核不占罐</span>
        </div>
      </template>

      <EmptyPanel
        v-if="ready && filtered.length === 0"
        title="还没有预约"
        description="采收队报点后先电话登记一条预约，容量够直接承诺占罐，不够会留草稿并提示差多少升。"
        create-text="电话新增预约"
        @create="openCreate()"
      />

      <el-table v-else :data="filtered" stripe border>
        <el-table-column label="地块 / 品种" min-width="160">
          <template #default="{ row }">
            <div>{{ parcelName(row.parcelId) }}</div>
            <div class="muted">{{ parcelVariety(row.parcelId) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="罐 / 排队" width="110">
          <template #default="{ row }">
            <div>{{ tankCode(row.tankId) }}</div>
            <div v-if="row.seq > 0" class="muted">第 {{ row.seq }} 位</div>
          </template>
        </el-table-column>
        <el-table-column prop="expectedAt" label="预计到厂" width="150" />
        <el-table-column label="预报/实际(L)" width="130" align="right">
          <template #default="{ row }">
            <div>{{ row.forecastVolumeL }}</div>
            <div v-if="row.actualVolumeL !== null" class="muted">实到 {{ row.actualVolumeL }}</div>
          </template>
        </el-table-column>
        <el-table-column label="罐容量占用" min-width="190">
          <template #default="{ row }">
            <template v-if="row.tankId && summaryOf(row.tankId)">
              <div class="muted" style="font-size: 12px">
                容 {{ summaryOf(row.tankId).capacityL }} · 在罐 {{ summaryOf(row.tankId).actualL }} ·
                预留 {{ summaryOf(row.tankId).reservedL }} ·
                <span :style="{ color: summaryOf(row.tankId).freeL < 0 ? '#c0392b' : '#1e8449' }">
                  余 {{ summaryOf(row.tankId).freeL }}L
                </span>
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="状态 / 差量" width="150">
          <template #default="{ row }">
            <StageTag :value="row.status" size="small" />
            <div v-if="row.shortfallL < 0" class="shortfall">还差 {{ -row.shortfallL }}L</div>
            <div v-else-if="row.status === '已承诺' || row.status === '排队中'" class="muted" style="font-size: 12px">
              占后余 {{ row.shortfallL }}L
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="contact" label="联系人" width="170" show-overflow-tooltip />
        <el-table-column prop="reason" label="说明" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="RESERVATION_ARRIVABLE_STATUSES.includes(row.status)"
              link
              type="success"
              @click="openArrival(row)"
            >
              到厂登记
            </el-button>
            <el-button v-if="row.status === '草稿'" link type="primary" @click="resubmitDraft(row)">重新抢罐</el-button>
            <el-button v-if="row.status === '待复核'" link type="warning" @click="openEdit(row)">改约/改量</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button
              v-if="row.status !== '已入罐' && row.status !== '已取消'"
              link
              type="warning"
              @click="cancel(row)"
            >
              取消
            </el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt">
      <template #header>
        <div class="card-title">
          <span>失败演练（故障注入）</span>
          <span class="muted">开启后下一次提交 / 到厂主事务会失败，用于验证「保留预约和草稿 → 重试」</span>
        </div>
      </template>
      <div class="fault-row">
        <span>提交抢罐故障</span>
        <el-switch :model-value="store.faultCommit" @change="toggleFaultCommit" />
        <span>到厂登记故障</span>
        <el-switch :model-value="store.faultArrive" @change="toggleFaultArrive" />
        <span class="muted">提示：开启后新增一条预约，可看到草稿与失败写入；关闭后点「重试」即可成功。</span>
      </div>
    </el-card>

    <!-- 预约表单 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑预约' : '电话新增到厂预约'" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="地块采收" prop="parcelId">
          <el-select v-model="form.parcelId" class="full" placeholder="选择地块">
            <el-option v-for="item in parcels" :key="item.id" :label="`${item.name}（${item.variety}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发酵罐" prop="tankId">
          <el-select v-model="form.tankId" class="full" placeholder="选择要占的罐">
            <el-option
              v-for="item in tanks"
              :key="item.id"
              :label="`${item.code} · ${item.material} ${item.capacityL}L · ${item.state}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="预计到厂" prop="expectedAt">
          <el-date-picker
            v-model="form.expectedAt"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm"
            format="YYYY-MM-DD HH:mm"
            class="full"
          />
        </el-form-item>
        <el-form-item label="预报采收量(L)" prop="forecastVolumeL">
          <el-input-number v-model="form.forecastVolumeL" :min="10" :max="60000" :step="50" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact" placeholder="采收组 / 司机 / 电话" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>

        <el-alert
          v-if="selectedTankSummary"
          :type="preview && !preview.fits ? 'warning' : 'info'"
          :closable="false"
          show-icon
          class="mt"
          :title="
            preview
              ? preview.fits
                ? `提交即可${preview.status === '排队中' ? '排队（罐清洗中）' : '占住罐位'}：占后罐内还剩 ${preview.shortfallL}L`
                : `抢不到：该罐剩余可承诺容量不足，还差 ${-preview.shortfallL}L，提交后会留草稿`
              : '填写预报采收量后预览容量承诺'
          "
          :description="`罐容量 ${selectedTankSummary.capacityL}L · 实际在罐 ${selectedTankSummary.actualL}L · 已承诺/排队预留 ${selectedTankSummary.reservedL}L · 当前可承诺余 ${selectedTankSummary.freeL}L`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button @click="doSaveDraft">仅存草稿</el-button>
        <el-button type="primary" :loading="store.busy" @click="doSubmit">提交抢罐</el-button>
      </template>
    </el-dialog>

    <!-- 到厂登记表单 -->
    <el-dialog v-model="arrivalVisible" title="采收车到厂登记" width="520px">
      <el-form ref="arrivalRef" :model="arrivalForm" label-width="110px">
        <el-form-item label="预约单">
          <span v-if="arrivalTarget">
            {{ arrivalTarget ? parcelName(arrivalTarget.parcelId) : '' }} · 罐
            {{ arrivalTarget ? tankCode(arrivalTarget.tankId) : '' }} · 预报 {{ arrivalTarget.forecastVolumeL }}L
          </span>
        </el-form-item>
        <el-form-item label="实际到厂量(L)" required>
          <el-input-number v-model="arrivalForm.actualVolumeL" :min="10" :max="60000" :step="50" />
        </el-form-item>
        <el-form-item label="到厂日期" required>
          <el-date-picker v-model="arrivalForm.arrivedAt" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="实际糖度(°Bx)">
          <el-input-number v-model="arrivalForm.actualBrix" :min="5" :max="40" :step="0.5" />
        </el-form-item>
        <el-alert
          v-if="arrivalTankSummary"
          :type="arrivalForm.actualVolumeL > arrivalTankSummary.freeL + arrivalTankSummary.reservedL ? 'warning' : 'info'"
          :closable="false"
          show-icon
          class="mt"
          :title="`罐容量 ${arrivalTankSummary.capacityL}L，其它预约预留 ${arrivalTankSummary.reservedL}L`"
          description="实际量超量时可选择强制入罐，系统会把排不下的其它预约退回「待复核」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="arrivalVisible = false">取消</el-button>
        <el-button type="primary" :loading="store.busy" @click="doArrive">确认到厂入罐</el-button>
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

.shortfall {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #c0392b;
}

.fault-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
}
</style>
