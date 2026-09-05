export function bindParameters(request, parameters, sql) {
  if(parameters===undefined)return '';
  if(!Array.isArray(parameters)||parameters.length>30)throw new Error('Допускается до 30 параметров.');
  const names=new Set();
  return parameters.map((p,i)=>{
    if(!p||!/^@?[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(p.name))throw new Error('Некорректное имя параметра.');
    const name=p.name.replace(/^@/,''),type=String(p.type).toUpperCase();
    if(names.has(name.toLowerCase())||name.startsWith('studio_param'))throw new Error('Имена параметров повторяются или зарезервированы.');names.add(name.toLowerCase());
    if(!/^(INT|BIGINT|BIT|DATE|DATETIME2|UNIQUEIDENTIFIER|NVARCHAR\(MAX\)|DECIMAL\(38,10\))$/.test(type))throw new Error('Некорректный тип параметра.');
    if(p.value!==null&&typeof p.value!=='string')throw new Error('Значение параметра должно быть строкой или NULL.');
    request.input('studio_param'+i,sql.NVarChar(sql.MAX),p.value);
    return `DECLARE @${name} ${type} = CONVERT(${type},@studio_param${i});`;
  }).join('\n')+'\n';
}
