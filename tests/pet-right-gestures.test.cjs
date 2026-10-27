const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture(){
  const source=ts.createSourceFile('pet.js',fs.readFileSync(path.join(__dirname,'../src/ui/pet.js'),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS),functions=new Map();
  function visit(n){if(ts.isFunctionDeclaration(n))functions.set(n.name?.text,n);ts.forEachChild(n,visit);}visit(source);
  const events=[],frames=[],p={kind:'stretch',pointerId:7,holding:true,moved:false,startX:100,startY:100,rawX:0,rawY:0},context={rightPlay:p,S:{drag:null,x:100,y:100},scale:.82,rightPaintRegion:()=>[],lastRegionRects:[],wake:()=>{},releaseRightCapture:()=>events.push('capture-released'),rightCancel:()=>{context.rightPlay=null;},startRightHop:()=>events.push('hop'),draw:()=>events.push('draw'),performance:{now:()=>0},queueMicrotask:fn=>frames.push(fn)};
  vm.createContext(context);for(const name of ['rightMove','rightRelease'])vm.runInContext(functions.get(name).getText(source),context);
  return {context,p,events,frames};
}
const up=(x=100,y=100,type='pointerup',id=7)=>({type,pointerId:id,clientX:x,clientY:y});
test('right click hops only on release and drops native capture without waiting for a frame',()=>{
  const f=fixture();assert.deepEqual(f.events,[]);f.context.rightRelease(up());assert.deepEqual(f.events,['capture-released','hop']);assert.equal(f.frames.length,1);
});
test('a fast right drag with no intermediate move cannot become a hop',()=>{
  const f=fixture();f.context.rightRelease(up(180,120));assert.equal(f.p.moved,true);assert.equal(f.p.holding,false);assert.deepEqual(f.events,['capture-released']);assert.equal(f.p.rawX,0);
});
test('a right drag returning to its start still releases as a stretch',()=>{
  const f=fixture();f.context.rightMove(up(160,100,'pointermove'));f.context.rightMove(up(100,100,'pointermove'));f.context.rightRelease(up());assert.equal(f.p.moved,true);assert.ok(!f.events.includes('hop'));
});
test('pointer cancellation and capture loss never hop, including an unmoved press',()=>{
  for(const type of ['pointercancel','lostpointercapture']){const f=fixture();f.context.rightRelease(up(100,100,type));assert.equal(f.p.holding,false);assert.deepEqual(f.events,['capture-released']);}
});
test('an unrelated pointer and repeated release cannot start another action',()=>{
  const f=fixture();f.context.rightRelease(up(100,100,'pointerup',8));assert.deepEqual(f.events,[]);f.context.rightRelease(up());f.context.rightRelease(up());assert.equal(f.events.filter(e=>e==='hop').length,1);
});
