import { appError, err, ok, type Result } from "./errors";
import {
  EXCHANGE_WORKFLOW_BYTES,
  type ExchangeAcceptanceInput,
  type ExchangeRequest,
  exchangeAccessDenied,
  exchangeCount,
  exchangeInvalid,
  exchangeText,
  validateExchangeAcceptances,
} from "./exchanges";
import { isCanonicalUuid } from "./primitives/identity";
import { utf8ByteLength } from "./primitives/validation";

export type ExchangeState = "active" | "paused" | "completed";
export type ExchangeDisposition = { kind: "cancel" | "transfer"; reason: string; followUpProjectId: string | null };

export interface ExchangeRequestOwnership {
  requestId: string;
  version: number;
  acceptanceOwnerId: string | null;
  assignedProjectId: string | null;
  assignmentVersion: number;
  disposition: ExchangeDisposition | null;
}

export interface ExchangeVersionedRequest {
  requestId: string;
  version: number;
}

export interface ExchangeAgreement {
  rosterVersion: number;
  workRevision: number;
  criterion: string[];
  summary: string;
  report: ExchangeAcceptanceInput[];
  disposition: ExchangeVersionedRequest[];
}

export interface ExchangeProposal extends ExchangeAgreement {
  version: number;
  proposerId: string;
  members: string[];
}

export interface ExchangePause {
  version: number;
  reason: string;
  question: string | null;
}

type ControlIdentity = { exchangeId: string; operationId: string; replayOnly: boolean; claim?: string | undefined };
type Roster = {
  kind: "roster";
  rosterVersion: number;
  pauseVersion?: number;
  add: string[];
  remove: string[];
  reason: string;
  confirmed: boolean;
};
type Correct = {
  kind: "owner-correct";
  requestId: string;
  ownershipVersion: number;
  rosterVersion: number;
  pauseVersion?: number;
  acceptanceOwner?: string | undefined;
  assignee?: string | undefined;
  reason: string;
  confirmed: boolean;
};
type Dispose = {
  kind: "request-disposition";
  requestId: string;
  ownershipVersion: number;
  disposition: "cancel" | "transfer";
  followUp?: string | undefined;
  reason: string;
};
type Vote = {
  kind: "vote";
  proposalVersion: number;
  vote: "approve" | "object";
  objection?: string | undefined;
  accept: ExchangeAcceptanceInput[];
};

export type ExchangeControlInput = ControlIdentity &
  (
    | Roster
    | Correct
    | Dispose
    | { kind: "stop"; rosterVersion: number; pauseVersion?: number; reason: string; confirmed: boolean }
    | { kind: "pause"; reason: string; question: string }
    | ({ kind: "propose" } & ExchangeAgreement)
    | Vote
    | { kind: "material-revalidate"; materialId: string; source: string }
    | { kind: "resume"; pauseVersion: number; decision?: string | undefined; confirmed: boolean }
  );

export type ExchangeTransition =
  | {
      kind: "roster";
      rosterVersion: number;
      add: string[];
      remove: string[];
      reason: string;
      ownership: ExchangeRequestOwnership[];
    }
  | { kind: "owner-correct" | "request-disposition"; ownership: ExchangeRequestOwnership; reason: string }
  | { kind: "stop" | "pause"; pause: ExchangePause }
  | { kind: "resume"; pauseVersion: number; decision: string | null }
  | { kind: "propose"; proposal: ExchangeProposal }
  | {
      kind: "vote";
      proposalVersion: number;
      vote: Vote["vote"];
      objection: string | null;
      acceptanceSequences: number[];
      completed: boolean;
    }
  | { kind: "material-revalidate"; materialId: string };

