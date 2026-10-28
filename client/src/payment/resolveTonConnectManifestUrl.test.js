import assert from 'node:assert/strict';
import {resolveTonConnectManifestUrl as resolve} from './resolveTonConnectManifestUrl.js';
assert.equal(resolve('http://localhost:5173','https://public.example/tonconnect-manifest.json'),'https://public.example/tonconnect-manifest.json');
assert.equal(resolve('http://127.0.0.1:5173','https://public.example/tonconnect-manifest.json'),'https://public.example/tonconnect-manifest.json');
assert.equal(resolve('https://wheelwin.example','https://local-test.example/file.json'),'https://wheelwin.example/tonconnect-manifest.json');
assert.throws(()=>resolve('http://localhost:5173','http://public.example/file.json'));
console.log('PASS: local public HTTPS manifest override stays isolated from hosted game');
