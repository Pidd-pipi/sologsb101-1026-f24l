import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'
import { db, initDatabase, listReservations, getCommitmentVersion } from '../src/utils/db'

async function main(): Promise<void> {
  await initDatabase()
  const rs = await listReservations()
  const byId = Object.fromEntries(rs.map((r) => [r.id, r]))
  assert.equal(byId['rsv-001'].status, '已承诺')
  assert.equal(byId['rsv-001'].shortfallL, 600)
  assert.equal(byId['rsv-002'].status, '草稿')
  assert.equal(byId['rsv-002'].shortfallL, -200)
  assert.equal(byId['rsv-003'].status, '排队中')
  assert.equal(byId['rsv-004'].status, '待复核')
  assert.equal(byId['rsv-004'].shortfallL, -50)
  assert.equal(byId['rsv-005'].status, '已入罐')
  assert.equal(byId['rsv-006-demo'].status, '草稿')
  assert.ok((await getCommitmentVersion()) >= 1)
  assert.equal(await db.pendingWrites.count(), 1)
  console.log('seed smoke test passed ✅')
  db.close()
}
void main()
