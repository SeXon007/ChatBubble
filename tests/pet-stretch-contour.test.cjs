const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const file=ts.createSourceFile('pet.js',fs.readFileSync(path.join(__dirname,'../src/ui/pet.js'),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS),fns=new Map();
function visit(n){if(ts.isFunctionDeclaration(n))fns.set(n.name?.text,n);ts.forEachChild(n,visit);}visit(file);
function run(name,ctx){vm.createContext(ctx);vm.runInContext(fns.get(name).getText(file),ctx);return ctx;}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
test('stretch keeps every point on the attached contact face fixed',()=>{
  for(const side of ['left','right','top','bottom']){
    const S={x:side==='left'?34:side==='right'?766:400,y:side==='top'?34:side==='bottom'?566:300,side};
    const c=run('rightDeform',{S,rightPlay:{kind:'stretch',px:52,py:-43},scale:.82,smooth,clamp,activeArea:()=>({x:0,y:0,width:800,height:600})});
    for(const tangent of [-28,-10,0,10,28]){const p=side==='left'?[-34,tangent]:side==='right'?[34,tangent]:side==='top'?[tangent,-34]:[tangent,34];const q=c.rightDeform(...p);assert.ok(Math.hypot(q[0]-p[0],q[1]-p[1])<1e-8,side+' contact must stay fixed');}
  }
});
test('releasing an unmoved right press never changes the native window region',()=>{
  const calls=[],c=run('releaseRightCapture',{pet:{hasPointerCapture:()=>true,releasePointerCapture:()=>{}},host:{setRegions:(...args)=>{calls.push(args);return Promise.resolve();}},lastRegionRects:[{x:100,y:100,width:90,height:90}],lastRegions:'old'});
  c.releaseRightCapture({pointerId:7,kind:'stretch',holding:true,moved:false});assert.deepEqual(calls,[]);
});
test('boundary limiting scales the whole deformation rather than cutting separate points',()=>{
  const c=run('fitRightStretch',{activeArea:()=>({x:0,y:0,width:100,height:100})}),base=[[70,50],[70,60],[50,60]],closed=[[110,50],[90,60],[50,60]],points=closed.map(p=>[...p]);
  c.fitRightStretch(base,closed,points,0);assert.equal(closed[0][0],100);assert.equal(closed[1][0],85);assert.deepEqual(closed[2],base[2]);assert.deepEqual(points,closed);
});
test('left release keeps the paint envelope and exact input region until spring return',()=>{
  const calls=[],region=[{x:400,y:300,width:90,height:90}],paint=[{x:200,y:150,width:480,height:420}];
  const c=run('end',{S:{drag:{id:1,moved:true},side:null,x:400,y:300,tx:520,ty:330},pet:{hasPointerCapture:()=>false},host:{setRegions:(...a)=>{calls.push(a);return Promise.resolve();}},lastRegionRects:region,lastRegions:'old',leftPaint:paint,wake:()=>{},clear:()=>{},queueMicrotask:()=>{},move:()=>{}});
  c.end({pointerId:1},true);assert.equal(c.S.drag,null);assert.equal(calls.length,1);assert.equal(calls[0][0],region);assert.equal(calls[0][1],false);assert.equal(calls[0][2],paint);
});
