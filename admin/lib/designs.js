import {randomUUID} from 'node:crypto';
import {validateDesign} from './designer-model.js';
export function installDesigns(app,{store,fail}){
  const title=value=>{if(typeof value!=='string'||!value.trim()||value.length>120)throw fail('Название проекта: 1–120 символов.');return value.trim();};
  app.get('/api/designs',(req,res)=>res.json((store.read().designs||[]).map(({model,...p})=>({...p,tables:model.tables.length}))));
  app.get('/api/designs/:id',(req,res)=>{const p=(store.read().designs||[]).find(p=>p.id===req.params.id);if(!p)throw fail('Проект не найден.',404);res.json(p);});
  app.post('/api/designs',async(req,res)=>{const project={id:randomUUID(),name:title(req.body.name),model:validateDesign(req.body.model),revision:1,updatedAt:Date.now()};await store.update(s=>{s.designs||=[];if(s.designs.length>=20)throw fail('Сохранено 20 проектов. Удалите ненужный или скачайте проект в JSON.');s.designs.push(project);});res.status(201).json(project);});
  app.put('/api/designs/:id',async(req,res)=>{const model=validateDesign(req.body.model),name=title(req.body.name);let result;await store.update(s=>{const p=(s.designs||[]).find(p=>p.id===req.params.id);if(!p)throw fail('Проект не найден.',404);if(req.body.revision!==p.revision)throw fail('Проект изменён в другом окне. Сохраните копию или откройте актуальную версию.',409);Object.assign(p,{name,model,revision:p.revision+1,updatedAt:Date.now()});result=p;});res.json(result);});
  app.delete('/api/designs/:id',async(req,res)=>{await store.update(s=>{const p=(s.designs||[]).find(p=>p.id===req.params.id);if(!p)throw fail('Проект не найден.',404);if(req.body.confirm!==p.name||req.body.revision!==p.revision)throw fail('Подтвердите название и актуальную версию проекта.',409);s.designs=s.designs.filter(p=>p.id!==req.params.id);});res.json({ok:true});});
}
