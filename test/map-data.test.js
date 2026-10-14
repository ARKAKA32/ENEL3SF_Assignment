const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinates, filterIncidents, heatPoints } = require('../public/map-data');
const now = Date.parse('2026-10-14T12:00:00Z');
const records = [
  {status:'new',category:'fire',severity:'high',created_at:'2026-10-14T10:00:00Z',latitude:0,longitude:'0'},
  {status:'resolved',category:'medical',severity:'critical',created_at:'2026-10-10T10:00:00Z',latitude:'-29.8',longitude:'31'},
  {status:'assigned',category:'medical',severity:'low',created_at:'2026-08-10T10:00:00Z',latitude:null,longitude:null},
];
test('map accepts valid zero/string coordinates and omits missing or invalid coordinates', () => {
  assert.deepEqual(coordinates(records[0]),[0,0]);
  for(const latitude of [null,undefined,'', ' ', true, [], 'wrong',Infinity,91]) assert.equal(coordinates({latitude,longitude:0}),null);
  assert.equal(coordinates({latitude:0,longitude:181}),null);
});
test('map filters combine status, category, severity and time without changing source data', () => {
  assert.deepEqual(filterIncidents(records,{status:'active'},now),[records[0],records[2]]);
  assert.deepEqual(filterIncidents(records,{status:'finished'},now),[records[1]]);
  assert.deepEqual(filterIncidents(records,{status:'all',category:'medical',severity:'critical',days:7},now),[records[1]]);
  assert.deepEqual(filterIncidents(records,{status:'new',days:1},now),[records[0]]);
  assert.deepEqual(filterIncidents(records,{days:1,category:'medical'},now),[]);
  assert.equal(records.length,3);
});
test('density gives each geolocated report equal weight; severity weighting is explicit', () => {
  assert.deepEqual(heatPoints(records),[[0,0,1],[-29.8,31,1]]);
  assert.deepEqual(heatPoints(records,true),[[0,0,0.75],[-29.8,31,1]]);
  assert.deepEqual(heatPoints([]),[]);
});
