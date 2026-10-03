/**
 * 到厂预约 store：电话抢罐提交、草稿差量、到厂登记（超量强入）、
 * 取消/改约、容量与罐位变动后的排队重算、失败写入重试、故障注入。
 * 页面只读 store 并调用 actions，容量权威判定在 db.ts 的事务内完成。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Reservation, ReservationStatus } from '@/types/reservation'
import type { BatchRow, PendingWriteRow, ReservationRow, TankRow } from '@/utils/db'
import {
  cancelReservation as cancelReservationRow,
  db,
  dismissPendingWrite as dismissPendingWriteRow,
  getFaultFlags,
  getReservation,
  ROW_REVISION,
  recomputeReservationQueues,
  registerArrival,
  removeReservation as removeReservationRow,
  retryPendingWrite as retryPendingWriteRow,
  setFaultFlag as setFaultFlagRow,
  submitReservation,
  updateReservationDraft,
  type ArrivalInput
} from '@/utils/db'
import { evaluateSubmission, summarizeTank } from '@/utils/commitment'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import type { FilterModel } from '@/types/filter'

export const RESERVATION_FILTER_KEYS = ['resvStatuses', 'tankIds']

export type ReservationDraftForm = Omit<
  Reservation,
  | 'id'
  | 'status'
  | 'submittedAt'
  | 'committedAt'
  | 'seq'
  | 'shortfallL'
  | 'reason'
  | 'actualVolumeL'
  | 'arrivedAt'
  | 'actualBrix'
  | 'batchId'
  | 'commitmentVersion'
>

export const useReservationStore = defineStore('reservation', () => {
  const filters = ref<FilterModel>({ keyword: '', resvStatuses: [], tankIds: [] })
  const busy = ref(false)
  /** 最近一次提交/到厂的错误（页面弹提示） */
  const lastError = ref<string | null>(null)
  /** 故障注入开关（从 meta 水合） */
  const faultCommit = ref(false)
  const faultArrive = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', resvStatuses: [], tankIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, RESERVATION_FILTER_KEYS)
  }

  async function hydrateFaultFlags(): Promise<void> {
    const flags = await getFaultFlags()
    faultCommit.value = flags.commit
    faultArrive.value = flags.arrive
  }

  async function toggleFault(kind: 'commit' | 'arrive', enabled: boolean): Promise<void> {
    await setFaultFlagRow(kind, enabled)
    if (kind === 'commit') faultCommit.value = enabled
    else faultArrive.value = enabled
  }

  /** 提交前的容量预判（纯前端展示用；多标签页抢罐以事务内判定为准） */
  function previewCommit(
    tank: TankRow,
    batches: BatchRow[],
    reservations: ReservationRow[],
    volumeL: number,
    excludeId?: string
  ): ReturnType<typeof evaluateSubmission> {
    return evaluateSubmission(tank, batches, reservations, volumeL, Date.now(), excludeId)
  }

  /** 罐位看板的容量汇总（实际量 / 预留量 / 剩余可承诺） */
  function tankSummary(tank: TankRow, batches: BatchRow[], reservations: ReservationRow[]) {
    return summarizeTank(tank, batches, reservations)
  }

  /**
   * 电话预约抢罐。
   * 失败（容量不足/注入故障/写库异常）时 db 层已把单留草稿并记录补偿，
   * 这里把错误回传给页面提示，不吞异常。
   */
  async function submit(form: ReservationDraftForm, id?: string, submittedAt?: number): Promise<ReservationRow> {
    busy.value = true
    lastError.value = null
    const input = {
      id: id ?? createId('rsv'),
      parcelId: form.parcelId,
      tankId: form.tankId,
      expectedAt: form.expectedAt,
      forecastVolumeL: form.forecastVolumeL,
      contact: form.contact,
      note: form.note,
      submittedAt: submittedAt ?? Date.now()
    }
    try {
      return await submitReservation(input)
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : '提交失败'
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 保存草稿（不抢罐），用于先记下来稍后提交 */
  async function saveDraft(form: ReservationDraftForm, id?: string): Promise<string> {
    busy.value = true
    try {
      const now = Date.now()
      const draftId = id ?? createId('rsv')
      const existing = id ? await getReservation(id) : undefined
      await db.reservations.put({
        ...form,
        id: draftId,
        status: '草稿' as ReservationStatus,
        submittedAt: existing?.submittedAt ?? now,
        committedAt: null,
        seq: 0,
        shortfallL: existing?.shortfallL ?? 0,
        reason: existing?.reason ?? '仅保存草稿，尚未抢罐',
        actualVolumeL: existing?.actualVolumeL ?? null,
        arrivedAt: existing?.arrivedAt ?? null,
        actualBrix: existing?.actualBrix ?? null,
        batchId: existing?.batchId ?? null,
        commitmentVersion: existing?.commitmentVersion ?? 0,
        revision: existing?.revision ?? ROW_REVISION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
      return draftId
    } finally {
      busy.value = false
    }
  }

  /** 到厂登记：返回 arrived / overflow 两种结果，overflow 由页面确认后带 force=true 再调一次 */
  async function arrive(input: Omit<ArrivalInput, 'force'>, force = false) {
    busy.value = true
    lastError.value = null
    try {
      return await registerArrival({ ...input, force })
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : '到厂登记失败'
      throw error
    } finally {
      busy.value = false
    }
  }

  async function cancel(id: string): Promise<void> {
    await cancelReservationRow(id)
  }

  async function updateDraft(
    id: string,
    patch: Partial<Pick<Reservation, 'parcelId' | 'tankId' | 'expectedAt' | 'forecastVolumeL' | 'contact' | 'note'>>
  ): Promise<void> {
    await updateReservationDraft(id, patch)
  }

  async function remove(id: string): Promise<void> {
    await removeReservationRow(id)
  }

  /** 手动触发全量重算（容量/罐位异常后复核用） */
  async function recompute(): Promise<number> {
    return recomputeReservationQueues()
  }

  async function retryPending(pending: PendingWriteRow): Promise<void> {
    busy.value = true
    lastError.value = null
    try {
      await retryPendingWriteRow(pending.id)
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : '重试失败'
      throw error
    } finally {
      busy.value = false
    }
  }

  async function dismissPending(id: string): Promise<void> {
    await dismissPendingWriteRow(id)
  }

  return {
    filters,
    busy,
    lastError,
    faultCommit,
    faultArrive,
    setFilters,
    resetFilters,
    applyQuery,
    hydrateFaultFlags,
    toggleFault,
    previewCommit,
    tankSummary,
    submit,
    saveDraft,
    arrive,
    cancel,
    updateDraft,
    remove,
    recompute,
    retryPending,
    dismissPending
  }
})
