const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopBounds, placePet, petOptions, petDefaults, shapeRegions } = require('../dist/pet-state');
const { initialState, isState } = require('../dist/model');
const { mergeSettings, persistSettingsPatch } = require('../dist/settings');

test('approved pet defaults and legacy states retain connection, history and selected controls', () => {
  const state = initialState(); delete state.settings.petSize;
  assert(isState(state)); assert.equal(petOptions(state.settings).petSize,82);
  assert.equal(petDefaults.petColor,'#000000'); assert.equal(petDefaults.petEyeSize,140);
  const changed=mergeSettings(state.settings,{petEyeSize:100,petSize:70,petWidth:256});
  assert.equal(changed.baseUrl,state.settings.baseUrl); assert.equal(changed.petEyeSize,100);
  assert.equal(changed.petWidth,256); assert.equal(state.settings.petEyeSize,140);
  for(const patch of [{petSize:0},{petEyeSize:141},{petGaze:Infinity},{petColor:'url(x)'},{petEnabled:'true'},{petMotion:'__proto__'},{petShape:'custom'}])assert.throws(()=>mergeSettings(state.settings,patch));
});
test('pet autosave rolls back on disk failure without inspecting or requiring a connection',async()=>{
  const state=initialState(),before=state.settings;
  await assert.rejects(persistSettingsPatch(state,{petEyeSize:100},async()=>{throw Error('disk');}));
  assert.equal(state.settings,before);
  await persistSettingsPatch(state,{petEyeSize:100,petColor:'#3891ff'},async()=>{});
  assert.equal(state.settings.petEyeSize,100);assert.equal(state.settings.baseUrl,'');
});
test('display union supports negative coordinates, gaps and different work areas in DIP',()=>{
  const areas=[{id:1,x:-1280,y:100,width:1280,height:984},{id:2,x:0,y:0,width:1920,height:1040}];
  assert.deepEqual(desktopBounds(areas),{x:-1280,y:0,width:3200,height:1084});
  const left=placePet({x:-500,y:300,side:'left',displayId:1},areas,82);
  assert(Math.abs(left.x-(-1280+49*.82*.85))<.001);assert.equal(left.y,300);
  const moved=placePet({x:-500,y:300,side:'right',displayId:1},[areas[1]],82);
  assert.equal(moved.displayId,2);assert(moved.x>1800&&moved.x<1920);
  for(const side of ['left','right','top','bottom']){const p=placePet({x:99999,y:-9999,side},[areas[1]],100);assert(p.x>=0&&p.x<1920&&p.y>=0&&p.y<1040);}
});
test('native regions never become an unbounded desktop input surface from malformed IPC',()=>{
  const bounds={x:-500,y:0,width:1000,height:800};
  assert.deepEqual(shapeRegions([{x:-10,y:790,width:100,height:40}],bounds),[{x:0,y:790,width:90,height:10}]);
  for(const bad of [[],null,[{x:0,y:0,width:NaN,height:2}],[{x:0,y:0,width:-1,height:2}],Array(17).fill({x:0,y:0,width:1,height:1})])assert.throws(()=>shapeRegions(bad,bounds));
});
test('stored pet position and controls validate without invalidating prior version-one files',()=>{
  const state=initialState();state.petPosition={x:-400,y:250,side:'right',displayId:3};assert(isState(state));
  state.petPosition.side='bad';assert(!isState(state));state.petPosition.side=null;
  state.settings.petEyeSize=200;assert(!isState(state));delete state.settings.petEyeSize;assert(isState(state));
});
