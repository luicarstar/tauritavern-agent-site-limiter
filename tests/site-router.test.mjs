import test from 'node:test';
import assert from 'node:assert/strict';
import { SiteRouter } from '../extension/site-router.js';

function fixture() {
    const connections=new Map(), captures=[], applied=[], builds=[], starts=[];
    const api={llmConnections:{
        save:async c=>connections.set(c.id,structuredClone(c)),
        list:async()=>({connections:[...connections.values()].map(x=>({id:x.id}))}),
        load:async id=>({connection:structuredClone(connections.get(id))}),
    },agent:{promptAssembly:{
        buildCurrentModelConnectionSnapshot:async x=>{captures.push(x);return {settings:{...x.settings,model:x.model,secret_id:x.secretId}};},
        applyCurrentModelConnectionSnapshot:async x=>{applied.push(x);return x.currentModelConnection.settings;},
        buildSnapshot:async x=>{builds.push(x);return {promptSnapshot:{generationParameters:x.settings,messages:[{content:'unchanged'}]},frozenRunInputSnapshot:{currentModelConnection:{settings:x.settings}}};},
    },startRunWithPromptSnapshot:async x=>{starts.push(x);return x;}}};
    const saved={},routes=[];
    const relay=async (endpoint,input)=>{
        if(endpoint==='/api/sites')return {sites:input,routes};
        let route=routes.find(x=>x.upstream===input.upstream&&x.format===input.format);
        if(!route){route={id:String(routes.length),upstream:input.upstream,format:input.format,proxyBaseUrl:'http://127.0.0.1:19377/r/'+routes.length+'/token'+new URL(input.upstream).pathname};routes.push(route);}
        return route;
    };
    const router=new SiteRouter({api,relay,saved,persist:async()=>{}});router.install();
    return {router,api,saved,routes,connections,captures,applied,builds,starts};
}
const rules=[{origin:'https://api.example.test',enabled:true,concurrency:2,rpm:10,smooth:false}];
const settings={chat_completion_source:'custom',custom_url:'https://api.example.test/v1',custom_api_format:'openai_compat',custom_model:'original-model'};
test('current-chat Agent captures automatically route a matching site without changing UI settings or model',async()=>{
    const f=fixture();await f.router.configure(rules);
    const snapshot=await f.api.agent.promptAssembly.buildCurrentModelConnectionSnapshot({settings,model:'original-model',secretId:'key-reference'});
    assert.match(snapshot.settings.custom_url,/127\.0\.0\.1/);assert.equal(snapshot.settings.model,'original-model');
    assert.equal(snapshot.settings.secret_id,'key-reference');assert.equal(settings.custom_url,'https://api.example.test/v1');
    const materialized=await f.api.agent.promptAssembly.applyCurrentModelConnectionSnapshot({currentModelConnection:{settings}});
    assert.match(materialized.custom_url,/127\.0\.0\.1/);
});
test('independent child model connection keeps original id/name/auth and auto-save synchronization stays routed',async()=>{
    const f=fixture();await f.router.configure(rules);
    const connection={id:'model-target-original-id',displayName:'Original name',provider:{chatCompletionSource:'custom'},endpoint:{baseUrl:settings.custom_url},auth:{secretRef:{key:'api_key_custom',id:'secret-id'}}};
    await f.api.llmConnections.save(connection);
    assert.equal(f.connections.get(connection.id).displayName,'Original name');
    assert.match(f.connections.get(connection.id).endpoint.baseUrl,/127\.0\.0\.1/);
    assert.deepEqual(f.connections.get(connection.id).auth,connection.auth);
    // The real TT model-target sync calls the same public save API on every run.
    await f.api.llmConnections.save(connection);assert.match(f.connections.get(connection.id).endpoint.baseUrl,/127\.0\.0\.1/);
    assert.equal(f.connections.size,1);
    await f.router.configure(rules.map(x=>({...x,enabled:false})));
    assert.equal(f.connections.get(connection.id).endpoint.baseUrl,settings.custom_url);
    const direct=await f.api.agent.promptAssembly.buildCurrentModelConnectionSnapshot({settings,model:'original-model'});
    assert.equal(direct.settings.custom_url,settings.custom_url);
});
test('prompt assembly bridge and external snapshot start use the same site routing',async()=>{
    const f=fixture();await f.router.configure(rules);
    const assembled=await f.api.agent.promptAssembly.buildSnapshot({settings});
    assert.match(f.builds[0].settings.custom_url,/127\.0\.0\.1/);
    assert.deepEqual(assembled.promptSnapshot.messages,[{content:'unchanged'}]);
    const input={promptSnapshot:{generationParameters:settings,messages:[]},frozenRunInputSnapshot:{currentModelConnection:{settings}}};
    await f.api.agent.startRunWithPromptSnapshot(input);
    assert.match(f.starts[0].promptSnapshot.generationParameters.custom_url,/127\.0\.0\.1/);
    assert.match(f.starts[0].frozenRunInputSnapshot.currentModelConnection.settings.custom_url,/127\.0\.0\.1/);
    assert.equal(input.promptSnapshot.generationParameters.custom_url,settings.custom_url);
});
test('unmatched sites stay direct; concurrent route creation deduplicates; matched WebSocket fails clearly',async()=>{
    const f=fixture();await f.router.configure(rules);
    const unchanged={...settings,custom_url:'https://other.test/v1'};
    assert.equal((await f.router.settings(unchanged)).custom_url,unchanged.custom_url);
    await Promise.all(Array.from({length:10},()=>f.router.settings(settings)));assert.equal(f.routes.length,1);
    await assert.rejects(f.router.settings({...settings,custom_openai_responses_websocket:true}),/WebSocket/);
});
