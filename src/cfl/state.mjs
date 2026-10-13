import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function openState(directory, { readOnly = false } = {}) {
  if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    !existsSync(join(directory, "adapter.sqlite")) &&
    existsSync(join(directory, "state.json"))
  )
    throw new Error("Legacy Host directory cannot be used as adapter state");
  const existing = existsSync(join(directory, "adapter.sqlite"));
  const db = new DatabaseSync(join(directory, "adapter.sqlite"), { readOnly });
  if (!readOnly)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, device TEXT NOT NULL, request TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT, UNIQUE(device,request));`);
  const get = (id) => {
    const row = db.prepare("SELECT value FROM facts WHERE id=?").get(id);
    return row ? JSON.parse(row.value) : null;
  };
  const put = (id, value) =>
    db
      .prepare("INSERT OR REPLACE INTO facts VALUES (?,?)")
      .run(id, JSON.stringify(value));
  if (existing && (!get("identity") || !get("devices"))) {
    db.close();
    throw new Error("Invalid existing adapter state");
  }
  if (!get("identity"))
    put("identity", {
      serverId: `host_${randomUUID()}`,
      collaboratorId: `cfl_${randomUUID()}`,
      conversationId: `conv_${randomUUID()}`,
      createdAt: Date.now(),
    });
  if (!get("devices")) put("devices", []);
  const identity = get("identity");
  if (
    !identity?.serverId ||
    !identity.collaboratorId ||
    !identity.conversationId ||
    !Array.isArray(get("devices"))
  )
    throw new Error("Invalid adapter state");
  return {
    identity,
    get,
    put,
    transaction(action) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    operation(device, request) {
      return db
        .prepare("SELECT * FROM operations WHERE device=? AND request=?")
        .get(device, request);
    },
    admit(device, request, fingerprint) {
      const id = randomUUID();
      db.prepare("INSERT INTO operations VALUES (?,?,?,?,NULL)").run(
        id,
        device,
        request,
        fingerprint,
      );
      return { id, device, request, fingerprint, receipt: null };
    },
    receipt(id, receipt) {
      db.prepare("UPDATE operations SET receipt=? WHERE id=?").run(
        JSON.stringify(receipt),
        id,
      );
    },
    close() {
      db.close();
    },
  };
}
export function issuePairing(state, now = Date.now()) {
  const pairing = {
    token: randomBytes(32).toString("base64url"),
    issuedAt: now,
    consumedAt: null,
  };
  state.put("pairing", pairing);
  return pairing;
}
export function pair(state, body, now = Date.now()) {
  return state.transaction(() => {
    const pairing = state.get("pairing");
    if (
      !pairing ||
      pairing.consumedAt !== null ||
      now - pairing.issuedAt >= 600000 ||
      !equal(body.pairingToken, pairing.token)
    )
      throw new HttpError(
        401,
        "pairing.rejected",
        "Pairing token rejected or expired",
      );
    if (body.deviceRole)
      throw new HttpError(
        400,
        "pairing.device_role_unsupported",
        "Only phone pairing is supported",
      );
    const credentialSecret = randomBytes(32).toString("base64url");
    const device = {
      deviceId: `dev_${randomUUID()}`,
      label: String(body.deviceLabel ?? "phone").slice(0, 200),
      credentialSHA256: digest(credentialSecret),
      issuedAt: now,
      revokedAt: null,
    };
    const devices = state.get("devices");
    devices.push(device);
    state.put("devices", devices);
    pairing.consumedAt = now;
    state.put("pairing", pairing);
    return {
      schema: "aru.selfhost.pairing-grant.v1",
      serverId: state.identity.serverId,
      deviceId: device.deviceId,
      credentialSecret,
      credentialScope: "device",
      issuedAt: now,
      expiresAt: null,
      rotationPolicy: "manual",
      nextRotationAt: null,
      bootstrapTokenConsumedAt: now,
    };
  });
}
export function authenticate(state, request) {
  const token = /^Bearer\s+(.+)$/i.exec(
    request.headers.authorization ?? "",
  )?.[1];
  const device =
    token &&
    state
      .get("devices")
      .find((item) => equal(item.credentialSHA256, digest(token)));
  if (!device)
    throw new HttpError(
      401,
      "credential.unknown",
      "Device credential required",
    );
  if (device.revokedAt !== null)
    throw new HttpError(403, "credential.revoked", "Device revoked");
  return device;
}
