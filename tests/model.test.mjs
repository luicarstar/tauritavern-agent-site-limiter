import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceModel, managedTarget, targetConnection, bindingFor, profileCopy } from '../extension/model.js';
const original = { mode:'cc', id:'SAVED-ID', api:'custom', model:'fixture-model', name:'fixture',
    'api-url':'https://upstream.invalid/v1', 'secret-id':'fixture-secret-id', proxy:'None' };
test('normal API profiles become saved model targets with secret references, preserving original', () => {
    const before = structuredClone(original);
    const target = managedTarget(original,{id:'abc',proxyBaseUrl:'http://127.0.0.1:19377/r/abc/fixture/v1'});
    assert.equal(sourceModel(original).secretRef.key,'api_key_custom');
    const connection = targetConnection(target);
    assert.equal(connection.auth.secretRef.id,'fixture-secret-id');
    assert.equal(connection.endpoint.baseUrl,target['api-url']);
    assert.equal(bindingFor(target).connectionRef,connection.id);
    assert.deepEqual(original,before);
    assert.ok(!JSON.stringify(connection).includes('Bearer'));
});
test('unsupported routing and WebSocket fail explicitly', () => {
    assert.throws(()=>sourceModel({...original,api:'openrouter'}),/自定义/);
    assert.throws(()=>sourceModel({...original,proxy:'saved-proxy'}),/反代/);
    assert.throws(()=>sourceModel({...original,adapterHints:{openaiResponsesMode:'websocket'}}),/WebSocket/);
});
test('built-in profile cloning preserves policy while making a user-owned id', () => {
    const originalProfile={id:'default-writer',displayName:'Default Writer',sourceTrace:{builtin:true},
        model:{mode:'currentPromptSnapshot'},delegation:{maxConcurrentInvocations:3}};
    const copy=profileCopy(originalProfile,'ttlim-writer');
    assert.equal(copy.id,'ttlim-writer'); assert.equal(copy.sourceTrace,undefined);
    assert.equal(originalProfile.id,'default-writer'); assert.deepEqual(copy.delegation,originalProfile.delegation);
});
