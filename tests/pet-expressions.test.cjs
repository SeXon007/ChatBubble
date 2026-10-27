const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function expressionFixture() {
  const source = ts.createSourceFile('pet.js', fs.readFileSync(path.join(__dirname, '../src/ui/pet.js'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  let expression;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'expression') expression = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(expression);
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const context = { S: { face: { kind:'idle',action:'',drag:0,land:0,rest:0,lastActive:0,blinkAt:4200,blinkCount:0,dragAt:-Infinity,settleAt:-Infinity,settlePending:false,curiousArmed:false,peekStarted:-Infinity,lastPeekAt:-Infinity,peekCount:0,peekDirection:1 },
    hidden:false,wantsOpen:false,morph:0,drag:null,demo:null,side:null,mode:'idle',x:0,y:0,tx:0,ty:0,vx:0,vy:0,blend:0 },
    expressionPreview:{expression:'auto'},reduce:false,pet:{dataset:{}},config:{eyeSize:140},eyeScale:.86,
    clamp,lerp:(a,b,t)=>a+(b-a)*t,smooth:t=>{t=clamp(t,0,1);return t*t*(3-2*t);} };
  vm.createContext(context); vm.runInContext(expression.getText(source),context);
  return context;
}

test('curiosity requires prior pointer activity, swaps near/far eyes with direction, and returns to sleep once', () => {
  const c=expressionFixture();let face;
  for(let now=0;now<=60000;now+=16){face=c.expression(now,.016,0);assert.equal(face.curious,0);}
  assert.equal(c.S.face.kind,'rest');assert.ok(face.height<3);assert.equal(c.S.face.action,'');
  c.S.face.lastActive=60000;c.S.face.curiousArmed=true;
  let left=false,right=false,opened=false;
  for(let now=60016;now<=87000;now+=16){face=c.expression(now,.016,0);if(face.curious>.5){if(face.scanX<-5){left=true;assert.ok(face.asymmetry>0);}if(face.scanX>5){right=true;assert.ok(face.asymmetry<0);}opened ||= face.height>8;}}
  assert.ok(left&&right&&opened);assert.equal(c.S.face.action,'');assert.ok(face.height<3);
  for(let now=87016;now<=240000;now+=16)assert.equal(c.expression(now,.016,0).curious,0,'stationary mouse never starts another scan');
  c.S.face.lastActive=240000;face=c.expression(240016,.016,0);assert.equal(face.curious,0);
});

test('curiosity enforces a long cooldown and drops stale pointer activity',()=>{
  const c=expressionFixture();c.S.face.lastPeekAt=0;c.S.face.curiousArmed=true;c.S.face.lastActive=1000;
  assert.equal(c.expression(23000,.016,0).curious,0);c.expression(37000,.016,0);assert.equal(c.S.face.curiousArmed,false);
  c.S.face.lastActive=100000;c.S.face.curiousArmed=true;c.expression(122000,.016,0);assert.equal(c.S.face.lastPeekAt,122000);
});

test('drag reaction needs an actual drag, responds to motion, and does not change pet position', () => {
  const c=expressionFixture();c.S.drag={moved:false};c.S.face.dragAt=0;c.S.vx=600;
  const held=c.expression(100,.016,0);assert.equal(held.dragX,0);assert.equal(held.tilt,0);assert.equal(c.S.face.action,'');
  c.S.drag.moved=true;const face=c.expression(100,.016,0);
  assert.equal(c.S.face.action,'drag-recoil');assert.ok(Math.abs(face.tilt)>0);assert.ok(face.width>0&&face.height>0);
  assert.equal(c.S.x,0);assert.equal(c.S.tx,0);
});

test('settle reaction waits for motion to stop and produces two brief blinks', () => {
  const c=expressionFixture();c.S.face.settlePending=true;c.S.tx=50;
  c.expression(0,.016,0);assert.equal(c.S.face.settlePending,true);
  c.S.x=50;c.S.mode='snapping';c.S.blend=.5;c.expression(200,.016,0);assert.equal(c.S.face.settlePending,true);
  c.S.blend=1;c.expression(400,.016,0);assert.equal(c.S.face.settlePending,false);
  assert.ok(c.expression(545,.016,0).blink<.3);assert.equal(c.S.face.action,'settle-blink');
  assert.equal(c.expression(660,.016,0).blink,1);
  assert.ok(c.expression(795,.016,0).blink<.4);
  assert.equal(c.expression(1100,.016,0).blink,1);
});

test('reduced motion, hidden state and chat expansion suppress added actions; zero-delta redraw stays finite', () => {
  for(const mode of ['reduce','hidden','expanded']){
    const c=expressionFixture();c.S.face.settlePending=true;
    if(mode==='reduce')c.reduce=true;else if(mode==='hidden')c.S.hidden=true;else c.S.wantsOpen=true;
    const face=c.expression(19000,0,0);
    assert.equal(face.curious,0);assert.equal(face.tilt,0);assert.equal(c.S.face.action,'');assert.equal(c.S.face.settlePending,false);
    for(const v of Object.values(face))assert.ok(Number.isFinite(v));
  }
});
