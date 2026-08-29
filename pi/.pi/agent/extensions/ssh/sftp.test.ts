import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import test from "node:test";
import {
	RemoteFileNotFoundError,
	RemoteFileOperationError,
	RemoteFilePermissionError,
	SftpClient,
	SftpProtocolError,
	SshTransportError,
} from "./sftp.ts";

const SFTP_SERVER = "/usr/lib/openssh/sftp-server";

function u8(value: number): Buffer {
	const data = Buffer.allocUnsafe(1);
	data.writeUInt8(value);
	return data;
}

function u32(value: number): Buffer {
	const data = Buffer.allocUnsafe(4);
	data.writeUInt32BE(value);
	return data;
}

function bytes(value: Uint8Array): Buffer {
	const data = Buffer.from(value);
	return Buffer.concat([u32(data.length), data]);
}

function string(value: string): Buffer {
	return bytes(Buffer.from(value));
}

function frame(...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([u32(body.length), body]);
}

function versionFrame(): Buffer {
	return frame(u8(2), u32(3));
}

function attrsFrame(id: number, permissions = 0o100644): Buffer {
	return frame(u8(105), u32(id), u32(4), u32(permissions));
}

function handleFrame(id: number, handle = Buffer.from("handle")): Buffer {
	return frame(u8(102), u32(id), bytes(handle));
}

function dataFrame(id: number, data: Uint8Array): Buffer {
	return frame(u8(103), u32(id), bytes(data));
}

function statusFrame(id: number, code: number, message = ""): Buffer {
	return frame(u8(101), u32(id), u32(code), string(message), string(""));
}

class Cursor {
	private readonly data: Buffer;
	private offset = 0;

	constructor(data: Buffer) {
		this.data = data;
	}

	u8(): number {
		return this.data[this.offset++]!;
	}

	u32(): number {
		const value = this.data.readUInt32BE(this.offset);
		this.offset += 4;
		return value;
	}

	u64(): bigint {
		const value = this.data.readBigUInt64BE(this.offset);
		this.offset += 8;
		return value;
	}

	bytes(): Buffer {
		const length = this.u32();
		const value = this.data.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}
}

class PacketQueue {
	private buffered = Buffer.alloc(0);
	private readonly packets: Buffer[] = [];
	private readonly waiters: Array<{
		resolve: (packet: Buffer) => void;
		reject: (error: Error) => void;
	}> = [];
	private ended = false;

	constructor(input: Readable) {
		input.on("data", (chunk: Buffer) => {
			this.buffered = Buffer.concat([this.buffered, chunk]);
			while (this.buffered.length >= 4) {
				const length = this.buffered.readUInt32BE(0);
				if (this.buffered.length < length + 4) return;
				const packet = this.buffered.subarray(4, length + 4);
				this.buffered = this.buffered.subarray(length + 4);
				const waiter = this.waiters.shift();
				if (waiter) waiter.resolve(packet);
				else this.packets.push(packet);
			}
		});
		input.on("end", () => {
			this.ended = true;
			for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("packet stream ended"));
		});
	}

	next(): Promise<Buffer> {
		const packet = this.packets.shift();
		if (packet) return Promise.resolve(packet);
		if (this.ended) return Promise.reject(new Error("packet stream ended"));
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}
}

interface MockSftp {
	client: SftpClient;
	fromServer: PassThrough;
	toServer: PassThrough;
	packets: PacketQueue;
}

async function createMockSftp(): Promise<MockSftp> {
	const fromServer = new PassThrough();
	const toServer = new PassThrough();
	const packets = new PacketQueue(toServer);
	const client = new SftpClient(fromServer, toServer);
	const initializing = client.initialize();
	const init = new Cursor(await packets.next());
	assert.equal(init.u8(), 1);
	assert.equal(init.u32(), 3);
	fromServer.write(versionFrame());
	await initializing;
	return { client, fromServer, toServer, packets };
}

function requestId(packet: Buffer, expectedType: number): number {
	const cursor = new Cursor(packet);
	assert.equal(cursor.u8(), expectedType);
	return cursor.u32();
}

