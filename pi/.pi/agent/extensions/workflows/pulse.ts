// Single-flight latest-value writer for non-authoritative telemetry: at most one write is in flight
// with one pending value (merged, not queued). A write failure latches and silently drops the rest.
export interface LatestPulseWriterOptions<T> {
	write: (value: T) => Promise<void>;
	merge?: (pending: T, latest: T) => T;
}

export class LatestPulseWriter<T> {
	readonly #write: (value: T) => Promise<void>;
	readonly #merge: (pending: T, latest: T) => T;
	#active: Promise<void> | undefined;
	#pending: T | undefined;
	#failed = false;

	constructor(options: LatestPulseWriterOptions<T>) {
		this.#write = options.write;
		this.#merge = options.merge ?? ((_pending, latest) => latest);
	}

	submit(value: T): void {
		if (this.#failed) return;
		this.#pending = this.#pending === undefined ? value : this.#merge(this.#pending, value);
		this.#active ??= Promise.resolve().then(() => this.#drain());
	}

	async flush(): Promise<void> {
		await this.#active;
	}

	async #drain(): Promise<void> {
		try {
			while (this.#pending !== undefined) {
				const value = this.#pending;
				this.#pending = undefined;
				await this.#write(value);
			}
		} catch {
			this.#failed = true;
			this.#pending = undefined;
		} finally {
			this.#active = undefined;
		}
	}
}
