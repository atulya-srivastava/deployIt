const Redis = require('ioredis')

function createSafeRedisClient(url, name = 'REDIS') {
    if (!url) return null;
    const client = new Redis(url, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
        retryStrategy(times) {
            return Math.min(times * 1000, 15000);
        }
    });
    client.on('error', err => {
        if (err && err.message && (err.message.includes('max requests limit exceeded') || err.message.includes('Stream isn\'t writeable'))) {
            return;
        }
        console.error(`[${name} ERROR]`, err ? err.message : err);
    });
    return client;
}

const redisPublisher = createSafeRedisClient(process.env.REDIS_URL || 'redis://localhost:6379', 'REDIS PUBLISHER')

module.exports = {
    createSafeRedisClient,
    redisPublisher
}
