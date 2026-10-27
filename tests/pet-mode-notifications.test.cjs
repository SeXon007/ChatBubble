const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');

function petFixture(){
  const source=ts.createSourceFile('pet.js',fs.readFileSync(path.join(__dirname,'../src/ui/pet.js'),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  const functions=new Map();let apply;
  function visit(n){
    if(ts.isFunctionDeclaration(n)&&['open','close'].includes(n.name?.text))functions.set(n.name.text,n);
    if(ts.isBinaryExpression(n)&&n.left.getText(source)==='window.pet'&&ts.isObjectLiteralExpression(n.right))
      apply=n.right.properties.find(p=>p.name?.getText(source)==='setMode');
    ts.forEachChild(n,visit);
  }visit(source);assert.ok(apply);
  const sent=[],s={wantsOpen:false,hidden:false,morph:0,side:null,x:20,y:30,tx:20,ty:30,vx:0,vy:0,origin:null};
  const context={S:s,host:{setMode:mode=>{sent.push(mode);return Promise.resolve();}},document:{body:{dataset:{}}},cancel:()=>{},stop:()=>{},clear:()=>{},visible:()=>{},wake:()=>{},kick:()=>{},persist:()=>{}};
  vm.createContext(context);
  for(const name of ['open','close'])vm.runInContext(functions.get(name).getText(source),context);
  vm.runInContext(`applyMode=({${apply.getText(source)}}).setMode`,context);
  return {context,s,sent};
}

test('host mode notifications only update the pet and never echo commands back',()=>{
  const {context,s,sent}=petFixture();
  for(let i=0;i<20;i++){context.applyMode('expanded');assert.equal(s.wantsOpen,true);context.applyMode('collapsed');assert.equal(s.wantsOpen,false);}
  context.applyMode('hidden');assert.equal(s.hidden,true);assert.deepEqual(sent,[]);
});

test('a rapid user open/close stays at two commands after both acknowledgements arrive',()=>{
  const {context,s,sent}=petFixture();
  context.open();context.open();context.close(false);
  assert.deepEqual(sent,['expanded','collapsed']);
  context.applyMode('expanded');context.applyMode('collapsed');
  assert.deepEqual(sent,['expanded','collapsed']);assert.equal(s.wantsOpen,false);
});
