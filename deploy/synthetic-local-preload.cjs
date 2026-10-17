'use strict';
// Unit fixtures must never load the workstation's production .env.
const Module=require('module'),assert=require('assert/strict');
const load=Module._load;
Module._load=function(name,...rest){if(name==='dotenv')return {config:()=>({parsed:{}})};return load.call(this,name,...rest);};
const allowed=new Set(['127.0.0.1','localhost','::1','[::1]']);
const fetch=global.fetch;global.fetch=function(url,...args){assert.ok(allowed.has(new URL(url).hostname),'Synthetic test external network refused');return fetch(url,...args);};
for(const name of ['http','https']){const api=require(name),request=api.request;api.request=function(...args){const x=args[0],host=typeof x==='string'||x instanceof URL?new URL(x).hostname:x.hostname||x.host||'localhost';assert.ok(allowed.has(host),'Synthetic test external network refused');return request.apply(this,args);};}
