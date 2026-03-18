/**
 * Rate Limiter Service
 * 
 * Manages API rate limiting across multiple providers.
 * Implements token bucket algorithm with exponential backoff.
 */

import type { AIProvider } from './aiService';

// ============================================================================
// Types
// ============================================================================

export interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsPerDay?: number;
  tokensPerDay?: number;
  concurrentRequests?: number;
}

interface ProviderState {
  config: RateLimitConfig;
  // Minute window
  minuteWindowStart: number;
  minuteRequests: number;
  minuteTokens: number;
  // Day window
  dayWindowStart: number;
  dayRequests: number;
  dayTokens: number;
  // Concurrent tracking
  activeRequests: number;
  // Backoff state
  backoffUntil: number;
  backoffMultiplier: number;
  consecutiveErrors: number;
  // Queue
  queue: QueuedRequest[];
}

interface QueuedRequest {
  id: string;
  estimatedTokens: number;
  priority: number;
  resolve: (canProceed: boolean) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Default Configurations
// ============================================================================

const DEFAULT_CONFIGS: Record<AIProvider, RateLimitConfig> = {
  anthropic: {
    requestsPerMinute: 50,
    tokensPerMinute: 100000,
    requestsPerDay: 10000,
    tokensPerDay: 10000000,
    concurrentRequests: 10,
  },
  openai: {
    requestsPerMinute: 60,
    tokensPerMinute: 150000,
    requestsPerDay: 10000,
    tokensPerDay: 30000000,
    concurrentRequests: 20,
  },
  google: {
    requestsPerMinute: 60,
    tokensPerMinute: 1000000,
    requestsPerDay: 1500,
    tokensPerDay: 100000000,
    concurrentRequests: 10,
  },
  vertex: {
    requestsPerMinute: 60,
    tokensPerMinute: 1000000,
    requestsPerDay: 1500,
    tokensPerDay: 100000000,
    concurrentRequests: 10,
  },
  lmstudio: {
    requestsPerMinute: 999,
    tokensPerMinute: 10000000,
    requestsPerDay: 999999,
    tokensPerDay: 999999999,
    concurrentRequests: 5,
  },
};

// ============================================================================
// Rate Limiter Class
// ============================================================================

class RateLimiterService {
  private providers: Map<AIProvider, ProviderState> = new Map();
  private readonly MINUTE_MS = 60 * 1000;
  private readonly DAY_MS = 24 * 60 * 60 * 1000;
  private readonly MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes max
  private readonly BASE_BACKOFF_MS = 1000; // 1 second base
  private readonly REQUEST_TIMEOUT_MS = 60 * 1000; // 60 second queue timeout

  constructor() {
    // Initialize all providers with default configs
    for (const [provider, config] of Object.entries(DEFAULT_CONFIGS)) {
      this.initProvider(provider as AIProvider, config);
    }
  }

  /**
   * Initialize or reset a provider's state
   */
  private initProvider(provider: AIProvider, config: RateLimitConfig): void {
    const now = Date.now();
    this.providers.set(provider, {
      config,
      minuteWindowStart: now,
      minuteRequests: 0,
      minuteTokens: 0,
      dayWindowStart: now,
      dayRequests: 0,
      dayTokens: 0,
      activeRequests: 0,
      backoffUntil: 0,
      backoffMultiplier: 1,
      consecutiveErrors: 0,
      queue: [],
    });
  }

  /**
   * Update provider configuration
   */
  setConfig(provider: AIProvider, config: Partial<RateLimitConfig>): void {
    const state = this.providers.get(provider);
    if (state) {
      state.config = { ...state.config, ...config };
    }
  }

  /**
   * Reset windows if expired
   */
  private resetExpiredWindows(state: ProviderState): void {
    const now = Date.now();
    
    // Reset minute window
    if (now - state.minuteWindowStart >= this.MINUTE_MS) {
      state.minuteWindowStart = now;
      state.minuteRequests = 0;
      state.minuteTokens = 0;
    }
    
    // Reset day window
    if (now - state.dayWindowStart >= this.DAY_MS) {
      state.dayWindowStart = now;
      state.dayRequests = 0;
      state.dayTokens = 0;
    }
  }

