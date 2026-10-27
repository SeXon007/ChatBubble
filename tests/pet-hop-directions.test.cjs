const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture(x,y,area={x:0,y:0,width:1920,height:1080}) {
 const source=ts.createSourceFile('pet.js',fs.readFileSync(path.join(__dirname,'../src/ui/pet.js'),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
 let fn;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='rightTarget')fn=n;ts.forEachChild(n,visit)}visit(source);
 let seed=719;const random=Object.create(Math);random.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 const c={S:{x,y},scale:.82,rightTuning:{distance:126},activeArea:()=>area,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),Math:random};vm.createContext(c);vm.runInContext(fn.getText(source),c);return c;
}
test('edge hops include substantial travel in both tangent directions instead of scoring toward the centre',()=>{
 for(const [edge,x,y] of [['left',35,540],['right',1885,540],['top',960,35],['bottom',960,1045]]) {
  const c=fixture(x,y);let positive=0,negative=0;
  for(let i=0;i<2048;i++){const p=c.rightTarget(),dx=p.x-x,dy=p.y-y;const tangent=['left','right'].includes(edge)?dy:dx,inward=['left','right'].includes(edge)?dx:dy;if(Math.abs(tangent)>Math.abs(inward)){if(tangent>0)positive++;else negative++;}}
  assert.ok(positive>2048*.2,`${edge}: positive tangent only ${positive}/2048`);
  assert.ok(negative>2048*.2,`${edge}: negative tangent only ${negative}/2048`);
 }
});
test('random hop targets remain inside all four boundaries including corners and small displays',()=>{
 for(const area of [{x:0,y:0,width:1920,height:1080},{x:0,y:0,width:320,height:360},{x:-800,y:100,width:800,height:600}]) {
  for(const [u,v] of [[.5,.5],[0,0],[1,0],[0,1],[1,1],[0,.5],[1,.5],[.5,0],[.5,1]]) {
   const c=fixture(area.x+35+u*(area.width-70),area.y+35+v*(area.height-70),area),margin=69*.82+4;
   for(let i=0;i<128;i++){const p=c.rightTarget();assert.ok(p.x>=area.x+margin&&p.x<=area.x+area.width-margin);assert.ok(p.y>=area.y+margin&&p.y<=area.y+area.height-margin);assert.ok(Math.hypot(p.x-c.S.x,p.y-c.S.y)>=35);}
  }
 }
});
