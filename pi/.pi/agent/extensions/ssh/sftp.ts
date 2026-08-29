import type { Readable, Writable } from "node:stream";

const SFTP_VERSION = 3;
const MAX_PACKET_LENGTH = 1024 * 1024;
const CHUNK_LENGTH = 32 * 1024;

const PacketType = {
	Init: 1,
	Version: 2,
	Open: 3,
	Close: 4,
	Read: 5,
	Write: 6,
	Stat: 17,
	OpenDir: 11,
	ReadDir: 12,
	Mkdir: 14,
	RealPath: 16,
	Status: 101,
	Handle: 102,
	Data: 103,
	Name: 104,
	Attrs: 105,
} as const;
type PacketType = (typeof PacketType)[keyof typeof PacketType];

const StatusCode = {
	Ok: 0,
	Eof: 1,
	NoSuchFile: 2,
	PermissionDenied: 3,
	NoConnection: 6,
	ConnectionLost: 7,
} as const;

const OpenFlag = {
	Read: 1,
	Write: 2,
	Create: 8,
	Truncate: 16,
} as const;

const AttrFlag = {
	Size: 0x00000001,
	UidGid: 0x00000002,
	Permissions: 0x00000004,
	AccessModifyTime: 0x00000008,
	Extended: 0x80000000,
} as const;

const KNOWN_ATTR_FLAGS =
	AttrFlag.Size | AttrFlag.UidGid | AttrFlag.Permissions | AttrFlag.AccessModifyTime | AttrFlag.Extended;

export interface SftpAttrs {
	size?: bigint;
	permissions?: number;
}

export class SftpProtocolError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SftpProtocolError";
	}
}

export class SshTransportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SshTransportError";
	}
}

export class RemoteFileOperationError extends Error {
	readonly operation: string;
	readonly path: string;
	readonly statusCode: number;
	readonly statusMessage: string;

	constructor(operation: string, path: string, statusCode: number, statusMessage: string) {
		const detail = statusMessage ? `: ${statusMessage}` : "";
		super(`SFTP ${operation} failed for ${JSON.stringify(path)} (status ${statusCode})${detail}`);
		this.name = new.target.name;
		this.operation = operation;
		this.path = path;
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
	}
}

export class RemoteFileNotFoundError extends RemoteFileOperationError {}

export class RemoteFilePermissionError extends RemoteFileOperationError {}

class PacketReader {
	private readonly data: Buffer;
	private offset = 0;

	constructor(data: Buffer) {
		this.data = data;
	}

	get remaining(): number {
		return this.data.length - this.offset;
	}

	u8(): number {
		return this.take(1)[0]!;
	}

	u32(): number {
		const value = this.take(4).readUInt32BE(0);
		return value;
	}

	u64(): bigint {
		return this.take(8).readBigUInt64BE(0);
	}

	bytes(): Buffer {
		return this.take(this.u32());
	}

	utf8(label: string): string {
		const bytes = this.bytes();
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new SftpProtocolError(`SFTP ${label} is not valid UTF-8`, {
				cause: error,
			});
		}
	}

	finish(): void {
		if (this.remaining !== 0) {
			throw new SftpProtocolError(`SFTP response has ${this.remaining} trailing bytes`);
		}
	}

	private take(length: number): Buffer {
		if (length > this.remaining) {
			throw new SftpProtocolError("Truncated SFTP response");
		}
		const value = this.data.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}
}

class PacketWriter {
	private readonly parts: Buffer[] = [];
	private length = 0;

	u8(value: number): void {
		const data = Buffer.allocUnsafe(1);
		data.writeUInt8(value);
		this.add(data);
	}

	u32(value: number): void {
		const data = Buffer.allocUnsafe(4);
		data.writeUInt32BE(value);
		this.add(data);
	}

	u64(value: bigint): void {
		const data = Buffer.allocUnsafe(8);
		data.writeBigUInt64BE(value);
		this.add(data);
	}

	bytes(value: Uint8Array): void {
		const data = Buffer.from(value);
		this.u32(data.length);
		this.add(data);
	}

	packet(): Buffer {
		if (this.length < 1 || this.length > MAX_PACKET_LENGTH) {
			throw new SftpProtocolError(`SFTP packet length ${this.length} is out of bounds`);
		}
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(this.length);
		return Buffer.concat([header, ...this.parts], this.length + 4);
	}

