import path from 'node:path';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, openStorage, restoreBackup, type Migration} from '../../packages/storage/src';
import {digestOf, failed, ok, readOnly, sha256, workspace, uploadTestSource, uploadTestWork, uploadGame, TEST_CLOSE_GRACE_MS} from './helpers';
import {StorageClient} from '../../packages/storage/src/client';
import type {QualificationWire} from '../../packages/contracts/src/qualification';
import {storageWorker, terminateWorkers} from './recording-helpers';
import {r} from '../shared/trip-messages';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await terminateWorkers();await ws.dispose();});
const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {schema:string;value:unknown}[];
const scope='a'.repeat(43);

describe('qualification schema 11 (REG-013/014)', () => {
  it('adds empty companion tables to the frozen schema10 fixture without changing existing rows', async () => {
    const file = ws.copyFixture('schema-v10-representative.sqlite');
    const prior = readOnly(file, db => {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").pluck().all() as string[];
      return tables.map(name => ({name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()}));
    });
    const storage = await ws.open({path: file});
    expect(storage.summary).toMatchObject({schemaVersion: 11, migratedFrom: 10});
    const backup = storage.summary.backupFileName!;
    storage.close();
    readOnly(file, db => {
      for (const {name, rows} of prior) expect(db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(), name).toEqual(rows);
      for (const name of ['qualification_cache', 'qualification_result_versions', 'qualification_result_heads', 'qualification_refresh_state']) {
        expect(db.prepare(`SELECT count(*) FROM ${name}`).pluck().get()).toBe(0);
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
    });
    expect(digestOf(path.join(ws.backups, backup))).toEqual(digestOf(path.join('tests/fixtures/storage/schema-v10-representative.sqlite')));
    const restored = ok(await restoreBackup(path.join(ws.backups, backup.replace(/\.sqlite$/, '.json')), ws.options({path: path.join(ws.directory, 'restored.sqlite')})));
    expect(restored.summary.schemaVersion).toBe(11);
    restored.close();
  });
  it('rolls the entire migration back on failure and refuses schema11 in the prior build', async () => {
    const file = ws.copyFixture('schema-v10-representative.sqlite'), before = digestOf(file);
    const failure: Migration = {version: 12, name: '0012-test-failure', up: () => {throw Error('injected');}};
    failed(await openStorage(ws.options({path: file, migrations: [...MIGRATIONS, failure]})), 'MIGRATION_FAILED');
    expect(digestOf(file)).toEqual(before);
    (await ws.open({path: file})).close();
    const hash = sha256(file);
    failed(await openStorage(ws.options({path: file, migrations: MIGRATIONS.slice(0, 10)})), 'SCHEMA_NEWER');
    expect(sha256(file)).toBe(hash);
  });
});

for(const worker of [false,true]) describe(`qualification immutable results ${worker?'worker':'writer'} (REG-005/008/012/014)`,()=>{
  it('accepts only exact frozen local sources, survives restart, and never fabricates a receipt',async()=>{
    const client=worker?new StorageClient(storageWorker().handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}):await ws.open({purpose:'history'});
    if(worker)ok(await (client as StorageClient).open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
    const source=await uploadTestSource(client);
    ok(await client.commitEvent({message:uploadGame(source.script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',endedUtcMs:3000,recordingCompleteness:'complete'}]}));
    const workId=await uploadTestWork(client,source),frozen=ok(await client.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:4000}));
    const authority={registrationId:source.registrationId,connectionVersion:'1'};
    expect(ok(await client.setQualificationScope({...authority,securityScope:scope}))).toEqual({active:true});
    const page=ok(await client.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25}));
    expect(page.items).toHaveLength(1);expect(page.items[0].request.eventId).toBe(frozen.eventId);
    const request={requestId:randomUUID(),items:[page.items[0].request]};
    const template=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!;
    const result=structuredClone(template),identity=request.items[0];
    Object.assign(result,{source:identity.source,requestedEventId:identity.eventId,requestedRevision:identity.revision,resultRevision:'9007199254740993',version:'retained-1'});
    Object.assign(result.assessment!,{assessedSource:identity.source,sourceEventId:identity.eventId,sourceRevision:identity.revision,sourceMessageId:result.requestedSourceMessageId});
    const batch:QualificationWire['ResultBatch']={contract:'1.0',securityScope:scope,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,requestId:request.requestId,items:[result]};
    const input={...authority,securityScope:scope,request,batch,fetchedUtcMs:5000};
    expect(ok(await client.commitQualificationResults(input))).toEqual({saved:1,missingBase:[]});
    const refreshed=structuredClone(input);refreshed.batch.items[0].assessment!.trailerDisplay=[];
    expect(ok(await client.commitQualificationResults(refreshed))).toEqual({saved:0,missingBase:[]});
    const contradiction=structuredClone(input);contradiction.batch.items[0].assessment!.eventExempt=!result.assessment!.eventExempt;
    failed(await client.commitQualificationResults(contradiction),'INVALID_INPUT');
    const lower=structuredClone(input);lower.batch.items[0].resultRevision='9007199254740992';lower.batch.items[0].version='older';
    expect(ok(await client.commitQualificationResults(lower)).saved).toBe(0);
    const foreign=structuredClone(input);foreign.batch.items[0].source.tripId=randomUUID();
    failed(await client.commitQualificationResults(foreign),'INVALID_INPUT');
    await client.close();
    const reopened=await ws.open({purpose:'history'});
    const saved=ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0].result;
    expect(saved).toEqual(result);
    reopened.close();
    readOnly(ws.database,db=>{expect(db.prepare('SELECT count(*) FROM upload_receipts').pluck().get()).toBe(0);expect(db.prepare('SELECT count(*) FROM qualification_result_versions').pluck().get()).toBe(1);expect(db.pragma('foreign_key_check')).toEqual([]);});
  });
});
