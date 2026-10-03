/**
 * v1 → v2 数据库升级迁移测试：
 * 用 v1 schema 建库灌入旧数据（无 reservations/meta 表、无承诺版本号），
 * 再用当前 db（v2）打开，验证旧数据可读、补承诺版本号、预约补录后能正确排队。
 * 运行：npx tsx scripts/migration.test.ts
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { strict as assert } from 'node:assert'
import { db, getCommitmentVersion, META_COMMITMENT_VERSION } from '../src/utils/db'

let passed = 0
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function buildV1Database(): Promise<void> {
  const v1 = new Dexie('gbwinetank-db')
  v1.version(1).stores({
    parcels: 'id, name, variety, aspect, updatedAt',
    tanks: 'id, code, material, tempControl, state, updatedAt',
    batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
    readings: 'id, batchId, date, updatedAt',
    operations: 'id, batchId, type, state, date, seq, updatedAt',
    mlfs: 'id, batchId, state, updatedAt',
    tastings: 'id, batchId, date, verdict, updatedAt'
  })
  await v1.parcels.bulkPut([
    { id: 'p1', name: '旧地', variety: '赤霞珠', areaMu: 1, vineAge: 1, aspect: '南', revision: 1, createdAt: 1, updatedAt: 1 }
  ])
  await v1.tanks.bulkPut([
    // 1000L 空罐
    { id: 't1', code: 'F-01', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '空闲', revision: 1, createdAt: 1, updatedAt: 1 }
  ])
  await v1.batches.bulkPut([])
  v1.close()
}

async function main(): Promise<void> {
  console.log('v1 → v2 升级：')
  await buildV1Database()

  // 当前版本的 db 单例打开同名库，Dexie 自动执行 v2.upgrade
  await db.open()

  const parcels = await db.parcels.toArray()
  ok('旧地块数据保留', parcels.length === 1 && parcels[0].name === '旧地')
  const tanks = await db.tanks.toArray()
  ok('旧罐数据保留', tanks.length === 1 && tanks[0].capacityL === 1000)

  const meta = await db.meta.get(META_COMMITMENT_VERSION)
  ok('升级后写入承诺版本号基线（v=0，无预约无需重排）', typeof meta?.value === 'number')
  ok('承诺版本号基线为 0', (await getCommitmentVersion()) === 0)

  // 模拟「旧数据升级后补承诺版本再排队」：直接插两条无版本号的历史预约（复刻升级后补录）
  const now = Date.now()
  await db.reservations.bulkPut([
    {
      id: 'old1', parcelId: 'p1', tankId: 't1', expectedAt: '2026-10-04 08:00', forecastVolumeL: 600,
      contact: '', note: '', status: '待复核', submittedAt: now - 2000, committedAt: null, seq: 0,
      shortfallL: 0, reason: '', actualVolumeL: null, arrivedAt: null, actualBrix: null, batchId: null,
      commitmentVersion: 0, revision: 1, createdAt: now, updatedAt: now
    },
    {
      id: 'old2', parcelId: 'p1', tankId: 't1', expectedAt: '2026-10-04 09:00', forecastVolumeL: 600,
      contact: '', note: '', status: '待复核', submittedAt: now - 1000, committedAt: null, seq: 0,
      shortfallL: 0, reason: '', actualVolumeL: null, arrivedAt: null, actualBrix: null, batchId: null,
      commitmentVersion: 0, revision: 1, createdAt: now, updatedAt: now
    }
  ])
  const { recomputeReservationQueues, getReservation } = await import('../src/utils/db')
  await recomputeReservationQueues()
  const first = await getReservation('old1')
  const second = await getReservation('old2')
  ok('补录后第一条（600/1000）承诺成功', first?.status === '已承诺')
  ok('补录后第二条（占后差200）退待复核', second?.status === '待复核' && second.shortfallL === -200)
  ok('重排后承诺版本号 +1', (await getCommitmentVersion()) === 1)

  db.close()
  console.log(`\n迁移测试 ${passed} 项断言通过 ✅`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
