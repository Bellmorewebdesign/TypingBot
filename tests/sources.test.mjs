import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {rm} from 'node:fs/promises';
import {upload,excerpts} from '../server/sources.ts';
test('uploaded sources stay scoped to their collection and inform retrieval',async()=>{
  const collection=crypto.randomUUID();
  try {
    await upload(Readable.from([Buffer.from('A solar cell converts light into electricity.')]),collection,'Notes.txt');
    assert.match(await excerpts(collection,'Explain solar cells'),/Notes.txt\nA solar cell/);
    assert.equal(await excerpts(crypto.randomUUID(),'solar'),'');
    await assert.rejects(upload(Readable.from([]),collection,'archive.zip'),/PDF/);
  } finally {await rm('data/sources/'+collection,{recursive:true,force:true});}
});