export type ExchangeControlOutcome = { exchangeId: string; seq: number } & (
  | { kind: "propose"; proposalVersion: number }
  | { kind: "vote"; proposalVersion: number; state: "completed" | "active"; acceptanceSequences: number[] }
  | { kind: "pause" | "stop"; state: "paused"; pauseVersion: number }
  | { kind: "resume"; state: "active"; pauseVersion: number }
  | { kind: "roster"; rosterVersion: number }
  | { kind: "owner-correct" | "request-disposition"; ownershipVersion: number }
  | { kind: "material-revalidate"; materialId: string }
);

export interface ExchangeTransitionRecord {
  seq: number;
  workRevision: number;
  actorId: string;
  operationId: string;
  transition: ExchangeTransition;
  recordedAt?: string;
}

export interface ExchangeLifecycle {
  initialMembers: string[];
  workRevision: number;
  transitions: ExchangeTransitionRecord[];
}

export interface ExchangeLifecycleHead {
  state: ExchangeState;
  rosterVersion: number;
  workRevision: number;
  pauseVersion: number;
  pause: ExchangePause | null;
  proposal: ExchangeProposal | null;
  final: ExchangeProposal | null;
  votes: Map<string, { vote: Vote["vote"]; objection: string | null }>;
  members: Set<string>;
  ownership: Map<string, ExchangeRequestOwnership>;
}

export interface ExchangeObservedRequest {
  request: ExchangeRequest;
  ownership: ExchangeRequestOwnership;
  currentReport: number;
  accepted: boolean;
}

export const EXCHANGE_SUMMARY_BYTES = 65_536;
const invalid = (message: string) => err(exchangeInvalid(message));
const stale = (message: string) => err(appError("ROW_VERSION_CONFLICT", message));

export function exchangeDecisionText(...fields: (string | null | undefined)[]): boolean {
  return (
    fields.every((field) => field == null || exchangeText(field)) &&
    fields.reduce((bytes, field) => bytes + (field == null ? 0 : utf8ByteLength(field)), 0) <= EXCHANGE_WORKFLOW_BYTES
  );
}

export function initialOwnership(request: ExchangeRequest): ExchangeRequestOwnership {
  return {
    requestId: request.id,
    version: 1,
    acceptanceOwnerId: request.requesterId,
    assignedProjectId: request.assigneeId,
    assignmentVersion: request.assignmentVersion,
    disposition: null,
  };
}

export function ownershipAfterRosterRemoval(
  ownership: ExchangeRequestOwnership,
  removed: ReadonlySet<string>,
  hasAcceptedCurrentReport: boolean,
): ExchangeRequestOwnership[] {
  const acceptanceOwnerId = removed.has(ownership.acceptanceOwnerId ?? "") ? null : ownership.acceptanceOwnerId;
  const assignedProjectId =
    !hasAcceptedCurrentReport && removed.has(ownership.assignedProjectId ?? "") ? null : ownership.assignedProjectId;
  if (acceptanceOwnerId === ownership.acceptanceOwnerId && assignedProjectId === ownership.assignedProjectId) return [];
  return [
    {
      ...ownership,
      acceptanceOwnerId,
      assignedProjectId,
      version: ownership.version + 1,
      assignmentVersion: ownership.assignmentVersion + Number(assignedProjectId !== ownership.assignedProjectId),
    },
  ];
}

export function applyExchangeTransition(
  head: ExchangeLifecycleHead,
  actorId: string,
  transition: ExchangeTransition,
): void {
  switch (transition.kind) {
    case "roster":
      head.rosterVersion = transition.rosterVersion;
      for (const id of transition.remove) head.members.delete(id);
      for (const id of transition.add) head.members.add(id);
      for (const ownership of transition.ownership) head.ownership.set(ownership.requestId, ownership);
      break;
    case "owner-correct":
    case "request-disposition":
      head.ownership.set(transition.ownership.requestId, transition.ownership);
      break;
    case "pause":
    case "stop":
      head.state = "paused";
      head.pause = transition.pause;
      head.pauseVersion = transition.pause.version;
      break;
    case "resume":
      head.state = "active";
      head.pause = null;
      break;
    case "propose":
      head.proposal = transition.proposal;
      head.votes.clear();
      break;
    case "vote":
      head.votes.set(actorId, { vote: transition.vote, objection: transition.objection });
      if (transition.completed) {
        head.state = "completed";
        head.final = head.proposal;
      }
      break;
  }
}

