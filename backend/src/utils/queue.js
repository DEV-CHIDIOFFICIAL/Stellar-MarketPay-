"use strict";

const Queue = require("bull");
const { createServiceLogger, logError } = require("./logger");
const { queueEnqueueFailuresTotal, queueRedisConnected } = require("../metrics");

const queueLogger = createServiceLogger("bull-queue");
const ENQUEUE_TIMEOUT_MS = 2000;

// Setup Redis connection from env, fallback to localhost
const redisConfig = process.env.REDIS_URL || {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
};

// Queue for processing emails asynchronously
const emailQueue = new Queue("emailQueue", redisConfig);

// Queue for non-blocking audit log writes
const auditQueue = new Queue("auditQueue", redisConfig);

// Queue for processing portfolio link HEAD checks asynchronously.
// We keep the connection string identical to `emailQueue` so that an
// environment redeploy only needs a single Redis URL.
const linkVerificationQueue = new Queue("linkVerificationQueue", redisConfig, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

function recordEnqueueFailure(queueName, error) {
  queueEnqueueFailuresTotal.inc({ queue: queueName });
  logError(queueLogger, error, {
    queue: queueName,
    operation: "queue_enqueue",
    nonFatal: true,
  });
  return null;
}

function monitorQueue(queue, queueName) {
  queueRedisConnected.set({ queue: queueName }, 0);
  queue.on("ready", () => {
    queueRedisConnected.set({ queue: queueName }, 1);
    queueLogger.info({ queue: queueName }, "Bull queue connected to Redis");
  });
  queue.on("error", (error) => {
    queueRedisConnected.set({ queue: queueName }, 0);
    logError(queueLogger, error, { queue: queueName, operation: "queue_redis_connection" });
  });

  const add = queue.add;
  queue.add = function (...args) {
    let enqueuePromise;
    try {
      enqueuePromise = Promise.resolve(add.apply(this, args));
    } catch (error) {
      return Promise.resolve(recordEnqueueFailure(queueName, error));
    }

    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Bull queue ${queueName} enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`)),
        ENQUEUE_TIMEOUT_MS,
      );
    });

    return Promise.race([enqueuePromise, deadline])
      .catch((error) => recordEnqueueFailure(queueName, error))
      .finally(() => clearTimeout(timeout));
  };
}

monitorQueue(emailQueue, "emailQueue");
monitorQueue(auditQueue, "auditQueue");
monitorQueue(linkVerificationQueue, "linkVerificationQueue");

module.exports = {
  emailQueue,
  auditQueue,
  linkVerificationQueue,
};
