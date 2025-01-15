class CacheService {
    constructor(ttl = 5 * 60 * 1000) { // 5 minutes default TTL
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const cached = this.cache.get(key);
        if (!cached) return null;

        if (Date.now() - cached.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        return cached.value;
    }

    async getOrSet(key, fetchFn) {
        const cached = this.get(key);
        if (cached) return cached;

        const value = await fetchFn();
        this.set(key, value);
        return value;
    }

    invalidate(key) {
        this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    clearExpired() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.ttl) {
                this.cache.delete(key);
            }
        }
    }
}

module.exports = new CacheService();