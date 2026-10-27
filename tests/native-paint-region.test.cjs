const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture(){const source=ts.createSourceFile('main.ts',fs.readFileSync(path.join(__dirname,'../src/main.ts'),'utf8'),ts.ScriptTarget.ES2022,true),fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='updateNativeShape'),calls=[];
  const c={petDragging:false,nativePaintRegions:[{x:200,y:200,width:320,height:260}],inputRegions:[{x:250,y:250,width:90,height:90}],expandedBounds:{width:1920,height:1080},nativeShape:'',window:{setShape:r=>calls.push(JSON.parse(JSON.stringify(r)))}};
  vm.createContext(c);vm.runInContext(ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);return {c,calls};}
test('a local animation paint region stays stable while exact input regions keep moving',()=>{
  const {c,calls}=fixture();c.updateNativeShape();for(let i=0;i<30;i++){c.inputRegions[0].x+=3;c.updateNativeShape();}assert.equal(calls.length,1);assert.equal(c.inputRegions[0].x,340);assert.ok(calls[0].length>0);c.nativePaintRegions=[];c.updateNativeShape();assert.equal(calls.length,2);assert.ok(calls.every(r=>r.length>0));
});
test('right capture keeps its local paint region while legacy left drag remains unrestricted',()=>{
  const {c,calls}=fixture();c.petDragging=true;c.updateNativeShape();assert.equal(calls[0].length,1);c.petDragging=false;c.updateNativeShape();assert.equal(calls.length,1);c.nativePaintRegions=[];c.petDragging=true;c.updateNativeShape();assert.deepEqual(calls.at(-1),[]);
});
