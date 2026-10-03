/**
 * 容量承诺链路端到端逻辑测试（node + fake-indexeddb，不依赖浏览器/DOM）。
 * 运行：npx tsx scripts/commitment.test.ts
 */
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'
import {
  db,
  submitReservation,
  registerArrival,
  cancelReservation,
  recomputeReservationQueues,
  retryPendingWrite,
  setFaultFlag,
  getCommitmentVersion,
  updateTank,
  shipBatch,
  putBatch,
  ROW_REVISION,
  type TankRow,
  type ParcelRow,
  type BatchRow,
  listPendingWrites,
  getReservation
} from '../src/utils/db'
import type { ReservationInput } from '../src/utils/db'

let passed = 0
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function seedBase(): Promise<void> {
  const now = Date.now()
  const parcels: ParcelRow[] = [
    { id: 'p1', name: 'A地', variety: '赤霞珠', areaMu: 1, vineAge: 5, aspect: '南', revision: 1, createdAt: now, updatedAt: now }
  ]
  const tanks: TankRow[] = [
    { id: 't1', code: 'F-01', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '空闲', revision: 1, createdAt: now, updatedAt: now },
    { id: 't2', code: 'F-02', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '清洗中', revision: 1, createdAt: now, updatedAt: now },
    { id: 't3', code: 'F-03', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '空闲', revision: 1, createdAt: now, updatedAt: now }
  ]
  await db.parcels.bulkPut(parcels)
  await db.tanks.bulkPut(tanks)
}

function input(partial: Partial<ReservationInput>): ReservationInput {
  return {
    id: `r${Math.random().toString(36).slice(2, 8)}`,
    parcelId: 'p1',
    tankId: 't1',
    expectedAt: '2026-10-05 08:00',
    forecastVolumeL: 600,
    contact: '班组',
    note: '',
    submittedAt: Date.now() + (partial.submittedAtOffset ?? 0),
    ...partial
  }
}

async function main(): Promise<void> {
  console.log('1) 容量承诺 + 总预留不超剩余容量')
  await seedBase()
  const r1 = await submitReservation(input({ forecastVolumeL: 600, submittedAtOffset: 1 }))
  ok('600L 预约已承诺', r1.status === '已承诺')
  const r2 = await submitReservation(input({ forecastVolumeL: 600, submittedAtOffset: 2 }))
  ok('再来 600L（仅剩400）留草稿', r2.status === '草稿')
  ok('草稿差量为 -200L', r2.shortfallL === -200)
  const r3 = await submitReservation(input({ forecastVolumeL: 400, submittedAtOffset: 3 }))
  ok('400L 刚好占满 → 已承诺', r3.status === '已承诺')

  console.log('2) 多个标签页同罐先到先得（同一时刻并发）')
  const t = Date.now()
  const results = await Promise.all([
    submitReservation(input({ id: 'c1', tankId: 't2', forecastVolumeL: 600, submittedAt: t })),
    submitReservation(input({ id: 'c2', tankId: 't2', forecastVolumeL: 600, submittedAt: t }))
  ])
  // t2 清洗中 1000L：两单都能挂账，但第二单占后余 -200 → 草稿
  ok('并发第一单排队中（罐在洗）', results[0].status === '排队中')
  ok('并发第二单草稿', results[1].status === '草稿')
  ok('并发第二单差 200L', results[1].shortfallL === -200)

  console.log('3) 取消后排队重算，草稿不自动补，待复核补回')
  // 取消 t1 上的 400L 单：t1 的 600L 草稿仍是草稿（草稿不参与排队，需人工重新抢罐）
  await cancelReservation(r3.id)
  const r2After = await getReservation(r2.id)
  ok('取消后草稿仍是草稿（需人工再提交）', r2After?.status === '草稿')
  // 取消 400L 单后罐内余 400L：把 600L 草稿改量为 400L 重新抢罐应成功
  const r2Retry = await submitReservation(
    input({ id: r2.id, forecastVolumeL: 400, submittedAt: r2.submittedAt })
  )
  ok('草稿改量重新抢罐成功（同一 submittedAt 保持顺序）', r2Retry.status === '已承诺')

  console.log('4) 罐转清洗：已承诺降排队；洗回空闲：排队升承诺')
  await updateTank('t1', { state: '清洗中' })
  await recomputeReservationQueues()
  ok('t1 转清洗后承诺单变排队中', (await getReservation(r1.id))?.status === '排队中')
  await updateTank('t1', { state: '空闲' })
  await recomputeReservationQueues()
  ok('t1 洗完后排队单升回已承诺', (await getReservation(r1.id))?.status === '已承诺')

  console.log('5) 实际入罐超量 → 排不下的单退「待复核」（独立罐 t3）')
  // t3 空罐 1000L：800L 已承诺 + 200L 已承诺（刚好满）
  const a1 = await submitReservation(input({ id: 'ov1', tankId: 't3', forecastVolumeL: 800, submittedAtOffset: 10 }))
  const a2 = await submitReservation(input({ id: 'ov2', tankId: 't3', forecastVolumeL: 200, submittedAtOffset: 11 }))
  ok('t3：800L 与 200L 均已承诺', a1.status === '已承诺' && a2.status === '已承诺')
  // a1 到厂强入 900L（预报 800）：900+200=1100 > 1000
  const arrival = await registerArrival({
    reservationId: a1.id,
    actualVolumeL: 900,
    arrivedAt: '2026-10-05',
    actualBrix: 23,
    force: false
  })
  ok('非强入返回 overflow', arrival.outcome === 'overflow')
  const forced = await registerArrival({
    reservationId: a1.id,
    actualVolumeL: 900,
    arrivedAt: '2026-10-05',
    actualBrix: 23,
    force: true
  })
  ok('强入成功并创建批次', forced.outcome === 'arrived' && forced.batchId.length > 0)
  const a2After = await getReservation(a2.id)
  ok('排不下的 200L 单退「待复核」', a2After?.status === '待复核')
  ok('待复核单记录差量（-100L）', a2After?.shortfallL === -100)

  console.log('6) 出罐释放后待复核自动补回已承诺')
  await shipBatch(forced.batchId)
  const a2Recovered = await getReservation(a2.id)
  ok('出罐后待复核单补回已承诺', a2Recovered?.status === '已承诺')

  console.log('7) 写入失败 → 保留草稿 + outbox，可重试')
  await setFaultFlag('commit', true)
  let failed = false
  const failedInput = input({ id: 'fail1', forecastVolumeL: 100, tankId: 't3', submittedAt: Date.now() + 1000 })
  try {
    await submitReservation(failedInput)
  } catch {
    failed = true
  }
  ok('故障时提交抛错', failed)
  const draft = await getReservation('fail1')
  ok('失败后预约以草稿保留', draft?.status === '草稿')
  const pending = (await listPendingWrites()).find((p) => p.reservationId === 'fail1')
  ok('失败写入进入 outbox', pending?.kind === '提交预约')
  await setFaultFlag('commit', false)
  await retryPendingWrite(pending!.id)
  ok('重试成功后预约已承诺', (await getReservation('fail1'))?.status === '已承诺')
  ok('重试成功后补偿被清除', (await listPendingWrites()).every((p) => p.reservationId !== 'fail1'))

  console.log('8) 承诺版本号随队列变更递增')
  ok('承诺版本号 > 0', (await getCommitmentVersion()) > 0)

  await db.close()
  console.log(`\n全部 ${passed} 项断言通过 ✅`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

// 避免未使用告警
void ({} as BatchRow)
void ROW_REVISION
