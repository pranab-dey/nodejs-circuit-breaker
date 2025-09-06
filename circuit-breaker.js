const axios = require('axios');
const EventEmitter = require('events');

class CircuitBreaker extends EventEmitter {
	constructor(options = {}) {
		super();

		// Default configuration with customizable options
		this.config = {
			failureThreshold: options.failureThreshold || 5,
			successThreshold: options.successThreshold || 2, // Successes needed to close circuit
			timeout: options.timeout || 5000, // Request timeout in ms
			cooldownPeriod: options.cooldownPeriod || 60000, // Cooldown in ms
			monitoringPeriod: options.monitoringPeriod || 10000, // Window to track requests
			...options,
		};

		this.states = new Map(); // Use Map for better performance
		this.metrics = new Map(); // Track success/failure metrics

		// Start cleanup interval for old states
		this.cleanupInterval = setInterval(
			() => this.cleanup(),
			this.config.monitoringPeriod
		);
	}

	/**
	 * Main method to call external services through circuit breaker
	 */
	async callService(requestOptions, endpointOverride = null) {
		const endpoint =
			endpointOverride || this.generateEndpointKey(requestOptions);

		// Check if request should be allowed
		const canProceed = this.canRequest(endpoint);
		if (!canProceed) {
			const error = new Error(`Circuit breaker is OPEN for ${endpoint}`);
			error.code = 'CIRCUIT_BREAKER_OPEN';
			this.emit('circuitBreakerOpen', { endpoint, requestOptions });
			throw error;
		}

		// Set timeout if not already specified
		const options = {
			timeout: this.config.timeout,
			...requestOptions,
		};

		const startTime = Date.now();

		try {
			const response = await axios(options);
			const duration = Date.now() - startTime;

			this.onSuccess(endpoint, duration);
			return response;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.onFailure(endpoint, error, duration);
			throw error; // Re-throw the original error
		}
	}

	/**
	 * Handle successful requests
	 */
	onSuccess(endpoint, duration) {
		const state = this.getState(endpoint);
		const metrics = this.getMetrics(endpoint);

		// Record success metrics
		metrics.totalRequests++;
		metrics.successCount++;
		metrics.lastSuccess = Date.now();
		metrics.avgResponseTime = this.calculateAverage(
			metrics.avgResponseTime,
			duration,
			metrics.successCount
		);

		// Handle state transitions
		if (state.circuit === 'HALF') {
			state.halfOpenSuccesses++;
			if (state.halfOpenSuccesses >= this.config.successThreshold) {
				this.closeCircuit(endpoint);
			}
		} else if (state.circuit === 'CLOSED') {
			state.failures = 0; // Reset failure count on success
		}

		this.emit('requestSuccess', {
			endpoint,
			duration,
			state: state.circuit,
		});
	}

	/**
	 * Handle failed requests
	 */
	onFailure(endpoint, error, duration) {
		const state = this.getState(endpoint);
		const metrics = this.getMetrics(endpoint);

		// Record failure metrics
		metrics.totalRequests++;
		metrics.failureCount++;
		metrics.lastFailure = Date.now();

		// Update failure count and check threshold
		state.failures++;
		state.lastFailure = Date.now();

		if (
			state.failures >= this.config.failureThreshold &&
			state.circuit === 'CLOSED'
		) {
			this.openCircuit(endpoint);
		} else if (state.circuit === 'HALF') {
			// Failed during half-open, go back to open
			this.openCircuit(endpoint);
		}

		this.emit('requestFailure', {
			endpoint,
			error: error.message,
			duration,
			failures: state.failures,
			state: state.circuit,
		});
	}

	/**
	 * Check if request can proceed based on circuit state
	 */
	canRequest(endpoint) {
		const state = this.getState(endpoint);
		const now = Date.now();

		switch (state.circuit) {
			case 'CLOSED':
				return true;

			case 'OPEN':
				if (now >= state.nextTry) {
					this.halfOpenCircuit(endpoint);
					return true;
				}
				return false;

			case 'HALF':
				return true;

			default:
				return true;
		}
	}

	/**
	 * Open the circuit (block requests)
	 */
	openCircuit(endpoint) {
		const state = this.getState(endpoint);
		const backoffTime = this.calculateBackoff(state.failures);

		state.circuit = 'OPEN';
		state.openedAt = Date.now();
		state.nextTry = Date.now() + backoffTime;
		state.halfOpenSuccesses = 0;

		console.warn(
			`Circuit OPENED for ${endpoint}. Next try in ${backoffTime}ms`
		);
		this.emit('circuitOpened', {
			endpoint,
			backoffTime,
			failures: state.failures,
		});
	}

	/**
	 * Close the circuit (allow all requests)
	 */
	closeCircuit(endpoint) {
		const state = this.getState(endpoint);

		state.circuit = 'CLOSED';
		state.failures = 0;
		state.halfOpenSuccesses = 0;
		state.openedAt = null;

		console.info(`Circuit CLOSED for ${endpoint}`);
		this.emit('circuitClosed', { endpoint });
	}

