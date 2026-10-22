#!/usr/bin/env python3
"""Bounded, loopback-only scenario runner for stress_test.py.
Uses a dedicated flyte_load_* database and the instrumented local simulator.
Raw per-request timings and independently queried DB/processor state are saved.
"""
import argparse, asyncio, contextlib, io, json, os, time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse
import aiohttp, psycopg2, psutil
from psycopg2.extras import RealDictCursor
from rich.console import Console
import stress_test as load

async def main(args):
    for url in [args.url,args.simulator_url,args.dsn]:
        if urlparse(url).hostname not in ('127.0.0.1','localhost','::1'):
            raise SystemExit('Only loopback test targets are permitted')
    if not urlparse(args.dsn).path.startswith('/flyte_load_'):
        raise SystemExit('A dedicated flyte_load_* database is required')
    output=Path(args.output); output.mkdir(parents=True,exist_ok=True)
    conn=psycopg2.connect(args.dsn);conn.autocommit=True
    def query(sql,params=()):
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql,params)
            return [dict(row) for row in cur.fetchall()] if cur.description else []
    process=psutil.Process(args.app_pid)
    load.console=Console(file=io.StringIO(),force_terminal=False)
    scenarios=[
      ('warmup',1,20,100,0,0,0,True),
      ('baseline-c1',1,100,200,0,0,0,True),
      ('baseline-c10',10,500,600,0,0,0,True),
      ('baseline-c50',50,1000,1200,0,0,0,True),
      ('baseline-c100',100,1500,1700,0,0,0,True),
      ('baseline-c250',250,2000,2300,0,0,0,True),
      ('latency-c50',50,500,600,50,150,0,True),
      ('latency-c100',100,500,600,50,150,0,True),
      ('sellout-c100',100,500,50,20,50,0,True),
      ('single-ip-limit',10,100,200,0,0,0,False),
      ('capture-outage',25,50,100,0,0,1,True),
      ('duplicate-c100',100,100,200,0,0,0,True),
      ('declines-c25',25,50,100,0,0,0,True),
      ('soak-c100',100,30000,31000,50,150,0,True),
    ]
    if args.scenario: scenarios=[s for s in scenarios if s[0]==args.scenario]
    report=[]
    async with aiohttp.ClientSession() as api:
      for name,concurrency,total,capacity,create_delay,capture_delay,transient,bypass in scenarios:
        async with api.post(args.simulator_url+'/__load__/config',json={
          'STRIPE_SIM_CREATE_DELAY_MS':create_delay,'STRIPE_SIM_CAPTURE_DELAY_MS':capture_delay,
          'STRIPE_SIM_CAPTURE_FAIL_RATE':1 if name.startswith('declines') else 0,'STRIPE_SIM_CAPTURE_TRANSIENT_RATE':transient}) as resp:
            resp.raise_for_status()
        event_id=str(query("INSERT INTO events(name,event_date,total_capacity,available_slots,registration_fee_cents,status) VALUES(%s,now()+interval '30 days',%s,%s,1200,'OPEN') RETURNING event_id",('Load '+name,capacity,capacity))[0]['event_id'])
        metrics=[];done=False
        async def sample():
          while not done:
            metrics.append({'at':time.time(),'rss_mb':round(process.memory_info().rss/1048576,2),'cpu_percent_one_core':process.cpu_percent(None)})
            await asyncio.sleep(.5)
        monitor=asyncio.create_task(sample())
        print(json.dumps({'starting':name,'concurrency':concurrency,'attempts':total}),flush=True)
        original_email=load._random_email
        if name.startswith('duplicate'): load._random_email=lambda _: 'duplicate-'+event_id+'@example.invalid'
        try:
          stats=await load.run_load_test(args.url,event_id,concurrency,total,0,'1+3',30,bypass,str(output/(name+'.json')),args.simulator_url)
        finally:
          load._random_email=original_email
          done=True;await monitor
        unexpected=[r for r in stats.results if r.outcome in ('ERROR','NETWORK_ERROR','VALIDATION_ERROR','CSRF_REJECTED','UNVERIFIED','UNVERIFIED_REDIRECT')]
        if unexpected: raise RuntimeError(f'Invalid run: {len(unexpected)} unexpected outcomes, first: {unexpected[0]}')
        states=query('SELECT status,count(*)::int n FROM registrations WHERE event_id=%s GROUP BY status',(event_id,))
        event=query('SELECT status,total_capacity,confirmed_count,available_slots FROM events WHERE event_id=%s',(event_id,))[0]
        regs=query('SELECT registration_id::text,payment_intent_id,status,gross_amount_cents,net_amount_cents FROM registrations WHERE event_id=%s',(event_id,))
        async with api.get(args.simulator_url+'/__load__/state') as resp:sim=await resp.json()
        intents={i['id']:i for i in sim['intents'] if i.get('metadata',{}).get('eventId')==event_id}
        confirmed=[r for r in regs if r['status']=='CONFIRMED']
        expected = 1 if name.startswith('duplicate') else (capacity if name.startswith('sellout') else (60 if name=='single-ip-limit' else (0 if name in ('capture-outage','declines-c25') else total)))
        if len(confirmed)!=expected: raise RuntimeError(f'{name}: expected {expected} confirmations, got {len(confirmed)}')
        if name.startswith('declines') and any(r['status']!='PAYMENT_FAILED' for r in regs): raise RuntimeError('Definite declines must release their reservations')
        if name=='capture-outage' and any(r['status']!='PENDING_CAPTURE' for r in regs): raise RuntimeError('Uncertain capture must preserve reservations')
        reserved=[r for r in regs if r['status'] in ('CONFIRMED','PENDING_CAPTURE')]
        mismatches=[r['registration_id'] for r in confirmed if intents.get(r['payment_intent_id'],{}).get('status')!='succeeded' or intents.get(r['payment_intent_id'],{}).get('amount_received')!=r['gross_amount_cents']]
        captured_unconfirmed=[i['id'] for i in intents.values() if i['status']=='succeeded' and not any(r['payment_intent_id']==i['id'] and r['status']=='CONFIRMED' for r in regs)]
        summary=load._build_summary(stats,'1+3')
        row={'scenario':name,'event_id':event_id,'concurrency':concurrency,'attempts':total,'create_delay_ms':create_delay,'capture_delay_ms':capture_delay,'capture_transient_rate':transient,'summary':summary,'database_states':states,'event':event,'simulator_states':dict(Counter(i['status'] for i in intents.values())),
             'confirmed_per_second':round(len(confirmed)/summary['total_duration_s'],2),
             'integrity':{'capacity_equation':event['confirmed_count']+event['available_slots']==event['total_capacity'],'reserved_matches_rows':event['confirmed_count']==len(reserved),'not_oversold':event['confirmed_count']<=capacity,'confirmed_payment_mismatches':mismatches,'captured_unconfirmed':captured_unconfirmed},
             'resources':{'peak_app_rss_mb':max(m['rss_mb'] for m in metrics),'peak_app_cpu_percent_one_core':max(m['cpu_percent_one_core'] for m in metrics)},'samples':metrics}
        report.append(row)
        (output/'scenarios.json').write_text(json.dumps(report,indent=2,default=str))
        print(json.dumps({k:row[k] for k in ['scenario','confirmed_per_second','database_states','event','integrity','resources']}),flush=True)
        if not all([row['integrity']['capacity_equation'],row['integrity']['reserved_matches_rows'],row['integrity']['not_oversold']]) or mismatches or captured_unconfirmed:
            raise RuntimeError('Financial/capacity inconsistency: stopping load')
      await api.post(args.simulator_url+'/__load__/config',json={'STRIPE_SIM_CREATE_DELAY_MS':0,'STRIPE_SIM_CAPTURE_DELAY_MS':0,'STRIPE_SIM_CAPTURE_FAIL_RATE':0,'STRIPE_SIM_CAPTURE_TRANSIENT_RATE':0})
    conn.close()

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--url',default='http://127.0.0.1:53010');p.add_argument('--simulator-url',default='http://127.0.0.1:12121')
    p.add_argument('--dsn',required=True);p.add_argument('--app-pid',type=int,required=True);p.add_argument('--output',required=True);p.add_argument('--scenario')
    asyncio.run(main(p.parse_args()))
