import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../src/codecks-core.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
const user = "33333333-3333-4333-8333-333333333333";
const parse = (v: unknown) => JSON.parse(String(v).match(/```json\s*([\s\S]*?)\s*```/)![1]);
for (const count of [1, 4, 5, 9, 34, 100]) {
 let creates=0, queries=0; const original=globalThis.fetch;
 globalThis.fetch=(async (input, init) => { if (String(input).includes('/dispatch/cards/create')) { creates++; return new Response(JSON.stringify({payload:{card:{id:`card-${creates}`,accountSeq:creates}}}),{status:200}); } queries++; return new Response(JSON.stringify({data:{_root:{loggedInUser:user},user:{[user]:{id:user,name:'Sam'}}}}),{status:200}); }) as typeof fetch;
 try { const dry=parse(await core.card_bulk_create.execute({cards:Array.from({length:count},(_,i)=>({title:`Card ${i}`,correlationKey:`row-${i}`})),dryRun:true,format:'json'})); assert.equal(dry.data.count,count); assert.equal(typeof dry.data.previewFingerprint,"string"); assert.equal(dry.data.results.length,0); assert.equal(JSON.parse(readFileSync(dry.data.artifact.path,'utf8')).previewFingerprint,dry.data.previewFingerprint); assert.equal(creates,0); assert.equal(queries,1); const apply=parse(await core.card_bulk_create.execute({cards:Array.from({length:count},(_,i)=>({title:`Card ${i}`})),dryRun:false,expectedPreviewFingerprint:dry.data.previewFingerprint,format:'json'})); assert.equal(apply.data.created,count); assert.equal(apply.data.results.length,0); assert.equal(JSON.parse(readFileSync(apply.data.artifact.path,'utf8')).results.length,count); assert.equal(creates,count); assert.equal(queries,2); } finally { globalThis.fetch=original; }
}
console.log("bulk create physical request characterization tests passed");
