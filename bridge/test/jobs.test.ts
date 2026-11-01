/**
 * The print log's bookkeeping, and the logger's ring buffer.
 */

import { describe, expect, it, vi } from 'vitest';

import { JobTracker, applyJob, emptyStats, type JobRecord } from '../src/jobs.js';
import { createLogger, hex } from '../src/log.js';
import { summarizeStatus } from '../src/status.js';

const META = { session: 'abcd1234', printerId: 'p1', printerName: 'Desk', token: 'tablet' };

function packet(overrides: { statusType?: number; err1?: number; err2?: number; phase?: number } = {}): Buffer {
  const p = Buffer.alloc(32);
  p[0] = 0x80;
  p[1] = 0x20;
  p[2] = 0x42;
  p[8] = overrides.err1 ?? 0;
  p[9] = overrides.err2 ?? 0;
  p[10] = 62;
  p[11] = 0x0a;
  p[18] = overrides.statusType ?? 0;
  p[19] = overrides.phase ?? 0;
  return p;
}

describe('JobTracker', () => {
  function tracker(idleMs = 10_000) {
    const ended: JobRecord[] = [];
    const t = new JobTracker({ idleMs, onEnd: (job) => ended.push(job) });
    return { t, ended };
  }

  it('starts a job at the first frame and ends it as sent when the printer is closed', () => {
    const { t, ended } = tracker();
    expect(t.active).toBeNull();
    t.frame(META, 100);
    t.frame(META, 50);
    expect(t.active).toMatchObject({ bytes: 150, frames: 2, pages: null, pagesPrinted: null });
    t.end('sent');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ ...META, outcome: 'sent', bytes: 150, frames: 2, completions: 0, faults: [] });
    expect(t.active).toBeNull();
    expect(t.end('sent')).toBeNull(); // nothing in flight
  });

  it('takes the page count and label from an announcement', () => {
    const { t, ended } = tracker();
    t.announce(META, 2, '62');
    t.frame(META, 10);
    t.report(2, 'phase');
    expect(ended[0]).toMatchObject({ pages: 2, label: '62', pagesPrinted: 2, confirmation: 'phase', outcome: 'printed' });
  });

  it('maps the client report onto an outcome', () => {
    const a = tracker();
    a.t.frame(META, 1);
    a.t.report(1, 'none');
    expect(a.ended[0]?.outcome).toBe('sent');
    const b = tracker();
    b.t.frame(META, 1);
    b.t.report(0, 'none', 'PrinterStatusError: No media');
    expect(b.ended[0]).toMatchObject({ outcome: 'failed', message: 'PrinterStatusError: No media' });
    expect(new JobTracker({ idleMs: 10, onEnd: () => {} }).report(1, 'pages')).toBeNull();
  });

  it('notes completions and faults from status packets that pass through', () => {
    const { t, ended } = tracker();
    t.frame(META, 1);
    t.status(summarizeStatus(packet({ statusType: 0x06, phase: 1 })));
    t.status(summarizeStatus(packet({ statusType: 0x01 })));
    t.status(summarizeStatus(packet({ statusType: 0x02, err2: 0x10 })));
    t.status(summarizeStatus(packet({ statusType: 0x00, err1: 0x01 })));
    t.end('printer-closed');
    const job = ended[0]!;
    expect(job.completions).toBe(1);
    expect(job.faults).toHaveLength(2);
    expect(job.faults[0]).toMatchObject({ statusType: 'error', errorInfo: [0, 0x10] });
    expect(job.faults[1]).toMatchObject({ statusType: 'reply', errorInfo: [1, 0] });
    expect(job.lastStatus?.errorInfo).toEqual([1, 0]);
    expect(job.outcome).toBe('printer-closed');
  });

  it('ignores status with no job in flight', () => {
    const { t } = tracker();
    t.status(summarizeStatus(packet({ statusType: 0x01 })));
    expect(t.active).toBeNull();
  });

  it('ends an unreported job as sent once the frames go quiet', () => {
    vi.useFakeTimers();
    try {
      const { t, ended } = tracker(50);
      t.frame(META, 1);
      vi.advanceTimersByTime(40);
      t.frame(META, 1); // activity resets the clock
      vi.advanceTimersByTime(40);
      expect(ended).toHaveLength(0);
      vi.advanceTimersByTime(20);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.outcome).toBe('sent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a job idle while the printer is still taking a frame', () => {
    vi.useFakeTimers();
    try {
      const { t, ended } = tracker(50);
      t.hold(); // the write started before the job existed
      t.frame(META, 1);
      vi.advanceTimersByTime(200);
      expect(ended).toHaveLength(0); // the clock is not running
      t.release();
      vi.advanceTimersByTime(40);
      expect(ended).toHaveLength(0);
      vi.advanceTimersByTime(20);
      expect(ended).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the clock when a write starts mid-job, and restarts it when taken', () => {
    vi.useFakeTimers();
    try {
      const { t, ended } = tracker(50);
      t.frame(META, 1);
      vi.advanceTimersByTime(40);
      t.hold();
      vi.advanceTimersByTime(500);
      expect(ended).toHaveLength(0);
      t.frame(META, 1);
      t.release();
      vi.advanceTimersByTime(60);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.frames).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays open while the client polls status, and takes the report at the end', () => {
    vi.useFakeTimers();
    try {
      const { t, ended } = tracker(50);
      t.announce(META, 1);
      t.frame(META, 1);
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(40);
        t.touch(); // a status request
        vi.advanceTimersByTime(5);
        t.status(summarizeStatus(packet({ phase: 0x01 }))); // its answer
      }
      expect(ended).toHaveLength(0);
      t.report(1, 'phase');
      expect(ended[0]).toMatchObject({ outcome: 'printed', pagesPrinted: 1, confirmation: 'phase' });
      t.touch(); // no job: nothing happens
      vi.advanceTimersByTime(100);
      expect(ended).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a job as disconnected when disposed', () => {
    const { t, ended } = tracker();
    t.dispose(); // nothing in flight: nothing recorded
    expect(ended).toHaveLength(0);
    t.frame(META, 1);
    t.dispose();
    expect(ended[0]?.outcome).toBe('disconnected');
  });
});

describe('applyJob', () => {
  const base: JobRecord = {
    id: 'j',
    ...META,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    bytes: 500,
    frames: 2,
    pages: 2,
    pagesPrinted: null,
    confirmation: null,
    completions: 0,
    outcome: 'sent',
    faults: [],
  };

  it('counts reported pages, confirmed when the client had confirmation', () => {
    const s = applyJob(emptyStats(), { ...base, pagesPrinted: 2, confirmation: 'phase', outcome: 'printed' });
    expect(s).toMatchObject({ jobs: 1, labels: 2, labelsConfirmed: 2, bytes: 500, jobsWithFaults: 0 });
    const u = applyJob(emptyStats(), { ...base, pagesPrinted: 2, confirmation: 'none' });
    expect(u).toMatchObject({ labels: 2, labelsConfirmed: 0 });
  });

  it('falls back to completions seen, then to announced pages of a sent job', () => {
    expect(applyJob(emptyStats(), { ...base, completions: 1 })).toMatchObject({ labels: 1, labelsConfirmed: 1 });
    expect(applyJob(emptyStats(), base)).toMatchObject({ labels: 2, labelsConfirmed: 0 });
    expect(applyJob(emptyStats(), { ...base, outcome: 'printer-closed' })).toMatchObject({ labels: 0 });
    expect(applyJob(emptyStats(), { ...base, pages: null })).toMatchObject({ labels: 0 });
  });

  it('counts faults per job and per event, remembering the last', () => {
    const fault = { at: 't', statusType: 'error' as const, phase: 'printing' as const, errorInfo: [0, 16] as [number, number], hex: '80' };
    let s = applyJob(emptyStats(), { ...base, faults: [fault, fault] });
    s = applyJob(s, base);
    expect(s).toMatchObject({ jobs: 2, jobsWithFaults: 1, faultEvents: 2, lastFault: fault, lastFaultAt: 't' });
  });
});

describe('logger', () => {
  it('keeps every level in the ring buffer but only the threshold on stdout', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), stdoutLevel: 'info', capacity: 3 });
    log('debug', 'a', { x: 1 });
    log('info', 'b');
    log('warn', 'c');
    log('error', 'd');
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(['b', 'c', 'd']);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', message: 'b' });
    // Capacity 3: the oldest record fell off.
    expect(log.recent().map((r) => r.message)).toEqual(['b', 'c', 'd']);
    expect(log.recent(2).map((r) => r.message)).toEqual(['c', 'd']);
    expect(log.capacity).toBe(3);
  });

  it('wraps correctly across many records', () => {
    const log = createLogger({ write: () => {}, capacity: 5 });
    for (let i = 0; i < 23; i++) log('info', String(i));
    expect(log.recent().map((r) => r.message)).toEqual(['18', '19', '20', '21', '22']);
  });

  it('merges data into the stdout line and tolerates zero capacity', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), capacity: 0 });
    log('info', 'hello', { session: 's1', bytes: 3 });
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: 'hello', session: 's1', bytes: 3 });
    expect(log.recent()).toEqual([]);
  });

  it('formats hex and truncates long buffers', () => {
    expect(hex(Uint8Array.from([0x80, 0x20, 0x42]))).toBe('80 20 42');
    expect(hex(new Uint8Array(70), 4)).toBe('00 00 00 00 … (+66 bytes)');
  });
});
