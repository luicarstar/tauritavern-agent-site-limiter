import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../service/server.mjs';
import { managedTarget, targetConnection, bindingFor } from '../extension/model.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token='site-plugin-fixture-token-01234567890123456789';
async function until(fn) {const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('UI initialization timed out');await new Promise(r=>setTimeout(r,5));}}

for(const legacy of [false,true,'edited','acknowledged']) test(`site panel ${legacy==='acknowledged'?'clears migration reload notice on next page':legacy==='edited'?'preserves edited Agent during migration':legacy?'migrates old prefixed models':'initializes without model copies'} and applies rules`,async t=>{
    const dom=new JSDOM('<div id="extensions_settings2"></div>',{url:'http://tauri.localhost/'});t.after(()=>dom.window.close());
    const service=createRelay({state:{adminToken:token,routes:[],limits:{concurrency:2,rpm:30,smooth:true}}});
    const origin=await service.listen(0);t.after(()=>service.close());
    const definitions=new Map(),connections=new Map(),kv=new Map(),errors=[];
    const builtin={id:'default-writer',displayName:'Default Writer',model:{mode:'currentPromptSnapshot'},
        delegation:{canDelegate:true,maxConcurrentInvocations:3,maxInvocationsPerRun:8},run:{directRunnable:true},instructions:{agentSystemPrompt:'original'}};
    definitions.set(builtin.id,builtin);
    const sources=Array.from({length:5},(_,i)=>({id:`source-${i}`,name:`Original ${i}`,mode:'cc',api:'custom',model:`model-${i}`,
        'api-url':`https://provider-${i}.invalid/v1`,'secret-id':`secret-ref-${i}`,proxy:'None'}));
    const namespaceKey=x=>`${x.namespace}:${x.key}`;
    kv.set('agent-system:settings',{activeProfileId:'default-writer',agentModeEnabled:true});
    const ctx={extensionSettings:{connectionManager:{profiles:structuredClone(sources),modelTargets:[]}},
        chatCompletionSettings:{chat_completion_source:'custom',custom_url:sources[0]['api-url']},saveSettingsDebounced:()=>{}};
    if(legacy==='acknowledged')kv.set('tt-agent-limiter:settings',{siteMigrationDone:true,activeReloadNeeded:true});
    if(legacy===true||legacy==='edited'){
        const target=managedTarget(sources[0],{id:'aa',proxyBaseUrl:origin+'/r/aa/test/v1'});
        ctx.extensionSettings.connectionManager.modelTargets.push(target);connections.set('model-target-'+target.id,targetConnection(target));
        const writer={...structuredClone(builtin),id:'ttlim-writer',displayName:'Default Writer · 限流',model:bindingFor(target)};
        if(legacy==='edited')writer.instructions={agentSystemPrompt:'user changed this'};
        definitions.set(writer.id,writer);kv.set('agent-system:settings',{activeProfileId:writer.id});
        kv.set('tt-agent-limiter:settings',{setupDone:true,activeBefore:'default-writer',bindings:{'ttlim-writer':{
            model:{mode:'currentPromptSnapshot'},childCount:3,managedChildCount:3,managedRef:writer.model.connectionRef,created:true}}});
    }
    const captures=[];
    const api={extension:{store:{
        tryGetJson:async x=>({found:kv.has(namespaceKey(x)),value:structuredClone(kv.get(namespaceKey(x)))}),
        setJson:async x=>kv.set(namespaceKey(x),structuredClone(x.value)),
        updateJson:async x=>kv.set(namespaceKey(x),{...kv.get(namespaceKey(x)),...structuredClone(x.value)}),
    }},llmConnections:{save:async c=>connections.set(c.id,structuredClone(c)),list:async()=>({connections:[...connections.values()].map(x=>({id:x.id}))}),
        load:async id=>({connection:structuredClone(connections.get(id))})},agent:{profiles:{
        list:async()=>({profiles:[...definitions.values()].map(x=>({id:x.id,displayName:x.displayName}))}),
        load:async id=>({profile:structuredClone(definitions.get(id))}),save:async p=>definitions.set(p.id,structuredClone(p)),
    },promptAssembly:{
        buildCurrentModelConnectionSnapshot:async x=>{captures.push(x);return {settings:x.settings};},
        applyCurrentModelConnectionSnapshot:async x=>x.currentModelConnection.settings,
        buildSnapshot:async x=>({promptSnapshot:{generationParameters:x.settings}}),
    }}};
    const {window}=dom;window.__TAURITAVERN__={api,ready:Promise.resolve()};window.SillyTavern={getContext:()=>ctx};
    const config={baseUrl:origin,adminToken:token};
    const context=vm.createContext({window,document:window.document,URL,AbortSignal,crypto,structuredClone,location:{reload(){}},
        setInterval:()=>0,console:{error:(...args)=>errors.push(args)},fetch:async(url,opts)=>String(url).endsWith('client-config.json')?new Response(JSON.stringify(config)):fetch(url,opts)});
    const modules=new Map();
    for(const file of ['model.js','site-router.js','site-index.js'])modules.set('./'+file,new vm.SourceTextModule(fs.readFileSync(path.join(root,'extension',file),'utf8'),{
        context,initializeImportMeta:meta=>{meta.url='http://tauri.localhost/scripts/extensions/third-party/tt-agent-limiter/'+file;}}));
    const main=modules.get('./site-index.js');await main.link(name=>modules.get(name));await main.evaluate();
    await until(()=>window.document.querySelector('[data-field="message"]')?.textContent.includes('站点'));
    await until(()=>kv.get('tt-agent-limiter:settings')?.siteMigrationDone);
    assert.deepEqual(errors,[]);
    assert.equal(window.document.querySelectorAll('.ttal-site').length,5);
    assert.equal(ctx.extensionSettings.connectionManager.modelTargets.length,5);
    assert.ok(ctx.extensionSettings.connectionManager.modelTargets.every(x=>!x.name.startsWith('限流')&&!x.id.startsWith('ttlim-')));
    assert.deepEqual(ctx.extensionSettings.connectionManager.profiles,sources);
    assert.equal(builtin.model.mode,'currentPromptSnapshot');
    if(legacy===true||legacy==='edited'){assert.equal(definitions.get('ttlim-writer').model.mode,'currentPromptSnapshot');assert.equal(kv.get('agent-system:settings').activeProfileId,legacy==='edited'?'ttlim-writer':'default-writer');
        if(legacy==='edited')assert.equal(definitions.get('ttlim-writer').instructions.agentSystemPrompt,'user changed this');}
    else assert.equal(definitions.size,1);
    if(legacy==='acknowledged'){assert.equal(kv.get('tt-agent-limiter:settings').activeReloadNeeded,false);assert.ok(!window.document.querySelector('[data-field="message"]').textContent.includes('请再重新加载'));}
    const settings={chat_completion_source:'custom',custom_url:sources[0]['api-url'],custom_api_format:'openai_compat'};
    await api.agent.promptAssembly.buildCurrentModelConnectionSnapshot({settings,model:'model-0'});
    assert.match(captures.at(-1).settings.custom_url,/127\.0\.0\.1/);assert.equal(captures.at(-1).model,'model-0');
    const first=window.document.querySelector('.ttal-site');first.querySelector('[data-rule="rpm"]').value='7';
    const button=window.document.querySelector('[data-action="save"]');button.click();await until(()=>!button.disabled);
    assert.equal(service.state.siteRules.find(x=>x.origin==='https://provider-0.invalid').rpm,7);
    first.querySelector('[data-rule="enabled"]').checked=false;button.click();await until(()=>!button.disabled);
    await api.agent.promptAssembly.buildCurrentModelConnectionSnapshot({settings,model:'model-0'});
    assert.equal(captures.at(-1).settings.custom_url,sources[0]['api-url']);
    assert.equal(connections.get('model-target-source-0').endpoint.baseUrl,sources[0]['api-url']);
});
