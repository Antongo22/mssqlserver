import test from 'node:test';import assert from 'node:assert/strict';
import {createConnections} from '../lib/connections.js';
test('editing profiles retains a blank password and running requests keep their original server',async()=>{
  let data={connections:[{id:'remote',name:'Before',server:'old',port:1433,user:'login',password:'secret',environment:'test'}]};
  const store={read:()=>structuredClone(data),update:async fn=>fn(data)},routes={};
  const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(route,handler)=>{routes[method+route]=handler;}]));
  const connections=createConnections({store,config:{server:'local'},sql:{},fail:message=>new Error(message)});connections.install(app);
  let response;const res={json:r=>response=r};
  await connections.run('remote',async()=>{
    await routes['patch/api/connections/:id']({params:{id:'remote'},body:{name:'After',server:'new',password:''}},res);
    assert.equal(connections.config().server,'old');assert.equal(connections.config().password,'secret');
    assert.equal(connections.get('remote').server,'new');assert.ok(!('password' in response));
  });
  await connections.run('remote',async()=>assert.equal(connections.config().server,'new'));
});
