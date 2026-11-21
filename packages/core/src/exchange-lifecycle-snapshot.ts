import { canonicalJson } from "./backup-snapshot";
import { utf8ByteLength } from "./content";
import {
  applyExchangeTransition,
  type ExchangeLifecycle,
  type ExchangeRequestOwnership,
  type ExchangeTransition,
  currentExchangeProposal,
  exchangeAcceptanceChangesWork,
  exchangeDecisionText,
  exchangeLifecycleHead,
  exchangeTransitionChangesWork,
  EXCHANGE_SUMMARY_BYTES,
  initialOwnership,
  ownershipAfterRosterRemoval,
} from "./exchange-lifecycle";
import {
  type ExchangeAcceptanceInput,
  type ExchangeCollaboration,
  exchangeCount,
  exchangeOperationId,
  exchangeText,
} from "./exchanges";
import { memoObject } from "./memo-protocol";
import { isMemoUuid } from "./memos";

export function canonicalExchangeLifecycle(lifecycle: ExchangeLifecycle): ExchangeLifecycle {
  return {
    ...lifecycle,
    initialMembers: [...lifecycle.initialMembers].sort(),
    transitions: [...lifecycle.transitions].sort((a, b) => a.seq - b.seq),
  };
}

function ids(value: unknown, allowed: Set<string>): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => isMemoUuid(id) && allowed.has(id)) &&
    new Set(value).size === value.length
  );
}

function ownership(value: unknown, members: Set<string>): value is ExchangeRequestOwnership {
  if (
    !memoObject(value, [
      "requestId",
      "version",
      "assignedProjectId",
      "acceptanceOwnerId",
      "assignmentVersion",
      "disposition",
    ]) ||
    !isMemoUuid(value.requestId) ||
    !exchangeCount(value.version, 2) ||
    !exchangeCount(value.assignmentVersion, 1) ||
    ![value.assignedProjectId, value.acceptanceOwnerId].every(
      (id) => id === null || (isMemoUuid(id) && members.has(id)),
    )
  )
    return false;
  const choice = value.disposition;
  return (
    choice === null ||
    (memoObject(choice, ["kind", "reason", "followUpProjectId"]) &&
      exchangeText(choice.reason) &&
      exchangeDecisionText(choice.reason) &&
      ((choice.kind === "cancel" && choice.followUpProjectId === null) ||
        (choice.kind === "transfer" && isMemoUuid(choice.followUpProjectId) && members.has(choice.followUpProjectId))))
  );
}

function versions(value: unknown, key: string): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (row) => memoObject(row, ["requestId", key]) && isMemoUuid(row.requestId) && exchangeCount(row[key], 1),
    ) &&
    new Set(value.map((row) => row.requestId)).size === value.length
  );
}

