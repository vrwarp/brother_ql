/**
 * The core's side of the transport contract, pinned down against a fake.
 *
 * `bridge.test.ts` exercises the same code end to end through a simulated
 * bridge, which proves the pieces fit but leaves the core's own decisions —
 * which status failures are worth retrying, when a poll counts as idle, what a
 * job hook is told after a failure, what the tracer hears — only loosely
 * asserted. The mutation sweep found those gaps; the tests here close them
 * with a transport whose every reply is scripted.
 */

import { describe, expect, it } from "vitest";

import type { Tracer } from "../src/diagnostics.js";
import {
  BridgeError,
  DeviceDisconnectedError,
  PrinterStatusError,
  StatusTimeoutError,
} from "../src/errors.js";
import { BrotherQLPrinter } from "../src/printer.js";
import { BrotherQLPrinterCore, describeError } from "../src/printer-core.js";
import type { RawImage } from "../src/image/raw-image.js";
import type {
  CompletionMode,
  JobAnnouncement,
  JobReport,
  Transport,
} from "../src/transport.js";
import { AsyncQueue } from "../src/usb/async-queue.js";
import {
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  makeStatusPacket,
} from "./util/mock-usb.js";

const POLL_WAITING = makeStatusPacket({ phaseTypeCode: 0x00 });
const POLL_PRINTING = makeStatusPacket({ phaseTypeCode: 0x01 });
const POLL_UNKNOWN = makeStatusPacket({ phaseTypeCode: 0x05 });

/** One scripted answer to `requestStatus`: a packet, a failure, or silence. */
type PollReply = Uint8Array | Error | null;

class FakeTransport implements Transport {
  opened = true;
  readonly statusQueue = new AsyncQueue<Uint8Array>();
  readonly writes: Uint8Array[] = [];
  /** Answers to successive status requests; once spent, `pollDefault`. */
  polls: PollReply[] = [];
  pollDefault: PollReply = POLL_WAITING;
  pollCount = 0;
  /** Packets the printer "sends" once a job's last byte is written. */
  afterWrite: Uint8Array[] = [];
  /** Fail the first write after reporting this many bytes sent. */
  failAfterBytes: number | null = null;
  /** Fail every write after the first, i.e. the cancel sequence. */
  failCancel = false;
  /** Split writes into chunks of this size, pausing between them. */
  chunkSize = Infinity;
  chunkDelayMs = 0;

  beginJob?: (job: JobAnnouncement) => void;
  endJob?: (report: JobReport) => void;

  constructor(readonly completion: CompletionMode) {}

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async write(
    data: Uint8Array,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
    betweenChunks?: () => void | Promise<void>,
  ): Promise<void> {
    if (this.writes.length > 0 && this.failCancel) {
      this.writes.push(data);
      throw new Error("cancel failed");
    }
    this.writes.push(data);
    if (this.failAfterBytes !== null && this.writes.length === 1) {
      await betweenChunks?.();
      onProgress?.(this.failAfterBytes, data.length);
      throw new Error("link dropped");
    }
    for (let offset = 0; offset < data.length; offset += this.chunkSize) {
      await betweenChunks?.();
      if (this.chunkDelayMs > 0)
        await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      onProgress?.(Math.min(data.length, offset + this.chunkSize), data.length);
    }
    for (const packet of this.afterWrite) this.statusQueue.push(packet);
  }

  async requestStatus(): Promise<void> {
    this.pollCount += 1;
    const reply =
      this.polls.length > 0 ? this.polls.shift()! : this.pollDefault;
    if (reply instanceof Error) throw reply;
    if (reply) this.statusQueue.push(reply);
  }

  on(): () => void {
    return () => {};
  }
}

/** A tracer that keeps every event as `[category, name, data]`. */
function recorder(): Tracer & {
  events: [string, string, Record<string, unknown> | undefined][];
} {
  const events: [string, string, Record<string, unknown> | undefined][] = [];
  return {
    events,
    event: (category, name, data) => void events.push([category, name, data]),
  };
}

function core(
  transport: FakeTransport,
  options: ConstructorParameters<typeof BrotherQLPrinterCore>[1] = {},
): BrotherQLPrinterCore {
  return new BrotherQLPrinterCore(transport, {
    statusPollIntervalMs: 1,
    midJobStatusIntervalMs: 0,
    ...options,
  });
}

function image(width = 696, height = 8): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

describe("describeError", () => {
  it("names an Error and passes anything else through String()", () => {
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
  });

  it("keeps text of up to 200 characters whole", () => {
    const text = "x".repeat(200);
    expect(describeError(text)).toBe(text);
  });

  it("cuts longer text to 199 characters and an ellipsis", () => {
    const text = "a".repeat(150) + "b".repeat(100);
    const described = describeError(text);
    expect(described).toHaveLength(200);
    expect(described).toBe(`${text.slice(0, 199)}…`);
  });
});

