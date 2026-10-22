import sys, os
from collections import Counter
import stripe_simulator as sim
from fastapi import Request
from fastapi.responses import JSONResponse
app=sim.app
counts=Counter()
allowed={'STRIPE_SIM_CREATE_DELAY_MS','STRIPE_SIM_CAPTURE_DELAY_MS','STRIPE_SIM_CAPTURE_FAIL_RATE','STRIPE_SIM_CAPTURE_TRANSIENT_RATE'}
@app.middleware('http')
async def monitor(request:Request,call_next):
    path=request.url.path
    if path=='/__load__/config' and request.method=='POST':
        body=await request.json()
        if not set(body)<=allowed: return JSONResponse({'error':'unsupported option'},400)
        for key,value in body.items(): os.environ[key]=str(value)
        return JSONResponse({k:os.getenv(k,'0') for k in allowed})
    if path=='/__load__/state':
        return JSONResponse({'requests':dict(counts),'intents':[{k:v.get(k) for k in ['id','amount','amount_received','status','metadata','latest_charge']} for v in sim._INTENTS.values()]})
    key=request.method+' '+('/v1/payment_intents/:id/'+path.rsplit('/',1)[-1] if path.count('/')>3 else path.split('/pi_')[0])
    response=await call_next(request)
    counts[key+' '+str(response.status_code)]+=1
    return response
