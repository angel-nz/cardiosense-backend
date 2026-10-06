// Read-path integration against an in-memory Prisma adapter. No DB connection/writes.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript')
const assert=require('node:assert/strict'),{test}=require('node:test')
let records=[],predictions=[],queries=[]
function match(row,where={}) {
 return Object.entries(where).every(([key,value])=>{
  if(key==='AND')return value.every(w=>match(row,w))
  if(key==='OR')return value.some(w=>match(row,w))
  const actual=row[key]
  if(value===null||typeof value!=='object'||value instanceof Date)return actual===value
  if('is' in value)return actual!=null&&match(actual,value.is)
  if('in' in value)return value.in.includes(actual)
  if('not' in value&&actual===value.not)return false
  if('gte' in value&&(actual==null||actual<value.gte))return false
  if('lt' in value&&(actual==null||actual>=value.lt))return false
  return true
 })
}
const nonclinical={id:'info',patientId:'p',predictionId:null,type:'INFO_PATIENT_UPDATED',createdAt:new Date('2026-10-05T16:00:00Z')}
const prisma={
 healthRecord:{findMany:async q=>{queries.push(q);return records.filter(r=>match(r,q.where))}},
 prediction:{findMany:async q=>{
  queries.push(q);let list=predictions.map(p=>({...p,healthRecord:records.find(r=>r.id===p.healthRecordId)})).filter(p=>match(p,q.where))
  if(q.distinct)list=list.filter((p,i)=>list.findIndex(x=>x.patientId===p.patientId)===i)
  return list
 }},
 alert:{findMany:async q=>{queries.push(q);return [nonclinical]},count:async()=>1},
 $transaction:async values=>Promise.all(values),
}
const load=Module._load
Module._load=function(name,parent,main){
 if(name==='@/config/prisma')return {prisma}
 if(name.startsWith('@/'))name=path.join(__dirname,'../src',name.slice(2))
 return load.call(this,name,parent,main)
}
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},fileName:file}).outputText,file)
const {buildClinicalCalendarEvents}=require('../src/modules/patients/clinicalCalendar.ts')
const {AlertRepository}=require('../src/modules/alerts/alert.repository.ts')
function fixture(){
 queries=[]
 records=['06','07','08','09'].map((m,i)=>({id:`hr${i}`,patientId:'p',measuredAt:new Date(`2026-${m}-04T16:00:00Z`),recordedAt:new Date(`2026-10-05T15:00:0${i}Z`),clinicalTimeSource:'CLINICIAN_ENTERED',sysBP:120,diaBP:80}))
 predictions=records.map((r,i)=>({id:`pred${i}`,patientId:'p',healthRecordId:r.id,origin:'AUTOMATIC_HEALTH_RECORD',predictedAt:new Date('2026-10-05T16:00:00Z'),riskLevel:['LOW','MODERATE','HIGH','LOW'][i],riskScore:.2,isAnomaly:false,modelVersion:'Skorp-Beta-0.2'}))
}
test('July HR and change calculated October are returned for July, grouped in causal order',async()=>{
 fixture();const events=await buildClinicalCalendarEvents({patientId:'p'},new Date('2026-07-01'),new Date('2026-08-01'))
 assert.deepEqual(events.map(e=>e.eventType),['CLINICAL_RECORD','PREDICTION','RISK_CHANGE'])
 assert(events.every(e=>e.eventDate==='2026-07-04T16:00:00.000Z'))
 assert.equal(new Set(events.map(e=>e.groupId)).size,1)
 assert.equal(events[2].metadata.healthRecordId,'hr1');assert.equal(events[2].metadata.generatedAt,'2026-10-05T16:00:00.000Z')
 const candidateQuery=queries.find(q=>q.distinct);assert(!('predictedAt' in candidateQuery.where));assert(candidateQuery.where.healthRecord.is.AND)
})
test('July/August/September changes remain in clinical months despite identical October calculation times',async()=>{
 fixture();const events=await buildClinicalCalendarEvents({patientId:'p'},new Date('2026-07-01'),new Date('2026-10-01'))
 assert.deepEqual(events.filter(e=>e.eventType==='RISK_CHANGE').map(e=>e.eventDate.slice(0,7)),['2026-07','2026-08','2026-09'])
 assert.deepEqual(events.map(e=>e.metadata.healthRecordId),['hr1','hr1','hr1','hr2','hr2','hr2','hr3','hr3','hr3'])
 assert.deepEqual(await buildClinicalCalendarEvents({patientId:'p'},new Date('2026-10-01'),new Date('2026-11-01')),[])
})
test('Half-open range, stable order, scope isolation and predecessor outside selected month',async()=>{
 fixture();const first=await buildClinicalCalendarEvents({patientId:'p'},records[1].measuredAt,records[2].measuredAt)
 records.reverse();predictions.reverse();const second=await buildClinicalCalendarEvents({patientId:'p'},new Date('2026-07-04T16:00Z'),new Date('2026-08-04T16:00Z'))
 assert.deepEqual(first,second);assert.equal(first[2].metadata.previousPredictionId,'pred0')
 assert.deepEqual(await buildClinicalCalendarEvents({patientId:'another'}),[])
})
test('Multiple derived changes for same record have deterministic grouping, no timestamp heuristic',async()=>{
 fixture();predictions.push({...predictions[1],id:'pred1b',riskLevel:'HIGH'})
 const events=await buildClinicalCalendarEvents({patientId:'p'},new Date('2026-07-01'),new Date('2026-08-01'))
 assert.deepEqual(events.map(e=>e.eventType),['CLINICAL_RECORD','PREDICTION','PREDICTION','RISK_CHANGE','RISK_CHANGE'])
 assert.deepEqual(events.filter(e=>e.eventType==='RISK_CHANGE').map(e=>e.id),['risk-change:pred1','risk-change:pred1b'])
 assert.equal(new Set(events.map(e=>e.groupId)).size,1)
})
test('Legacy/missing measuredAt never invents a clinical risk-change date',async()=>{
 fixture();records[1].measuredAt=null;records[1].clinicalTimeSource='LEGACY_ENTRY_TIME'
 const events=await buildClinicalCalendarEvents({patientId:'p'})
 assert(!events.some(e=>e.eventType==='RISK_CHANGE'&&e.metadata.healthRecordId==='hr1'))
 assert.equal(events.find(e=>e.id==='hr1').eventDate,records[1].recordedAt.toISOString())
})
test('Non-clinical Alert API preserves createdAt and no fabricated measuredAt',async()=>{
 fixture();const result=await new AlertRepository().findByDoctor('doctor',{page:1,limit:20})
 assert.equal(result.data[0],nonclinical);assert.equal(result.data[0].createdAt.toISOString(),'2026-10-05T16:00:00.000Z')
 assert(!('measuredAt' in result.data[0]));assert.deepEqual(queries.at(-1).orderBy,[{createdAt:'desc'},{id:'desc'}])
 const events=await buildClinicalCalendarEvents({patientId:'p'});assert(!events.some(e=>e.id==='info'))
})
test('Both production calendar services call this single builder and keep returned grouping/order',()=>{
 for(const file of ['patients/patient.service.ts','dashboard/dashboard.service.ts']) {
  const s=fs.readFileSync(path.join(__dirname,'../src/modules',file),'utf8');assert(s.includes('buildClinicalCalendarEvents('))
 }
})
