export function selection(columns,query,request,{sql,identifier:q,parameter,cell,fail}){
  const parse=(value,fallback)=>{try{return value===undefined?fallback:typeof value==='string'?JSON.parse(value):value;}catch{throw fail('Некорректный фильтр или сортировка.');}};
  const column=name=>{const c=columns.find(c=>c.name===name);if(!c)throw fail('Столбец не найден: '+name);return c;};
  let counter=0;
  const value=(c,v)=>{if(++counter>400)throw fail('Слишком много значений фильтра.');return parameter(request,c,v,'selection_'+counter);};
  let nodes=0;
  function filter(node,depth=0){
    if(!node||typeof node!=='object'||++nodes>60||depth>4)throw fail('Слишком сложный фильтр.');
    if(node.rules){if(!['AND','OR'].includes(node.logic)||!Array.isArray(node.rules)||!node.rules.length)throw fail('Пустая или некорректная группа фильтров.');return '('+node.rules.map(n=>filter(n,depth+1)).join(' '+node.logic+' ')+')';}
    const c=column(node.column),name='t.'+q(c.name);
    if(['IS NULL','IS NOT NULL'].includes(node.op))return name+' '+node.op;
    if(node.op==='CONTAINS'){request.input('selection_'+(++counter),sql.NVarChar(sql.MAX),String(node.value??''));return `CHARINDEX(@selection_${counter},CONVERT(nvarchar(max),${name}))>0`;}
    if(['IN','NOT IN','BETWEEN'].includes(node.op)){
      if(!Array.isArray(node.values)||!node.values.length||node.values.length>100||(node.op==='BETWEEN'&&node.values.length!==2)||node.values.some(v=>v===null))throw fail('Укажите значения диапазона или списка (без NULL).');
      const values=node.values.map(v=>value(c,v));return node.op==='BETWEEN'?`${name} BETWEEN ${values[0]} AND ${values[1]}`:`${name} ${node.op} (${values.join(',')})`;
    }
    if(!['=','<>','>','>=','<','<='].includes(node.op)||node.value===null)throw fail('Некорректное условие. Для NULL используйте IS NULL.');
    return `${name} ${node.op} ${value(c,node.value)}`;
  }
  const conditions=[],tree=parse(query.filters,null);if(tree)conditions.push(filter(tree));
  const exact=parse(query.exact,{});if(!exact||Array.isArray(exact)||typeof exact!=='object'||Object.keys(exact).length>16)throw fail('Точный фильтр: до 16 столбцов.');
  for(const [name,v] of Object.entries(exact)){const c=column(name);conditions.push(v===null?`t.${q(name)} IS NULL`:`t.${q(name)}=${value(c,v)}`);}
  if(query.filterColumn){const c=column(query.filterColumn);if(query.filter)conditions.push(filter({column:c.name,op:'CONTAINS',value:String(query.filter)}));}
  const pk=columns.filter(c=>c.primaryKey),sorts=parse(query.sorts,[]);
  if(!Array.isArray(sorts)||sorts.length>8)throw fail('Сортировка: до 8 столбцов.');
  if(!sorts.length)sorts.push({column:columns.find(c=>c.name===query.sort)?.name||pk[0]?.name||columns[0].name,direction:query.direction||'ASC'});
  const seen=new Set(),order=sorts.map(s=>{const c=column(s.column);if(seen.has(c.name)||!['ASC','DESC'].includes(s.direction))throw fail('Некорректная сортировка.');seen.add(c.name);return (['xml','text','ntext','image'].includes(c.type)?cell(c):'t.'+q(c.name))+' '+s.direction;});
  for(const c of pk)if(!seen.has(c.name))order.push('t.'+q(c.name)+' ASC');
  return {where:conditions.length?'WHERE '+conditions.map(c=>'('+c+')').join(' AND '):'',order:order.join(','),sort:sorts[0].column};
}
