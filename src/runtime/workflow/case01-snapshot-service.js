import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createCase01WorkspaceSnapshot,
  removeCase01WorkspaceSnapshot,
  reconcileCase01WorkspaceSnapshots,
  validateCase01WorkspaceArtifact,
  readVerifiedCase01WorkspaceSnapshot,
  collectCase01SnapshotReferences,
  validateCase01DurableSnapshotReferences
} from './case01-artifact-acceptance.js';
import { parseStrictJson } from '../strict-json.js';

function requiredFunction(owner, name, label) {
  if (typeof owner?.[name] !== 'function') throw new TypeError(`${label}.${name} must be a function`);
  return owner[name].bind(owner);
}

const hash = value => createHash('sha256').update(value).digest('hex');

/**
 * CASE-01 application boundary. Owns immutable snapshot creation/compensation,
 * reservation recovery, exact consumer-byte verification and durable
 * consumption acknowledgement. Workflow rows/events remain owned by Workflow
 * and are accessed only through the injected semantic port.
 *
 * The snapshot reservation and acknowledgement transactions intentionally use
 * the current shared Workflow database. This is an in-process extraction seam,
 * not an independent database or process boundary.
 */
export class Case01SnapshotService {
  #workflow;
  #store;
  #snapshotBase;
  #env;
  #process;
  #warn;

