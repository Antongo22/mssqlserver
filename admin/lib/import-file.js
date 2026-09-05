import express from 'express';
import { Worker } from 'node:worker_threads';
export function installImportFile(app) {
  app.post('/api/import-file',express.raw({type:'application/octet-stream',limit:'5mb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||!req.body.length)throw new Error('Выберите XLSX-файл до 5 МБ.');
    const worker=new Worker(new URL('./xlsx-worker.js',import.meta.url),{workerData:req.body,resourceLimits:{maxOldGenerationSizeMb:256}});
    let timer;
    try {
      const result=await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Файл слишком сложный: превышено время разбора.')),15000);
        worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error('Не удалось разобрать Excel-файл.'));});
      });if(result.error)throw new Error(result.error);res.json(result);
    }finally{clearTimeout(timer);await worker.terminate();}
  });
}
