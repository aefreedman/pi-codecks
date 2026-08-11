export type CheckContext = {
  answer: string;
  guidance: string;
  changedPaths: string[];
  toolCalls: Array<{ name: string; args: unknown }>;
  toolErrors: number;
  condition: "available" | "baseline" | "forced";
  skillLoaded: boolean;
  auditRoot: string;
};

const matches = (answer: string, pattern: RegExp): boolean => pattern.test(answer);

/** Package-specific checks intentionally grade observable guidance, not one exact sentence. */
export function evaluateCustomCheck(checkId: string, context: CheckContext): boolean | undefined {
  const answer = context.answer.replace(/[*_`]/g, "");
  switch (checkId) {
    case "mentions_dry_run":
      return matches(answer, /dry[- ]?run|preview/i);
    case "commits_to_matching_apply":
      return matches(answer, /(?:then|after|if|once)[\s\S]{0,100}(?:apply|create)/i)
        && matches(answer, /match(?:es|ing)?|same|exact|authorized scope/i);
    case "avoids_redundant_approval":
      return !matches(answer, /(?:please|must|need to|would)\s+(?:ask|wait|request)[\s\S]{0,40}approv|need your approval|approve before I (?:apply|create)/i);
    case "preserves_preview_only_scope":
      return matches(answer, /(?:will|would|do) not (?:apply|create|dispatch)|preview only|stop after (?:the )?(?:dry[- ]?run|preview)|await approval/i);
    case "recognizes_empty_results_as_success":
      return matches(answer, /(?:40|all)[\s\S]{0,60}(?:created|succeeded)|no (?:failures|exceptional|exceptions|unsent|indeterminate)/i)
        && !matches(answer, /results\s*=\s*\[\][\s\S]{0,60}(?:failure|unknown|missing)/i);
    case "avoids_unnecessary_artifact_read":
      return matches(answer, /(?:do|would|need) not (?:need to )?(?:open|read|inspect)|no need to (?:open|read|inspect)|artifact[^.]{0,80}(?:only|unless)[^.]{0,80}(?:identit|diagnostic|detail)/i);
    case "reports_partial_counts":
      return matches(answer, /(?:19[^.]{0,50}created|records?\s+1\s*[-–]\s*19[^.]{0,50}created)/i)
        && matches(answer, /(?:1[^.]{0,40}fail|record 20[^.]{0,50}rejected)/i)
        && matches(answer, /(?:20[^.]{0,50}(?:unsent|not dispatched)|records?\s+21\s*[-–]\s*40[^.]{0,50}(?:never sent|unsent|not dispatched))/i);
    case "identifies_safe_continuation":
      return matches(answer, /(?:records?|range)[^.]*(?:21\s*[-–]\s*40|21 through 40|20\s*[-–]\s*39|20 through 39)[^.]*safe|safe[^.]*(?:21\s*[-–]\s*40|21 through 40|20\s*[-–]\s*39|20 through 39)/i);
    case "does_not_retry_rejected_record_automatically":
      return matches(answer, /(?:do|would|should|must) not (?:automatically )?(?:retry|resubmit)|not automatically (?:retry|resubmit)|exclude[^.]*record 20|retr(?:y|ied|ying)[^.]*(?:if desired|once corrected|only after|after (?:fixing|correction))|(?:diagnos|correct)[^.]{0,100}before retr(?:y|ying)|submit[^.]*independently/i);
    default:
      return undefined;
  }
}