  constructor({ workflowPort, snapshotStore, snapshotBase, env = process.env,
    processApi = process, onRecoveryWarning = message => process.stderr.write(`${message}\n`) } = {}) {
    if (typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase)) {
      throw new TypeError('snapshotBase must be an absolute path');
    }
    this.#workflow = {
      getExecutionPlan: requiredFunction(workflowPort, 'getExecutionPlan', 'workflowPort'),
      getProposal: requiredFunction(workflowPort, 'getProposal', 'workflowPort'),
      listArtifacts: requiredFunction(workflowPort, 'listArtifacts', 'workflowPort'),
      listArtifactContents: requiredFunction(workflowPort, 'listArtifactContents', 'workflowPort'),
      getArtifact: requiredFunction(workflowPort, 'getArtifact', 'workflowPort'),
      getTask: requiredFunction(workflowPort, 'getTask', 'workflowPort'),
      getResult: requiredFunction(workflowPort, 'getResult', 'workflowPort'),
      hasSuccessfulTaskResult: requiredFunction(workflowPort, 'hasSuccessfulTaskResult', 'workflowPort'),
      getAttempt: requiredFunction(workflowPort, 'getAttempt', 'workflowPort'),
      listEventsForJob: requiredFunction(workflowPort, 'listEventsForJob', 'workflowPort'),
      listArtifactCreatedEvents: requiredFunction(workflowPort, 'listArtifactCreatedEvents', 'workflowPort'),
      getEvent: requiredFunction(workflowPort, 'getEvent', 'workflowPort'),
      recordEvent: requiredFunction(workflowPort, 'recordEvent', 'workflowPort'),
      completeLocalTask: requiredFunction(workflowPort, 'completeLocalTask', 'workflowPort')
    };
    const storeMethods = [
      'reserveSnapshot', 'deleteSnapshotReservation', 'listSnapshotReservations', 'listReservedSnapshotIds',
      'beginSnapshotCleanupTransaction', 'commitSnapshotCleanupTransaction', 'rollbackSnapshotCleanupTransaction',
      'beginConsumptionAckTransaction', 'commitConsumptionAckTransaction', 'rollbackConsumptionAckTransaction',
      'getConsumptionAck', 'insertConsumptionAck'
    ];
    for (const name of storeMethods) requiredFunction(snapshotStore, name, 'snapshotStore');
    this.#store = snapshotStore;
    this.#snapshotBase = path.resolve(snapshotBase);
    this.#env = env;
    this.#process = processApi;
    if (typeof onRecoveryWarning !== 'function') throw new TypeError('onRecoveryWarning must be a function');
    this.#warn = onRecoveryWarning;
  }

  isApplicable(jobId) {
    return this.#workflow.getExecutionPlan(jobId)?.workflow_id === 'custom-case01-artifact-lineage';
  }

  #ensureSnapshotBase() {
    try { fs.lstatSync(this.#snapshotBase); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(this.#snapshotBase, { mode: 0o700 });
    }
    const initial = fs.lstatSync(this.#snapshotBase);
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new Error('CASE-01 snapshot base must be a non-symlink directory');
    }
    const current = fs.lstatSync(this.#snapshotBase);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino) {
      throw new Error('CASE-01 snapshot base changed during initialization');
    }
    if ((current.mode & 0o077) !== 0) {
      throw new Error('CASE-01 snapshot base permissions are too broad; refusing to chmod a path that may be concurrently replaced');
    }
    return this.#snapshotBase;
  }

  #case01CompletionEvent(jobId, resultId) {
    const rows = this.#workflow.listEventsForJob(jobId, { type: 'task.local_completed' });
    const matches = [];
    for (const row of rows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('CASE-01 completion trace contains malformed task.local_completed payload'); }
      if (payload?.resultId === resultId) matches.push({ row, payload });
    }
    if (matches.length !== 1) throw new Error('CASE-01 requires exactly one completion event for each consumed result');
    const { row, payload } = matches[0];
    const expectedId = hash(`${jobId}|task.local_completed|${resultId}`);
    if (row.event_id !== expectedId || row.job_id !== jobId || row.type !== 'task.local_completed' ||
        row.payload_json !== JSON.stringify(payload) || Object.keys(payload).sort().join(',') !== 'attemptId,executor,resultId,taskId') {
      throw new Error('CASE-01 completion event must have exact deterministic identity and canonical payload bytes');
    }
    return matches[0];
  }

  #case01ArtifactEvent(jobId, artifact) {
    const rows = this.#workflow.listArtifactCreatedEvents(jobId);
    const matches = [];
    for (const row of rows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('CASE-01 artifact trace contains malformed artifact.created payload'); }
      if (payload?.artifactId === artifact.artifact_id) matches.push({ row, payload });
    }
    if (matches.length !== 1) throw new Error('CASE-01 requires exactly one artifact.created event for each consumed artifact');
    const { row, payload } = matches[0];
    const expectedId = hash(`${jobId}|artifact.created|${artifact.artifact_id}`);
    if (row.event_id !== expectedId || row.job_id !== jobId || row.type !== 'artifact.created' ||
        row.payload_json !== JSON.stringify(payload) ||
        Object.keys(payload).sort().join(',') !== 'artifactId,contentHash,status,supersedes,taskId,type' ||
        payload.taskId !== artifact.task_id || payload.type !== artifact.type || payload.status !== artifact.status ||
        payload.contentHash !== artifact.content_hash || (payload.supersedes ?? null) !== (artifact.supersedes ?? null)) {
      throw new Error('CASE-01 artifact.created event conflicts with durable artifact metadata');
    }
    return matches[0];
  }

  validateTaskEvidence(jobId, taskId, artifactContent, artifactId, resultId) {
    const proposal = this.#workflow.getProposal(jobId);
    if (typeof artifactContent?.workspace_snapshot_id !== 'string') {
      throw new Error('CASE-01 task artifact is missing its immutable workspace snapshot identity');
    }
    validateCase01WorkspaceArtifact({ workspace: proposal.workspace, content: artifactContent,
      snapshotBase: this.#snapshotBase, snapshotId: artifactContent.workspace_snapshot_id });
    const artifact = artifactId ? this.#workflow.getArtifact(artifactId) : null;
    const task = this.#workflow.getTask(taskId);
    const result = this.#workflow.getResult(resultId);
    if (!task || task.job_id !== jobId || task.status !== 'completed' || !artifact || artifact.status !== 'active' ||
        artifact.job_id !== jobId || artifact.task_id !== taskId || artifact.type !== 'requirements' ||
        artifact.artifact_id !== `requirements-${resultId}` || artifact.evidence.length !== 1 || artifact.evidence[0] !== resultId ||
        artifact.content?.workspace_snapshot_id !== artifactContent.workspace_snapshot_id ||
        JSON.stringify(artifact.content?.workspace_artifacts) !== JSON.stringify(artifactContent.workspace_artifacts) ||
        !result || result.task_id !== taskId || result.outcome !== 'success') {
      throw new Error('CASE-01 task artifact is not bound to its durable successful task result');
    }
  }

  validateWorkspaceArtifact({ workspace, content, taskArtifactId = null, snapshotId = null } = {}) {
    return validateCase01WorkspaceArtifact({ workspace, content, taskArtifactId,
      snapshotBase: snapshotId === null ? null : this.#snapshotBase, snapshotId });
  }

  readVerifiedWorkspaceSnapshot({ content, snapshotId } = {}) {
    return readVerifiedCase01WorkspaceSnapshot({ content, snapshotBase: this.#snapshotBase, snapshotId });
  }

  validateSynthesisEvidence(jobId, ctoContent, taskArtifact) {
    const proposal = this.#workflow.getProposal(jobId);
    if (typeof taskArtifact.content?.workspace_snapshot_id !== 'string') {
      throw new Error('CASE-01 task artifact is missing its immutable workspace snapshot identity');
    }
    validateCase01WorkspaceArtifact({ workspace: proposal.workspace, content: ctoContent,
      taskArtifactId: taskArtifact.artifact_id, snapshotBase: this.#snapshotBase,
      snapshotId: taskArtifact.content.workspace_snapshot_id });
    if (ctoContent?.workspace_snapshot_id !== taskArtifact.content.workspace_snapshot_id) {
      throw new Error('CASE-01 CTO snapshot identity must exactly match the active task artifact');
    }
    if (JSON.stringify(taskArtifact.content.workspace_artifacts) !== JSON.stringify(ctoContent.workspace_artifacts)) {
      throw new Error('CASE-01 CTO workspace hashes must exactly match the active task artifact');
    }
    const task = this.#workflow.getTask(taskArtifact.task_id);
    const resultRefs = taskArtifact.evidence.filter(value => this.#workflow.hasSuccessfulTaskResult(value, taskArtifact.task_id));
    const resultId = resultRefs.length === 1 ? resultRefs[0] : null;
    const result = resultId ? this.#workflow.getResult(resultId) : null;
    if (taskArtifact.status !== 'active' || taskArtifact.type !== 'requirements' || taskArtifact.job_id !== jobId ||
        taskArtifact.artifact_id !== `requirements-${resultId}` || taskArtifact.evidence.length !== 1 ||
        !task || task.job_id !== jobId || task.status !== 'completed' || !result ||
        result.task_id !== task.task_id || result.outcome !== 'success') {
      throw new Error('CASE-01 synthesis requires a completed task and its durable successful result');
    }
    return true;
  }

  /**
   * Snapshot and then complete a CASE-01 requirements task. Filesystem bytes
   * are created before the Workflow transaction; a failed transaction triggers
   * guarded compensation only when no committed artifact references the ID.
   */
  completeRequirementsTask({ task, taskId, jobId, content, artifactContent, outcome = 'success' } = {}) {
    if (!task || task.task_id !== taskId || task.job_id !== jobId) throw new Error('CASE-01 task identity mismatch');
    if (outcome !== 'success') return this.#workflow.completeLocalTask(taskId, { content, artifact: artifactContent, outcome });

    let effectiveArtifactContent = artifactContent;
    let newlyCreatedSnapshotId = null;
    let snapshotBase = null;
    const existing = this.#workflow.listArtifacts(jobId, { taskId, activeOnly: true, type: 'requirements' }).at(-1);
    if (task.status === 'completed' && existing) {
      // Idempotent retry reuses and revalidates the exact durable snapshot.
      effectiveArtifactContent = existing.content;
    } else {
      snapshotBase = this.#ensureSnapshotBase();
      const snapshotId = randomUUID();
      this.#store.reserveSnapshot({ snapshotId, ownerPid: this.#process.pid, createdAt: new Date().toISOString() });
      let snapshot;
      try {
        snapshot = createCase01WorkspaceSnapshot({ workspace: this.#workflow.getProposal(jobId).workspace,
          content: effectiveArtifactContent, snapshotBase, snapshotId });
      } catch (error) {
        try { this.#compensateSnapshotIfUnreferenced(snapshotBase, snapshotId); }
        catch { /* retain reservation and original creation failure for crash recovery */ }
        throw error;
      }
      newlyCreatedSnapshotId = snapshot.snapshot_id;
      effectiveArtifactContent = { ...effectiveArtifactContent, workspace_snapshot_id: snapshot.snapshot_id,
        workspace_artifacts: snapshot.workspace_artifacts };
    }

    let result;
    try {
      result = this.#workflow.completeLocalTask(taskId, {
        content, artifact: effectiveArtifactContent, outcome,
        validateBeforeCommit: ({ resultId, artifactId }) =>
          this.validateTaskEvidence(jobId, taskId, effectiveArtifactContent, artifactId, resultId)
      });
    } catch (error) {
      if (newlyCreatedSnapshotId) {
        try { this.#compensateSnapshotIfUnreferenced(snapshotBase, newlyCreatedSnapshotId); }
        catch (cleanupError) {
          try {
            this.#workflow.recordEvent(jobId, 'case01.snapshot_cleanup_failed', {
              taskId, snapshotId: newlyCreatedSnapshotId,
              error: String(cleanupError?.message || cleanupError).slice(0, 500)
            }, `${taskId}|snapshot-cleanup-failed|${newlyCreatedSnapshotId}`);
          } catch { /* preserve the original completion failure */ }
        }
      }
      throw error;
    }
    if (newlyCreatedSnapshotId) {
      try { this.#store.deleteSnapshotReservation(newlyCreatedSnapshotId); } catch { /* recovery is idempotent */ }
    }
    return result;
  }

  #compensateSnapshotIfUnreferenced(snapshotBase, snapshotId) {
    this.#store.beginSnapshotCleanupTransaction();
    try {
      const referenced = collectCase01SnapshotReferences(this.#workflow.listArtifactContents());
      if (referenced.has(snapshotId)) {
        this.#store.deleteSnapshotReservation(snapshotId);
        this.#store.commitSnapshotCleanupTransaction();
        return { removed: false, referenced: true };
      }
      removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId });
      this.#store.deleteSnapshotReservation(snapshotId);
      this.#store.commitSnapshotCleanupTransaction();
      return { removed: true, referenced: false };
    } catch (error) {
      this.#store.rollbackSnapshotCleanupTransaction();
      throw error;
    }
  }

  recordConsumptionAck({ jobId, taskArtifact, ctoArtifact, synthesisResultId, consumedWorkspaceBytes } = {}) {
    if (!Array.isArray(consumedWorkspaceBytes) || consumedWorkspaceBytes.length !== 2) {
      throw new Error('CASE-01 synthesis must provide the exact workspace bytes it consumed');
    }
    this.#store.beginConsumptionAckTransaction();
    try {
      const lockedSourceArtifact = this.#workflow.getArtifact(taskArtifact.artifact_id);
      const lockedCtoArtifact = this.#workflow.getArtifact(ctoArtifact.artifact_id);
      const sameArtifactSnapshot = (actual, supplied) => actual && supplied &&
        actual.artifact_id === supplied.artifact_id && actual.job_id === supplied.job_id && actual.task_id === supplied.task_id &&
        actual.type === supplied.type && actual.status === supplied.status && actual.content_hash === supplied.content_hash &&
        JSON.stringify(actual.content) === JSON.stringify(supplied.content) &&
        JSON.stringify(actual.evidence) === JSON.stringify(supplied.evidence);
      if (!sameArtifactSnapshot(lockedSourceArtifact, taskArtifact) || !sameArtifactSnapshot(lockedCtoArtifact, ctoArtifact) ||
          lockedSourceArtifact.job_id !== jobId || lockedSourceArtifact.status !== 'active' ||
          lockedSourceArtifact.type !== 'requirements' || lockedSourceArtifact.evidence.length !== 1 ||
          lockedCtoArtifact.job_id !== jobId || lockedCtoArtifact.status !== 'active' ||
          lockedCtoArtifact.type !== 'cto-decision' || lockedCtoArtifact.evidence.length !== 1 ||
          lockedCtoArtifact.evidence[0] !== synthesisResultId) {
        throw new Error('CASE-01 acknowledgement source/CTO artifacts changed or lost exact active result binding before the writer reservation');
      }
      const sourceTaskState = this.#workflow.getTask(lockedSourceArtifact.task_id);
      const ctoTaskState = this.#workflow.getTask(lockedCtoArtifact.task_id);
      if (!sourceTaskState || sourceTaskState.job_id !== jobId || sourceTaskState.status !== 'completed' ||
          !ctoTaskState || ctoTaskState.job_id !== jobId || ctoTaskState.status !== 'completed') {
        throw new Error('CASE-01 acknowledgement requires both source and CTO tasks to remain durably completed under the writer reservation');
      }
      const verified = readVerifiedCase01WorkspaceSnapshot({ content: taskArtifact.content,
        snapshotBase: this.#snapshotBase, snapshotId: taskArtifact.content.workspace_snapshot_id });
      const consumed = consumedWorkspaceBytes.map((entry, index) => {
        const expected = verified.workspace_artifacts[index];
        if (!entry || entry.path !== expected.path || entry.encoding !== 'base64' || typeof entry.bytes !== 'string' ||
            entry.bytes !== expected.bytes_base64 || entry.sha256 !== expected.sha256 ||
            Buffer.from(entry.bytes, 'base64').toString('base64') !== entry.bytes) {
          throw new Error(`CASE-01 consumed bytes do not match the verified snapshot at ${expected.path}`);
        }
        const bytes = Buffer.from(entry.bytes, 'base64');
        const digest = hash(bytes);
        if (digest !== entry.sha256) throw new Error(`CASE-01 consumer buffer digest mismatch at ${entry.path}`);
        return { path: entry.path, sha256: digest, size_bytes: bytes.length };
      });
      const consumedManifest = JSON.stringify(consumed);
      const consumedDigest = hash(consumedManifest);
      const verifiedManifest = JSON.stringify(verified.workspace_artifacts.map(entry => ({
        path: entry.path, sha256: entry.sha256, size_bytes: Buffer.from(entry.bytes_base64, 'base64').length
      })));
      const verifiedDigest = hash(verifiedManifest);
      if (verifiedDigest !== consumedDigest) throw new Error('CASE-01 consumed manifest differs from the independently re-read verified snapshot manifest');

      const sourceResultId = taskArtifact.evidence?.length === 1 ? taskArtifact.evidence[0] : null;
      const sourceResult = sourceResultId ? this.#workflow.getResult(sourceResultId) : null;
      const ctoResult = this.#workflow.getResult(synthesisResultId);
      if (!sourceResult || sourceResult.task_id !== taskArtifact.task_id || sourceResult.outcome !== 'success' ||
          typeof sourceResult.content !== 'string' || !sourceResult.content.trim() || !ctoResult ||
          ctoResult.task_id !== ctoArtifact.task_id || ctoResult.outcome !== 'success' ||
          typeof ctoResult.content !== 'string' || !ctoResult.content.trim()) {
        throw new Error('CASE-01 downstream acknowledgement requires both exact successful source and CTO result rows');
      }
      const sourceCompletion = this.#case01CompletionEvent(jobId, sourceResultId);
      const ctoCompletion = this.#case01CompletionEvent(jobId, synthesisResultId);
      const sourceAttempt = sourceCompletion.payload.attemptId
        ? this.#workflow.getAttempt(sourceCompletion.payload.attemptId, taskArtifact.task_id) : null;
      const ctoAttempt = ctoCompletion.payload.attemptId
        ? this.#workflow.getAttempt(ctoCompletion.payload.attemptId, ctoArtifact.task_id) : null;
      const sourceArtifactEvent = this.#case01ArtifactEvent(jobId, taskArtifact);
      const ctoArtifactEvent = this.#case01ArtifactEvent(jobId, ctoArtifact);
      if (sourceCompletion.payload.taskId !== taskArtifact.task_id || ctoCompletion.payload.taskId !== ctoArtifact.task_id ||
          sourceCompletion.payload.executor !== 'chat-on-steroids-plugin' || ctoCompletion.payload.executor !== 'chat-on-steroids-plugin' ||
          sourceAttempt?.status !== 'completed' || ctoAttempt?.status !== 'completed') {
        throw new Error('CASE-01 consumed bytes lack exact source/CTO task, result, attempt and completion-event lineage');
      }
      const lineage = {
        source_task_id: taskArtifact.task_id, source_result_id: sourceResultId, source_artifact_id: taskArtifact.artifact_id,
        source_attempt_id: sourceAttempt.attempt_id, source_completion_event_id: sourceCompletion.row.event_id,
        source_artifact_event_id: sourceArtifactEvent.row.event_id, snapshot_id: verified.snapshot_id,
        cto_task_id: ctoArtifact.task_id, cto_result_id: synthesisResultId, cto_artifact_id: ctoArtifact.artifact_id,
        cto_attempt_id: ctoAttempt.attempt_id, cto_completion_event_id: ctoCompletion.row.event_id,
        cto_artifact_event_id: ctoArtifactEvent.row.event_id, verified_manifest_sha256: verifiedDigest,
        consumed_manifest_sha256: consumedDigest,
        source_result_content_sha256: hash(Buffer.from(sourceResult.content, 'utf8')),
        cto_result_content_sha256: hash(Buffer.from(ctoResult.content, 'utf8')),
        consumed_files: consumed
      };
      if (this.#env.NODE_ENV === 'test' && this.#env.CHAT_ON_STEROIDS_TEST_CASE01_ACK_LINEAGE_BARRIER_DIR) {
        const barrierDir = path.resolve(this.#env.CHAT_ON_STEROIDS_TEST_CASE01_ACK_LINEAGE_BARRIER_DIR);
        const armPath = path.join(barrierDir, `${jobId}.arm`);
        if (fs.existsSync(armPath)) {
          const readyPath = path.join(barrierDir, `${jobId}.lineage-ready`);
          const releasePath = path.join(barrierDir, `${jobId}.release`);
          fs.writeFileSync(readyPath, 'lineage computed before acknowledgement transaction', { flag: 'wx', mode: 0o600 });
          const deadline = Date.now() + 15000;
          while (!fs.existsSync(releasePath)) {
            if (Date.now() >= deadline) throw new Error('test CASE-01 acknowledgement lineage barrier timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
        }
      }
      const prior = this.#store.getConsumptionAck(jobId);
      if (prior) {
        const expected = {
          source_task_id: lineage.source_task_id, source_result_id: lineage.source_result_id,
          source_artifact_id: lineage.source_artifact_id, source_attempt_id: lineage.source_attempt_id,
          snapshot_id: lineage.snapshot_id, cto_task_id: lineage.cto_task_id, cto_result_id: lineage.cto_result_id,
          cto_artifact_id: lineage.cto_artifact_id, cto_attempt_id: lineage.cto_attempt_id,
          verified_manifest_sha256: verifiedDigest, consumed_manifest_sha256: consumedDigest,
          lineage_json: JSON.stringify(lineage)
        };
        for (const [key, value] of Object.entries(expected)) {
          if (prior[key] !== value) throw new Error(`CASE-01 idempotent consumption acknowledgement conflicts at ${key}`);
        }
      } else {
        this.#store.insertConsumptionAck({
          job_id: jobId, source_task_id: lineage.source_task_id, source_result_id: lineage.source_result_id,
          source_artifact_id: lineage.source_artifact_id, source_attempt_id: lineage.source_attempt_id,
          snapshot_id: lineage.snapshot_id, cto_task_id: lineage.cto_task_id, cto_result_id: lineage.cto_result_id,
          cto_artifact_id: lineage.cto_artifact_id, cto_attempt_id: lineage.cto_attempt_id,
          verified_manifest_sha256: verifiedDigest, consumed_manifest_sha256: consumedDigest,
          lineage_json: JSON.stringify(lineage), created_at: new Date().toISOString()
        });
      }
      const payload = { ...lineage,
        acknowledgement: 'runtime-verified-synthesis-input-bytes',
        claim_scope: 'submitted bytes match immutable snapshot; does not prove unobservable model cognition' };
      const expectedEventId = hash(`${jobId}|case01.snapshot_consumption_acknowledged|${synthesisResultId}`);
      const eventId = this.#workflow.recordEvent(jobId, 'case01.snapshot_consumption_acknowledged', payload, synthesisResultId);
      const event = this.#workflow.getEvent(eventId);
      if (eventId !== expectedEventId || !event || event.event_id !== expectedEventId || event.job_id !== jobId ||
          event.type !== 'case01.snapshot_consumption_acknowledged' || event.payload_json !== JSON.stringify(payload)) {
        throw new Error('CASE-01 consumption acknowledgement event identity or exact durable payload conflicts with its lineage');
      }
      this.#store.commitConsumptionAckTransaction();
      return { snapshot_id: verified.snapshot_id, consumed_manifest_sha256: consumedDigest, acknowledgement: 'durable' };
    } catch (error) {
      this.#store.rollbackConsumptionAckTransaction();
      throw error;
    }
  }

  validateConsumptionAck(jobId) {
    const ack = this.#store.getConsumptionAck(jobId);
    if (!ack) throw new Error('durable CASE-01 downstream consumption acknowledgement is missing');
    const source = this.#workflow.getArtifact(ack.source_artifact_id);
    const cto = this.#workflow.getArtifact(ack.cto_artifact_id);
    if (!source || !cto || source.job_id !== jobId || cto.job_id !== jobId || source.status !== 'active' || cto.status !== 'active' ||
        source.task_id !== ack.source_task_id || cto.task_id !== ack.cto_task_id || source.type !== 'requirements' || cto.type !== 'cto-decision' ||
        source.content?.workspace_snapshot_id !== ack.snapshot_id || cto.content?.workspace_snapshot_id !== ack.snapshot_id ||
        JSON.stringify(source.content?.workspace_artifacts) !== JSON.stringify(cto.content?.workspace_artifacts)) {
      throw new Error('durable CASE-01 consumption acknowledgement no longer matches source/CTO artifacts');
    }
    const verified = readVerifiedCase01WorkspaceSnapshot({ content: source.content,
      snapshotBase: this.#snapshotBase, snapshotId: ack.snapshot_id });
    const files = verified.workspace_artifacts.map(entry => ({
      path: entry.path, sha256: hash(Buffer.from(entry.bytes_base64, 'base64')),
      size_bytes: Buffer.from(entry.bytes_base64, 'base64').length
    }));
    const digest = hash(JSON.stringify(files));
    if (digest !== ack.verified_manifest_sha256 || digest !== ack.consumed_manifest_sha256) {
      throw new Error('durable CASE-01 consumption digest does not match actual recovered snapshot bytes');
    }
    const lineage = parseStrictJson(ack.lineage_json);
    if (ack.lineage_json !== JSON.stringify(lineage)) {
      throw new Error('durable CASE-01 consumption acknowledgement lineage JSON is non-canonical or contains duplicate decoded keys');
    }
    const expectedLineageKeys = 'consumed_files,consumed_manifest_sha256,cto_artifact_event_id,cto_artifact_id,cto_attempt_id,cto_completion_event_id,cto_result_content_sha256,cto_result_id,cto_task_id,snapshot_id,source_artifact_event_id,source_artifact_id,source_attempt_id,source_completion_event_id,source_result_content_sha256,source_result_id,source_task_id,verified_manifest_sha256';
    if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage) || Object.keys(lineage).sort().join(',') !== expectedLineageKeys ||
        !/^[a-f0-9]{64}$/.test(lineage.source_result_content_sha256 || '') || !/^[a-f0-9]{64}$/.test(lineage.cto_result_content_sha256 || '')) {
      throw new Error('durable CASE-01 consumption acknowledgement lineage schema or result-byte digests are invalid');
    }
    const sourceResult = this.#workflow.getResult(ack.source_result_id);
    const ctoResult = this.#workflow.getResult(ack.cto_result_id);
    if (!sourceResult || sourceResult.result_id !== ack.source_result_id || sourceResult.task_id !== ack.source_task_id ||
        sourceResult.outcome !== 'success' || typeof sourceResult.content !== 'string' || !sourceResult.content.trim() ||
        !ctoResult || ctoResult.result_id !== ack.cto_result_id || ctoResult.task_id !== ack.cto_task_id ||
        ctoResult.outcome !== 'success' || typeof ctoResult.content !== 'string' || !ctoResult.content.trim() ||
        lineage.source_result_content_sha256 !== hash(Buffer.from(sourceResult.content, 'utf8')) ||
        lineage.cto_result_content_sha256 !== hash(Buffer.from(ctoResult.content, 'utf8'))) {
      throw new Error('durable CASE-01 consumption acknowledgement no longer matches exact successful source/CTO result bytes');
    }
    const exact = {
      source_task_id: ack.source_task_id, source_result_id: ack.source_result_id, source_artifact_id: ack.source_artifact_id,
      source_attempt_id: ack.source_attempt_id, snapshot_id: ack.snapshot_id, cto_task_id: ack.cto_task_id,
      cto_result_id: ack.cto_result_id, cto_artifact_id: ack.cto_artifact_id, cto_attempt_id: ack.cto_attempt_id,
      verified_manifest_sha256: ack.verified_manifest_sha256, consumed_manifest_sha256: ack.consumed_manifest_sha256
    };
    for (const [key, value] of Object.entries(exact)) if (lineage[key] !== value) throw new Error(`durable CASE-01 consumption lineage mismatch at ${key}`);
    if (JSON.stringify(lineage.consumed_files) !== JSON.stringify(files)) throw new Error('durable CASE-01 consumed file manifest differs from recovered bytes');
    const sourceCompletion = this.#case01CompletionEvent(jobId, ack.source_result_id);
    const ctoCompletion = this.#case01CompletionEvent(jobId, ack.cto_result_id);
    const sourceAttempt = this.#workflow.getAttempt(ack.source_attempt_id, ack.source_task_id);
    const ctoAttempt = this.#workflow.getAttempt(ack.cto_attempt_id, ack.cto_task_id);
    if (sourceCompletion.row.event_id !== lineage.source_completion_event_id || ctoCompletion.row.event_id !== lineage.cto_completion_event_id ||
        sourceCompletion.payload.taskId !== ack.source_task_id || ctoCompletion.payload.taskId !== ack.cto_task_id ||
        sourceCompletion.payload.executor !== 'chat-on-steroids-plugin' || ctoCompletion.payload.executor !== 'chat-on-steroids-plugin' ||
        sourceCompletion.payload.attemptId !== ack.source_attempt_id || ctoCompletion.payload.attemptId !== ack.cto_attempt_id ||
        sourceAttempt?.status !== 'completed' || ctoAttempt?.status !== 'completed') {
      throw new Error('durable CASE-01 consumption acknowledgement completion-event or attempt lineage is invalid');
    }
    const sourceArtifactEvent = this.#case01ArtifactEvent(jobId, source);
    const ctoArtifactEvent = this.#case01ArtifactEvent(jobId, cto);
    if (sourceArtifactEvent.row.event_id !== lineage.source_artifact_event_id || ctoArtifactEvent.row.event_id !== lineage.cto_artifact_event_id) {
      throw new Error('durable CASE-01 consumption acknowledgement artifact-event lineage is invalid');
    }
    const ackRows = this.#workflow.listEventsForJob(jobId, { type: 'case01.snapshot_consumption_acknowledged' });
    if (ackRows.length !== 1) throw new Error('CASE-01 consumption trace must contain exactly one acknowledgement event for the workflow');
    const ackEvent = ackRows[0];
    let payload;
    try { payload = parseStrictJson(ackEvent.payload_json); }
    catch { throw new Error('CASE-01 consumption trace contains malformed acknowledgement payload'); }
    const expectedPayload = { ...lineage,
      acknowledgement: 'runtime-verified-synthesis-input-bytes',
      claim_scope: 'submitted bytes match immutable snapshot; does not prove unobservable model cognition' };
    if (Object.keys(payload).sort().join(',') !== Object.keys(expectedPayload).sort().join(',')) {
      throw new Error('CASE-01 acknowledgement event contains missing or unknown lineage fields');
    }
    const expectedEventId = hash(`${jobId}|case01.snapshot_consumption_acknowledged|${ack.cto_result_id}`);
    if (ackEvent.event_id !== expectedEventId || ackEvent.job_id !== jobId ||
        ackEvent.type !== 'case01.snapshot_consumption_acknowledged' || ackEvent.payload_json !== JSON.stringify(expectedPayload)) {
      throw new Error('CASE-01 consumption acknowledgement event does not exactly match durable acknowledgement lineage');
    }
    return true;
  }

  #processIsAlive(pid) {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) return false;
    try { this.#process.kill(Number(pid), 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  }

  reconcileSnapshots() {
    this.#store.beginSnapshotCleanupTransaction();
    try {
      const artifactRows = this.#workflow.listArtifactContents();
      const referenced = validateCase01DurableSnapshotReferences({ artifactRows, snapshotBase: this.#snapshotBase });
      let baseExists = true;
      try { fs.lstatSync(this.#snapshotBase); }
      catch (error) { if (error?.code === 'ENOENT') baseExists = false; else throw error; }
      if (!baseExists) {
        this.#store.commitSnapshotCleanupTransaction();
        return { removed: [], preserved: [], errors: [] };
      }
      const reservations = this.#store.listSnapshotReservations();
      const now = Date.now();
      for (const reservation of reservations) {
        const createdAt = Date.parse(reservation.created_at);
        const staleEnough = Number.isFinite(createdAt) && now - createdAt >= 60_000;
        if (this.#processIsAlive(reservation.owner_pid) || !staleEnough) continue;
        if (referenced.has(reservation.snapshot_id)) {
          this.#store.deleteSnapshotReservation(reservation.snapshot_id);
          continue;
        }
        try {
          removeCase01WorkspaceSnapshot({ snapshotBase: this.#snapshotBase, snapshotId: reservation.snapshot_id });
          this.#store.deleteSnapshotReservation(reservation.snapshot_id);
        } catch (error) {
          this.#warn(`[case01-snapshot-recovery] preserved ${reservation.snapshot_id}: ${String(error?.message || error)}`);
        }
      }
      const liveReservations = this.#store.listReservedSnapshotIds();
      const result = reconcileCase01WorkspaceSnapshots({ snapshotBase: this.#snapshotBase,
        referencedSnapshotIds: [...referenced], reservedSnapshotIds: liveReservations,
        minOrphanAgeMs: 60 * 60 * 1000 });
      for (const failure of result.errors) {
        this.#warn(`[case01-snapshot-recovery] cleanup failed for ${failure.snapshot_id}: ${failure.error}`);
      }
      this.#store.commitSnapshotCleanupTransaction();
      return result;
    } catch (error) {
      this.#store.rollbackSnapshotCleanupTransaction();
      throw error;
    }
  }
}

export function createCase01SnapshotService(dependencies) {
  return new Case01SnapshotService(dependencies);
}
