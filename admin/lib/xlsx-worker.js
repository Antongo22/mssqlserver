import { parentPort, workerData } from 'node:worker_threads';
import ExcelJS from 'exceljs';
try {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(workerData));
  const sheets = workbook.worksheets.slice(0,20).map(sheet => {
    if(sheet.rowCount>501||sheet.columnCount>100)throw new Error(`Лист «${sheet.name}»: максимум 500 строк данных и 100 столбцов.`);
    const rows=[]; sheet.eachRow({includeEmpty:true},row=>{ const values=[];for(let i=1;i<=sheet.columnCount;i++){
      let value=row.getCell(i).value;
      if(value&&typeof value==='object'&&('formula' in value||'sharedFormula' in value))value=value.result;
      if(value instanceof Date)value=value.toISOString();
      else if(value&&typeof value==='object')value=value.richText?value.richText.map(x=>x.text).join(''):value.text??value.error??'';
      values.push(value==null?'':String(value));
    } rows.push(values); }); return {name:sheet.name,rows};
  });parentPort.postMessage({sheets});
}catch(e){parentPort.postMessage({error:e.message});}
