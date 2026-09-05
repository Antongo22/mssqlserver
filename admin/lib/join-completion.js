const quote=s=>`[${s.replaceAll(']', ']]')}]`;
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const identifier=s=>`(?:${escape(quote(s))}|${escape(s)})(?![\\w])`;
export function joinCompletion(context,model) {
  if(!model)return null;
  const text=context.state.sliceDoc(0,context.pos),match=/\bJOIN\s+[\w.\[\]]*$/i.exec(text);if(!match)return null;
  const before=text.slice(0,match.index),options=[],tables=new Map(model.tables.map(t=>[t.id,t]));
  for(const fk of model.foreignKeys)for(const reverse of [false,true]){
    const source=tables.get(reverse?fk.parentTableId:fk.childTableId),target=tables.get(reverse?fk.childTableId:fk.parentTableId);
    if(!source||!target)continue;
    const schema=source.schema==='dbo'?`(?:${identifier(source.schema)}\\s*\\.\\s*)?`:`${identifier(source.schema)}\\s*\\.\\s*`;
    const from=new RegExp(`\\b(?:FROM|JOIN)\\s+${schema}${identifier(source.name)}(?:\\s+(?:AS\\s+)?(\\[[^\\]]+\\]|[a-zA-Z_]\\w*))?`,'i').exec(before);
    if(!from)continue;
    const alias=from[1]&&!/^(WHERE|LEFT|RIGHT|FULL|INNER|OUTER|JOIN|ON|CROSS|GROUP|ORDER|HAVING|UNION|SET)$/i.test(from[1])?from[1]:`${quote(source.schema)}.${quote(source.name)}`;
    let targetAlias='related';for(let n=2;new RegExp(`\\b${targetAlias}\\b`,'i').test(before);n++)targetAlias='related'+n;
    const conditions=fk.columns.map(pair=>{
      const sc=source.columns.find(c=>c.id===(reverse?pair.parentColumnId:pair.childColumnId)),tc=target.columns.find(c=>c.id===(reverse?pair.childColumnId:pair.parentColumnId));
      return `${alias}.${quote(sc.name)} = ${targetAlias}.${quote(tc.name)}`;
    });
    options.push({label:`JOIN ${target.schema}.${target.name}`,detail:fk.name,type:'keyword',apply:`JOIN ${quote(target.schema)}.${quote(target.name)} AS ${targetAlias}\n    ON ${conditions.join(' AND ')}`,boost:5});
  }
  return options.length?{from:match.index,options,filter:false}:null;
}
