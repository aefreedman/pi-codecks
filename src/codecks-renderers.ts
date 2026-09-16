import { stripVTControlCharacters } from "node:util";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

// Presentation only. Never import the core, fetch more data, or write to a result.
type RecordValue = Readonly<Record<string, unknown>>;
type Theme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type Result = { readonly content?: readonly { readonly type?: string; readonly text?: string }[]; readonly details?: unknown };
type Context = { args?: unknown; isError?: boolean; lastComponent?: unknown; state?: Record<string, unknown> };
type Options = { expanded?: boolean; isPartial?: boolean };
type Summary = { label: string; tone: string; rows: string[]; notices: string[] };
const dot = " \u00b7 ";
const titles: Record<string, string> = {
  card_get: "Card", card_get_batch: "Cards", card_get_formatted: "Card summary", card_search: "Find cards",
  card_bulk_create: "Bulk create", card_bulk_update: "Bulk update", card_list_resolvables: "Card conversations",
  list_open_resolvable_cards: "Open conversations", list_logged_in_user_actionable_resolvables: "Conversation inbox",
  tool_search: "Find tools", query: "Query", dispatch: "Dispatch",
};
const title = (name: string): string => titles[name] ?? name.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const scalar = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const rawText = (result: Result): string => (result.content ?? []).filter(item => item.type === "text").map(item => item.text ?? "").join("\n");

