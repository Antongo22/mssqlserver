import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const scripts=await Promise.all(['app.js','advanced.js','productivity.js','import-preview.js','plan-tree.js','data-workbench.js','navigation.js','governance.js','catalog-view.js'].map(f=>readFile(new URL('../public/'+f,import.meta.url),'utf8')));
function setup(){
  const {window,document,CustomEvent,Event,DOMParser}=parseHTML(html),data=new Map(),calls=[];
  const $=id=>document.getElementById(id),dialog=$('modal');dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new Event('close'));};
  window.HTMLElement.prototype.scrollIntoView=()=>{};
  Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){return new Proxy({}, {get:(_,name)=>this.querySelector(`[name="${name}"]`)});}});
  class FormData{constructor(form){this.entriesArray=[...form.querySelectorAll('[name]')].filter(n=>!['checkbox','radio'].includes(n.type)||n.checked).map(n=>[n.name,n.type==='checkbox'?'on':n.value]);}get(n){return this.entriesArray.find(x=>x[0]===n)?.[1]??null;}getAll(n){return this.entriesArray.filter(x=>x[0]===n).map(x=>x[1]);}[Symbol.iterator](){return this.entriesArray[Symbol.iterator]();}}
  let respond=(url,options)=>{
    if(url==='/api/databases')return {databases:[{name:'Demo',id:5,state:'ONLINE',sizeMB:10}],server:{version:'16'}};
    if(url==='/api/connections')return [{id:'local',name:'Local',server:'mssql',port:1433,user:'sa',environment:'development'}];
    if(url.endsWith('/completion'))return {dbo:{Items:['Id']}};
    if(url.endsWith('/structure'))return {sql:'ALTER TABLE dbo.Items ADD Name INT',dependencies:[{schema:'dbo',name:'View',kind:'View'}]};
    if(url.endsWith('/import/preview'))return {valid:true,errors:[],rows:1};
    return [];
  };
  const context=vm.createContext({window,document,CustomEvent,Event,DOMParser,FormData,console,crypto:globalThis.crypto,URL,URLSearchParams,Blob,setTimeout,clearTimeout,localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>respond(url,options)};}});
  for(const script of scripts)vm.runInContext(script,context);
  return {$,document,context,calls,data,respond:fn=>{respond=fn;},evaluate:code=>vm.runInContext(code,context),Event,CustomEvent};
}
test('SQL previews never apply on first submit and reset on closing the dialog',async()=>{
  const {$,evaluate,calls}=setup();await new Promise(r=>setTimeout(r,20));
  evaluate("modal('Изменение','',async()=>{});");
  await assert.rejects(evaluate("api('/api/databases/Demo/structure',{method:'POST',body:{name:'Items',action:'addColumn',column:'Name',type:'INT'}})"),e=>e.preview===true);
  assert.match($('structure-preview').textContent,/ALTER TABLE/);
  assert.ok(calls.filter(c=>c.url.endsWith('/structure')).every(c=>JSON.parse(c.options.body).preview));
  await evaluate("api('/api/databases/Demo/structure',{method:'POST',body:{name:'Items',action:'addColumn',column:'Name',type:'INT'}})");
  assert.ok(!JSON.parse(calls.at(-1).options.body).preview);
  $('modal-submit').disabled=true;$('modal').close();evaluate("modal('Следующая форма','',async()=>{})");assert.equal($('modal-submit').disabled,false);
});
test('favorites collect parameter values without persisting them and the plan preserves tree hierarchy',async()=>{
  const {$,document,evaluate,data,Event,CustomEvent}=setup();await new Promise(r=>setTimeout(r,20));
  evaluate("openFavorite({name:'By ID',sql:'SELECT @Id',parameters:[{name:'Id',type:'NVARCHAR(MAX)'}]})");
  $('modal-form').elements.p0.value='temporary-parameter-value';
  await $('modal-form').onsubmit({preventDefault(){},target:$('modal-form')});
  assert.equal(evaluate('state.queryParameters[0].value'),'temporary-parameter-value');assert.ok(![...data.values()].some(v=>v.includes('temporary-parameter-value')));
  $('sql-editor').dispatchEvent(new Event('input'));assert.equal(evaluate('state.queryParameters'),undefined);
  const xml='<ShowPlanXML><StmtSimple><QueryPlan><RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimatedTotalSubtreeCost="1" EstimateRows="1"><NestedLoops><RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimatedTotalSubtreeCost=".2" EstimateRows="1"><IndexScan><Object Table="Items"/></IndexScan></RelOp><RelOp NodeId="2" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimatedTotalSubtreeCost=".3" EstimateRows="50"/></NestedLoops></RelOp></QueryPlan></StmtSimple></ShowPlanXML>';
  document.dispatchEvent(new CustomEvent('query-completed',{detail:{database:'Demo',sql:'SELECT 1',result:{recordsets:[{rows:[[xml]]}]}}}));
  assert.equal(document.querySelectorAll('.plan-node').length,3);assert.equal(document.querySelectorAll('.plan-root>.plan-node').length,0);
  assert.equal(document.querySelectorAll('.plan-root>li>.plan-node>ul>li').length,2);assert.match($('plan-graph').textContent,/Index Seek/);
  $('plan-close-all').click();assert.ok([...document.querySelectorAll('.plan-node')].every(n=>!n.open));
});
test('cell drafts preview changes, preserve NULL, reject invalid paste and block navigation',async()=>{
  const {$,evaluate,calls}=setup();await new Promise(r=>setTimeout(r,20));
  evaluate("state.table={id:1,schema:'dbo',name:'Items'};state.columns=[{name:'Id',primaryKey:true,writable:false},{name:'Label',writable:true}];state.data={columns:state.columns,editable:true,rows:[{values:['1','old'],token:'version'},{values:['2','second'],token:'version2'}]};showTableData();");
  const cell=$('table-content').querySelector('[data-row="0"][data-col="1"]');
  evaluate('pasteCells')({preventDefault(){},clipboardData:{getData:()=>"new\n\\N"}},cell);
  assert.equal(evaluate('cellDrafts.get(1).get("Label")'),null);assert.equal($('cell-save').disabled,false);
  await assert.rejects(evaluate("selectDatabase('Another')"),/сохраните/);assert.equal(evaluate('state.database'),'Demo');
  const count=calls.length;$('cell-save').click();assert.match($('modal-body').textContent,/old/);assert.match($('modal-body').textContent,/new/);assert.equal(calls.length,count,'preview must not issue a mutation');
  $('modal').close();$('cell-discard').click();assert.equal(evaluate('cellDrafts.size'),0);
  const first=$('table-content').querySelector('[data-row="0"][data-col="0"]');evaluate('pasteCells')({preventDefault(){},clipboardData:{getData:()=>"3\tvalue"}},first);assert.equal(evaluate('cellDrafts.size'),0);assert.match($('notice').textContent,/редактируемых/);
});
test('pins are scoped by database and production confirmation preserves the underlying dialog',async()=>{
  const {$,document,evaluate,Event}=setup();await new Promise(r=>setTimeout(r,20));
  evaluate("state.table={schema:'dbo',name:'Items',id:1};");$('pin-table').click();assert.equal(evaluate('navigationState().pinned.length'),1);
  evaluate("state.database='Different';");assert.equal(evaluate('navigationState().pinned.length'),0);
  evaluate("modal('Original','<p>Original content</p>',async()=>{});");
  const prototype=Object.getPrototypeOf($('modal'));prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
  const promise=evaluate("window.confirmProduction({name:'Production',server:'sql',port:1433,database:'Demo'},'/api/query',{method:'POST',body:JSON.stringify({sql:'DELETE FROM dbo.Items'})})");
  const confirmation=document.querySelector('.production-dialog'),input=confirmation.querySelector('input'),submit=confirmation.querySelector('[type=submit]');assert.equal(submit.disabled,true);
  input.value='wrong';input.oninput();assert.equal(submit.disabled,true);input.value='Production';input.oninput();assert.equal(submit.disabled,false);
  confirmation.querySelector('form').onsubmit({preventDefault(){}});await promise;assert.equal($('modal').open,true);assert.match($('modal-body').textContent,/Original content/);
});
test('catalog filters index columns and opens read-only properties instead of executing SQL',async()=>{
  const {$,evaluate,respond,calls}=setup();await new Promise(r=>setTimeout(r,20));
  respond(url=>{
    if(url.endsWith('/objects'))return {objects:[{id:8,type:'P',name:'ReadItems',schema:'dbo',kind:'SQL_STORED_PROCEDURE'}],schemas:[{name:'dbo'}]};
    if(url.endsWith('/indexes'))return {indexes:[{name:'IX_Test',objectId:1,indexId:2,schema:'dbo',table:'Items',kind:'NONCLUSTERED',typeId:2,columns:[{name:'IncludedLabel',included:true,position:2,keyOrdinal:0}]}]};
    if(url.endsWith('/details'))return {id:8,type:'P',name:'ReadItems',schema:'dbo',createdAt:'2026-01-01',modifiedAt:'2026-01-01',parameters:[{id:1,name:'@Name',sqlType:'nvarchar(80)',output:false,readOnly:false}],columns:[],dependencies:[],dependents:[],definition:"CREATE PROC dbo.ReadItems AS SELECT '<script>unsafe</script>';"};
    return [];
  });
  await evaluate('loadObjects(state.generation)');$('object-search').value='IncludedLabel';evaluate('renderObjects()');assert.match($('object-list').textContent,/IX_Test/);assert.ok(!$('object-list').textContent.includes('ReadItems'));
  await $('objects-panel').onclick({target:$('object-list').querySelector('[data-action="index-details"]')});assert.match($('modal-body').textContent,/INCLUDE/);assert.match($('modal-body').textContent,/IncludedLabel/);$('modal').close();
  await evaluate('showObjectDetails(extra.objects[0])');assert.match($('modal-body').textContent,/@Name/);assert.match($('modal-body').textContent,/nvarchar\(80\)/);assert.equal($('modal-body').querySelectorAll('script').length,0);
  assert.ok(calls.every(c=>!c.options?.method||c.options.method==='GET'),'viewing metadata must never execute SQL');
});