describe("constructor options", () => {
  it("names the bad option and value in the error", () => {
    const t = new FakeTransport("phase");
    expect(
      () => new BrotherQLPrinterCore(t, { statusPollIntervalMs: -1 }),
    ).toThrow("statusPollIntervalMs must be a non-negative number, got -1.");
    expect(
      () => new BrotherQLPrinterCore(t, { midJobStatusIntervalMs: -2 }),
    ).toThrow("midJobStatusIntervalMs must be a non-negative number, got -2.");
  });

  it("accepts zero for both intervals", () => {
    const t = new FakeTransport("phase");
    expect(
      () =>
        new BrotherQLPrinterCore(t, {
          statusPollIntervalMs: 0,
          midJobStatusIntervalMs: 0,
        }),
    ).not.toThrow();
  });
});

describe("status timeouts say which wait ran out", () => {
  it("a status query that goes unanswered is a query timeout", async () => {
    const t = new FakeTransport("pages");
    t.pollDefault = null;
    const error = await core(t)
      .queryStatus(20)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatusTimeoutError);
    expect((error as StatusTimeoutError).phase).toBe("query");
  });

  it("a job that goes unanswered is a job timeout", async () => {
    const t = new FakeTransport("pages");
    const error = await core(t)
      .sendRaw(new Uint8Array(8), { statusTimeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatusTimeoutError);
    expect((error as StatusTimeoutError).phase).toBe("job");
  });
});

describe("completion 'none'", () => {
  it("reports the job as sent, to the tracer too", async () => {
    const t = new FakeTransport("none");
    const diagnostics = recorder();
    const result = await core(t, { diagnostics }).sendRaw(new Uint8Array(8));
    expect(result).toEqual({
      pagesPrinted: 0,
      lastStatus: null,
      confirmation: "none",
    });
    expect(diagnostics.events).toContainEqual([
      "printer",
      "job-sent",
      { pagesPrinted: 0 },
    ]);
  });

  it("needs no tracer", async () => {
    const t = new FakeTransport("none");
    await expect(core(t).sendRaw(new Uint8Array(8))).resolves.toMatchObject({
      confirmation: "none",
    });
  });
});

describe("completion 'phase'", () => {
  it("confirms every page once the printer is back to waiting, without a callback", async () => {
    const t = new FakeTransport("phase");
    t.polls = [POLL_PRINTING, POLL_WAITING];
    const diagnostics = recorder();
    const result = await core(t, { diagnostics }).sendRaw(new Uint8Array(8), {
      pageCount: 2,
    });
    expect(result.pagesPrinted).toBe(2);
    expect(result.confirmation).toBe("phase");
    expect(diagnostics.events).toContainEqual([
      "printer",
      "job-done",
      { pagesPrinted: 2, confirmation: "phase" },
    ]);
  });

  it('counts only "waiting" answers as idle', async () => {
    // An unknown phase is not the printer resting. Were it counted, the job
    // would be called done at the first unknown after the printing answer.
    const t = new FakeTransport("phase");
    t.polls = [POLL_PRINTING, POLL_UNKNOWN, POLL_UNKNOWN, POLL_WAITING];
    await core(t).sendRaw(new Uint8Array(8));
    expect(t.pollCount).toBe(4);
  });

  it("restarts the idle clock whenever the phase changes", async () => {
    // Each phase lasts one poll, far less than the idle budget, though the
    // whole job takes well over it. Only a printer stuck in one phase for
    // the full budget is a timeout.
    const t = new FakeTransport("phase");
    const flip: Uint8Array[] = [];
    for (let i = 0; i < 12; i++)
      flip.push(i % 2 === 0 ? POLL_UNKNOWN : POLL_PRINTING);
    t.polls = [...flip, POLL_WAITING];
    const printer = core(t, { statusPollIntervalMs: 10 });
    const result = await printer.sendRaw(new Uint8Array(8), {
      statusTimeoutMs: 60,
    });
    expect(result.confirmation).toBe("phase");
    expect(t.pollCount).toBe(13);
  });

  it("still times out a printer stuck in one phase", async () => {
    const t = new FakeTransport("phase");
    t.pollDefault = POLL_PRINTING;
    await expect(
      core(t, { statusPollIntervalMs: 5 }).sendRaw(new Uint8Array(8), {
        statusTimeoutMs: 30,
      }),
    ).rejects.toBeInstanceOf(StatusTimeoutError);
  });

  it.each(["timeout", "status-failed"] as const)(
    "rides out a bridge %s on one poll",
    async (reason) => {
      const t = new FakeTransport("phase");
      const failure = new BridgeError(reason, "lost");
      t.polls = [failure, POLL_PRINTING, POLL_WAITING];
      const diagnostics = recorder();
      const result = await core(t, { diagnostics }).sendRaw(new Uint8Array(8));
      expect(result.confirmation).toBe("phase");
      expect(diagnostics.events).toContainEqual([
        "printer",
        "poll-failed",
        { error: String(failure) },
      ]);
    },
  );

  it("gives up on any other bridge failure", async () => {
    const t = new FakeTransport("phase");
    const failure = new BridgeError("status-unavailable", "no SNMP");
    t.polls = [failure];
    await expect(core(t).sendRaw(new Uint8Array(8))).rejects.toBe(failure);
  });

  it("gives up on a non-bridge error even if it carries a transient-looking reason", async () => {
    const t = new FakeTransport("phase");
    const failure = Object.assign(new Error("odd"), {
      reason: "status-failed",
    });
    t.polls = [failure];
    await expect(core(t).sendRaw(new Uint8Array(8))).rejects.toBe(failure);
  });

  it("lets a disconnect while waiting for the reply through", async () => {
    const t = new FakeTransport("phase");
    t.polls = [null];
    const disconnected = new DeviceDisconnectedError();
    const original = t.requestStatus.bind(t);
    t.requestStatus = async () => {
      await original();
      t.statusQueue.fail(disconnected);
    };
    await expect(
      core(t, { statusPollIntervalMs: 50 }).sendRaw(new Uint8Array(8)),
    ).rejects.toBe(disconnected);
  });
});

