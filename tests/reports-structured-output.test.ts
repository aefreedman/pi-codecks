import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { CODECKS_READ_ERROR_CODES } from "../src/contracts/common.ts";
import { REPORT_TOOL_DEFINITIONS } from "../src/tools/reports/definitions.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { runWithAbortSignal } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
import { observationCache } from "./velocity-fixtures.ts";
import { projectRunDeliveredOutput, REPORTS_READ_LIMITS } from "../src/tools/reports/reports-read-output.ts";
import { projectVelocityReportOutput, REPORTS_FILE_LIMITS } from "../src/tools/reports/reports-file-output.ts";

useInertEnvironmentCredentialProvider();
process.env.CODECKS_ACCOUNT = "example";
process.env.CODECKS_API_BASE = "https://api.codecks.io";
const root = await mkdtemp(join(tmpdir(), "pi-codecks-reports-structured-"));
const priorFetch = globalThis.fetch;
const requests: any[] = [];
let mode = "normal";
const runs = [
 { id: "run-zero", accountSeq: 0, name: null, completedAt: "2026-02-20T00:00:00Z", startDate: "2026-02-09", endDate: "2026-02-15", stats: { finishStats: { progress: { done: [1, 0, 1] } }, progress: { done: [2, 9, 0] } } },
 { id: "run-positive", accountSeq: 1, name: "", completedAt: "2026-02-19T00:00:00Z", startDate: "2026-02-02", endDate: "2026-02-08", stats: { finishStats: { progress: { done: [2, 10, 0] } } } },
 { id: "run-null", accountSeq: 2, name: "Delivery", completedAt: "2026-02-18T00:00:00Z", stats: { finishStats: null } },
 { id: "run-missing", completedAt: "2026-02-17T00:00:00Z" },
];
globalThis.fetch = (async (_url: any, init: any) => {
 const body = JSON.parse(init.body); const query = body.query; requests.push(body);
 if (mode === "forbidden") return new Response(JSON.stringify({ error: "Synthetic forbidden" }), { status: 403 });
 const relation = (query._root?.[0]?.account ?? []).flatMap((x: any) => x && typeof x === "object" ? Object.keys(x) : []).find((x: string) => /^(sprints|activities|cards)(\(|$)/.test(x));
 assert.ok(relation, "canonical report query expected");
 if (relation === "sprints") {
  const fields = query._root[0].account.find((entry: any) => Object.hasOwn(entry, "sprints")).sprints;
  assert.ok(fields.includes("name"), "canonical Run query selects name");
  assert.equal(fields.includes("customLabel"), false, "customLabel is not an upstream field");
 }
 if (relation.startsWith("cards")) return new Response(JSON.stringify({ data: { user: mode === "ambiguous" ? { a: { id: "user-a", name: "Alex" }, b: { id: "user-b", name: "Alex" } } : {} } }));
 const values = relation === "sprints" ? mode === "empty" ? [] : mode === "raw" ? [{ completedAt: "2026-02-20T00:00:00Z", stats: { finishStats: { progress: { done: { count: null, effort: false, noEffort: 0 } } } } }] : runs : mode === "scan" ? Array.from({ length: 50 }, (_, i) => ({ id: `activity-${i}`, createdAt: "2026-02-03T12:00:00Z", data: { diff: { status: ["started", "done"] } }, card: { cardId: `card-${i}`, accountSeq: i, title: "Synthetic", effort: 0, status: "done" } })) : [];
 return new Response(JSON.stringify({ data: { _root: { account: "account-test" }, account: { "account-test": { id: "account-test", sprintsEnabled: true, [relation]: values } } } }));
}) as typeof fetch;
const register = (d: any) => { let result: any; registerCodecksTool({ registerTool(t: any) { result = t; } } as any, d, "Fixture", true, () => "PERSONAL"); return result; };
const direct = (d: any, args: any) => runWithAbortSignal(undefined, () => d.executePayload(args), root);
const invoke = (d: any, args: any, signal?: AbortSignal) => register(d).execute("fixture", args, signal, undefined, { cwd: root });
let checks = 0;
const check = (condition: unknown, message?: string) => { assert.ok(condition, message); checks++; };
try {
 for (const d of REPORT_TOOL_DEFINITIONS) for (const code of CODECKS_READ_ERROR_CODES) { const error = { schemaVersion: 1, action: d.exportName.replaceAll("_", "-"), ok: false, error: { code, message: "Synthetic error" }, completeness: { projection: true }, warnings: [], ...(d.exportName.startsWith("velocity") ? { effects: { certainty: "not_written", artifacts: [], replayAllowed: false } } : {}) }; const dto: any = d.projectOutput!(error); check(!dto.ok); assert.equal(dto.error.code, code); check(Value.Check(d.outputSchema!, dto)); }
 const cache: any = observationCache(); cache.organization.profile = "PERSONAL";
 await writeFile(join(root, "cache.json"), JSON.stringify(cache));
 let deliveredNative: any;
 let reportNative: any;
 const inspectSchema = (schema: any): void => { if (schema.type === "object") { assert.equal(schema.additionalProperties, false); for (const child of Object.values(schema.properties ?? {})) inspectSchema(child); } if (schema.type === "string" && schema.const === undefined) check(Number.isFinite(schema.maxLength)); if (schema.type === "array") { check(Number.isFinite(schema.maxItems)); inspectSchema(schema.items); } for (const child of schema.anyOf ?? []) inspectSchema(child); };
 for (const d of REPORT_TOOL_DEFINITIONS) {
  inspectSchema(d.outputSchema); check(d.read === undefined);
  resetRateGate(); requests.length = 0;
  const file = d.exportName.startsWith("velocity");
  const args = d.exportName === "velocity_observations_update" ? { observationsPath: "new.json", refreshMode: "full", fromDate: "2026-02-01", toDate: "2026-02-28", format: "json" } : file ? { observationsPath: "cache.json", format: "json" } : { completedRuns: 4, includeCurrentStats: true, format: "json" };
  const native = await direct(d, args);
  const dto: any = d.projectOutput!(native.payload);
  check(dto.ok, `${d.exportName}: ${native.text}; ${JSON.stringify(dto)}`);
  check(Value.Check(d.outputSchema!, dto));
  check(!Value.Check(d.outputSchema!, { ...dto, extra: true }));
  const legacy = JSON.parse(native.text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ?? native.text); check(legacy.ok);
  const bodies = structuredClone(requests);
  if (file && d.exportName === "velocity_report") check(requests.length === 0);
  else if (!file) check(requests.length === 1);
  if (d.exportName === "run_delivered_effort") {
   deliveredNative = native.payload;
   assert.equal(dto.data.totals.effort, 10); assert.equal(dto.data.runs[0].observedDone.effort, 0);
   assert.equal(dto.data.runs[0].customLabel, null); assert.equal(dto.data.runs[0].accountSeq, 0);
   assert.equal(dto.data.runs[2].observedDone.effort, null); assert.equal(dto.data.runs[2].finishStatsPresence, "null");
   assert.equal(dto.data.runs[3].finishStatsPresence, "missing"); check(!Object.hasOwn(dto.data.runs[3], "accountSeq"));
   assert.equal(dto.data.runs[0].current.effort, 9); assert.equal(dto.data.runs[0].calculatedDelivered.effort, 0);
   assert.deepEqual(dto.data.totals, legacy.data.totals);
  }
  if (d.exportName === "run_average_effort") { assert.equal(dto.data.averageEffort, 10); assert.equal(dto.data.filteredRunCount, 3); assert.equal(dto.data.includedRunCount, 1); }
  if (d.exportName === "velocity_report") { reportNative = native.payload; assert.deepEqual(dto.data.subjects[0].summary, legacy.data.subjects[0].summary); check(!Object.hasOwn(dto.data, "organization")); }
  if (d.exportName === "velocity_observations_update") { assert.equal(dto.effects.certainty, "written"); assert.deepEqual(dto.effects.artifacts, [{ kind: "observations", reference: "new.json" }]); assert.equal(dto.data.mode, "full"); check(dto.data.visibility.includes("unverifiable")); }
  requests.length = 0; resetRateGate();
  let invocations = 0;
  const counted = { ...d, executePayload: async (input: any) => { invocations++; return d.executePayload!(input); } };
  const registered = await invoke(counted, { ...args, format: "text" });
  assert.equal(invocations, 1);
  check(registered.structuredContent.ok); check(!registered.isError);
  assert.deepEqual(requests, bodies);
  if (!file) { const text = await direct(d, { ...args, format: "text" }); assert.equal(registered.content[0].text, text.text); }
  const malformed = register({ ...d, executePayload: async () => ({ text: "malformed", payload: {} }) });
  const invalid = await malformed.execute("fixture", args, undefined, undefined, { cwd: root });
  check(invalid.isError); assert.equal(invalid.structuredContent.error.code, "output_contract_error");
  const fail = await direct(d, file ? {} : { user: "Unknown" });
  check(!d.projectOutput!(fail.payload).ok);
 }
 const delivered = REPORT_TOOL_DEFINITIONS[2]; const average = REPORT_TOOL_DEFINITIONS[3]; const report = REPORT_TOOL_DEFINITIONS[1]; const updater = REPORT_TOOL_DEFINITIONS[0];
 // Real queried name observations must survive independently of legacy label
 // defaults, including all zero-effort rows in BOTH reports and includedRuns.
 for (const d of [delivered, average]) for (const format of ["json", "text"]) {
  const args = { completedRuns: 4, minDeliveredEffort: 0, includeFilteredRuns: true, includeCurrentStats: true, format };
  requests.length = 0; resetRateGate();
  const native = await direct(d, args); const dto: any = d.projectOutput!(native.payload);
  check(dto.ok); check(Value.Check(d.outputSchema!, dto));
  check(dto.completeness.projection === true);
  assert.equal(dto.data.visibility, "token_visible_account_runs_snapshot");
  assert.equal(requests.length, 1); const queryBody = structuredClone(requests[0]);
  assert.equal(dto.data.returned, 4); assert.equal(dto.data.matchedCompletedRuns, 4);
  assert.deepEqual(dto.data.runs.map((row: any) => row.runId), runs.map(row => row.id));
  const assertLabels = (rows: any[]) => {
   assert.equal(rows.length, 4);
   for (const [index, row] of rows.entries()) {
    check(Object.hasOwn(row, "customLabel") === Object.hasOwn(runs[index], "name"));
    if (Object.hasOwn(runs[index], "name")) assert.strictEqual(row.customLabel, runs[index].name);
   }
  };
  assertLabels(dto.data.runs);
  assert.deepEqual(dto.data.runs.map((row: any) => row.calculatedDelivered.effort), [0, 10, 0, 0]);
  assert.deepEqual(dto.data.totals, { count: 3, effort: 10, noEffort: 1 });
  if (d === average) {
   assert.equal(dto.data.includedRunCount, 4); assert.equal(dto.data.filteredRunCount, 0);
   assert.equal(dto.data.averageEffort, 2.5); assert.equal(dto.data.averageDoneCards, 0.75);
   assertLabels(dto.data.includedRuns); assert.deepEqual(dto.data.filteredRuns, []);
  }
  requests.length = 0; resetRateGate();
  const legacy = await runWithAbortSignal(undefined, () => d.tool.execute(args), root);
  assert.equal(legacy, native.text, "legacy text/JSON interface unchanged");
  assert.equal(requests.length, 1); assert.deepEqual(requests[0], queryBody);
  if (format === "json") {
   const payload = JSON.parse(String(legacy).match(/```json\s*([\s\S]*?)\s*```/)![1]);
   assert.deepEqual(payload.data.totals, dto.data.totals);
   if (d === average) assert.equal(payload.data.averageEffort, 2.5);
  } else {
   assert.match(String(legacy), /Total Delivered Effort: 10/);
   if (d === average) assert.match(String(legacy), /Average Delivered Effort: 2.5/);
  }
  requests.length = 0; resetRateGate();
  const registered = await invoke(d, args);
  assert.equal(registered.isError, false); assert.deepEqual(registered.structuredContent, dto);
  assert.equal(registered.content[0].text, legacy);
  assert.equal(requests.length, 1); assert.deepEqual(requests[0], queryBody);
 }
 console.log("reports name observations: both reports x two formats x native/legacy/registered; absent/null/empty/nonempty rows, all four included, one canonical name query and unchanged totals/text passed");
 for (const d of [delivered, average]) {
  mode = "ambiguous"; resetRateGate(); const out = await invoke(d, { user: "Alex" }); check(out.isError); assert.equal(out.structuredContent.error.code, "ambiguous_match");
  mode = "forbidden"; resetRateGate(); const denied = await invoke(d, {}); check(denied.isError); check(!denied.structuredContent.ok);
  mode = "empty"; resetRateGate(); const empty = await invoke(d, {}); check(empty.structuredContent.ok); assert.equal(empty.structuredContent.data.returned, 0);
 }
 mode = "raw"; resetRateGate();
 const rawNative = await direct(delivered, {}); const nativeFacts: any = delivered.projectOutput!(rawNative.payload); check(nativeFacts.ok); check(!Object.hasOwn(nativeFacts.data.runs[0], "runId")); assert.deepEqual(nativeFacts.data.runs[0].rawDone, { count: null, effort: false, noEffort: 0 }); assert.equal(nativeFacts.data.runs[0].observedDone.effort, null); check(rawNative.text.includes("Total Delivered Effort: 0"));
 mode = "scan"; resetRateGate();
 const scan = await invoke(updater, { observationsPath: "scan.json", fromDate: "2026-02-01", toDate: "2026-02-28", scanLimit: 50, pageSize: 50 });
 check(scan.structuredContent.ok); assert.equal(scan.structuredContent.data.mode, "full"); assert.equal(scan.structuredContent.data.scanLimitReached, true); assert.equal(scan.structuredContent.data.complete, false); assert.equal(scan.structuredContent.data.scannedActivities, 50);
 check(!JSON.stringify(scan.structuredContent).includes(root));
 const persistedScan = JSON.parse(await readFile(join(root, "scan.json"), "utf8")); assert.equal(persistedScan.refresh.complete, false); assert.equal(persistedScan.refresh.scannedActivities, 50);
 mode = "normal";
 const zero = await invoke(average, { minDeliveredEffort: 0, includeFilteredRuns: false }); assert.equal(zero.structuredContent.data.averageEffort, 2.5); check(!Object.hasOwn(zero.structuredContent.data, "filteredRuns"));
 for (const d of [updater, report]) for (const observationsPath of ["../outside.json", "cache.json"]) {
  const out = await invoke(d, { observationsPath, ...(d === report && observationsPath === "cache.json" ? { csvPath: "cache.json" } : {}) });
  check(out.isError); assert.equal(out.structuredContent.effects.certainty, "not_written"); assert.deepEqual(out.structuredContent.effects.artifacts, []);
 }
 await mkdir(join(root, "directory.md"));
 const partial = await invoke(report, { observationsPath: "cache.json", csvPath: "partial.csv", summaryMarkdownPath: "directory.md" });
 check(partial.isError); assert.equal(partial.structuredContent.effects.certainty, "indeterminate"); assert.deepEqual(partial.structuredContent.effects.artifacts, [{ kind: "csv", reference: "partial.csv" }]); check((await readFile(join(root, "partial.csv"), "utf8")).includes("summary"));
 const full = await invoke(report, { observationsPath: "cache.json", csvPath: "full.csv", summaryMarkdownPath: "full.md" }); check(full.structuredContent.ok); assert.equal(full.structuredContent.effects.artifacts.length, 2); check((await readFile(join(root, "full.md"), "utf8")).includes("Transformations"));
 const badCache: any = structuredClone(cache); badCache.organization.profile = "ORG";
 await writeFile(join(root, "bad.json"), JSON.stringify(badCache)); await writeFile(join(root, "malformed.json"), "{}");
 for (const d of [updater, report]) for (const observationsPath of ["bad.json", "malformed.json"]) { const out = await invoke(d, { observationsPath, refreshMode: "full" }); check(out.isError); assert.equal(out.structuredContent.effects.certainty, "not_written"); }
 await symlink(root, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
 const alias = await invoke(report, { observationsPath: "cache.json", csvPath: "alias/cache.json" }); check(alias.isError); assert.equal(alias.structuredContent.effects.certainty, "not_written");
 for (const d of REPORT_TOOL_DEFINITIONS) { const controller = new AbortController(); controller.abort(); const aborted = await invoke(d, {}, controller.signal); check(aborted.isError); }
 // Direct projector faults and inclusive UTF-8 boundaries, with no extra persistence.
 const long = structuredClone(deliveredNative); long.data.runs[0].customLabel = "😀".repeat(2049);
 const clipped: any = projectRunDeliveredOutput(long); check(clipped.ok); assert.equal(clipped.completeness.projection, false); assert.equal(Array.from(clipped.data.runs[0].customLabel).length, 2048);
 const bad = structuredClone(deliveredNative); bad.data.runs[0].runId = "x".repeat(2049); assert.equal((projectRunDeliveredOutput(bad) as any).error.code, "output_contract_error");
 const falsy = structuredClone(deliveredNative); falsy.data.runs[0].current = null; falsy.data.runs[0].customLabel = ""; check(projectRunDeliveredOutput(falsy).ok);
 for (const ceiling of [REPORTS_READ_LIMITS.bytes, REPORTS_FILE_LIMITS.bytes]) {
  const native = structuredClone(ceiling === REPORTS_READ_LIMITS.bytes ? deliveredNative : reportNative);
  const project = ceiling === REPORTS_READ_LIMITS.bytes ? projectRunDeliveredOutput : projectVelocityReportOutput;
  native.warnings = [];
  // Every chunk stays below its code-point limit; total compact JSON drives the separate budget.
  while (Buffer.byteLength(JSON.stringify(project(native))) + 2051 < ceiling) native.warnings.push("x".repeat(2048));
  const remaining = ceiling - Buffer.byteLength(JSON.stringify(project(native))) - (native.warnings.length ? 3 : 2);
  native.warnings.push("x".repeat(remaining));
  assert.equal(Buffer.byteLength(JSON.stringify(project(native))), ceiling); check(project(native).ok);
  native.warnings[native.warnings.length - 1] += "x"; assert.equal((project(native) as any).error.code, "output_too_large");
 }
 const afterWrite = structuredClone(reportNative); afterWrite.effects = { certainty: "written", artifacts: [{ kind: "csv", reference: "partial.csv" }], replayAllowed: false }; afterWrite.data.subjects[0].summary.mean = "bad";
 const failed: any = projectVelocityReportOutput(afterWrite); check(!failed.ok); assert.equal(failed.effects.certainty, "written"); assert.equal(failed.effects.replayAllowed, false); assert.equal(failed.effects.artifacts[0].reference, "partial.csv");
 const registeredFailure = register({ ...report, executePayload: async (args: any) => { const result = await report.executePayload!(args); (result.payload as any).data.subjects[0].summary.mean = "invalid"; return result; } });
 requests.length = 0;
 const outputFailure = await registeredFailure.execute("fixture", { observationsPath: "cache.json", csvPath: "projection.csv" }, undefined, undefined, { cwd: root });
 check(outputFailure.isError); assert.equal(outputFailure.structuredContent.effects.certainty, "written"); assert.deepEqual(outputFailure.structuredContent.effects.artifacts, [{ kind: "csv", reference: "projection.csv" }]); assert.equal(requests.length, 0); check((await readFile(join(root, "projection.csv"), "utf8")).includes("summary"));
 const bounded = structuredClone(reportNative); bounded.data.subjects = Array(101).fill({ ...bounded.data.subjects[0], periods: [], biweekly: [] }); bounded.data.sourceSubjects = 101; bounded.data.subjectPeriodCounts = Array(101).fill({ periods: 0, biweekly: 0 });
 const subjectClip: any = projectVelocityReportOutput(bounded); check(subjectClip.ok); assert.equal(subjectClip.data.subjects.length, 100); assert.equal(subjectClip.completeness.projection, false); assert.equal(subjectClip.data.sourceSubjects, 101);
 const raw = structuredClone(deliveredNative); raw.data.runs[0].rawDone = { effort: false, count: null, noEffort: 0 }; const rawDto: any = projectRunDeliveredOutput(raw); check(rawDto.ok); assert.deepEqual(rawDto.data.runs[0].rawDone, { effort: false, count: null, noEffort: 0 });
 for (const native of [undefined, {}, { ok: true }, { ...deliveredNative, data: undefined }, { ...deliveredNative, ok: false, error: undefined }]) { const malformed: any = projectRunDeliveredOutput(native); check(!malformed.ok); assert.equal(malformed.error.code, "output_contract_error"); }
 const unsafe = structuredClone(afterWrite); unsafe.effects.artifacts[0].reference = "/private/path"; const sanitized: any = projectVelocityReportOutput(unsafe); check(!sanitized.ok); assert.deepEqual(sanitized.effects.artifacts, []);
 for (const reference of ["/private/path", "C:\\private\\path", "../outside.csv", "x".repeat(2049)]) { const candidate = structuredClone(reportNative); candidate.effects = { certainty: "written", artifacts: [{ kind: "csv", reference }], replayAllowed: false }; const out: any = projectVelocityReportOutput(candidate); check(!out.ok); assert.equal(out.effects.certainty, "written"); assert.deepEqual(out.effects.artifacts, []); }
 const aliased = await invoke(report, report.config.prepareArguments!({ observations_path: "cache.json", output_format: "json" })); check(aliased.structuredContent.ok); assert.deepEqual(aliased.structuredContent.data.dateWindow, (projectVelocityReportOutput(reportNative) as any).data.dateWindow);
 console.log(`reports structured output: ${checks} assertions passed; four direct seams and registered adapters; zero live transports`);
} finally { globalThis.fetch = priorFetch; await rm(root, { recursive: true, force: true }); resetRateGate(); }