export function exchangeLifecycleHead(lifecycle: ExchangeLifecycle, beforeSeq = Infinity): ExchangeLifecycleHead {
  const head: ExchangeLifecycleHead = {
    state: "active",
    rosterVersion: 1,
    workRevision: lifecycle.workRevision,
    pauseVersion: 0,
    pause: null,
    proposal: null,
    final: null,
    votes: new Map(),
    members: new Set(lifecycle.initialMembers),
    ownership: new Map(),
  };
  for (const record of lifecycle.transitions) {
    if (record.seq >= beforeSeq) break;
    applyExchangeTransition(head, record.actorId, record.transition);
  }
  return head;
}

export function currentExchangeProposal(head: ExchangeLifecycleHead): ExchangeProposal | null {
  const proposal = head.proposal;
  return proposal?.rosterVersion === head.rosterVersion && proposal.workRevision === head.workRevision
    ? proposal
    : null;
}

export function exchangeAcceptanceChangesWork(
  acceptances: ExchangeAcceptanceInput[],
  proposal: ExchangeProposal | null,
): boolean {
  return acceptances.some(
    (item) =>
      !proposal?.report.some(
        (report) => report.requestId === item.requestId && report.reportVersion === item.reportVersion,
      ),
  );
}

export function exchangeTransitionChangesWork(transition: ExchangeTransition): boolean {
  return (
    transition.kind === "roster" ||
    transition.kind === "owner-correct" ||
    transition.kind === "request-disposition" ||
    transition.kind === "material-revalidate"
  );
}

export function exchangeControlOutcome(
  exchangeId: string,
  seq: number,
  transition: ExchangeTransition,
): ExchangeControlOutcome {
  const base = { exchangeId, seq };
  switch (transition.kind) {
    case "propose":
      return { ...base, kind: transition.kind, proposalVersion: transition.proposal.version };
    case "vote":
      return {
        ...base,
        kind: transition.kind,
        proposalVersion: transition.proposalVersion,
        state: transition.completed ? "completed" : "active",
        acceptanceSequences: transition.acceptanceSequences,
      };
    case "stop":
    case "pause":
      return { ...base, kind: transition.kind, state: "paused", pauseVersion: transition.pause.version };
    case "resume":
      return { ...base, kind: transition.kind, state: "active", pauseVersion: transition.pauseVersion };
    case "roster":
      return { ...base, kind: transition.kind, rosterVersion: transition.rosterVersion };
    case "owner-correct":
    case "request-disposition":
      return { ...base, kind: transition.kind, ownershipVersion: transition.ownership.version };
    case "material-revalidate":
      return { ...base, kind: transition.kind, materialId: transition.materialId };
  }
}

function exactRequest<T extends { requestId: string }>(items: T[]): boolean {
  return (
    items.every((item) => isCanonicalUuid(item.requestId)) &&
    new Set(items.map((item) => item.requestId)).size === items.length
  );
}

export function exchangeRequiresParticipantClaim(kind: ExchangeControlInput["kind"]): boolean {
  return kind !== "stop" && kind !== "resume" && kind !== "roster" && kind !== "owner-correct";
}

