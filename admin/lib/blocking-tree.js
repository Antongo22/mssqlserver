export function blockingTree(sessions){
  const nodes=new Map();
  for(const s of sessions){const previous=nodes.get(s.id);if(!previous||(!previous.blockedBy&&s.blockedBy)||(s.waitMs||0)>(previous.waitMs||0))nodes.set(s.id,{...s});}
  const relevant=new Set(),children=new Map();
  for(const s of [...nodes.values()])if(s.blockedBy){
    relevant.add(s.id);relevant.add(s.blockedBy);
    if(!nodes.has(s.blockedBy))nodes.set(s.blockedBy,{id:s.blockedBy,missing:true,status:s.blockedBy<0?'Специальный владелец блокировки':'Сессия вне снимка'});
    if(!children.has(s.blockedBy))children.set(s.blockedBy,[]);children.get(s.blockedBy).push(s.id);
  }
  const rows=[],seen=new Set();
  const visit=(id,cycle=false)=>{
    const stack=[{id,depth:0,cycle}];
    while(stack.length){const current=stack.pop();if(seen.has(current.id))continue;seen.add(current.id);rows.push({...nodes.get(current.id),...current});const next=children.get(current.id)||[];for(let i=next.length-1;i>=0;i--)stack.push({id:next[i],depth:current.depth+1,cycle:false});}
  };
  for(const id of relevant)if(!nodes.get(id).blockedBy)visit(id);
  // A snapshot can contain a cycle. Render each session once instead of recursing forever.
  for(const id of relevant)if(!seen.has(id))visit(id,true);
  return rows;
}
