const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../app/static/result-paste.js'),'utf8'),ctx);
const schema=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../app/lab_schemas.json'))).modules;
function plan(type,variant,key,rows,text,mode,opts={}){
 const table=schema[type].variants[variant].tables.find(t=>t.key===key);const rec={type,variant,tables:{samples:opts.samples||[],[key]:rows}};
 const i=ctx.parseExcelTSV(text),m=ctx.initialPasteMapping(i.headers,ctx.pasteSpec(rec,table).cols);return ctx.buildPastePlan(rec,table,i,m,mode,opts.fallback||'',!!opts.append);
}
let luci=[{sample:'S1',plate:'P1',well:'A1',raw_value:'15',unit:'RLU',notes:'保留'},{sample:'S2',plate:'P2',well:'A1',raw_value:'25'}];
let p=plan('luci','assay','samples',luci,'板号\t孔位\tRLU\t备注\r\nP1\ta01\t0\t\r\nP2\tA1\t8\t"两行\n说明"','position');
assert.equal(p[0].patch.raw_value,'0');assert.ok(!('notes' in p[0].patch));assert.equal(p[1].rowIndex,1);assert.equal(p[1].patch.notes,'两行\n说明');
p=plan('luci','assay','samples',luci,'样本号\tRLU\t单位\nS1\t2\tcps\nS3\t9\tRLU','sample');assert.equal(p[0].status,'跳过');assert.match(p[0].msg,/单位/);assert.match(p[1].msg,/未匹配/);
p=plan('pcr','qpcr','samples',[{sample:'X',plate:'P1',well:'B1',target:'A'},{sample:'X',plate:'P1',well:'B2',target:'B'}],'样本号\tCq\nX\t20','sample');assert.match(p[0].msg,/多行/);
p=plan('pcr','qpcr','samples',[{sample:'X',plate:'P1',well:'B1',target:'A'}],'样本号\t孔号\tCq\nX\tB1\t未检出','sample');assert.equal(p[0].patch.ct,'未检出');
p=plan('flow','assay','results',[{sample:'X',metric:'M',value:'8'}],'样本号\t指标\t结果\nX\tM\t12\nX\tM\t25','sample');assert.ok(p.every(r=>r.status==='跳过'));
p=plan('flow','assay','results',[],'板号\t孔位\t指标\t结果\nP3\tC4\tM\t7','position',{append:true,samples:[{sample:'XX',plate:'P3',tube:'C4'}]});assert.equal(p[0].patch.sample,'XX');assert.equal(p[0].status,'新增');console.log('Three assay import matching, conflicts, duplicates, quoted TSV, blank/zero and provenance passed.');
const memory=new Map();
ctx.window={localStorage:{
 getItem:key=>memory.get(key)??null,
 setItem:(key,value)=>memory.set(key,value),
 removeItem:key=>memory.delete(key)
}};
const columnDefs=[{key:'sample',label:'样本编号'},{key:'raw_value',label:'发光值'},{key:'unit',label:'单位'}];
function prefs(headers,parts={}){
 const record={type:'luci',variant:'assay',...parts};
 return ctx.pasteMappingPreferences(parts.workspace??'notebook-A',record,{key:parts.table??'samples'},headers,columnDefs);
}
const original=['Sample ID','Instrument result','单位'];
const preference=prefs(original);
assert.deepEqual([...preference.read()],['sample','','unit']);
preference.remember(['sample','raw_value','unit']);
assert.equal(memory.size,1);
assert.deepEqual([...prefs(['单位','INSTRUMENT_RESULT','sample-id']).read()],['unit','raw_value','sample']);
for(const parts of [{workspace:'notebook-B'},{type:'flow'},{variant:'other'},{table:'raw_plate'},{workspace:''}]){
 assert.deepEqual([...prefs(original,parts).read()],['sample','','unit']);
}
assert.deepEqual([...prefs([...original,'extra']).read()],['sample','','unit','']);
// A deliberate one-paste override of a recognized identifier/unit cannot silently become the next default.
const protectedHeaders=prefs([...original,'Second unit']);
protectedHeaders.remember(['','raw_value','','unit']);
assert.deepEqual([...protectedHeaders.read()],['sample','raw_value','unit','']);
const protectedKey=[...memory.keys()].find(k=>k.includes('secondunit'));
memory.set(protectedKey,JSON.stringify([['sampleid','raw_value'],['单位',''],['secondunit','unit']]));
assert.deepEqual([...protectedHeaders.read()],['sample','','unit','']);
protectedHeaders.reset();
const ambiguous=prefs(['Sample ID','custom','CUSTOM','单位']);
ambiguous.remember(['sample','raw_value','','unit']);
assert.deepEqual([...ambiguous.read()],['sample','','','unit']);
preference.reset();
assert.equal(memory.size,0);
ctx.window.localStorage={getItem:()=>'{',setItem:()=>{throw Error('QuotaExceededError');},removeItem:()=>{throw Error('disabled');}};
assert.deepEqual([...preference.read()],['sample','','unit']);
preference.remember(['sample','raw_value','unit']);
preference.reset();
Object.defineProperty(ctx.window,'localStorage',{get(){throw Error('SecurityError');}});
assert.deepEqual([...preference.read()],['sample','','unit']);
preference.remember(['sample','raw_value','unit']);
preference.reset();
console.log('Paste mapping keys, normalized reorder, ambiguous headers, reset, unavailable storage and quota fallback passed.');
const partiallyBound=[{sample:'Incoming',plate:'P1'},{sample:'Owner',plate:'P1',well:'A1'}];
p=plan('luci','assay','samples',partiallyBound,'样本号\t板号\t孔位\tRLU\nIncoming\tP1\tA01\t40','sample');
assert.equal(p[0].status,'跳过','completing a matched row must preserve another sample’s occupied well');
const authoritative=[{sample:'Owner',plate:'P1',tube:'A1'},{sample:'Incoming',plate:'P1',tube:'B2'}];
for(const mode of ['sample','position']){
 for(const [plate,well] of [['P1','A1'],['P1','C3'],['P2','B2']]){
  p=plan('flow','assay','results',[],`Sample ID\t板号\t孔位\t指标\t结果\nIncoming\t${plate}\t${well}\tM\t7`,mode,{append:true,samples:authoritative});
  assert.equal(p[0].status,'跳过',mode+' must check the authoritative sample position');
  assert.match(p[0].msg,/样本表/);
 }
 p=plan('flow','assay','results',[],'Sample ID\t板号\t孔位\t指标\t结果\nIncoming\tP1\tB02\tM\t7',mode,{append:true,samples:authoritative});
 assert.equal(p[0].status,'新增');
}
