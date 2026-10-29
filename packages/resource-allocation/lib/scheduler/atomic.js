/**
 * Atomic durable file writes shared by every resource-allocation fact
 * source (queue.json, policy.json).
 *
 * The incident lesson (unflushed writes die with a hard power-off) applies
 * to scheduler fact sources exactly as it does to hardware-guard's incident log:
 * temp file + fsync + rename, and the result is verified after the write.
 *
 * @module resource-allocation/atomic
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Read a file if present, returning null on any failure. */
export function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Atomic durable write: write to a unique temp file in the same directory,
 * fsync, close, rename over the target, then verify the target content.
 * No partial state is ever observable by another reader: a reader sees the
 * old document or the complete new one.
 */
export function writeFileDurable(path, text) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	let fd = -1;
	try {
		fd = openSync(tmp, "w");
		writeFileSync(fd, text, { encoding: "utf8" });
		try {
			fsyncSync(fd);
		} catch {
			/* best effort */
		}
	} finally {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				/* best effort */
			}
		}
	}
	renameSync(tmp, path);
	const verify = tryRead(path);
	if (verify !== text) {
		throw new Error(`durable write verification failed for ${path}: content mismatch after rename`);
	}
}