	private add(data: Buffer): void {
		this.length += data.length;
		if (this.length > MAX_PACKET_LENGTH) {
			throw new SftpProtocolError(`SFTP packet length ${this.length} exceeds ${MAX_PACKET_LENGTH}`);
		}
		this.parts.push(data);
	}
}

interface Status {
	code: number;
	message: string;
}

interface PendingRequest {
	prepareCompletion: (type: PacketType, reader: PacketReader) => () => void;
	reject: (error: Error) => void;
}

interface VersionWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

function encodePath(path: string): Buffer {
	if (path.includes("\0")) throw new SftpProtocolError("SFTP paths must not contain NUL");
	const encoded = Buffer.from(path, "utf8");
	try {
		if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== path) {
			throw new SftpProtocolError("SFTP path is not representable as UTF-8");
		}
	} catch (error) {
		if (error instanceof SftpProtocolError) throw error;
		throw new SftpProtocolError("SFTP path is not representable as UTF-8", {
			cause: error,
		});
	}
	return encoded;
}

function parseAttrs(reader: PacketReader): SftpAttrs {
	const flags = reader.u32();
	if ((flags & ~KNOWN_ATTR_FLAGS) !== 0) {
		throw new SftpProtocolError(`SFTP attributes contain unknown flags 0x${flags.toString(16)}`);
	}

	const attrs: SftpAttrs = {};
	if (flags & AttrFlag.Size) attrs.size = reader.u64();
	if (flags & AttrFlag.UidGid) {
		reader.u32();
		reader.u32();
	}
	if (flags & AttrFlag.Permissions) attrs.permissions = reader.u32();
	if (flags & AttrFlag.AccessModifyTime) {
		reader.u32();
		reader.u32();
	}
	if (flags & AttrFlag.Extended) {
		const count = reader.u32();
		for (let index = 0; index < count; index++) {
			reader.bytes();
			reader.bytes();
		}
	}
	return attrs;
}

function parseStatus(reader: PacketReader): Status {
	const code = reader.u32();
	const message = reader.utf8("status message");
	reader.utf8("status language");
	return { code, message };
}

function statusError(operation: string, path: string, status: Status): Error {
	if (status.code === StatusCode.Ok) {
		return new SftpProtocolError(`Unexpected successful SFTP STATUS for ${operation}`);
	}
	if (status.code === StatusCode.NoSuchFile) {
		return new RemoteFileNotFoundError(operation, path, status.code, status.message);
	}
	if (status.code === StatusCode.PermissionDenied) {
		return new RemoteFilePermissionError(operation, path, status.code, status.message);
	}
	if (status.code === StatusCode.NoConnection || status.code === StatusCode.ConnectionLost) {
		return new SshTransportError(`SFTP transport failed during ${operation} for ${JSON.stringify(path)}`);
	}
	return new RemoteFileOperationError(operation, path, status.code, status.message);
}

function parseNames(reader: PacketReader): string[] {
	const count = reader.u32();
	const names: string[] = [];
	for (let index = 0; index < count; index++) {
		names.push(reader.utf8("filename"));
		reader.bytes();
		parseAttrs(reader);
	}
	return names;
}

function isResponseType(type: number): type is PacketType {
	return (
		type === PacketType.Status ||
		type === PacketType.Handle ||
		type === PacketType.Data ||
		type === PacketType.Name ||
		type === PacketType.Attrs
	);
}

export class SftpClient {
	private incoming: Buffer = Buffer.alloc(0);
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private versionWaiter: VersionWaiter | undefined;
	private initialization: Promise<void> | undefined;
	private initialized = false;
	private terminalError: Error | undefined;
	private closed = false;
	private readonly output: Writable;

	constructor(input: Readable, output: Writable) {
		if (input.readableEncoding !== null) throw new Error("SFTP input stream must use binary mode");
		this.output = output;
		input.on("data", this.onData);
		input.on("end", this.onInputEnd);
		input.on("close", this.onInputClose);
		input.on("error", this.onInputError);
		output.on("error", this.onOutputError);
		output.on("close", this.onOutputClose);
		output.on("finish", this.onOutputFinish);
	}

	initialize(): Promise<void> {
		if (this.initialization) return this.initialization;
		if (this.terminalError) return Promise.reject(this.terminalError);

		this.initialization = new Promise<void>((resolve, reject) => {
			this.versionWaiter = { resolve, reject };
			const writer = new PacketWriter();
			writer.u8(PacketType.Init);
			writer.u32(SFTP_VERSION);
			this.send(writer.packet());
		});
		return this.initialization;
	}