export function planExchangeControl(
  input: ExchangeControlInput,
  head: ExchangeLifecycleHead,
  actorId: string,
  criteria: string[],
  requests: ExchangeObservedRequest[],
): Result<ExchangeTransition> {
  if (!head.members.has(actorId)) return err(exchangeAccessDenied());
  if (head.state === "completed") return stale("The Exchange is Completed.");
  if (exchangeRequiresParticipantClaim(input.kind) && head.state !== "active") return stale("The Exchange is Paused.");
  if ("confirmed" in input && !input.confirmed)
    return err(appError("CONFIRMATION_REQUIRED", "Confirm the authorized Exchange control."));
  if ("rosterVersion" in input && input.rosterVersion !== head.rosterVersion)
    return stale("The Exchange roster version changed.");
  if (
    (input.kind === "roster" || input.kind === "owner-correct" || input.kind === "stop") &&
    (input.pauseVersion ?? 0) !== head.pauseVersion
  )
    return stale("The observed Exchange pause version changed.");
  if (
    "reason" in input &&
    (!exchangeText(input.reason) ||
      !exchangeDecisionText(input.reason, input.kind === "pause" ? input.question : undefined))
  )
    return invalid("The Exchange workflow record must fit 8192 UTF-8 bytes.");

  switch (input.kind) {
    case "roster": {
      const add = new Set(input.add);
      const remove = new Set(input.remove);
      if (
        add.size + remove.size === 0 ||
        add.size !== input.add.length ||
        remove.size !== input.remove.length ||
        [...add].some((id) => head.members.has(id) || remove.has(id)) ||
        [...remove].some((id) => !head.members.has(id)) ||
        head.members.size + add.size - remove.size < 1
      )
        return invalid("Supply a changed roster with at least one remaining Project.");
      const ownership = requests.flatMap(({ ownership, accepted }) =>
        ownershipAfterRosterRemoval(ownership, remove, accepted),
      );
      return ok({
        kind: input.kind,
        rosterVersion: head.rosterVersion + 1,
        add: [...add],
        remove: [...remove],
        reason: input.reason,
        ownership,
      });
    }
    case "owner-correct":
    case "request-disposition": {
      const request = requests.find((entry) => entry.request.id === input.requestId);
      if (!request || request.ownership.version !== input.ownershipVersion)
        return stale("The observed request ownership version changed.");
      const { ownership } = request;
      if (request.accepted) return stale("The request already has a retained accepted outcome.");
      if (input.kind === "owner-correct") {
        if (
          (input.acceptanceOwner === undefined && input.assignee === undefined) ||
          (input.acceptanceOwner !== undefined &&
            (ownership.acceptanceOwnerId !== null || !head.members.has(input.acceptanceOwner))) ||
          (input.assignee !== undefined && (ownership.assignedProjectId !== null || !head.members.has(input.assignee)))
        )
          return invalid("Name a current Project for each vacant owner or assignee field being corrected.");
        return ok({
          kind: input.kind,
          reason: input.reason,
          ownership: {
            ...ownership,
            version: ownership.version + 1,
            acceptanceOwnerId: input.acceptanceOwner ?? ownership.acceptanceOwnerId,
            assignedProjectId: input.assignee ?? ownership.assignedProjectId,
            assignmentVersion: ownership.assignmentVersion + Number(input.assignee !== undefined),
          },
        });
      }
      if (ownership.acceptanceOwnerId !== actorId) return err(exchangeAccessDenied());
      const transfer = input.disposition === "transfer";
      if (
        (input.disposition !== "cancel" && !transfer) ||
        transfer !== (input.followUp !== undefined) ||
        (input.followUp !== undefined && !head.members.has(input.followUp))
      )
        return invalid("A transfer needs a current follow-up Project; a cancellation has none.");
      return ok({
        kind: input.kind,
        reason: input.reason,
        ownership: {
          ...ownership,
          version: ownership.version + 1,
          disposition: { kind: input.disposition, reason: input.reason, followUpProjectId: input.followUp ?? null },
        },
      });
    }
    case "pause":
    case "stop":
      if (head.state !== "active") return stale("The Exchange is already Paused.");
      if (input.kind === "pause" && !exchangeText(input.question))
        return invalid("Supply the specific required user decision.");
      return ok({
        kind: input.kind,
        pause: {
          version: head.pauseVersion + 1,
          reason: input.reason,
          question: input.kind === "pause" ? input.question : null,
        },
      });
    case "resume":
      if (head.state !== "paused" || head.pause?.version !== input.pauseVersion)
        return stale("The observed Exchange pause changed.");
      if ((head.pause.question !== null && !exchangeText(input.decision)) || !exchangeDecisionText(input.decision))
        return invalid("Supply the requested decision within 8192 UTF-8 bytes.");
      return ok({ kind: input.kind, pauseVersion: input.pauseVersion, decision: input.decision ?? null });
    case "propose": {
      if (input.workRevision !== head.workRevision || JSON.stringify(input.criterion) !== JSON.stringify(criteria))
        return stale("The observed Exchange work revision or criteria changed.");
      if (
        !exchangeText(input.summary) ||
        utf8ByteLength(input.summary) > EXCHANGE_SUMMARY_BYTES ||
        !validateExchangeAcceptances(input.report) ||
        !exactRequest(input.disposition) ||
        input.disposition.some((entry) => !exchangeCount(entry.version, 1)) ||
        !exactRequest([...input.report, ...input.disposition])
      )
        return invalid("Supply a summary within 65536 UTF-8 bytes and distinct exact request observations.");
      const expected = new Map(requests.map((request) => [request.request.id, request]));
      if (
        input.report.some((entry) => expected.get(entry.requestId)?.currentReport !== entry.reportVersion) ||
        input.disposition.some((entry) => {
          const found = expected.get(entry.requestId)?.ownership;
          return !found?.disposition || found.version !== entry.version;
        })
      )
        return stale("A named report or disposition version changed.");
      const { rosterVersion, workRevision, criterion, summary, report, disposition } = input;
      return ok({
        kind: input.kind,
        proposal: {
          version: (head.proposal?.version ?? 0) + 1,
          proposerId: actorId,
          members: [...head.members].sort(),
          rosterVersion,
          workRevision,
          criterion,
          summary,
          report,
          disposition,
        },
      });
    }
    case "vote": {
      const proposal = currentExchangeProposal(head);
      if (!proposal || proposal.version !== input.proposalVersion)
        return stale("The observed Exchange proposal is no longer current.");
      if (
        !validateExchangeAcceptances(input.accept) ||
        (input.vote !== "approve" && input.vote !== "object") ||
        (input.vote === "object"
          ? !exchangeText(input.objection) || input.accept.length !== 0
          : input.objection !== undefined) ||
        !exchangeDecisionText(input.objection)
      )
        return invalid("An objection needs bounded text; only approval may name report acceptances.");
      if (
        input.accept.some(
          (item) =>
            !proposal.report.some(
              (report) => report.requestId === item.requestId && report.reportVersion === item.reportVersion,
            ),
        )
      )
        return stale("Each bundled acceptance must name a report covered by the current proposal.");
      const completed =
        input.vote === "approve" &&
        proposal.members.every((id) => id === actorId || head.votes.get(id)?.vote === "approve");
      if (completed) {
        for (const { request, currentReport, accepted, ownership } of requests) {
          const disposed =
            ownership.disposition &&
            proposal.disposition.some((item) => item.requestId === request.id && item.version === ownership.version) &&
            (ownership.disposition.followUpProjectId === null ||
              head.members.has(ownership.disposition.followUpProjectId));
          const reviewed =
            proposal.report.some((item) => item.requestId === request.id && item.reportVersion === currentReport) &&
            (accepted ||
              input.accept.some((item) => item.requestId === request.id && item.reportVersion === currentReport));
          if (!disposed && !reviewed)
            return stale("An actionable request is missing a current accepted report or agreed disposition.");
        }
      }
      return ok({
        kind: input.kind,
        proposalVersion: proposal.version,
        vote: input.vote,
        objection: input.objection ?? null,
        acceptanceSequences: [],
        completed,
      });
    }
    case "material-revalidate":
      return isCanonicalUuid(input.materialId)
        ? ok({ kind: input.kind, materialId: input.materialId })
        : invalid("Name a registered local material ID.");
  }
}
