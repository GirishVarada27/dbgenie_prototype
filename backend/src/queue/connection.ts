import { Redis } from "ioredis"

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not set. Copy .env.example to .env and add a Redis connection string.")
}

// maxRetriesPerRequest: null is required by BullMQ's blocking connections —
// see https://docs.bullmq.io/guide/going-to-production#maxretriesperrequest
export const redisConnection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
})