test("frames fragmented packets and matches coalesced concurrent responses", async () => {
	const fromServer = new PassThrough();
	const toServer = new PassThrough();
	const packets = new PacketQueue(toServer);
	const client = new SftpClient(fromServer, toServer);
	try {
		const initializing = client.initialize();
		const init = new Cursor(await packets.next());
		assert.equal(init.u8(), 1);
		assert.equal(init.u32(), 3);
		const version = versionFrame();
		fromServer.write(version.subarray(0, 2));
		fromServer.write(version.subarray(2, 7));
		fromServer.write(version.subarray(7));
		await initializing;

		const first = client.stat("/first");
		const second = client.stat("/second");
		const firstId = requestId(await packets.next(), 17);
		const secondId = requestId(await packets.next(), 17);
		assert.notEqual(firstId, secondId);
		fromServer.write(Buffer.concat([attrsFrame(secondId, 0o040755), attrsFrame(firstId)]));

		assert.equal((await first).permissions, 0o100644);
		assert.equal((await second).permissions, 0o040755);
	} finally {
		client.close();
	}
});

test("maps numeric STATUS codes to typed errors", async () => {
	const { client, fromServer, packets } = await createMockSftp();
	try {
		const missing = client.stat("/missing");
		const denied = client.stat("/denied");
		const failed = client.stat("/failed");
		const disconnected = client.stat("/disconnected");
		const missingId = requestId(await packets.next(), 17);
		const deniedId = requestId(await packets.next(), 17);
		const failedId = requestId(await packets.next(), 17);
		const disconnectedId = requestId(await packets.next(), 17);
		fromServer.write(
			Buffer.concat([
				statusFrame(missingId, 2, "missing"),
				statusFrame(deniedId, 3, "denied"),
				statusFrame(failedId, 4, "failure"),
				statusFrame(disconnectedId, 6, "no connection"),
			]),
		);

		await Promise.all([
			assert.rejects(missing, (error) => error instanceof RemoteFileNotFoundError && error.statusCode === 2),
			assert.rejects(denied, (error) => error instanceof RemoteFilePermissionError && error.statusCode === 3),
			assert.rejects(
				failed,
				(error) =>
					error instanceof RemoteFileOperationError &&
					!(error instanceof RemoteFileNotFoundError) &&
					error.statusCode === 4,
			),
			assert.rejects(disconnected, SshTransportError),
		]);
	} finally {
		client.close();
	}
});

test("uses bounded WRITE and READ chunks", async () => {
	const { client, fromServer, packets } = await createMockSftp();
	try {
		const content = Buffer.alloc(100_000, 0x5a);
		const writing = client.writeFile("/large", content);
		const openWriteId = requestId(await packets.next(), 3);
		fromServer.write(handleFrame(openWriteId));

		let written = 0;
		while (written < content.length) {
			const cursor = new Cursor(await packets.next());
			assert.equal(cursor.u8(), 6);
			const id = cursor.u32();
			assert.equal(cursor.bytes().toString(), "handle");
			assert.equal(cursor.u64(), BigInt(written));
			const chunk = cursor.bytes();
			assert.ok(chunk.length > 0 && chunk.length <= 32 * 1024);
			assert.deepEqual(chunk, content.subarray(written, written + chunk.length));
			written += chunk.length;
			fromServer.write(statusFrame(id, 0));
		}
		const closeWriteId = requestId(await packets.next(), 4);
		fromServer.write(statusFrame(closeWriteId, 0));
		await writing;

		const source = Buffer.alloc(70_000, 0xa5);
		const reading = client.readFile("/large");
		const openReadId = requestId(await packets.next(), 3);
		fromServer.write(handleFrame(openReadId));
		let readOffset = 0;
		while (readOffset < source.length) {
			const cursor = new Cursor(await packets.next());
			assert.equal(cursor.u8(), 5);
			const id = cursor.u32();
			assert.equal(cursor.bytes().toString(), "handle");
			assert.equal(cursor.u64(), BigInt(readOffset));
			const requested = cursor.u32();
			assert.ok(requested > 0 && requested <= 32 * 1024);
			const chunk = source.subarray(readOffset, readOffset + requested);
			readOffset += chunk.length;
			fromServer.write(dataFrame(id, chunk));
		}
		const eofId = requestId(await packets.next(), 5);
		fromServer.write(statusFrame(eofId, 1, "EOF"));
		const closeReadId = requestId(await packets.next(), 4);
		fromServer.write(statusFrame(closeReadId, 0));
		assert.deepEqual(await reading, source);
	} finally {
		client.close();
	}
});

test("closes a handle when an operation fails", async () => {
	const { client, fromServer, packets } = await createMockSftp();
	try {
		const reading = client.readFile("/denied");
		const openId = requestId(await packets.next(), 3);
		fromServer.write(handleFrame(openId));
		const readId = requestId(await packets.next(), 5);
		fromServer.write(statusFrame(readId, 3, "denied"));
		const closeId = requestId(await packets.next(), 4);
		fromServer.write(statusFrame(closeId, 0));
		await assert.rejects(reading, RemoteFilePermissionError);
	} finally {
		client.close();
	}
});