	async readFile(path: string, maxBytes?: number): Promise<Buffer> {
		if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
			throw new RangeError("maxBytes must be a non-negative safe integer");
		}
		const handle = await this.open(path, OpenFlag.Read);
		return this.withHandle(handle, path, async () => {
			const chunks: Buffer[] = [];
			let offset = 0n;
			let total = 0;
			while (maxBytes === undefined || total < maxBytes) {
				const length = Math.min(CHUNK_LENGTH, maxBytes === undefined ? CHUNK_LENGTH : maxBytes - total);
				const data = await this.read(handle, offset, length, path);
				if (data === undefined) break;
				if (data.length === 0) throw this.protocolFailure("SFTP READ returned empty DATA before EOF");
				chunks.push(data);
				total += data.length;
				offset += BigInt(data.length);
			}
			return Buffer.concat(chunks, total);
		});
	}

	async writeFile(path: string, content: Uint8Array): Promise<void> {
		const data = Buffer.from(content);
		const handle = await this.open(path, OpenFlag.Write | OpenFlag.Create | OpenFlag.Truncate);
		await this.withHandle(handle, path, async () => {
			for (let offset = 0; offset < data.length; offset += CHUNK_LENGTH) {
				await this.write(handle, BigInt(offset), data.subarray(offset, offset + CHUNK_LENGTH), path);
			}
		});
	}

	async access(path: string, mode: "read" | "read-write"): Promise<void> {
		let flags: number;
		switch (mode) {
			case "read":
				flags = OpenFlag.Read;
				break;
			case "read-write":
				flags = OpenFlag.Read | OpenFlag.Write;
				break;
		}
		const handle = await this.open(path, flags);
		await this.withHandle(handle, path, async () => undefined);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch (error) {
			if (error instanceof RemoteFileNotFoundError) return false;
			throw error;
		}
	}

	async stat(path: string): Promise<SftpAttrs> {
		const encodedPath = encodePath(path);
		return this.request(
			PacketType.Stat,
			(writer) => writer.bytes(encodedPath),
			(type, reader) => {
				if (type === PacketType.Attrs) return parseAttrs(reader);
				throw this.responseError(type, reader, "stat", path, PacketType.Attrs);
			},
		);
	}

	async readdir(path: string): Promise<string[]> {
		const handle = await this.openDir(path);
		return this.withHandle(handle, path, async () => {
			const result: string[] = [];
			while (true) {
				const names = await this.readDir(handle, path);
				if (names === undefined) break;
				if (names.length === 0) throw this.protocolFailure("SFTP READDIR returned an empty NAME before EOF");
				for (const name of names) {
					if (name !== "." && name !== "..") result.push(name);
				}
			}
			return result;
		});
	}

	async mkdir(path: string): Promise<void> {
		const encodedPath = encodePath(path);
		return this.request(
			PacketType.Mkdir,
			(writer) => {
				writer.bytes(encodedPath);
				writer.u32(0);
			},
			(type, reader) => this.expectStatus(type, reader, "mkdir", path),
		);
	}

	async realpath(path: string): Promise<string> {
		const encodedPath = encodePath(path);
		return this.request(
			PacketType.RealPath,
			(writer) => writer.bytes(encodedPath),
			(type, reader) => {
				if (type === PacketType.Name) {
					const names = parseNames(reader);
					if (names.length !== 1) {
						throw new SftpProtocolError(`SFTP REALPATH returned ${names.length} names`);
					}
					return names[0]!;
				}
				throw this.responseError(type, reader, "realpath", path, PacketType.Name);
			},
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.fail(new SshTransportError("SFTP client closed"));
		if (!this.output.destroyed && !this.output.writableEnded) this.output.end();
	}

	private open(path: string, flags: number): Promise<Buffer> {
		const encodedPath = encodePath(path);
		return this.request(
			PacketType.Open,
			(writer) => {
				writer.bytes(encodedPath);
				writer.u32(flags);
				writer.u32(0);
			},
			(type, reader) => {
				if (type === PacketType.Handle) return reader.bytes();
				throw this.responseError(type, reader, "open", path, PacketType.Handle);
			},
		);
	}

	private openDir(path: string): Promise<Buffer> {
		const encodedPath = encodePath(path);
		return this.request(
			PacketType.OpenDir,
			(writer) => writer.bytes(encodedPath),
			(type, reader) => {
				if (type === PacketType.Handle) return reader.bytes();
				throw this.responseError(type, reader, "opendir", path, PacketType.Handle);
			},
		);
	}

	private read(handle: Buffer, offset: bigint, length: number, path: string): Promise<Buffer | undefined> {
		return this.request(
			PacketType.Read,
			(writer) => {
				writer.bytes(handle);
				writer.u64(offset);
				writer.u32(length);
			},
			(type, reader) => {
				if (type === PacketType.Data) {
					const data = reader.bytes();
					if (data.length > length) {
						throw new SftpProtocolError(`SFTP READ returned ${data.length} bytes after requesting ${length}`);
					}
					return data;
				}
				if (type === PacketType.Status) {
					const status = parseStatus(reader);
					if (status.code === StatusCode.Eof) return undefined;
					throw statusError("read", path, status);
				}
				throw new SftpProtocolError(`Unexpected SFTP response type ${type} for READ`);
			},
		);
	}

	private write(handle: Buffer, offset: bigint, data: Buffer, path: string): Promise<void> {
		return this.request(
			PacketType.Write,
			(writer) => {
				writer.bytes(handle);
				writer.u64(offset);
				writer.bytes(data);
			},
			(type, reader) => this.expectStatus(type, reader, "write", path),
		);
	}

	private readDir(handle: Buffer, path: string): Promise<string[] | undefined> {
		return this.request(
			PacketType.ReadDir,
			(writer) => writer.bytes(handle),
			(type, reader) => {
				if (type === PacketType.Name) return parseNames(reader);
				if (type === PacketType.Status) {
					const status = parseStatus(reader);
					if (status.code === StatusCode.Eof) return undefined;
					throw statusError("readdir", path, status);
				}
				throw new SftpProtocolError(`Unexpected SFTP response type ${type} for READDIR`);
			},
		);
	}

	private closeHandle(handle: Buffer, path: string): Promise<void> {
		return this.request(
			PacketType.Close,
			(writer) => writer.bytes(handle),
			(type, reader) => this.expectStatus(type, reader, "close", path),
		);
	}

	private async withHandle<T>(handle: Buffer, path: string, operation: () => Promise<T>): Promise<T> {
		let result: T;
		try {
			result = await operation();
		} catch (operationError) {
			if (!this.terminalError) {
				try {
					await this.closeHandle(handle, path);
				} catch (closeError) {
					throw new AggregateError([operationError, closeError], `SFTP operation and handle close failed for ${path}`, {
						cause: operationError,
					});
				}
			}
			throw operationError;
		}
		await this.closeHandle(handle, path);
		return result;
	}

	private expectStatus(type: PacketType, reader: PacketReader, operation: string, path: string): void {
		if (type !== PacketType.Status) {
			throw new SftpProtocolError(`Unexpected SFTP response type ${type} for ${operation.toUpperCase()}`);
		}
		const status = parseStatus(reader);
		if (status.code !== StatusCode.Ok) throw statusError(operation, path, status);
	}

	private responseError(
		type: PacketType,
		reader: PacketReader,
		operation: string,
		path: string,
		expected: PacketType,
	): Error {
		if (type === PacketType.Status) return statusError(operation, path, parseStatus(reader));
		return new SftpProtocolError(`Unexpected SFTP response type ${type}; expected ${expected}`);
	}

	private async request<T>(
		type: PacketType,
		writePayload: (writer: PacketWriter) => void,
		parse: (type: PacketType, reader: PacketReader) => T,
	): Promise<T> {
		await this.initialize();
		if (this.terminalError) throw this.terminalError;

		const id = this.allocateId();
		const writer = new PacketWriter();
		writer.u8(type);
		writer.u32(id);
		writePayload(writer);
		const packet = writer.packet();

		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				prepareCompletion: (responseType, reader) => {
					const value = parse(responseType, reader);
					return () => resolve(value);
				},
				reject,
			});
			this.send(packet);
		});
	}

	private allocateId(): number {
		for (let attempts = 0; attempts <= 0xffffffff; attempts++) {
			const id = this.nextId;
			this.nextId = this.nextId === 0xffffffff ? 1 : this.nextId + 1;
			if (!this.pending.has(id)) return id;
		}
		throw new SftpProtocolError("No SFTP request IDs are available");
	}

	private send(packet: Buffer): void {
		if (this.terminalError) return;
		try {
			this.output.write(packet, (error) => {
				if (error) this.transportFailure("Failed to write SFTP packet", error);
			});
		} catch (error) {
			this.transportFailure("Failed to write SFTP packet", error);
		}
	}

	private handlePacket(packet: Buffer): void {
		const reader = new PacketReader(packet);
		const type = reader.u8();

		if (!this.initialized) {
			if (!this.versionWaiter || type !== PacketType.Version) {
				throw new SftpProtocolError(`Unexpected SFTP packet type ${type} before VERSION`);
			}
			const version = reader.u32();
			if (version !== SFTP_VERSION) {
				throw new SftpProtocolError(`SFTP server selected unsupported version ${version}`);
			}
			while (reader.remaining > 0) {
				reader.bytes();
				reader.bytes();
			}
			reader.finish();
			this.initialized = true;
			const waiter = this.versionWaiter;
			this.versionWaiter = undefined;
			waiter.resolve();
			return;
		}

		if (!isResponseType(type)) {
			throw new SftpProtocolError(`Unknown SFTP response type ${type}`);
		}
		const id = reader.u32();
		const pending = this.pending.get(id);
		if (!pending) throw new SftpProtocolError(`Unknown or duplicate SFTP request ID ${id}`);
		this.pending.delete(id);

		try {
			const complete = pending.prepareCompletion(type, reader);
			reader.finish();
			complete();
		} catch (error) {
			if (error instanceof RemoteFileOperationError || error instanceof SshTransportError) {
				try {
					reader.finish();
				} catch (trailingError) {
					const protocolError =
						trailingError instanceof SftpProtocolError
							? trailingError
							: new SftpProtocolError("Failed to parse SFTP response", {
									cause: trailingError,
							  });
					pending.reject(protocolError);
					this.fail(protocolError);
					return;
				}
				pending.reject(error);
				if (error instanceof SshTransportError) this.fail(error);
				return;
			}
			const protocolError =
				error instanceof SftpProtocolError
					? error
					: new SftpProtocolError("Failed to parse SFTP response", {
							cause: error,
					  });
			pending.reject(protocolError);
			this.fail(protocolError);
		}
	}

	private protocolFailure(message: string): SftpProtocolError {
		const error = new SftpProtocolError(message);
		this.fail(error);
		return error;
	}

	private transportFailure(message: string, cause?: unknown): void {
		this.fail(new SshTransportError(message, cause === undefined ? undefined : { cause }));
	}

	private fail(error: Error): void {
		if (this.terminalError) return;
		this.terminalError = error;
		this.versionWaiter?.reject(error);
		this.versionWaiter = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		if (!this.closed && !this.output.destroyed && !this.output.writableEnded) this.output.end();
	}

	private readonly onData = (chunk: Buffer): void => {
		if (this.terminalError) return;
		this.incoming = this.incoming.length === 0 ? chunk : Buffer.concat([this.incoming, chunk]);
		try {
			while (this.incoming.length >= 4) {
				const length = this.incoming.readUInt32BE(0);
				if (length < 1 || length > MAX_PACKET_LENGTH) {
					throw new SftpProtocolError(`SFTP packet length ${length} is out of bounds`);
				}
				if (this.incoming.length < length + 4) return;
				const packet = this.incoming.subarray(4, length + 4);
				this.incoming = this.incoming.subarray(length + 4);
				this.handlePacket(packet);
				if (this.terminalError) return;
			}
		} catch (error) {
			this.fail(
				error instanceof SftpProtocolError
					? error
					: new SftpProtocolError("Failed to frame SFTP response", {
							cause: error,
					  }),
			);
		}
	};

	private readonly onInputEnd = (): void => {
		if (this.terminalError) return;
		if (this.incoming.length > 0) this.fail(new SftpProtocolError("SFTP transport ended with a truncated packet"));
		else this.transportFailure("SFTP transport ended unexpectedly");
	};

	private readonly onInputClose = (): void => {
		if (!this.closed && !this.terminalError) this.transportFailure("SFTP transport closed unexpectedly");
	};

	private readonly onInputError = (error: Error): void => {
		this.transportFailure("SFTP transport read failed", error);
	};

	private readonly onOutputError = (error: Error): void => {
		this.transportFailure("SFTP transport write failed", error);
	};

	private readonly onOutputClose = (): void => {
		if (!this.closed && !this.terminalError) this.transportFailure("SFTP transport closed unexpectedly");
	};

	private readonly onOutputFinish = (): void => {
		if (!this.closed && !this.terminalError) this.transportFailure("SFTP transport became unwritable");
	};
}
