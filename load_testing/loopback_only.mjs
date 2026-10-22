import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const a=Array.isArray(args[0])?args[0]:args;
 const first=a[0];
 const host=typeof first==='object' ? first?.host : (typeof a[1]==='string'?a[1]:undefined);
 if(host && !['127.0.0.1','::1','localhost'].includes(host)) {
  console.error('LOAD_TEST_EGRESS_BLOCKED',host); throw Error('Load tests only permit loopback networking');
 }
 return connect.apply(this,args);
};
if(process.env.STRIPE_SECRET_KEY!=='sk_test_loadtest_simulator'||process.env.STRIPE_SIMULATOR_HOST!=='127.0.0.1'||!new URL(process.env.DATABASE_URL ?? 'postgres://localhost/').pathname.startsWith('/flyte_load_')) throw Error('Unsafe load test environment');
console.log('LOAD_TEST_LOOPBACK_ONLY active; dummy Stripe key; isolated database');