  /**
   * Check if a request can proceed immediately
   */
  canProceed(provider: AIProvider, estimatedTokens: number): boolean {
    const state = this.providers.get(provider);
    if (!state) return true;
    
    this.resetExpiredWindows(state);
    const now = Date.now();
    
    // Check backoff
    if (now < state.backoffUntil) {
      return false;
    }
    
    // Check concurrent limit
    if (state.config.concurrentRequests && 
        state.activeRequests >= state.config.concurrentRequests) {
      return false;
    }
    
    // Check minute limits
    if (state.minuteRequests >= state.config.requestsPerMinute) {
      return false;
    }
    if (state.minuteTokens + estimatedTokens > state.config.tokensPerMinute) {
      return false;
    }
    
    // Check day limits
    if (state.config.requestsPerDay && 
        state.dayRequests >= state.config.requestsPerDay) {
      return false;
    }
    if (state.config.tokensPerDay && 
        state.dayTokens + estimatedTokens > state.config.tokensPerDay) {
      return false;
    }
    
    return true;
  }

  /**
   * Get estimated wait time in milliseconds
   */
  getWaitTime(provider: AIProvider): number {
    const state = this.providers.get(provider);
    if (!state) return 0;
    
    this.resetExpiredWindows(state);
    const now = Date.now();
    
    // If in backoff, return remaining backoff time
    if (now < state.backoffUntil) {
      return state.backoffUntil - now;
    }
    
    // If at minute limit, return time until window resets
    if (state.minuteRequests >= state.config.requestsPerMinute) {
      return this.MINUTE_MS - (now - state.minuteWindowStart);
    }
    
    // If at day limit, return time until day resets
    if (state.config.requestsPerDay && 
        state.dayRequests >= state.config.requestsPerDay) {
      return this.DAY_MS - (now - state.dayWindowStart);
    }
    
    return 0;
  }

  /**
   * Acquire a slot for a request (blocks until available or timeout)
   */
  async acquire(
    provider: AIProvider, 
    estimatedTokens: number,
    priority = 0
  ): Promise<boolean> {
    const state = this.providers.get(provider);
    if (!state) return true;
    
    // Check if can proceed immediately
    if (this.canProceed(provider, estimatedTokens)) {
      state.activeRequests++;
      return true;
    }
    
    // Queue the request
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      
      const timeoutId = setTimeout(() => {
        // Remove from queue on timeout
        state.queue = state.queue.filter(r => r.id !== id);
        reject(new Error(`Rate limit queue timeout for ${provider}`));
      }, this.REQUEST_TIMEOUT_MS);
      
      const request: QueuedRequest = {
        id,
        estimatedTokens,
        priority,
        resolve: (canProceed) => {
          clearTimeout(timeoutId);
          if (canProceed) {
            state.activeRequests++;
          }
          resolve(canProceed);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        timeoutId,
      };
      
      // Insert by priority (higher priority first)
      const insertIndex = state.queue.findIndex(r => r.priority < priority);
      if (insertIndex === -1) {
        state.queue.push(request);
      } else {
        state.queue.splice(insertIndex, 0, request);
      }
      
      // Schedule queue processing
      this.scheduleQueueProcessing(provider);
    });
  }

