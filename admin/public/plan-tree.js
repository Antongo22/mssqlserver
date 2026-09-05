document.addEventListener('query-completed',event=>{
  const plans=event.detail.result.recordsets.flatMap(s=>s.rows.flat().filter(v=>typeof v==='string'&&v.includes('<ShowPlanXML')));
  if(!plans.length)return;
  const panel=$('execution-plans'),old=panel.innerHTML;
  panel.innerHTML=`<div class="panel-head"><h2>Графический план выполнения</h2><div class="actions"><button class="button" id="plan-open-all">Развернуть</button><button class="button" id="plan-close-all">Свернуть</button></div></div><p class="plan-help muted">Поток данных: от дочерних операторов к родительским. Цвет показывает долю собственной оценочной стоимости; фактические строки показаны, если доступны.</p><div id="plan-graph"></div><details class="plan-table"><summary>Табличный вид и .sqlplan</summary>${old}</details>`;
  plans.forEach((xml,index)=>{
    const doc=new DOMParser().parseFromString(xml,'application/xml');if(doc.querySelector('parsererror'))return;
    const nodes=[...doc.getElementsByTagNameNS('*','RelOp')],parents=new Map();
    const nearest=n=>{for(let p=n.parentNode;p;p=p.parentNode)if(p.localName==='RelOp')return p;return null;};
    for(const n of nodes)parents.set(n,nearest(n));
    const roots=nodes.filter(n=>!parents.get(n));
    function draw(node,total,depth=0){
      if(depth>100)return '<li>Глубокое поддерево: смотрите .sqlplan</li>';
      const children=nodes.filter(n=>parents.get(n)===node),cost=Number(node.getAttribute('EstimatedTotalSubtreeCost')||0),own=Math.max(0,cost-children.reduce((s,n)=>s+Number(n.getAttribute('EstimatedTotalSubtreeCost')||0),0)),percent=total?own/total*100:0;
      const counters=[...node.getElementsByTagNameNS('*','RunTimeCountersPerThread')].filter(n=>{for(let p=n.parentNode;p;p=p.parentNode)if(p.localName==='RelOp')return p===node;return false;}),actual=counters.length?counters.reduce((s,n)=>s+Number(n.getAttribute('ActualRows')||0),0):null;
      const objects=[...node.getElementsByTagNameNS('*','Object')].filter(n=>nearest(n)===node),warnings=[...node.getElementsByTagNameNS('*','Warnings')].filter(n=>nearest(n)===node);
      return `<li><details open class="plan-node ${percent>=30?'expensive':percent>=10?'notable':''}"><summary><strong>${esc(node.getAttribute('PhysicalOp'))}</strong><span>${percent.toFixed(1)}% · #${esc(node.getAttribute('NodeId'))}</span></summary><div class="plan-node-info"><span>${esc(node.getAttribute('LogicalOp'))}</span><span>Оценка строк: ${esc(node.getAttribute('EstimateRows'))}${actual!==null?' · факт: '+actual.toLocaleString('ru-RU'):''}</span>${objects.map(o=>`<span>${esc(['Database','Schema','Table','Index'].map(a=>o.getAttribute(a)).filter(Boolean).join('.'))}</span>`).join('')}${warnings.length?'<span class="diagram-warning">Предупреждения: '+warnings.map(w=>esc([...w.children].map(c=>c.localName).join(', ')||w.textContent||'смотрите XML')).join('; ')+'</span>':''}<small>Стоимость поддерева: ${cost} · собственная: ${own.toPrecision(4)}</small></div>${children.length?`<ul>${children.map(c=>draw(c,total,depth+1)).join('')}</ul>`:''}</details></li>`;
    }
    const section=document.createElement('section');section.className='plan-canvas';section.innerHTML=`<h3>План ${index+1}</h3>${roots.map((root,i)=>`<h4>Оператор запроса ${i+1}</h4><ul class="plan-root">${draw(root,Number(root.getAttribute('EstimatedTotalSubtreeCost')||0))}</ul>`).join('')}`;$('plan-graph').append(section);
  });
  $('plan-open-all').onclick=()=>panel.querySelectorAll('.plan-node').forEach(n=>n.open=true);$('plan-close-all').onclick=()=>panel.querySelectorAll('.plan-node').forEach(n=>n.open=false);
  panel.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>download(plans[Number(b.dataset.plan)],'query.sqlplan','application/xml'));
});