describe("mid-job status polling", () => {
  function slowJob(): FakeTransport {
    const t = new FakeTransport("phase");
    t.chunkSize = 4;
    t.chunkDelayMs = 3;
    return t;
  }

  it("ignores a transient failure mid-job and tells the tracer", async () => {
    const t = slowJob();
    const failure = new BridgeError("timeout", "late");
    t.polls = [failure];
    const diagnostics = recorder();
    const result = await core(t, {
      diagnostics,
      midJobStatusIntervalMs: 1,
    }).sendRaw(new Uint8Array(16));
    expect(result.confirmation).toBe("phase");
    expect(diagnostics.events).toContainEqual([
      "printer",
      "poll-failed",
      { during: "send", error: String(failure) },
    ]);
  });

  it("needs no tracer for that", async () => {
    const t = slowJob();
    t.polls = [new BridgeError("timeout", "late")];
    await expect(
      core(t, { midJobStatusIntervalMs: 1 }).sendRaw(new Uint8Array(16)),
    ).resolves.toMatchObject({ confirmation: "phase" });
  });

  it("stops the job on any other failure mid-job", async () => {
    const t = slowJob();
    const failure = new BridgeError("connection", "gone");
    t.polls = [failure];
    await expect(
      core(t, { midJobStatusIntervalMs: 1 }).sendRaw(new Uint8Array(16)),
    ).rejects.toBe(failure);
  });
});

describe("an abandoned job", () => {
  it("is cancelled, and the tracer hears how many bytes that took", async () => {
    const t = new FakeTransport("pages");
    t.failAfterBytes = 4;
    const diagnostics = recorder();
    await expect(
      core(t, { diagnostics }).sendRaw(new Uint8Array(8)),
    ).rejects.toThrow("link dropped");
    expect(t.writes).toHaveLength(2);
    expect(diagnostics.events).toContainEqual([
      "printer",
      "job-cancelled",
      { bytes: 402 },
    ]);
  });

  it("is cancelled without a tracer, and the original error still surfaces", async () => {
    const t = new FakeTransport("pages");
    t.failAfterBytes = 4;
    await expect(core(t).sendRaw(new Uint8Array(8))).rejects.toThrow(
      "link dropped",
    );
    expect(t.writes).toHaveLength(2);
  });

  it("reports a failed cancel to the tracer and keeps the original error", async () => {
    const t = new FakeTransport("pages");
    t.failAfterBytes = 4;
    t.failCancel = true;
    const diagnostics = recorder();
    await expect(
      core(t, { diagnostics }).sendRaw(new Uint8Array(8)),
    ).rejects.toThrow("link dropped");
    expect(diagnostics.events).toContainEqual([
      "printer",
      "cancel-failed",
      { error: "Error: cancel failed" },
    ]);
  });

  it("is not cancelled over a connection that has already closed", async () => {
    const t = new FakeTransport("pages");
    t.failAfterBytes = 4;
    const original = t.write.bind(t);
    t.write = async (...args) => {
      try {
        await original(...args);
      } finally {
        t.opened = false;
      }
    };
    await expect(core(t).sendRaw(new Uint8Array(8))).rejects.toThrow(
      "link dropped",
    );
    expect(t.writes).toHaveLength(1);
  });
});