  /**
   * Release a slot after request completes
   */
  release(provider: AIProvider): void {
    const state = this.providers.get(provider);
    if (state && state.activeRequests > 0) {
      state.activeRequests--;
      // Process queue when slot becomes available
      this.processQueue(provider);
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(provider: AIProvider, inputTokens: number, outputTokens: number): void {
    const state = this.providers.get(provider);
    if (!state) return;
    
    const totalTokens = inputTokens + outputTokens;
    
    state.minuteRequests++;
    state.minuteTokens += totalTokens;
    state.dayRequests++;
    state.dayTokens += totalTokens;
    
    // Reset backoff on success
    state.consecutiveErrors = 0;
    state.backoffMultiplier = 1;
    state.backoffUntil = 0;
  }

  /**
   * Record a rate limit error (429)
   */
  recordRateLimitError(provider: AIProvider, retryAfterSeconds?: number): void {
    const state = this.providers.get(provider);
    if (!state) return;
    
    state.consecutiveErrors++;
    
    // Calculate backoff time
    let backoffMs: number;
    if (retryAfterSeconds) {
      backoffMs = retryAfterSeconds * 1000;
    } else {
      // Exponential backoff
      backoffMs = Math.min(
        this.BASE_BACKOFF_MS * Math.pow(2, state.consecutiveErrors - 1) * state.backoffMultiplier,
        this.MAX_BACKOFF_MS
      );
    }
    
    state.backoffUntil = Date.now() + backoffMs;
    state.backoffMultiplier = Math.min(state.backoffMultiplier * 1.5, 10);
    
    console.log(`[RateLimiter] ${provider} rate limited, backing off for ${backoffMs}ms`);
  }

  /**
   * Record a general error (not rate limit)
   */
  recordError(provider: AIProvider): void {
    const state = this.providers.get(provider);
    if (!state) return;
    
    state.consecutiveErrors++;
    
    // Light backoff for general errors
    if (state.consecutiveErrors >= 3) {
      const backoffMs = Math.min(
        this.BASE_BACKOFF_MS * state.consecutiveErrors,
        this.MAX_BACKOFF_MS / 2
      );
      state.backoffUntil = Date.now() + backoffMs;
    }
  }

  /**
   * Schedule queue processing
   * Always uses setTimeout to prevent synchronous recursion stack overflow
   * when canProceed returns false but getWaitTime returns 0 (e.g., concurrent limit)
   */
  private scheduleQueueProcessing(provider: AIProvider): void {
    const waitTime = this.getWaitTime(provider);
    // Always use setTimeout to break synchronous call chain
    // Minimum 50ms prevents busy-waiting when concurrent limit is hit
    const delay = Math.max(waitTime, 50);
    setTimeout(() => this.processQueue(provider), delay);
  }

  /**
   * Process queued requests
   */
  private processQueue(provider: AIProvider): void {
    const state = this.providers.get(provider);
    if (!state || state.queue.length === 0) return;
    
    this.resetExpiredWindows(state);
    
    // Process requests in order
    while (state.queue.length > 0) {
      const request = state.queue[0];
      
      if (this.canProceed(provider, request.estimatedTokens)) {
        state.queue.shift();
        request.resolve(true);
      } else {
        // Can't proceed, schedule retry
        this.scheduleQueueProcessing(provider);
        break;
      }
    }
  }

  /**
   * Get current state for a provider (for UI display)
   */
  getState(provider: AIProvider): {
    minuteUsage: { requests: number; tokens: number; limit: { requests: number; tokens: number } };
    dayUsage: { requests: number; tokens: number; limit: { requests: number; tokens: number } };
    activeRequests: number;
    queueLength: number;
    backoffRemaining: number;
    isLimited: boolean;
  } | null {
    const state = this.providers.get(provider);
    if (!state) return null;
    
    this.resetExpiredWindows(state);
    const now = Date.now();
    
    return {
      minuteUsage: {
        requests: state.minuteRequests,
        tokens: state.minuteTokens,
        limit: {
          requests: state.config.requestsPerMinute,
          tokens: state.config.tokensPerMinute,
        },
      },
      dayUsage: {
        requests: state.dayRequests,
        tokens: state.dayTokens,
        limit: {
          requests: state.config.requestsPerDay || Infinity,
          tokens: state.config.tokensPerDay || Infinity,
        },
      },
      activeRequests: state.activeRequests,
      queueLength: state.queue.length,
      backoffRemaining: Math.max(0, state.backoffUntil - now),
      isLimited: !this.canProceed(provider, 1000), // Check with minimal tokens
    };
  }

  /**
   * Get all provider states
   */
  getAllStates(): Record<AIProvider, ReturnType<typeof this.getState>> {
    const states: Record<string, ReturnType<typeof this.getState>> = {};
    for (const provider of this.providers.keys()) {
      states[provider] = this.getState(provider);
    }
    return states as Record<AIProvider, ReturnType<typeof this.getState>>;
  }

  /**
   * Clear all state (for testing)
   */
  reset(): void {
    for (const [provider, state] of this.providers.entries()) {
      // Cancel all queued requests
      for (const request of state.queue) {
        clearTimeout(request.timeoutId);
        request.reject(new Error('Rate limiter reset'));
      }
      // Reinitialize
      this.initProvider(provider, state.config);
    }
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiterService();

// Export types
export type { RateLimiterService };
