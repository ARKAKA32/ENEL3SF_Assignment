const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('migration, atomic staff edits, role checks and reporter privacy', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create publication supabase_realtime;`);
    const base = fs.readFileSync('supabase/schema.sql','utf8').split('-- Increment 2:')[0].replace('create extension if not exists "pgcrypto";','');
    await db.exec(base);
    const migration = fs.readFileSync('supabase/migrations/002_increment2.sql','utf8');
    await db.exec(migration);
    await db.exec(migration); // Reapplying does not delete or reset existing data.
    for (let n=1;n<=5;n++) await db.query('insert into auth.users(id,email) values($1,$2)',[id(n),`user${n}@test.invalid`]);
    await db.query("update public.users set role = 'admin' where user_id=$1",[id(1)]);
    await db.query("update public.users set role = 'operator' where user_id=$1",[id(2)]);
    await db.query("update public.users set role = 'responder' where user_id=$1",[id(3)]);
    await db.query("update public.users set account_status='suspended' where user_id=$1",[id(5)]);
    await db.query("insert into public.incidents(incident_id,reporter_id,description,is_anon,category,severity,latitude,longitude) values($1,$2,'test',false,'other','medium',0,0),($3,null,'anonymous',true,'fire','high',0,0)",[id(10),id(4),id(11)]);
    async function actor(n) { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[n ? id(n) : '']); await db.exec('set role authenticated'); }
    async function current() { await db.exec('reset role'); return (await db.query('select *,updated_at::text as updated_at from incidents where incident_id=$1',[id(10)])).rows[0]; }
    async function save(n, changes={}) {
      const inc = await current(); await actor(n);
      return db.query('select * from public.save_incident_update($1,$2,$3,$4,$5,$6,$7,$8)',[id(10),changes.status ?? inc.status,changes.category ?? inc.category,changes.severity ?? inc.severity,changes.assigned_to === undefined ? inc.assigned_to : changes.assigned_to,changes.note || '',changes.public || false,changes.expected || inc.updated_at]);
    }
    await assert.rejects(save(4,{severity:'critical'}), /Staff access required/);
    await assert.rejects(save(5,{severity:'critical'}), /Staff access required/);
    await assert.rejects(save(2,{assigned_to:id(3),status:'assigned'}), /Only admins/);
    await assert.rejects(save(1,{assigned_to:id(4),status:'assigned'}), /active staff/);
    await assert.rejects(save(1,{assigned_to:null,status:'assigned'}), /Choose an assignee/);
    const before = await current();
    await save(1,{assigned_to:id(3),status:'assigned',category:'medical',severity:'critical',note:'internal secret'});
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from incident_updates')).rows[0].n,5);
    assert.equal((await current()).assigned_to,id(3));
    await assert.rejects(save(2,{severity:'low',expected:before.updated_at}), /Another staff member/);
    await save(2,{status:'resolved',note:'Help arrived',public:true});
    assert.ok((await current()).resolved_at);
    await save(2,{status:'in_progress'});
    assert.equal((await current()).resolved_at,null);
    await actor(4);
    assert.equal((await db.query('select * from incidents')).rows.length,1);
    const history = (await db.query('select * from incident_updates')).rows;
    assert.ok(history.some((h) => h.note === 'Help arrived'));
    assert.ok(!history.some((h) => h.note === 'internal secret' || h.update_type === 'ASSIGNMENT'));
    await assert.rejects(db.query("update incidents set severity='low'"), /permission denied/);
    await assert.rejects(db.query("insert into incidents(description) values('bypass')"), /permission denied/);
    await assert.rejects(db.query("update users set role='admin'"), /permission denied/);
    await assert.rejects(db.query('select * from push_subscriptions'), /permission denied/);
    await db.exec('reset role');
    await db.exec("insert into notifications(title,message,notification_type,expires_at) values('active','test','PUBLIC_BROADCAST',now()+interval '1 hour'),('expired','test','PUBLIC_BROADCAST',now()-interval '1 hour'),('private','test','ADMIN_ALERT',null)");
    await db.exec('set role anon');
    assert.deepEqual((await db.query('select title from notifications')).rows.map((r)=>r.title),['active']);
    await assert.rejects(db.query('select * from incidents'), /permission denied/);
    await db.exec('reset role');
    assert.equal((await db.query("select public from storage.buckets where id='incident-media'")).rows[0].public,false);
  } finally { await db.close(); }
});
