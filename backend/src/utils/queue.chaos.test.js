"use strict";

jest.mock("bull", () => {
  const { EventEmitter } = require("events");

  return class MockQueue extends EventEmitter {
    constructor(name) {
      super();
      this.name = name;
      this.add = jest.fn().mockResolvedValue({ id: "job-1" });
      this.rawAdd = this.add;
    }
  };
});

jest.mock("./logger", () => ({
  createServiceLogger: jest.fn(() => ({
    info: jest.fn(),
  })),
  logError: jest.fn(),
}));

const { auditQueue, emailQueue } = require("./queue");
const { logError } = require("./logger");
const { queueEnqueueFailuresTotal, queueRedisConnected } = require("../metrics");

function metricValue(metric, queue) {
  return metric.get().values.find((sample) => sample.labels.queue === queue)?.value ?? 0;
}

describe("Bull queue Redis chaos behavior", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test("audit enqueue failures are logged, counted, and non-fatal", async () => {
    const before = metricValue(queueEnqueueFailuresTotal, "auditQueue");
    auditQueue.rawAdd.mockRejectedValueOnce(new Error("Redis unavailable"));

    await expect(auditQueue.add({ type: "audit_log", payload: {} })).resolves.toBeNull();

    expect(metricValue(queueEnqueueFailuresTotal, "auditQueue")).toBe(before + 1);
    expect(logError).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ message: "Redis unavailable" }),
      expect.objectContaining({
        queue: "auditQueue",
        operation: "queue_enqueue",
        nonFatal: true,
      }),
    );
  });

  test("email enqueue does not block indefinitely while Redis is unavailable", async () => {
    const before = metricValue(queueEnqueueFailuresTotal, "emailQueue");
    jest.useFakeTimers();
    emailQueue.rawAdd.mockImplementationOnce(() => new Promise(() => {}));

    const enqueue = emailQueue.add({ recipientAddress: "user", eventType: "test" });
    await jest.advanceTimersByTimeAsync(2000);

    await expect(enqueue).resolves.toBeNull();
    expect(metricValue(queueEnqueueFailuresTotal, "emailQueue")).toBe(before + 1);
  });

  test("Redis connection metrics recover after Bull reconnects", () => {
    auditQueue.emit("ready");
    expect(metricValue(queueRedisConnected, "auditQueue")).toBe(1);

    auditQueue.emit("error", new Error("Redis connection lost"));
    expect(metricValue(queueRedisConnected, "auditQueue")).toBe(0);

    auditQueue.emit("ready");
    expect(metricValue(queueRedisConnected, "auditQueue")).toBe(1);
  });
});