	/**
	 * Half-open the circuit (allow limited requests for testing)
	 */
	halfOpenCircuit(endpoint) {
		const state = this.getState(endpoint);

		state.circuit = 'HALF';
		state.halfOpenSuccesses = 0;

		console.info(`🟡 Circuit HALF-OPEN for ${endpoint}`);
		this.emit('circuitHalfOpen', { endpoint });
	}

	/**
	 * Get or create state for an endpoint
	 */
	getState(endpoint) {
		if (!this.states.has(endpoint)) {
			this.states.set(endpoint, {
				failures: 0,
				circuit: 'CLOSED',
				nextTry: 0,
				openedAt: null,
				halfOpenSuccesses: 0,
				createdAt: Date.now(),
				lastFailure: null,
			});
		}
		return this.states.get(endpoint);
	}

	/**
	 * Get or create metrics for an endpoint
	 */
	getMetrics(endpoint) {
		if (!this.metrics.has(endpoint)) {
			this.metrics.set(endpoint, {
				totalRequests: 0,
				successCount: 0,
				failureCount: 0,
				avgResponseTime: 0,
				lastSuccess: null,
				lastFailure: null,
				createdAt: Date.now(),
			});
		}
		return this.metrics.get(endpoint);
	}

	/**
	 * Generate unique endpoint key
	 */
	generateEndpointKey(requestOptions) {
		const method = requestOptions.method || 'GET';
		const url = requestOptions.url || requestOptions.baseURL;
		return `${method.toUpperCase()}:${url}`;
	}

	/**
	 * Calculate exponential backoff
	 */
	calculateBackoff(failures) {
		const baseDelay = this.config.cooldownPeriod;
		const maxDelay = baseDelay * 10; // Cap at 10x base delay
		const backoff = Math.min(
			baseDelay * Math.pow(2, failures - this.config.failureThreshold),
			maxDelay
		);

		// Add jitter to prevent thundering herd
		const jitter = Math.random() * 0.1 * backoff;
		return Math.floor(backoff + jitter);
	}

	/**
	 * Calculate running average
	 */
	calculateAverage(currentAvg, newValue, count) {
		return (currentAvg * (count - 1) + newValue) / count;
	}

	/**
	 * Get comprehensive stats for monitoring
	 */
	getStats(endpoint = null) {
		if (endpoint) {
			return {
				state: this.getState(endpoint),
				metrics: this.getMetrics(endpoint),
			};
		}

		const stats = {};
		for (const [ep] of this.states) {
			stats[ep] = this.getStats(ep);
		}
		return stats;
	}

	/**
	 * Get health status of all endpoints
	 */
	getHealthStatus() {
		const health = {
			healthy: [],
			unhealthy: [],
			recovering: [],
		};

		for (const [endpoint, state] of this.states) {
			const metrics = this.getMetrics(endpoint);
			const successRate =
				metrics.totalRequests > 0
					? (metrics.successCount / metrics.totalRequests) * 100
					: 100;

			const endpointHealth = {
				endpoint,
				state: state.circuit,
				successRate: parseFloat(successRate.toFixed(2)),
				failures: state.failures,
				avgResponseTime: metrics.avgResponseTime,
			};

			switch (state.circuit) {
				case 'CLOSED':
					health.healthy.push(endpointHealth);
					break;
				case 'OPEN':
					health.unhealthy.push(endpointHealth);
					break;
				case 'HALF':
					health.recovering.push(endpointHealth);
					break;
			}
		}

		return health;
	}

	/**
	 * Cleanup old unused states and metrics
	 */
	cleanup() {
		const now = Date.now();
		const maxAge = this.config.monitoringPeriod * 10; // Keep for 10 monitoring periods

		for (const [endpoint, state] of this.states) {
			if (
				now - state.createdAt > maxAge &&
				state.circuit === 'CLOSED' &&
				state.failures === 0
			) {
				this.states.delete(endpoint);
				this.metrics.delete(endpoint);
			}
		}
	}

	/**
	 * Manually reset a circuit (for admin/debugging purposes)
	 */
	reset(endpoint) {
		if (endpoint) {
			this.states.delete(endpoint);
			this.metrics.delete(endpoint);
			console.info(`Reset circuit breaker for ${endpoint}`);
			this.emit('circuitReset', { endpoint });
		} else {
			this.states.clear();
			this.metrics.clear();
			console.info('Reset all circuit breakers');
			this.emit('circuitResetAll');
		}
	}

	/**
	 * Cleanup on destruction
	 */
	destroy() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}
		this.removeAllListeners();
	}
}

module.exports = CircuitBreaker;

// Usage Examples:
//
// Basic usage:
// const breaker = new CircuitBreaker();
// const response = await breaker.callService({ method: 'GET', url: 'https://api.example.com/users' });
//
// Advanced usage with custom config:
// const breaker = new CircuitBreaker({
//   failureThreshold: 3,
//   timeout: 2000,
//   cooldownPeriod: 30000
// });
//
// Event handling:
// this should be integregated with service-registry
// breaker.on('circuitOpened', ({ endpoint, failures }) => {
//   console.log(`Circuit opened for ${endpoint} after ${failures} failures`);
//   // Send alert to monitoring system
// });
//
// Health monitoring:
// app.get('/health/circuit-breakers', (req, res) => {
//   res.json(breaker.getHealthStatus());
// });
