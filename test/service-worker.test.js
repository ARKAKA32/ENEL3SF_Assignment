const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('service worker displays a push and opens only its own app',async()=>{
  const events={},shown=[],opened=[];
  const self={addEventListener:(name,fn)=>{events[name]=fn;},registration:{showNotification:async(title,options)=>shown.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async(url)=>opened.push(url)},location:{origin:'https://sentry.test'}};
  vm.runInNewContext(fs.readFileSync('public/sw.js','utf8'),{self,URL});
  let pending;events.push({data:{json:()=>({title:'Broadcast',body:'Road closed',url:'https://attacker.invalid'})},waitUntil:(p)=>{pending=p;}});await pending;
  assert.equal(shown[0].title,'Broadcast');assert.equal(shown[0].body,'Road closed');assert.equal(shown[0].data.url,'/');
  events.notificationclick({notification:{close(){}},waitUntil:(p)=>{pending=p;}});await pending;assert.deepEqual(opened,['/']);
});
