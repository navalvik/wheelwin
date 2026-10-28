// Public metadata only; this listener has no game, wallet, env or filesystem routes.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const icon=readFileSync(fileURLToPath(new URL('../../client/public/icon.png',import.meta.url)));
const originFile=process.argv[2];
if(!originFile) throw new Error('Provide public HTTPS origin file path');
createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/icon.png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(icon);return;}
    if(req.url!=='/tonconnect-manifest.json'){res.writeHead(404);res.end();return;}
    let origin;
    try { origin=readFileSync(originFile,'utf8').trim(); if(new URL(origin).protocol!=='https:')throw new Error(); }
    catch {res.writeHead(503);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({url:origin,name:'WheelWin Local Testnet',iconUrl:origin+'/icon.png'}));
}).listen(5174,'127.0.0.1',()=>console.log('TonConnect public metadata listener ready on 127.0.0.1:5174'));
