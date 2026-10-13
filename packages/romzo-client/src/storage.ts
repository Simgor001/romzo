import { randomHex } from './canonical.js';
import { exportPrivateKey, generateKeyPair, importKeyPair, sign, verify, type Identity } from './crypto.js';
import { discover, fetchDescriptor, normalizeOrigin, requestAdmission, RelayHttpError } from './http.js';
import { restoreSession, verifyDescriptor } from './facade.js';
import type { SignedDescriptor, SignedTicket } from './types.js';
export const DEFAULT_IDENTITY_TTL_MS = 1800000;
export interface IdentityStoreOptions {
    namespace: string;
    identityTtlMs?: number;
}
export interface RoomIdentity {
    namespace: string;
    origin: string;
    code: string;
    instance: string;
    identityId: string;
    transport: Identity;
    host?: Identity;
    signedDescriptor: SignedDescriptor;
    recovery?: SignedTicket;
    expiresAt: number;
}
export interface RoomIdentityScope {
    origin: string;
    code: string;
    instance: string;
}
interface StoredIdentity extends Omit<RoomIdentity, 'transport' | 'host'> {
    transport: {
        publicKey: string;
        privateKey: string;
    };
    host?: {
        publicKey: string;
        privateKey: string;
    };
}
interface LifecycleSession {
    on(event: 'close' | 'reconnecting', handler: () => void): () => void;
    close(): void;
}
export interface PersistentRoom<T> {
    session: T;
    identity: RoomIdentity;
    leave(): Promise<void>;
    flush(): Promise<void>;
}
export interface PersistentSessionOptions {
    onRecovery: (ticket: SignedTicket) => Promise<void>;
    keepaliveIntervalMs: number;
}
export type IdentityConnector<T> = (admission: SignedTicket, transport: Identity, signed: SignedDescriptor, options: PersistentSessionOptions) => Promise<T>;
/** Reuse a tab's identity, or probe the latest identity before allocating a new one. */
export async function connectPersistentRoom<T extends LifecycleSession>(store: IdentityStore, origin: string, code: string, connect: IdentityConnector<T>, options: {
    newIdentity?: boolean;
} = {}): Promise<PersistentRoom<T>> {
    origin = normalizeOrigin(origin);
    const discovery = await discover(origin);
    if (!discovery.persistentIdentity)
        throw new RelayHttpError('persistent_identity_unavailable', 400);
    const tabKey = JSON.stringify(['romzo-identity', store.namespace, origin, code]);
    const tab = options.newIdentity ? null : sessionStorage.getItem(tabKey);
    let signed: SignedDescriptor;
    try {
        signed = await fetchDescriptor(origin, code);
    }
    catch (error) {
        if (!(error instanceof RelayHttpError) || error.code !== 'room_not_found')
            throw error;
        const saved = await store.list({ origin, code });
        const selected = await Promise.all([...new Map(saved.map(r => [r.instance, r])).values()].map(r => store.latest(r)));
        const candidates = selected.filter((r): r is RoomIdentity => !!r);
        const candidate = tab ? saved.find(r => r.identityId === tab) : candidates.length === 1 ? candidates[0] : undefined;
        if (!candidate?.recovery)
            throw error;
        signed = candidate.signedDescriptor;
    }
    await verifyDescriptor(signed, origin, code);
    const policy = (signed.descriptor.options as {
        identityPolicy?: {
            exclusive?: boolean;
            ttlMs?: number;
        };
    })?.identityPolicy;
    if (policy?.exclusive !== true || !Number.isSafeInteger(policy.ttlMs) || policy.ttlMs! <= 0 || policy.ttlMs! > 9223372036854)
        throw new RelayHttpError('identity_policy_mismatch', 400);
    const scope = { origin, code, instance: signed.descriptor.instance };
    let identity = options.newIdentity ? null : tab ? await store.get(scope, tab) : await store.latest(scope);
    const fromTab = !!identity && !!tab;
    const deadline = Date.now() + 10000;
    let allocations = 0;
    while (true) {
        if (!identity) {
            if (++allocations > 3)
                throw new RelayHttpError('identity_in_use', 409);
            identity = await store.save({ ...scope, transport: await generateKeyPair(), signedDescriptor: signed });
        }
        // Remember the attempted identity even if the network fails; only select() marks success.
        sessionStorage.setItem(tabKey, identity.identityId);
        const tracker = store.track(identity);
        try {
            const admission = identity.recovery ? (await restoreSession(signed, identity.recovery, identity.transport)).admission : (await requestAdmission(origin, code, identity.transport.publicKey)).admission;
            const session = await connect(admission, identity.transport, signed, { onRecovery: tracker.onRecovery, keepaliveIntervalMs: Math.min(10000, Math.max(1, Math.floor(policy.ttlMs! / 3))) });
            tracker.bind(session);
            try {
                await store.select(identity);
                sessionStorage.setItem(tabKey, identity.identityId);
            }
            catch (error) {
                session.close();
                throw error;
            }
            return { session, identity, flush: tracker.flush, leave: async () => { await tracker.remove(); sessionStorage.removeItem(tabKey); session.close(); } };
        }
        catch (error) {
            if ((error as {
                code?: string;
            })?.code !== 'identity_in_use')
                throw error;
            if (!fromTab) {
                identity = null;
                continue;
            }
            if (Date.now() >= deadline)
                throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
function request<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function completion(tx: IDBTransaction): Promise<void> {
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('identity_storage_aborted')); tx.onerror = () => { }; });
    void done.catch(() => { });
    return done;
}
function scopeKey(namespace: string, scope: RoomIdentityScope): string[] {
    return [namespace, normalizeOrigin(scope.origin), scope.code, scope.instance];
}
function rowKey(r: Pick<RoomIdentity, 'namespace' | 'origin' | 'code' | 'instance' | 'identityId'>): string[] {
    return [...scopeKey(r.namespace, r), r.identityId];
}
async function decodeIdentity(key: {
    publicKey: string;
    privateKey: string;
}): Promise<Identity> {
    const identity = await importKeyPair(key.publicKey, key.privateKey);
    const probe = { challenge: randomHex(16) };
    if (!await verify(key.publicKey, probe, 'romzo/storage-key/v1', await sign(identity, probe, 'romzo/storage-key/v1')))
        throw Error('identity_key_mismatch');
    return identity;
}
/** Local identity persistence. Call close() when the application no longer uses it. */
export class IdentityStore {
    private readonly db: IDBDatabase;
    constructor(db: unknown, readonly namespace: string, readonly identityTtlMs: number) { this.db = db as IDBDatabase; }
    close(): void { this.db.close(); }
    async cleanup(): Promise<void> {
        const tx = this.db.transaction(['identities', 'selections'], 'readwrite');
        const done = completion(tx);
        const identities = tx.objectStore('identities'), selections = tx.objectStore('selections');
        const rows = await request(identities.getAll()) as StoredIdentity[];
        const live = new Set<string>();
        for (const row of rows) {
            if (!Number.isSafeInteger(row.expiresAt)) {
                tx.abort();
                await done;
                throw Error('identity_storage_corrupt');
            }
            if (row.expiresAt <= Date.now())
                identities.delete(rowKey(row));
            else
                live.add(JSON.stringify(rowKey(row)));
        }
        for (const selection of await request(selections.getAll()) as Array<RoomIdentityScope & {
            namespace: string;
            identityId: string;
        }>) {
            if (!live.has(JSON.stringify(rowKey(selection))))
                selections.delete(scopeKey(selection.namespace, selection));
        }
        await done;
    }
    private async unpack(row: StoredIdentity): Promise<RoomIdentity> {
        await verifyDescriptor(row.signedDescriptor, row.origin, row.code);
        if (row.signedDescriptor.descriptor.instance !== row.instance)
            throw Error('identity_room_mismatch');
        const transport = await decodeIdentity(row.transport);
        const host = row.host ? await decodeIdentity(row.host) : undefined;
        if (host && host.publicKey !== row.signedDescriptor.descriptor.host)
            throw Error('identity_host_mismatch');
        if (row.recovery && (row.recovery.ticket.key !== transport.publicKey || row.recovery.ticket.instance !== row.instance || row.recovery.ticket.origin !== row.origin || row.recovery.ticket.code !== row.code))
            throw Error('identity_recovery_mismatch');
        return { ...row, transport, ...(host ? { host } : {}) } as RoomIdentity;
    }
    async list(scope?: Partial<RoomIdentityScope>): Promise<RoomIdentity[]> {
        await this.cleanup();
        const tx = this.db.transaction('identities', 'readonly');
        const done = completion(tx);
        const rows = await request(tx.objectStore('identities').getAll()) as StoredIdentity[];
        await done;
        return Promise.all(rows.filter(r => r.namespace === this.namespace && (!scope?.origin || r.origin === normalizeOrigin(scope.origin)) && (!scope?.code || r.code === scope.code) && (!scope?.instance || r.instance === scope.instance)).map(r => this.unpack(r)));
    }
    async get(scope: RoomIdentityScope, identityId: string): Promise<RoomIdentity | null> {
        await this.cleanup();
        const tx = this.db.transaction('identities', 'readonly');
        const done = completion(tx);
        const row = await request(tx.objectStore('identities').get([...scopeKey(this.namespace, scope), identityId])) as StoredIdentity | undefined;
        await done;
        return row ? this.unpack(row) : null;
    }
    async latest(scope: RoomIdentityScope): Promise<RoomIdentity | null> {
        await this.cleanup();
        const tx = this.db.transaction('selections', 'readonly');
        const done = completion(tx);
        const selection = await request(tx.objectStore('selections').get(scopeKey(this.namespace, scope)));
        await done;
        return selection ? this.get(scope, selection.identityId) : null;
    }
    async save(input: Omit<RoomIdentity, 'namespace' | 'identityId' | 'expiresAt'> & Partial<Pick<RoomIdentity, 'identityId' | 'expiresAt'>>): Promise<RoomIdentity> {
        await this.cleanup();
        const ttl = (input.signedDescriptor.descriptor.options as {
            identityPolicy?: {
                ttlMs: number;
            };
        })?.identityPolicy?.ttlMs ?? this.identityTtlMs;
        const row: RoomIdentity = { ...input, origin: normalizeOrigin(input.origin), namespace: this.namespace, identityId: input.identityId ?? randomHex(16), expiresAt: input.expiresAt ?? Date.now() + ttl };
        if (!Number.isSafeInteger(row.expiresAt))
            throw Error('invalid_identity_expiry');
        const stored: StoredIdentity = { ...row, transport: { publicKey: row.transport.publicKey, privateKey: await exportPrivateKey(row.transport.privateKey) }, host: row.host ? { publicKey: row.host.publicKey, privateKey: await exportPrivateKey(row.host.privateKey) } : undefined };
        await this.unpack(stored);
        const tx = this.db.transaction('identities', 'readwrite');
        const done = completion(tx);
        tx.objectStore('identities').put(stored);
        await done;
        return row;
    }
    async select(row: RoomIdentity): Promise<void> {
        if (row.namespace !== this.namespace)
            throw Error('identity_namespace_mismatch');
        const tx = this.db.transaction(['identities', 'selections'], 'readwrite');
        const done = completion(tx);
        if (await request(tx.objectStore('identities').get(rowKey(row))))
            tx.objectStore('selections').put({ namespace: this.namespace, origin: row.origin, code: row.code, instance: row.instance, identityId: row.identityId });
        else {
            tx.abort();
            await done;
            throw Error('identity_missing');
        }
        await done;
    }
    async remove(row: RoomIdentity): Promise<void> {
        if (row.namespace !== this.namespace)
            throw Error('identity_namespace_mismatch');
        const tx = this.db.transaction(['identities', 'selections'], 'readwrite');
        const done = completion(tx);
        tx.objectStore('identities').delete(rowKey(row));
        const selected = await request(tx.objectStore('selections').get(scopeKey(this.namespace, row)));
        if (selected?.identityId === row.identityId)
            tx.objectStore('selections').delete(scopeKey(this.namespace, row));
        await done;
    }
    /** Create before connecting; pass onRecovery to SessionOptions, then bind the session. */
    track(row: RoomIdentity): {
        onRecovery: (ticket: SignedTicket) => Promise<void>;
        bind: (session: LifecycleSession) => () => void;
        remove: () => Promise<void>;
        flush: () => Promise<void>;
    } {
        if (row.namespace !== this.namespace)
            throw Error('identity_namespace_mismatch');
        const ttl = (row.signedDescriptor.descriptor.options as {
            identityPolicy?: {
                ttlMs: number;
            };
        })?.identityPolicy?.ttlMs ?? this.identityTtlMs;
        let stopped = false;
        let tail: Promise<void> = Promise.resolve();
        let unlisten: Array<() => void> = [];
        const update = (ticket?: SignedTicket): Promise<void> => {
            const task = tail.then(async () => {
                if (stopped)
                    return;
                if (ticket && (ticket.ticket.key !== row.transport.publicKey || ticket.ticket.instance !== row.instance || ticket.ticket.code !== row.code || ticket.ticket.origin !== row.origin || ticket.ticket.purpose !== 'recovery'))
                    throw Error('identity_recovery_mismatch');
                const tx = this.db.transaction('identities', 'readwrite');
                const done = completion(tx);
                const store = tx.objectStore('identities');
                const stored = await request(store.get(rowKey(row))) as StoredIdentity | undefined;
                if (stored && !stopped) {
                    stored.expiresAt = Date.now() + ttl;
                    if (ticket)
                        stored.recovery = ticket;
                    store.put(stored);
                }
                await done;
                if (stored && !stopped) {
                    row.expiresAt = stored.expiresAt;
                    if (ticket)
                        row.recovery = ticket;
                }
            });
            tail = task;
            return task;
        };
        return { onRecovery: ticket => update(ticket), bind: session => {
                unlisten = [session.on('reconnecting', () => { void update().catch(() => { }); }), session.on('close', () => { void update().catch(() => { }); })];
                return () => {
                    for (const off of unlisten)
                        off();
                    unlisten = [];
                };
            }, remove: async () => {
                stopped = true;
                for (const off of unlisten)
                    off();
                await tail.catch(() => { });
                await this.remove(row);
            }, flush: () => tail };
    }
}
export async function openIdentityStore(options: IdentityStoreOptions): Promise<IdentityStore> {
    const ttl = options.identityTtlMs ?? DEFAULT_IDENTITY_TTL_MS;
    if (!options.namespace || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 9223372036854)
        throw new RangeError('invalid identity store options');
    if (!globalThis.indexedDB)
        throw Error('identity_storage_unavailable');
    const open = indexedDB.open('romzo-identities', 1);
    open.onupgradeneeded = () => { const db = open.result; db.createObjectStore('identities', { keyPath: ['namespace', 'origin', 'code', 'instance', 'identityId'] }); db.createObjectStore('selections', { keyPath: ['namespace', 'origin', 'code', 'instance'] }); };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        let abandoned = false;
        open.onsuccess = () => {
            if (abandoned)
                open.result.close();
            else
                resolve(open.result);
        };
        open.onerror = () => reject(open.error);
        open.onblocked = () => { abandoned = true; reject(Error('identity_storage_blocked')); };
    });
    db.onversionchange = () => db.close();
    const store = new IdentityStore(db, options.namespace, ttl);
    try {
        await store.cleanup();
        return store;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
