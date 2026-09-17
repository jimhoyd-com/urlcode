import {createHash,randomUUID} from 'node:crypto';
import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {linkCollection,linkCode,linkData,linkVersion,randomLinkCode} from './link-records.ts';
import {HttpError} from './errors.ts';
let db;
const error=(status,message)=>{throw new HttpError(status,message);};
try {
  db=new DatabaseSync(workerData.file,{readOnly:workerData.readOnly,allowExtension:false});
  db.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
  const schemaVersion=db.prepare('PRAGMA user_version').get().user_version;
  const applicationId=db.prepare('PRAGMA application_id').get().application_id;
  const empty=db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count===0;
  if(!(schemaVersion===1 && applicationId===1431456835) && !(schemaVersion===0 && applicationId===0 && empty && !workerData.readOnly))throw new Error('Unsupported database schema');
  if(!workerData.readOnly){
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if(schemaVersion===0)db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS urlcode_link_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO urlcode_link_meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS urlcode_links (
        collection TEXT NOT NULL, code TEXT NOT NULL, url TEXT NOT NULL,
        status INTEGER NOT NULL, enabled INTEGER NOT NULL, expires TEXT,
        version INTEGER NOT NULL, PRIMARY KEY(collection,code));
      PRAGMA application_id=1431456835; PRAGMA user_version=1; COMMIT;`);
  }
  if(!workerData.readOnly)db.exec(`CREATE TABLE IF NOT EXISTS urlcode_link_audit (revision INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL, collection TEXT NOT NULL, action TEXT NOT NULL, code_sha256 TEXT NOT NULL)`);
  if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')throw new Error('Link stores require WAL mode');
  const meta=db.prepare('SELECT revision FROM urlcode_link_meta WHERE id=1').get();
  if(!meta || !Number.isSafeInteger(meta.revision) || meta.revision<0)throw new Error('Invalid store revision');
  db.prepare('SELECT collection,code,url,status,enabled,expires,version FROM urlcode_links LIMIT 0').all();
  parentPort.postMessage({ready:true});
}catch{try{db?.close();}catch{/* Initialization can fail before opening. */}parentPort.postMessage({failed:true});parentPort.close();}
function get(collection,code) {
  const row=db.prepare('SELECT * FROM urlcode_links WHERE collection=? AND code=?').get(collection,code);
  return row ? {...row,enabled:row.enabled===1} : null;
}
function transaction(fn, audit, collection, operation, code) {
  db.exec('BEGIN IMMEDIATE');
  try{
    const value=fn();
    const actor=audit?.actor??'local-operator',requestId=audit?.requestId??randomUUID();
    if(typeof actor!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(actor)||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(requestId))error(400,'Invalid audit identity');
    const revision=db.prepare('SELECT revision FROM urlcode_link_meta WHERE id=1').get().revision;
    db.prepare('INSERT INTO urlcode_link_audit VALUES(?,?,?,?,?,?,?)').run(revision,new Date().toISOString(),actor,requestId,collection,operation,createHash('sha256').update(value.code??code).digest('hex'));
    db.exec('COMMIT');return value;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
function version() {
  const current=db.prepare('SELECT revision FROM urlcode_link_meta WHERE id=1').get().revision;
  if(!Number.isSafeInteger(current) || current>=Number.MAX_SAFE_INTEGER)error(503,'Link store revision exhausted');
  db.prepare('UPDATE urlcode_link_meta SET revision=? WHERE id=1').run(current+1);return current+1;
}
// A consistent operator export needs one read transaction spanning every page.
// WAL gives this connection a point-in-time view while writers keep committing;
// the transaction is deliberately bounded and belongs to a single connection.
let exporting=null;
function exportEnd() {
  if(!exporting)return false;
  exporting=null;
  try{db.exec('ROLLBACK');}catch{/* A lost transaction is already finished. */}
  return true;
}
function exportBegin(collection) {
  if(exporting)error(409,'An export is already in progress on this connection');
  if(collection!==undefined)linkCollection(collection);
  db.exec('BEGIN DEFERRED');
  try {
    // The first read inside the transaction is what pins the snapshot.
    const records=collection===undefined
      ? db.prepare('SELECT count(*) AS count FROM urlcode_links').get().count
      : db.prepare('SELECT count(*) AS count FROM urlcode_links WHERE collection=?').get(collection).count;
    const revision=db.prepare('SELECT revision FROM urlcode_link_meta WHERE id=1').get().revision;
    exporting={collection:collection??null};
    return {format:'urlcode.links.v1',schemaVersion:db.prepare('PRAGMA user_version').get().user_version,
      applicationId:db.prepare('PRAGMA application_id').get().application_id,
      collection:collection??null,revision,records,generatedAt:new Date().toISOString()};
  }catch(e){try{db.exec('ROLLBACK');}catch{/* Reported through the original error. */}throw e;}
}
function exportPage({afterCollection='',afterCode='',limit=100}) {
  if(!exporting)error(409,'No export is in progress on this connection');
  if(!Number.isInteger(limit)||limit<1||limit>100)error(400,'Limit must be 1–100');
  if(afterCollection!=='')linkCollection(afterCollection);
  if(afterCode!=='')linkCode(afterCode);
  const rows=exporting.collection===null
    ? db.prepare('SELECT collection,code,url,status,enabled,expires,version FROM urlcode_links WHERE collection>? OR (collection=? AND code>?) ORDER BY collection,code LIMIT ?').all(afterCollection,afterCollection,afterCode,limit)
    : db.prepare('SELECT collection,code,url,status,enabled,expires,version FROM urlcode_links WHERE collection=? AND code>? ORDER BY code LIMIT ?').all(exporting.collection,afterCode,limit);
  return rows.map(row=>({...row,enabled:row.enabled===1}));
}
parentPort.on('message',({id,operation,args})=>{
  try {
    if(operation==='close'){exportEnd();db.close();parentPort.postMessage({id,value:true});parentPort.close();return;}
    if(operation==='exportBegin'){parentPort.postMessage({id,value:exportBegin(args.collection)});return;}
    if(operation==='exportPage'){
      try{parentPort.postMessage({id,value:exportPage(args)});}
      catch(e){exportEnd();throw e;}
      return;
    }
    if(operation==='exportEnd'){parentPort.postMessage({id,value:exportEnd()});return;}
    const {collection,code}=args;linkCollection(collection);
    let value;
    if(operation==='get'){linkCode(code);value=get(collection,code);}
    else if(operation==='list'){
      const limit=args.limit??100,after=args.after??'';
      if(!Number.isInteger(limit)||limit<1||limit>100)error(400,'Limit must be 1–100');
      if(after!=='')linkCode(after);
      value=db.prepare('SELECT * FROM urlcode_links WHERE collection=? AND code>? ORDER BY code LIMIT ?').all(collection,after,limit).map(row=>({...row,enabled:row.enabled===1}));
    }else{
      if(workerData.readOnly)error(403,'Store is read-only');
      if(exporting)error(409,'An export is in progress on this connection');
      value=transaction(()=>{
        if(operation==='create'){
          const data=linkData(args.data);
          if(db.prepare('SELECT count(*) AS count FROM urlcode_links').get().count>=100000)error(507,'Link store record limit reached');
          let assigned=code===undefined?randomLinkCode():linkCode(code);
          if(code!==undefined && get(collection,assigned))error(409,'Short code already exists');
          if(code===undefined){let attempts=0;while(get(collection,assigned)){if(++attempts>=5)error(503,'Code allocation failed');assigned=randomLinkCode();}}
          db.prepare('INSERT INTO urlcode_links VALUES(?,?,?,?,?,?,?)').run(collection,assigned,data.url,data.status,Number(data.enabled),data.expires,version());
          return get(collection,assigned);
        }
        if(!['update','delete'].includes(operation))error(400,'Unsupported store operation');
        linkCode(code);linkVersion(args.expectedVersion);
        const previous=get(collection,code);if(!previous)error(404,'Link not found');
        if(previous.version!==args.expectedVersion)error(409,'Link version changed');
        if(operation==='delete'){version();db.prepare('DELETE FROM urlcode_links WHERE collection=? AND code=?').run(collection,code);return true;}
        const data=linkData(args.data);
        db.prepare('UPDATE urlcode_links SET url=?,status=?,enabled=?,expires=?,version=? WHERE collection=? AND code=?').run(data.url,data.status,Number(data.enabled),data.expires,version(),collection,code);
        return get(collection,code);
      },args.audit,collection,operation,code);
    }
    parentPort.postMessage({id,value});
  }catch(e){parentPort.postMessage({id,error:{status:e instanceof HttpError?e.status:503,message:e instanceof HttpError?e.message:'Link store unavailable'}});}
});
