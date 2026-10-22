import { testSql, truncateTables, createTestEvent, assertEqual, assert } from './test-helpers.js';
import { RefundService } from '../services/RefundService.js';
import { MockStripeClient } from './MockStripeClient.js';
import { sql } from '../../services/db.js';
import type { StripeClient, INotificationService } from '../interfaces.js';
import crypto from 'node:crypto';
const notifications: INotificationService = { sendRegistrationConfirmation: async()=>{}, sendRefundConfirmation:async()=>{}, sendWaitlistAcknowledgement:async()=>{} };
async function registration() {
  await truncateTables();
  const eventId = await createTestEvent({availableSlots:9,confirmedCount:1});
  const id=crypto.randomUUID();
  await testSql`INSERT INTO registrations(registration_id,event_id,email,first_name,last_name,status,payment_intent_id,gross_amount_cents,net_amount_cents,confirmed_at) VALUES(${id},${eventId},'refund@test.invalid','Refund','Test','CONFIRMED',${'pi_'+id},10000,10000,now())`;
  return {id,eventId};
}
async function main() {
  let {id,eventId}=await registration();
  const stripe=new MockStripeClient();
  const service=new RefundService(stripe as unknown as StripeClient,notifications);
  const request={registrationId:id,refundType:'PARTIAL' as const,partialAmountCents:1000,reason:'test',operationId:crypto.randomUUID()};
  const results=await Promise.all([service.refundRegistration(request),service.refundRegistration(request)]);
  assert(results.every(r=>r.outcome==='PARTIAL_REFUND_ISSUED'),'both concurrent requests complete');
  let row=(await testSql`SELECT refunded_amount_cents FROM registrations WHERE registration_id=${id}`)[0];
  assertEqual(row.refunded_amount_cents,1000,'concurrent replay counted once');
  assertEqual((await testSql`SELECT count(*)::int n FROM refund_log`)[0].n,1,'one ledger entry');
  await service.refundRegistration(request);
  assertEqual((await testSql`SELECT refunded_amount_cents FROM registrations WHERE registration_id=${id}`)[0].refunded_amount_cents,1000,'delayed replay counted once');
  const full=await service.refundRegistration({registrationId:id,refundType:'FULL',reason:'test',operationId:crypto.randomUUID()});
  assertEqual(full.refundedAmountCents,9000,'full after partial uses remaining balance');
  row=(await testSql`SELECT * FROM registrations WHERE registration_id=${id}`)[0];
  assertEqual(row.refunded_amount_cents,10000,'ledger equals captured amount');
  assertEqual(row.status,'CANCELLED','full refund cancels');
  assertEqual((await testSql`SELECT available_slots FROM events WHERE event_id=${eventId}`)[0].available_slots,10,'slot restored once');
  console.log('PASS concurrent/delayed replay and partial then full');

  ({id,eventId}=await registration());
  const saved=new Map<string,{id:string;amount:number;status:string}>(); let loseResponse=true; let externalRefunds=0;
  const uncertain=new MockStripeClient() as unknown as StripeClient;
  uncertain.refunds.create=async(params,opts)=>{
    const key=(opts as {idempotencyKey:string}).idempotencyKey;
    if(!saved.has(key)){externalRefunds++;saved.set(key,{id:'re_'+crypto.randomUUID(),amount:params.amount as number,status:'succeeded'});}
    if(loseResponse){loseResponse=false;throw new Error('Response lost after refund accepted');}
    return saved.get(key)!;
  };
  const retrySvc=new RefundService(uncertain,notifications);
  const uncertainRequest={registrationId:id,refundType:'PARTIAL' as const,partialAmountCents:1000,reason:'test',operationId:'lost-response'};
  assertEqual((await retrySvc.refundRegistration(uncertainRequest)).outcome,'STRIPE_ERROR','unknown response remains pending');
  assertEqual((await retrySvc.refundRegistration({...uncertainRequest,operationId:'different-operation'})).outcome,'INTERNAL_ERROR','second operation blocked while uncertain');
  assertEqual(await retrySvc.reconcilePendingRefunds(),1,'recovery settles saved operation');
  assertEqual(externalRefunds,1,'one external refund despite lost response');
  assertEqual((await testSql`SELECT refunded_amount_cents FROM registrations WHERE registration_id=${id}`)[0].refunded_amount_cents,1000,'recovered ledger correct');
  console.log('PASS ambiguous refund recovery');

  const cancel=await retrySvc.refundEvent({eventId,refundType:'FULL',reason:'cancel'});
  assertEqual(cancel.totalFailed,0,'event cancellation settles remaining refund');
  assertEqual((await testSql`SELECT refunded_amount_cents FROM registrations WHERE registration_id=${id}`)[0].refunded_amount_cents,10000,'event cancellation totals remaining amount');
  assertEqual((await testSql`SELECT status FROM events WHERE event_id=${eventId}`)[0].status,'CANCELLED','settled event cancelled');
  console.log('PASS event cancellation after partial refund');

  ({id,eventId}=await registration());
  await testSql`UPDATE registrations SET status='PENDING_CAPTURE',net_amount_cents=NULL,confirmed_at=NULL WHERE registration_id=${id}`;
  const waiting=await service.refundEvent({eventId,refundType:'FULL',reason:'cancel'});
  assertEqual(waiting.totalFailed,1,'in-flight capture remains unresolved');
  assertEqual((await testSql`SELECT status FROM events WHERE event_id=${eventId}`)[0].status,'CANCELLING','admissions frozen during settlement');
  await testSql`UPDATE registrations SET status='CONFIRMED',net_amount_cents=10000,confirmed_at=now() WHERE registration_id=${id}`;
  assertEqual((await service.refundEvent({eventId,refundType:'FULL',reason:'cancel'})).totalFailed,0,'later capture refunded on resumed cancellation');
  assertEqual((await testSql`SELECT status FROM events WHERE event_id=${eventId}`)[0].status,'CANCELLED','resumed cancellation complete');
  console.log('PASS cancellation waits for in-flight capture');
}
main().then(()=>console.log('Refund stabilization checks complete')).catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await testSql.end();await sql.end();});