function validTransition(input: unknown, members: Set<string>): input is ExchangeTransition {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case "roster":
      return (
        memoObject(value, ["kind", "rosterVersion", "add", "remove", "reason", "ownership"]) &&
        exchangeCount(value.rosterVersion, 2) &&
        ids(value.add, members) &&
        ids(value.remove, members) &&
        exchangeText(value.reason) &&
        exchangeDecisionText(value.reason) &&
        Array.isArray(value.ownership) &&
        value.ownership.every((row) => ownership(row, members)) &&
        new Set(value.ownership.map((row) => row.requestId)).size === value.ownership.length
      );
    case "owner-correct":
    case "request-disposition":
      return (
        memoObject(value, ["kind", "ownership", "reason"]) &&
        ownership(value.ownership, members) &&
        exchangeText(value.reason) &&
        exchangeDecisionText(value.reason) &&
        (value.kind === "owner-correct" || value.ownership.disposition?.reason === value.reason)
      );
    case "pause":
    case "stop": {
      if (!memoObject(value, ["kind", "pause"]) || !memoObject(value.pause, ["version", "reason", "question"]))
        return false;
      const { version, reason, question } = value.pause;
      return (
        exchangeCount(version, 1) &&
        exchangeText(reason) &&
        (value.kind === "pause" ? exchangeText(question) : question === null) &&
        exchangeDecisionText(reason, typeof question === "string" ? question : null)
      );
    }
    case "resume":
      return (
        memoObject(value, ["kind", "pauseVersion", "decision"]) &&
        exchangeCount(value.pauseVersion, 1) &&
        (value.decision === null || (exchangeText(value.decision) && exchangeDecisionText(value.decision)))
      );
    case "propose": {
      if (
        !memoObject(value, ["kind", "proposal"]) ||
        !memoObject(value.proposal, [
          "version",
          "proposerId",
          "members",
          "rosterVersion",
          "workRevision",
          "criterion",
          "summary",
          "report",
          "disposition",
        ])
      )
        return false;
      const proposal = value.proposal;
      return (
        exchangeCount(proposal.version, 1) &&
        isMemoUuid(proposal.proposerId) &&
        members.has(proposal.proposerId) &&
        ids(proposal.members, members) &&
        exchangeCount(proposal.rosterVersion, 1) &&
        exchangeCount(proposal.workRevision, 1) &&
        Array.isArray(proposal.criterion) &&
        proposal.criterion.every(exchangeText) &&
        exchangeText(proposal.summary) &&
        utf8ByteLength(proposal.summary) <= EXCHANGE_SUMMARY_BYTES &&
        versions(proposal.report, "reportVersion") &&
        versions(proposal.disposition, "version") &&
        new Set(
          [...(proposal.report as { requestId: string }[]), ...(proposal.disposition as { requestId: string }[])].map(
            (row) => row.requestId,
          ),
        ).size ===
          (proposal.report as unknown[]).length + (proposal.disposition as unknown[]).length
      );
    }
    case "vote":
      return (
        memoObject(value, ["kind", "proposalVersion", "vote", "objection", "acceptanceSequences", "completed"]) &&
        exchangeCount(value.proposalVersion, 1) &&
        typeof value.completed === "boolean" &&
        Array.isArray(value.acceptanceSequences) &&
        value.acceptanceSequences.every((seq) => exchangeCount(seq, 1)) &&
        (value.vote === "approve"
          ? value.objection === null
          : value.vote === "object" &&
            exchangeText(value.objection) &&
            exchangeDecisionText(value.objection) &&
            !value.completed &&
            value.acceptanceSequences.length === 0)
      );
    case "material-revalidate":
      return memoObject(value, ["kind", "materialId"]) && isMemoUuid(value.materialId);
    default:
      return false;
  }
}

export function openExchangeLifecycle(
  value: unknown,
  historical: Set<string>,
  opener: string,
  lastSeq: unknown,
): ExchangeLifecycle | null {
  if (
    !memoObject(value, ["initialMembers", "workRevision", "transitions"]) ||
    !exchangeCount(value.workRevision, 1) ||
    !exchangeCount(lastSeq) ||
    !ids(value.initialMembers, historical) ||
    value.initialMembers.length < 2 ||
    !value.initialMembers.includes(opener) ||
    !Array.isArray(value.transitions)
  )
    return null;
  let previous = 0;
  for (const record of value.transitions) {
    if (
      !memoObject(record, ["seq", "workRevision", "actorId", "operationId", "transition"]) ||
      !exchangeCount(record.seq, previous + 1) ||
      record.seq > lastSeq ||
      !exchangeCount(record.workRevision, 1) ||
      record.workRevision > value.workRevision ||
      !isMemoUuid(record.actorId) ||
      !historical.has(record.actorId) ||
      !exchangeOperationId(record.operationId) ||
      !validTransition(record.transition, historical)
    )
      return null;
    previous = record.seq;
  }
  return value as unknown as ExchangeLifecycle;
}

/** Identify committed operation boundaries, never an interior sequence of a grouped acceptance. */
function exchangeWorkTimeline(collaboration: ExchangeCollaboration) {
  const acceptanceGroups = new Map<string, ExchangeAcceptanceInput[]>();
  for (const row of collaboration.acceptances) {
    const key = JSON.stringify([row.requesterId, row.receipt.operationId]);
    const group = acceptanceGroups.get(key) ?? [];
    group.push({ requestId: row.requestId, reportVersion: row.reportVersion });
    acceptanceGroups.set(key, group);
  }
  const sequenced = new Map<number, true | ExchangeAcceptanceInput[]>();
  const registrations: { seq: number; actorId: string }[] = [];
  for (const { outcome, operationId, projectId, registrationAfterSeq } of collaboration.operations) {
    switch (outcome.kind) {
      case "request":
      case "report":
        sequenced.set(outcome.seq, true);
        break;
      case "send":
      case "accept": {
        const seq = outcome.kind === "send" ? outcome.seq : outcome.sequences.at(-1);
        if (seq !== undefined) sequenced.set(seq, acceptanceGroups.get(JSON.stringify([projectId, operationId])) ?? []);
        break;
      }
      case "material-register":
        if (registrationAfterSeq !== undefined) registrations.push({ seq: registrationAfterSeq, actorId: projectId });
        break;
    }
  }
  registrations.sort((left, right) => left.seq - right.seq);
  return { sequenced, registrations };
}