test("rejects malformed lengths, duplicate or unknown IDs, unknown types, and transport loss", async (context) => {
	await context.test("oversized packet", async () => {
		const { client, fromServer, packets } = await createMockSftp();
		try {
			const pending = client.stat("/pending");
			await packets.next();
			fromServer.write(u32(0xffffffff));
			await assert.rejects(pending, SftpProtocolError);
		} finally {
			client.close();
		}
	});

	await context.test("unknown request ID", async () => {
		const { client, fromServer, packets } = await createMockSftp();
		try {
			const pending = client.stat("/pending");
			const id = requestId(await packets.next(), 17);
			fromServer.write(attrsFrame(id + 1));
			await assert.rejects(pending, SftpProtocolError);
		} finally {
			client.close();
		}
	});

	await context.test("duplicate request ID", async () => {
		const { client, fromServer, packets } = await createMockSftp();
		try {
			const first = client.stat("/first");
			const second = client.stat("/second");
			const firstId = requestId(await packets.next(), 17);
			await packets.next();
			fromServer.write(Buffer.concat([attrsFrame(firstId), attrsFrame(firstId)]));
			await first;
			await assert.rejects(second, SftpProtocolError);
		} finally {
			client.close();
		}
	});

	await context.test("unknown response type", async () => {
		const { client, fromServer, packets } = await createMockSftp();
		try {
			const pending = client.stat("/pending");
			const id = requestId(await packets.next(), 17);
			fromServer.write(frame(u8(250), u32(id)));
			await assert.rejects(pending, SftpProtocolError);
		} finally {
			client.close();
		}
	});

	await context.test("unexpected EOF", async () => {
		const { client, fromServer, packets } = await createMockSftp();
		try {
			const pending = client.stat("/pending");
			await packets.next();
			fromServer.end();
			await assert.rejects(pending, SshTransportError);
		} finally {
			client.close();
		}
	});
});

test("close is idempotent and rejects pending requests", async () => {
	const { client, toServer, packets } = await createMockSftp();
	const pending = client.stat("/pending");
	await packets.next();
	let finishCount = 0;
	toServer.on("finish", () => finishCount++);
	const finished = once(toServer, "finish");
	client.close();
	client.close();
	await assert.rejects(pending, SshTransportError);
	await finished;
	assert.equal(finishCount, 1);
});

test("rejects NUL-containing paths", async () => {
	const { client } = await createMockSftp();
	try {
		await assert.rejects(client.stat("bad\0path"), SftpProtocolError);
	} finally {
		client.close();
	}
});

test("works against OpenSSH sftp-server over stdio", { skip: !existsSync(SFTP_SERVER), timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-sftp-test-"));
	const child = spawn(SFTP_SERVER, [], {
		cwd: directory,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stderr: Buffer[] = [];
	child.stderr.on("data", (data) => stderr.push(data));
	const client = new SftpClient(child.stdout, child.stdin);
	try {
		await client.initialize();
		assert.equal(await client.realpath("."), directory);

		const subdirectory = join(directory, "sub dir");
		await client.mkdir(subdirectory);
		const path = join(subdirectory, "binary file\nname");
		const content = Buffer.allocUnsafe(100_000);
		for (let index = 0; index < content.length; index++) content[index] = index % 251;
		await client.writeFile(path, content);
		assert.deepEqual(await readFile(path), content);
		assert.deepEqual(await client.readFile(path), content);
		assert.deepEqual(await client.readFile(path, 19), content.subarray(0, 19));
		assert.equal(await client.exists(path), true);
		assert.equal(await client.exists(join(directory, "missing")), false);
		assert.equal((await client.stat(path)).size, BigInt(content.length));
		await client.access(path, "read");
		await client.access(path, "read-write");
		assert.deepEqual(await client.readdir(subdirectory), ["binary file\nname"]);

		const invalidName = Buffer.concat([Buffer.from(`${directory}/`), Buffer.from([0xff])]);
		await writeFile(invalidName, "invalid UTF-8 name");
		await assert.rejects(client.readdir(directory), SftpProtocolError);
	} finally {
		const closed = child.exitCode === null ? once(child, "close") : Promise.resolve();
		client.close();
		await closed;
		await rm(directory, { recursive: true, force: true });
	}
	assert.equal(child.exitCode, 0, Buffer.concat(stderr).toString("utf8"));
});