describe("job hooks", () => {
  it("reports nothing for a job that was never announced", async () => {
    // endJob without beginJob: there is nothing for it to close.
    const t = new FakeTransport("none");
    const reports: JobReport[] = [];
    t.endJob = (report) => void reports.push(report);
    await core(t).sendRaw(new Uint8Array(8));
    expect(reports).toEqual([]);
  });

  it("does not report a job whose announcement threw, and tells the tracer", async () => {
    const t = new FakeTransport("none");
    const reports: JobReport[] = [];
    t.beginJob = () => {
      throw new Error("hook broke");
    };
    t.endJob = (report) => void reports.push(report);
    const diagnostics = recorder();
    await core(t, { diagnostics }).sendRaw(new Uint8Array(8));
    expect(reports).toEqual([]);
    expect(diagnostics.events).toContainEqual([
      "printer",
      "hook-failed",
      { hook: "beginJob", error: "Error: hook broke" },
    ]);
  });

  it("survives a throwing announcement without a tracer", async () => {
    const t = new FakeTransport("none");
    t.beginJob = () => {
      throw new Error("hook broke");
    };
    await expect(core(t).sendRaw(new Uint8Array(8))).resolves.toMatchObject({
      confirmation: "none",
    });
  });

  it("survives a throwing report, with or without a tracer", async () => {
    for (const diagnostics of [recorder(), undefined]) {
      const t = new FakeTransport("none");
      t.beginJob = () => {};
      t.endJob = () => {
        throw new Error("report broke");
      };
      await expect(
        core(t, { diagnostics }).sendRaw(new Uint8Array(8)),
      ).resolves.toMatchObject({
        confirmation: "none",
      });
      if (diagnostics) {
        expect(diagnostics.events).toContainEqual([
          "printer",
          "hook-failed",
          { hook: "endJob", error: "Error: report broke" },
        ]);
      }
    }
  });

  it("sendRaw: a failure before the job starts is not reported, and surfaces unchanged", async () => {
    const t = new FakeTransport("none");
    const reports: JobReport[] = [];
    t.beginJob = () => {};
    t.endJob = (report) => void reports.push(report);
    const broken = new Error("tracer broke");
    const diagnostics: Tracer = {
      event: (_category, name) => {
        if (name === "send-start") throw broken;
      },
    };
    await expect(
      core(t, { diagnostics }).sendRaw(new Uint8Array(8)),
    ).rejects.toBe(broken);
    expect(reports).toEqual([]);
  });

  it("sendRaw: a failed job reports the pages it did confirm", async () => {
    const t = new FakeTransport("pages");
    t.afterWrite = [
      STATUS_PHASE_PRINTING,
      STATUS_COMPLETED,
      STATUS_ERROR_COVER_OPEN,
    ];
    const reports: JobReport[] = [];
    t.beginJob = () => {};
    t.endJob = (report) => void reports.push(report);
    await expect(
      core(t).sendRaw(new Uint8Array(8), { pageCount: 2 }),
    ).rejects.toBeInstanceOf(PrinterStatusError);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ pagesPrinted: 1, confirmation: "none" });
    expect(reports[0]!.error).toMatch(/^PrinterStatusError: /);
  });

  it("print: a failure before the job starts is not reported", async () => {
    const t = new FakeTransport("pages");
    const reports: JobReport[] = [];
    t.beginJob = () => {};
    t.endJob = (report) => void reports.push(report);
    const printer = new BrotherQLPrinter(t, { model: "QL-820NWB" });
    await expect(printer.print([], { label: "62" })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(reports).toEqual([]);
  });

  it("print: a failed job reports the pages it did confirm", async () => {
    const t = new FakeTransport("pages");
    t.afterWrite = [
      STATUS_PHASE_PRINTING,
      STATUS_COMPLETED,
      STATUS_ERROR_COVER_OPEN,
    ];
    const reports: JobReport[] = [];
    t.beginJob = () => {};
    t.endJob = (report) => void reports.push(report);
    const printer = new BrotherQLPrinter(t, { model: "QL-820NWB" });
    await expect(
      printer.print([image(), image()], { label: "62" }),
    ).rejects.toBeInstanceOf(PrinterStatusError);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ pagesPrinted: 1 });
  });

  it("print: a successful job is reported with its pages", async () => {
    const t = new FakeTransport("pages");
    t.afterWrite = [
      STATUS_PHASE_PRINTING,
      STATUS_COMPLETED,
      STATUS_PHASE_WAITING,
    ];
    const reports: JobReport[] = [];
    t.beginJob = () => {};
    t.endJob = (report) => void reports.push(report);
    const printer = new BrotherQLPrinter(t, { model: "QL-820NWB" });
    await printer.print(image(), { label: "62" });
    expect(reports).toEqual([{ pagesPrinted: 1, confirmation: "pages" }]);
  });
});