export function validateExchangeLifecycleEffects(
  lifecycle: ExchangeLifecycle,
  collaboration: ExchangeCollaboration,
  historical: Set<string>,
  criteria: unknown,
): boolean {
  const { messages, requests, reports, acceptances, materials } = collaboration;
  const head = exchangeLifecycleHead(lifecycle, 0);
  head.workRevision = 1;
  const seen = new Set(lifecycle.initialMembers);
  const messageSeqs = new Set(messages.map((message) => message.seq));
  const byRequest = new Map(requests.map((request) => [request.id, request]));
  const timeline = [...messages].sort((a, b) => a.seq - b.seq);
  const { sequenced, registrations } = exchangeWorkTimeline(collaboration);
  const transitionSeqs = new Set(lifecycle.transitions.map((record) => record.seq));
  const firstSequence = Math.min(timeline[0]?.seq ?? Infinity, lifecycle.transitions[0]?.seq ?? Infinity);
  const legacySequenceFloor = Number.isFinite(firstSequence) ? firstSequence - 1 : collaboration.lastSeq;
  if (
    registrations.some(
      ({ seq }) => seq !== 0 && seq !== legacySequenceFloor && !transitionSeqs.has(seq) && !sequenced.has(seq),
    )
  )
    return false;
  const opened = new Set<string>();
  const currentReports = new Map<string, number>();
  const accepted = new Set<string>();
  let messageIndex = 0;
  let registrationIndex = 0;
  const applyRegistrationsBefore = (seq: number): boolean => {
    while (registrationIndex < registrations.length) {
      const registration = registrations[registrationIndex];
      if (!registration || registration.seq >= seq) break;
      if (head.state !== "active" || !head.members.has(registration.actorId)) return false;
      head.workRevision++;
      registrationIndex++;
    }
    return true;
  };
  const applyMessagesBefore = (seq: number): boolean => {
    while (messageIndex < timeline.length) {
      const message = timeline[messageIndex];
      if (!message || message.seq >= seq) break;
      if (!applyRegistrationsBefore(message.seq) || !head.members.has(message.senderId) || head.state !== "active")
        return false;
      if (message.kind === "request" && message.requestId) opened.add(message.requestId);
      if (message.kind === "report" && message.requestId && message.reportVersion)
        currentReports.set(message.requestId, message.reportVersion);
      if (message.kind === "accept") accepted.add(`${message.requestId}:${message.reportVersion}`);
      const work = sequenced.get(message.seq);
      if (work === true || (work && exchangeAcceptanceChangesWork(work, currentExchangeProposal(head))))
        head.workRevision++;
      messageIndex++;
    }
    return applyRegistrationsBefore(seq);
  };
  for (const { seq, actorId, workRevision, transition } of lifecycle.transitions) {
    if (
      !applyMessagesBefore(seq) ||
      workRevision !== head.workRevision ||
      !head.members.has(actorId) ||
      head.state === "completed" ||
      messageSeqs.has(seq)
    )
      return false;
    if (
      head.state === "paused" &&
      transition.kind !== "roster" &&
      transition.kind !== "owner-correct" &&
      transition.kind !== "resume"
    )
      return false;
    const state = (id: string) => {
      const request = opened.has(id) ? byRequest.get(id) : undefined;
      return request ? (head.ownership.get(id) ?? initialOwnership(request)) : undefined;
    };
    const current = (id: string): number => {
      const report = reports.find((row) => row.requestId === id && row.version === currentReports.get(id));
      return report?.assignmentVersion === state(id)?.assignmentVersion ? (report?.version ?? 0) : 0;
    };
    if (transition.kind === "roster") {
      const { add, remove, rosterVersion } = transition;
      if (
        rosterVersion !== head.rosterVersion + 1 ||
        add.length + remove.length === 0 ||
        add.some((id) => head.members.has(id) || remove.includes(id)) ||
        remove.some((id) => !head.members.has(id)) ||
        head.members.size + add.length - remove.length < 1
      )
        return false;
      const removed = new Set(remove);
      const expected = [...opened].sort().flatMap((id) => {
        const old = state(id);
        return old ? ownershipAfterRosterRemoval(old, removed, accepted.has(`${id}:${current(id)}`)) : [];
      });
      if (canonicalJson(expected) !== canonicalJson(transition.ownership)) return false;
      for (const id of add) seen.add(id);
    } else if (transition.kind === "owner-correct" || transition.kind === "request-disposition") {
      const next = transition.ownership;
      const old = state(next.requestId);
      if (
        !old ||
        accepted.has(`${next.requestId}:${current(next.requestId)}`) ||
        next.version !== old.version + 1 ||
        next.assignmentVersion !== old.assignmentVersion + Number(next.assignedProjectId !== old.assignedProjectId)
      )
        return false;
      if (
        transition.kind === "owner-correct" &&
        (canonicalJson(next.disposition) !== canonicalJson(old.disposition) ||
          (next.assignedProjectId === old.assignedProjectId && next.acceptanceOwnerId === old.acceptanceOwnerId) ||
          (next.assignedProjectId !== old.assignedProjectId &&
            (old.assignedProjectId !== null || !head.members.has(next.assignedProjectId ?? ""))) ||
          (next.acceptanceOwnerId !== old.acceptanceOwnerId &&
            (old.acceptanceOwnerId !== null || !head.members.has(next.acceptanceOwnerId ?? ""))))
      )
        return false;
      if (
        transition.kind === "request-disposition" &&
        (head.state !== "active" ||
          old.acceptanceOwnerId !== actorId ||
          next.assignedProjectId !== old.assignedProjectId ||
          next.acceptanceOwnerId !== old.acceptanceOwnerId ||
          (next.disposition?.followUpProjectId && !head.members.has(next.disposition.followUpProjectId)))
      )
        return false;
    } else if (transition.kind === "stop" || transition.kind === "pause") {
      if (head.state !== "active" || transition.pause.version !== head.pauseVersion + 1) return false;
    } else if (transition.kind === "resume") {
      if (
        head.state !== "paused" ||
        head.pause?.version !== transition.pauseVersion ||
        (head.pause.question !== null && transition.decision === null)
      )
        return false;
    } else if (transition.kind === "propose") {
      const { proposal } = transition;
      if (
        head.state !== "active" ||
        proposal.proposerId !== actorId ||
        proposal.version !== (head.proposal?.version ?? 0) + 1 ||
        proposal.rosterVersion !== head.rosterVersion ||
        proposal.workRevision !== workRevision ||
        canonicalJson(proposal.criterion) !== canonicalJson(criteria) ||
        canonicalJson(proposal.members) !== canonicalJson([...head.members].sort()) ||
        proposal.report.some((row) => current(row.requestId) !== row.reportVersion) ||
        proposal.disposition.some((row) => {
          const prior = state(row.requestId);
          return !prior?.disposition || prior.version !== row.version;
        })
      )
        return false;
    } else if (transition.kind === "vote") {
      const proposal = currentExchangeProposal(head);
      if (
        head.state !== "active" ||
        !proposal ||
        proposal.workRevision !== workRevision ||
        proposal.version !== transition.proposalVersion ||
        proposal.rosterVersion !== head.rosterVersion ||
        transition.completed !==
          (transition.vote === "approve" &&
            proposal.members.every((id) => id === actorId || head.votes.get(id)?.vote === "approve"))
      )
        return false;
      if (
        transition.completed &&
        (proposal.workRevision !== lifecycle.workRevision ||
          [...opened].some((id) => {
            const request = state(id);
            const reference =
              proposal.report.some((row) => row.requestId === id && row.reportVersion === current(id)) &&
              accepted.has(`${id}:${current(id)}`);
            const disposition =
              request?.disposition &&
              proposal.disposition.some((row) => row.requestId === id && row.version === request.version) &&
              (request.disposition.followUpProjectId === null ||
                head.members.has(request.disposition.followUpProjectId));
            return !reference && !disposition;
          }))
      )
        return false;
      if (
        transition.acceptanceSequences.some((index) => {
          const message = messages.find((entry) => entry.seq === index);
          return (
            !message ||
            !proposal.report.some(
              (row) => row.requestId === message.requestId && row.reportVersion === message.reportVersion,
            )
          );
        })
      )
        return false;
    } else if (transition.kind === "material-revalidate") {
      if (
        !materials.some(
          (row) =>
            row.id === transition.materialId &&
            row.ownerProjectId === actorId &&
            (row.kind === "live" || row.kind === "versioned"),
        )
      )
        return false;
    }
    if (exchangeTransitionChangesWork(transition)) head.workRevision++;
    applyExchangeTransition(head, actorId, transition);
  }
  return (
    applyMessagesBefore(Infinity) &&
    lifecycle.workRevision === head.workRevision &&
    seen.size === historical.size &&
    acceptances.every((row) => byRequest.has(row.requestId))
  );
}
