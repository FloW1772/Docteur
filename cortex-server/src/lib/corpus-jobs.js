// In-memory progress tracker for background corpus imports.
// Jobs are ephemeral (lost on server restart) — the durable record lives in corpus_sources.

const jobs = new Map();
const MAX_JOBS = 50;

export function createJob(id, total) {
  if (jobs.size >= MAX_JOBS) {
    const oldestKey = jobs.keys().next().value;
    jobs.delete(oldestKey);
  }
  jobs.set(id, { id, done: 0, total, status: 'running', errors: [] });
  return jobs.get(id);
}

export function updateJobProgress(id, done) {
  const job = jobs.get(id);
  if (job) job.done = done;
}

export function addJobError(id, error) {
  const job = jobs.get(id);
  if (job) job.errors.push(error);
}

export function finishJob(id, status = 'done') {
  const job = jobs.get(id);
  if (job) job.status = status;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}
