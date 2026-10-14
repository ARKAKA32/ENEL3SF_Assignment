const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../server');
const id = '00000000-0000-4000-8000-000000000010';
const owner = '00000000-0000-4000-8000-000000000004';
const responder = '00000000-0000-4000-8000-000000000003';
function fixture({failUpload=false,rpcError=null,anon=false}={}) {
  const tables={users:[{user_id:owner,role:'civilian',account_status:'active'},{user_id:responder,role:'responder',account_status:'active'},{user_id:'admin',role:'admin',account_status:'active'},{user_id:'suspended',role:'admin',account_status:'suspended'}],incidents:[{incident_id:id,reporter_id:anon?null:owner,is_anon:anon,status:'new',severity:'medium',category:'other',assigned_to:null,updated_at:'2026-10-03T10:00:00Z'}],incident_updates:[],incident_media:[],notifications:[],push_subscriptions:[]};
  const calls={rpc:[],push:[],stored:[],removed:[]};
  const db={auth:{getUser:async(token)=>({data:{user:token==='invalid'?null:{id:token}},error:token==='invalid'?{}:null})},
    from(name){
      let filters=[],action='select',values=null,one=false;
      const query={select(){return this;},eq(k,v){filters.push([k,v]);return this;},order(){return this;},single(){one=true;return this;},insert(v){action='insert';values=v;return this;},upsert(v){action='insert';values=v;return this;},delete(){action='delete';return this;},then(resolve){
        let data=tables[name].filter((row)=>filters.every(([k,v])=>row[k]===v));
        if(action==='insert'){data=Array.isArray(values)?values:[values];tables[name].push(...data);}
        if(action==='delete')tables[name]=tables[name].filter((row)=>!data.includes(row));
        resolve({data:one?data[0]:data,error:null});
      }}; return query;
    },storage:{from(){return {upload:async(p)=>{calls.stored.push(p);return {error:failUpload?{}:null};},remove:async(p)=>{calls.removed.push(...p);return {};},createSignedUrl:async(p)=>({data:{signedUrl:`https://storage.test/${p}`}})};}}};
  const push={enabled:true,send:async(payload,user)=>{calls.push.push({payload,user});return {};}};
  const userClient=()=>({rpc:async(name,args)=>{calls.rpc.push({name,args});return {data:[{...tables.incidents[0],status:args.p_status,severity:args.p_severity}],error:rpcError};}});
  const classify=async()=>({category:'fire',severity:'high',title:'Fire report',ai_notes:'Review classification'});
  return {app:createApp({db,userClient,push,classify}),tables,calls};
}
const update={status:'acknowledged',category:'medical',severity:'high',assigned_to:null,note:'',is_public:false,expected_updated_at:'2026-10-03T10:00:00Z'};
test('anonymous submission uses server-generated ID, zero coordinates and private attachments',async()=>{
  const {app,tables}=fixture();
  const result=await request(app).post('/api/incidents').field('description','Fire').field('is_anon','true').field('latitude','0').field('longitude','0').field('location_source','manual').attach('media',Buffer.from([255,216,255,0]),{filename:'test.jpg',contentType:'image/jpeg'});
  assert.equal(result.status,201);const inc=tables.incidents.at(-1);assert.equal(inc.reporter_id,null);assert.equal(inc.latitude,0);assert.equal(inc.longitude,0);assert.equal(inc.category,'fire');assert.ok(tables.incident_media[0].file_url.startsWith(`${inc.incident_id}/`));assert.equal(tables.incident_updates[0].is_public,false);
});
test('report remains saved when an optional media upload fails',async()=>{
  const {app,tables}=fixture({failUpload:true});
  const result=await request(app).post('/api/incidents').field('description','Fire').field('is_anon','true').attach('media',Buffer.from([255,216,255,0]),{filename:'test.jpg',contentType:'image/jpeg'});
  assert.equal(result.status,201);assert.ok(result.body.warnings.length);assert.equal(tables.incidents.length,2);assert.equal(tables.incident_media.length,0);
});
test('identified reporting requires a valid active account',async()=>{
  const {app}=fixture();
  assert.equal((await request(app).post('/api/incidents').send({description:'test',is_anon:false})).status,401);
  assert.equal((await request(app).post('/api/incidents').auth('invalid',{type:'bearer'}).send({description:'test',is_anon:false})).status,401);
  assert.equal((await request(app).post('/api/incidents').auth('suspended',{type:'bearer'}).send({description:'test',is_anon:false})).status,403);
});
test('civilian cannot edit even their own incident; staff RPC success pushes only to its reporter',async()=>{
  const {app,calls}=fixture();
  assert.equal((await request(app).patch(`/api/incidents/${id}`).auth(owner,{type:'bearer'}).send(update)).status,403);
  assert.equal(calls.rpc.length,0);
  const result=await request(app).patch(`/api/incidents/${id}`).auth(responder,{type:'bearer'}).send(update);
  assert.equal(result.status,200);assert.equal(calls.rpc.length,1);assert.equal(calls.push[0].user,owner);assert.ok(!JSON.stringify(calls.push[0]).includes('medical'));
});
test('stale edits and denied assignment return clear errors without pushing',async()=>{
  for(const [code,status] of [['40001',409],['42501',403]]) {
    const {app,calls}=fixture({rpcError:{code,message:'Rejected update'}});
    const result=await request(app).patch(`/api/incidents/${id}`).auth(responder,{type:'bearer'}).send(update);
    assert.equal(result.status,status);assert.equal(calls.push.length,0);
  }
});
test('another civilian and anonymous users cannot retrieve report media',async()=>{
  const {app}=fixture();
  assert.equal((await request(app).get(`/api/incidents/${id}/media`)).status,401);
  const other=fixture({anon:true});
  assert.equal((await request(other.app).get(`/api/incidents/${id}/media`).auth(owner,{type:'bearer'})).status,404);
  assert.equal((await request(app).get(`/api/incidents/${id}/media`).auth(owner,{type:'bearer'})).status,200);
});
test('broadcast permission is limited to admins/operators and delivery follows persistence',async()=>{
  const {app,calls,tables}=fixture();const body={title:'Road closed',message:'Use another route.',severity:'high',hours:2};
  assert.equal((await request(app).post('/api/broadcasts').auth(responder,{type:'bearer'}).send(body)).status,403);
  assert.equal((await request(app).post('/api/broadcasts').auth('admin',{type:'bearer'}).send(body)).status,201);
  assert.equal(tables.notifications.length,1);assert.equal(calls.push.length,1);assert.equal(calls.push[0].user,null);
});
test('public classification overwrite endpoint is removed',async()=>{
  const {app}=fixture();assert.equal((await request(app).post('/api/classify').send({incident_id:id,message:'minor'})).status,404);
});