// Card prose can legitimately discuss passwords, tokens and JSON. Do not redact,
// normalize Markdown, or rewrite it here. Core credential sanitization is unchanged.
function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const compact = (value: string, width = 160): string => truncateToWidth(terminalText(value).replace(/\s+/g, " ").trim(), width);
function component(text: string, context?: Context): Text {
  const view = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  view.setText(text);
  return view;
}
function paint(theme: Theme, color: string, text: string): string {
  return terminalText(text).split("\n").map(line => theme.fg(color, line)).join("\n");
}
function payload(result: Result): RecordValue {
  const details = record(result.details);
  // Legacy format:text card results retain a separate structured presentation.
  if (details.cardPresentation !== undefined) return record(details.cardPresentation);
  const raw = rawText(result);
  // Decode only an entire envelope. A JSON fence within card prose is not a result.
  const json = raw.match(/^(?:## [^\r\n]+\r?\n\r?\n)?```json\r?\n([\s\S]*)\r?\n```\s*$/)?.[1] ?? raw;
  try { return record(JSON.parse(json)); }
  catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
}
const cardHeading = (card: RecordValue): string => [scalar(card.shortCode) || scalar(card.cardRef), scalar(card.title)].filter(Boolean).join("  ") || "Untitled card";
const named = (value: unknown): string => scalar(value) || scalar(record(value).title) || scalar(record(value).name) || scalar(record(value).fullName);
const cardRole = (card: RecordValue): string => card.derivedStatus === "hero" || card.derivedStatus === "heroDone" ? "Hero" : "";
function cardStatus(card: RecordValue): string {
  const derived = scalar(card.derivedStatus);
  const status = scalar(card.status) || (derived === "heroDone" ? "done" : derived === "hero" ? "" : derived);
  return status.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
}
const cardMeta = (card: RecordValue): string => [cardStatus(card), cardRole(card), named(card.deck), card.effort !== null && scalar(card.effort) ? `effort ${scalar(card.effort)}` : ""].filter(Boolean).join(dot);

const singleCard = (name: string): boolean => name === "card_get" || name === "card_get_formatted";
function runResidency(card: RecordValue): string {
  const run = named(card.run) || scalar(record(card.run).customLabel) || scalar(card.runId) || scalar(card.sprintId);
  if (run) return `Run: ${run}`;
  return card.run === null || card.runId === null || card.sprintId === null ? "No Run" : "";
}
function compactCard(card: RecordValue, theme: Theme): string {
  const code = scalar(card.shortCode) || scalar(card.cardRef);
  const heading = [code, scalar(card.title) || "Untitled card"].filter(Boolean).join(dot);
  const metadata = [cardStatus(card), cardRole(card), named(card.deck), named(card.assignee), named(card.milestone), runResidency(card),
    card.effort !== null && scalar(card.effort) ? `Effort ${scalar(card.effort)}` : ""].filter(Boolean).join(dot);
  return `${theme.fg("muted", "Codecks")}  ${theme.bold(paint(theme, "toolTitle", heading))}${metadata ? `\n         ${paint(theme, "muted", metadata)}` : ""}`;
}

export function renderCodecksCall(name: string, input: unknown, theme: Theme, context?: Context): Text {
  const args = record(input);
  if (singleCard(name)) {
    const target = scalar(args.cardId) || scalar(args.title);
    const view = component(`${theme.fg("muted", "Codecks")}${target ? `  ${paint(theme, "accent", compact(target))}` : ""}`, context);
    if (context?.state) context.state.codecksCardCall = view;
    return view;
  }
  let heading = theme.fg("toolTitle", theme.bold(`Codecks${dot}${title(name)}`));
  const bulk = name === "card_bulk_create" || name === "card_bulk_update";
  if (bulk) {
    const entries = name === "card_bulk_create" ? args.cards : args.updates;
    heading += theme.fg(args.dryRun === false ? "warning" : "accent", `${dot}${args.dryRun === false ? "apply" : "preview"}${Array.isArray(entries) ? `${dot}${entries.length} cards` : ""}`);
  }
  const target = scalar(args.cardId) || scalar(args.cardCode) || scalar(args.resolvableId) || scalar(args.entryId)
    || scalar(args.deckId) || scalar(args.milestoneId) || scalar(args.runId) || scalar(args.title) || scalar(args.text)
    || scalar(args.path) || scalar(args.search) || (name === "tool_search" ? strings(args.toolNames).join(", ") || scalar(args.query) : "");
  const scope = [args.deck !== undefined ? `deck: ${scalar(args.deck)}` : "", args.milestone !== undefined ? `milestone: ${scalar(args.milestone)}` : "", scalar(args.location)].filter(Boolean).join(dot);
  if (target) heading += `\n${paint(theme, "accent", compact(target))}`;
  if (scope) heading += `\n${paint(theme, "muted", compact(scope))}`;
  if (Array.isArray(args.cardIds)) heading += `\n${paint(theme, "accent", compact(args.cardIds.map(scalar).join(", ")))}`;
  return component(heading, context);
}

function summarize(name: string, result: Result, context?: Context): Summary {
  const envelope = payload(result);
  const data = record(envelope.data);
  const error = record(envelope.error);
  const summary: Summary = { label: "Result returned", tone: "toolOutput", rows: [], notices: [...strings(envelope.warnings)] };
  const incomplete = data.complete === false || error.complete === false || data.scanLimitReached === true;
  if (incomplete) summary.notices.unshift("Incomplete coverage; missing results are not proof of absence.");
  if (data.truncated === true || data.truncatedByOutputLimit === true) summary.notices.push("The tool limited the returned rows; expanded output cannot restore omitted data.");
  if (typeof envelope.nextSuggestedAction === "string") summary.notices.push(envelope.nextSuggestedAction);
  if (context?.isError || envelope.ok === false) {
    summary.label = "Request failed";
    summary.tone = "error";
    summary.rows = [scalar(error.message) || rawText(result).split(/\r?\n/).find(line => line.trim()) || "No error message returned"];
    if (scalar(error.category)) summary.label += `${dot}${scalar(error.category)}`;
    if (scalar(error.recoveryHint)) summary.notices.push(scalar(error.recoveryHint));
  } else if (name === "tool_search" && Array.isArray(record(result.details).matches)) {
    const details = record(result.details);
    summary.label = details.browse === true ? "Browse Codecks capabilities" : strings(details.matches).length === 0 ? "No executable tools matched" : `${strings(details.added).length} activated${dot}${strings(details.alreadyActive).length} already active`;
    summary.rows = strings(details.matches);
    if (strings(details.unavailableToolNames).length) summary.notices.push(`Unavailable: ${strings(details.unavailableToolNames).join(", ")}`);
  } else if ((name === "card_bulk_create" || name === "card_bulk_update") && typeof data.dryRun === "boolean") {
    summary.label = data.dryRun ? "Preview" : "Apply results";
    for (const [key, label] of [["count", "records"], ["created", "created"], ["updated", "updated"], ["failed", "failed"], ["indeterminate", "indeterminate"], ["definitelyUnsent", "definitely unsent"], ["pending", "pending"]]) {
      if (count(data[key]) !== undefined) summary.label += `${dot}${data[key]} ${label}`;
    }
    if (count(data.indeterminate)) summary.notices.unshift("Write outcome uncertain. Inspect Codecks before retrying.");
    if (count(data.failed) || count(data.definitelyUnsent) || count(data.pending)) summary.notices.push("Some records were not applied; inspect per-record outcomes.");
    if (record(data.artifact).unavailable === true) summary.notices.push(scalar(record(data.artifact).reason) || "Detailed artifact unavailable.");
    summary.rows = rows(data.results).map(item => `#${count(item.index) !== undefined ? Number(item.index) + 1 : "?"}${dot}${scalar(item.status)}${dot}${scalar(item.certainty)}${scalar(record(item.error).message) ? `: ${scalar(record(item.error).message)}` : ""}`);
    summary.tone = data.dryRun ? "warning" : "toolOutput";
  } else if (name === "card_get_batch" && count(data.requested) !== undefined) {
    summary.label = `${data.requested} requested${dot}${scalar(data.found) || "?"} found${dot}${scalar(data.missing) || "?"} missing`;
    summary.rows = rows(data.items).map(item => `${scalar(item.requestedRef)}${dot}${scalar(item.status)}${scalar(record(item.card).title) ? `${dot}${scalar(record(item.card).title)}` : ""}`);
    if (count(data.missing)) summary.notices.push("Some requested cards were not found.");
  } else if (Object.keys(record(data.card)).length) {
    summary.label = cardHeading(record(data.card));
    summary.rows = [cardMeta(record(data.card))].filter(Boolean);
  } else if (count(data.matches) !== undefined) {
    summary.label = `${data.matches} matches${count(data.returnedCards) !== undefined ? `${dot}${data.returnedCards} returned` : ""}${incomplete ? `${dot}incomplete scan` : ""}`;
    const cards = rows(data.cards ?? data.sampleCards);
    summary.rows = cards.map(card => `${cardHeading(card)}${cardMeta(card) ? `${dot}${cardMeta(card)}` : ""}`);
    if (Array.isArray(data.sampleCards)) summary.notices.push("Card rows are samples.");
  } else if (["deck_get", "milestone_get", "run_get"].includes(name) && (scalar(data.title) || scalar(data.name) || scalar(data.customLabel))) {
    summary.label = scalar(data.title) || scalar(data.name) || scalar(data.customLabel);
    summary.rows = [scalar(data.description)].filter(Boolean);
  } else if (["cards", "eligibleCards", "milestones", "runs", "threads"].some(key => Array.isArray(data[key]))) {
    const key = ["cards", "eligibleCards", "milestones", "runs", "threads"].find(key => Array.isArray(data[key]))!;
    const items = rows(data[key]);
    summary.label = `${items.length} ${key === "eligibleCards" ? "eligible cards" : key} returned`;
    summary.rows = items.map(item => [scalar(item.shortCode), scalar(item.title) || scalar(item.name) || scalar(item.customLabel) || scalar(item.id), scalar(item.contextLabel), scalar(item.state) || scalar(item.status)].filter(Boolean).join(dot));
  } else {
    // Unknown results, text-format output and raw dispatch remain neutral.
    // Successful transport or ok:true does not prove a requested write was applied.
    summary.label = `${title(name)}: result returned`;
    summary.rows = rawText(result).split(/\r?\n/).filter(line => line.trim()).slice(0, 2);
  }
  if (summary.notices.length && summary.tone !== "error") summary.tone = "warning";
  return summary;
}

function cardView(card: RecordValue, theme: Theme): string {
  const metadata: [string, string][] = [
    ["Status", cardStatus(card)], ["Role", cardRole(card)], ["Type", scalar(card.cardType)],
    ["Priority", scalar(card.priority)], ["Effort", card.effort === null ? "Not set" : scalar(card.effort)],
    ["Deck", named(card.deck)], ["Milestone", named(card.milestone)], ["Assignee", named(card.assignee)],
    ["Run", runResidency(card).replace(/^Run: /, "")],
    ["Tags", strings(card.tags).join(", ")], ["Due", scalar(card.dueDate)], ["Updated", scalar(card.lastUpdatedAt)],
  ];
  const parts = [paint(theme, "toolTitle", cardHeading(card)), metadata.filter(([, value]) => value !== "").map(([label, value]) => `${theme.fg("muted", label.padEnd(10))} ${paint(theme, "toolOutput", value)}`).join("\n")];
  if (typeof card.content === "string") parts.push(`${theme.fg("muted", "Card content (external, untrusted)")}\n${paint(theme, "toolOutput", card.content)}`);
  if (Object.keys(record(card.parentCard)).length) parts.push(`${theme.fg("muted", "Parent")}\n${paint(theme, "accent", cardHeading(record(card.parentCard)))}`);
  if (rows(card.childCards).length) parts.push(`${theme.fg("muted", "Children")}\n${rows(card.childCards).map(child => paint(theme, "toolOutput", `${cardHeading(child)}${dot}${cardMeta(child)}`)).join("\n")}`);
  return parts.filter(Boolean).join("\n\n");
}

function progressView(name: string, result: Result): string {
  const progress = record(record(result.details).progress);
  if (!Object.keys(progress).length) return "Running Codecks request...";
  const values = [`${title(name)}${dot}${scalar(progress.stage) || "running"}`];
  for (const [key, label] of [["recordsProcessed", "records"], ["requestsAttempted", "requests"], ["created", "created"], ["updated", "updated"], ["failed", "failed"], ["definitelyUnsent", "definitely unsent"]]) {
    if (count(progress[key]) !== undefined) values.push(`${progress[key]} ${label}`);
  }
  const lines = [values.join(dot)];
  for (const [key, label] of [["elapsedMs", "elapsed"], ["queueWaitMs", "queued"], ["localGateWaitMs", "local wait"], ["serverCooldownWaitMs", "server wait"]]) {
    if (count(progress[key]) !== undefined) lines.push(`${progress[key]}ms ${label}`);
  }
  if (typeof progress.pacingReason === "string") lines.push(`Pacing: ${progress.pacingReason}${dot}${scalar(progress.pacingElapsedMs)}ms elapsed${dot}~${scalar(progress.pacingRemainingMs)}ms remaining`);
  if (count(progress.retryAttempt) !== undefined) lines.push(`Rate limited record ${scalar(progress.recordIndex)}/${scalar(progress.recordCount)}, retry ${progress.retryAttempt}/${scalar(progress.retryMax)} after ${scalar(progress.retryAfterMs)}ms (${scalar(progress.retryAfterFormat)}; ${scalar(progress.retryAfterParseStatus)})${scalar(progress.retryAfterReason) ? `: ${scalar(progress.retryAfterReason)}` : ""}`);
  return lines.join("\n");
}

export function renderCodecksResult(name: string, result: Result = {}, options: Options = {}, theme: Theme, context?: Context): Text {
  if (options.isPartial && !context?.isError) return component(paint(theme, "warning", progressView(name, result)), context);
  const summary = summarize(name, result, context);
  const card = record(record(payload(result).data).card);
  const compactSingleCard = singleCard(name) && summary.tone !== "error" && Object.keys(card).length > 0;
  // Pi composes the call before the result. Clear that row-local component once
  // the result supplies the complete header, without altering execution data.
  if (compactSingleCard && context?.state?.codecksCardCall instanceof Text) context.state.codecksCardCall.setText("");
  let text = compactSingleCard ? compactCard(card, theme) : paint(theme, summary.tone, `${summary.tone === "error" ? "!" : summary.tone === "warning" ? "!" : "\u2022"} ${compact(summary.label, 220)}`);
  const notices = [...new Set(summary.notices)];
  for (const notice of notices.slice(0, options.expanded ? notices.length : 2)) text += `\n${paint(theme, "warning", options.expanded ? notice : compact(notice))}`;
  if (!options.expanded) {
    if (notices.length > 2) text += `\n${theme.fg("dim", `${notices.length - 2} more notices`)}`;
    for (const row of (compactSingleCard ? [] : summary.rows.slice(0, 3))) text += `\n${paint(theme, summary.tone === "error" ? "error" : "muted", compact(row))}`;
    if (summary.rows.length > 3) text += `\n${theme.fg("dim", `${summary.rows.length - 3} more rows in this result`)}`;
    if (!compactSingleCard) text += `\n${theme.fg("dim", "Expand for full content and original output")}`;
  } else {
    const data = record(payload(result).data);
    const section = (label: string, value: string) => { if (value) text += `\n\n${theme.fg("toolTitle", theme.bold(label))}\n${value}`; };
    if (!context?.isError && (name === "card_get" || name === "card_get_formatted") && Object.keys(record(data.card)).length) section("Card", cardView(record(data.card), theme));
    if (!context?.isError && name === "card_get_batch") {
      for (const item of rows(data.items)) if (item.status === "found") section("Card", cardView(record(item.card), theme));
    }
    const artifact = scalar(record(data.artifact).path);
    if (artifact) section("Detailed results artifact", paint(theme, "accent", artifact));
    // Original text is never JSON.stringify(JSON.parse(text)): retain numeric
    // lexemes, duplicate keys, unknown fields and card Markdown verbatim.
    section("Original output", paint(theme, "toolOutput", rawText(result)));
  }
  return component(text, context);
}
