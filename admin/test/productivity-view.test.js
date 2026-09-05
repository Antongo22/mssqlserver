import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const scripts=await Promise.all(['app.js','advanced.js','productivity.js','import-preview.js','plan-tree.js'].map(f=>readFile(new URL('../public/'+f,import.meta.url),'utf8')));
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
