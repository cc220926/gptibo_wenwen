import {test} from 'node:test'
import assert from 'node:assert/strict'
import {supportedColumns,supportedTables} from './legacy-columns.mjs'
test('accept only the observed additive production recovery field',()=>{
 const table={name:'xgift_recovery_attempts',columns:[{name:'id',type:'TEXT',pk:1}]}
 assert(supportedColumns(table,table.columns))
 assert(supportedColumns(table,[{name:'previous_stage',type:'TEXT',pk:0},...table.columns]))
 assert(!supportedColumns(table,[...table.columns,{name:'unknown',type:'TEXT',pk:0}]))
 assert(!supportedColumns(table,[...table.columns,{name:'previous_stage',type:'INTEGER',pk:0}]))
 assert(!supportedColumns(table,[{name:'previous_stage',type:'TEXT',pk:0}]))
})

test('optional table inventory accepts known migrations and fails closed on unknown or missing tables',()=>{
 const base=[{name:'orders',columns:[]}]
 assert.deepEqual(supportedTables(base,['orders']).map(t=>t.name),['orders'])
 assert.deepEqual(supportedTables(base,['orders','partner_payout_accounts','recharge_api_reads']).map(t=>t.name),['orders','partner_payout_accounts','recharge_api_reads'])
 assert.throws(()=>supportedTables(base,['orders','unknown_table']))
 assert.throws(()=>supportedTables(base,['partner_payout_accounts']))
 assert.throws(()=>supportedTables(base,['orders','orders']))
 const account=supportedTables(base,['orders','partner_payout_accounts']).find(t=>t.name==='partner_payout_accounts')
 assert(supportedColumns(account,account.columns))
 assert(!supportedColumns(account,[...account.columns,{name:'unknown_secret',type:'TEXT',pk:0}]))
})
test('only explicit recharge ordinals and notification columns may extend legacy columns',()=>{
 for(const [name,keys] of [['recharge_redemptions',['remote_attempt_no']],['recharge_orders',['order_checked_notify_version','redemption_checked_notify_version']]]){
  const table={name,columns:[{name:'order_id',type:'TEXT',pk:1}]}
  assert(supportedColumns(table,table.columns))
  const columns=[...table.columns,...keys.map(name=>({name,type:'INTEGER',pk:0}))]
  assert(supportedColumns(table,columns))
  assert(!supportedColumns(table,[...columns,{name:'unexpected',type:'INTEGER',pk:0}]))
 }
})
