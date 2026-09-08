import test from 'node:test';import assert from 'node:assert/strict';
const base=process.env.ADMIN_URL||'http://localhost:3001';
async function call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'X-Admin-Request':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
async function ok(...args){const r=await call(...args);assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
test('cell batches roll back all rows on stale versions; exact relation filters preserve composite keys',async()=>{
  const db='Studio_daily_'+Date.now(),root='/api/databases/'+db;await ok('/api/databases','POST',{name:db});
  const query=sql=>ok('/api/query','POST',{database:db,sql});
  try{
    await query("CREATE TABLE dbo.Items(Id int PRIMARY KEY,A nvarchar(20),B bigint,Value int);INSERT dbo.Items VALUES(1,N'x',9007199254740993,10),(2,N'xx',9007199254740993,20),(3,N'x',2,30);");
    let data=await ok(root+'/data?name=Items');const changes=data.rows.slice(0,2).map((r,i)=>({keys:{Id:r.values[0]},token:r.token,values:{Value:String(50+i)}}));
    await query('UPDATE dbo.Items SET Value=21 WHERE Id=2');
    assert.equal((await call(root+'/data/batch','PATCH',{name:'Items',changes})).status,400);
    assert.equal((await query('SELECT Value FROM dbo.Items WHERE Id=1')).recordsets[0].rows[0][0],10);
    data=await ok(root+'/data?name=Items');changes.forEach((c,i)=>c.token=data.rows[i].token);await ok(root+'/data/batch','PATCH',{name:'Items',changes});
    const filtered=await ok(root+'/data?name=Items&exact='+encodeURIComponent(JSON.stringify({A:'x',B:'9007199254740993'})));assert.equal(filtered.rows.length,1);assert.equal(filtered.rows[0].values[0],'1');
    assert.equal((await call(root+'/data?name=Items&exact='+encodeURIComponent(JSON.stringify({'Bad];--':'1'})))).status,400);
  }finally{await ok(root,'DELETE',{confirm:db});}
});
