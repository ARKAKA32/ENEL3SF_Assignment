const test = require('node:test');
const assert = require('node:assert/strict');
const { reportInput, validateFiles } = require('../server/validation');
const { validSubscription, createPush } = require('../server/push');
const { classifyIncident } = require('../server/classify');
test('report validation keeps zero coordinates and enforces anonymous ownership', () => {
  const input = reportInput({description:'smoke',is_anon:'true',latitude:'0',longitude:'0',location_source:'manual',location_text:'Gate A'},'actor');
  assert.equal(input.latitude,0); assert.equal(input.longitude,0); assert.equal(input.reporter_id,null);
  assert.throws(()=>reportInput({description:'test',is_anon:'false'}),/Log in/);
  assert.throws(()=>reportInput({description:'test',is_anon:'true',latitude:'91',longitude:'0',location_source:'manual'}),/Coordinates/);
  assert.throws(()=>reportInput({description:'test',is_anon:'true',latitude:'0'}),/both/);
  assert.equal(reportInput({description:'test',is_anon:true,location_text:'Landmark'}).location_source,'manual');
});
test('media rejects disguised or oversized files', () => {
  assert.throws(()=>validateFiles([{size:5,mimetype:'image/png',buffer:Buffer.from('<svg>')}]),/PNG or JPEG/);
  assert.throws(()=>validateFiles([{size:6*1024*1024,mimetype:'image/jpeg',buffer:Buffer.from([255,216,255])}]),/5 MB/);
  validateFiles([{size:8,mimetype:'image/png',buffer:Buffer.from([137,80,78,71,13,10,26,10])}]);
});
test('push subscription validation blocks arbitrary server destinations', () => {
  const subscription = {endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}};
  assert.ok(validSubscription(subscription));
  for (const endpoint of ['http://fcm.googleapis.com/test','https://localhost/test','https://fcm.googleapis.com.attacker.invalid/test','https://fcm.googleapis.com:444/test']) assert.equal(validSubscription({...subscription,endpoint}),false);
});
test('push delivery removes expired subscriptions and preserves transient failures', async () => {
  const prior = { public:process.env.VAPID_PUBLIC_KEY, private:process.env.VAPID_PRIVATE_KEY, subject:process.env.VAPID_SUBJECT };
  process.env.VAPID_PUBLIC_KEY='test'; process.env.VAPID_PRIVATE_KEY='test'; process.env.VAPID_SUBJECT='mailto:test@example.com';
  const deleted=[]; const deliveries=[];
  const db={from(table){
    if(table==='users') return {select(){return this;},eq(){return this;},single:async()=>({data:{account_status:'active'}})};
    return {select(){return this;},eq(key,value){if(this.removing)deleted.push(value); return this;},delete(){this.removing=true;return this;},then(resolve){resolve({data:[{endpoint:'expired',keys:{},user_id:'one'},{endpoint:'good',keys:{},user_id:'one'}]});}};
  }};
  const transport={setVapidDetails(){},async sendNotification(sub,payload){deliveries.push(JSON.parse(payload));if(sub.endpoint==='expired')throw {statusCode:410};}};
  try { const result=await createPush(db,transport).send({title:'test'},'one');assert.deepEqual(result,{}); assert.deepEqual(deleted,['expired']);assert.equal(deliveries.length,2); }
  finally { for(const [key,value] of Object.entries({VAPID_PUBLIC_KEY:prior.public,VAPID_PRIVATE_KEY:prior.private,VAPID_SUBJECT:prior.subject})) { if(value===undefined)delete process.env[key];else process.env[key]=value; } }
});
test('fallback classification works without external credentials',async()=>{
  const before=process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {const result=await classifyIncident('Smoke and fire in a building');assert.equal(result.category,'fire');}
  finally {if(before)process.env.ANTHROPIC_API_KEY=before;}
});
