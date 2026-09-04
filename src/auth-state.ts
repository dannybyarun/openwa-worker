import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';

/**
 * Baileys `AuthenticationState` backed by Durable Object storage, so a session survives DO
 * evictions and reconnects from the last persisted credentials.
 *
 * Storage layout (all keys under `auth:`):
 *   auth:creds              -> encoded AuthenticationCreds
 *   auth:key:<type>:<id>    -> encoded signal key value (pre-key, session, sender-key, ...)
 *
 * Values are encoded with baileys' own BufferJSON replacer/reviver (Buffers become base64), then
 * stored as JSON strings. Durable Object storage caps a value at 128 KiB, and an active WhatsApp
 * account's signal state (app-state-sync-key, sessions) regularly exceeds that, so values are
 * chunked into <= 60 KiB pieces. A small meta object holds either the single value (`{ v }`) or
 * the chunk count (`{ c }`).
 */

const PREFIX = 'auth:';
const CHUNK_SIZE = 60_000; // well under the 128 KiB per-value storage limit

interface Meta {
  v?: string;
  c?: number;
}

export class DurableObjectAuthState {
  private state?: AuthenticationState;
  private loaded = false;
  /** Serializes transaction() calls (baileys pre-key generation does read-modify-write). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage) {}

  /** Load (once) and return the auth state. Call before handing it to makeWASocket. */
  async get(): Promise<AuthenticationState> {
    if (!this.loaded) {
      this.loaded = true;
      const creds =
        ((await this.readValue('creds')) as AuthenticationCreds | undefined) ?? initAuthCreds();
      const keys = {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            const value = await this.readValue(`key:${type}:${id}`);
            if (value !== undefined) out[id] = value;
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          for (const [type, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values)) {
              await this.writeValue(`key:${type}:${id}`, value);
            }
          }
        },
        transaction: <T>(fn: () => Promise<T>) => this.runExclusive(fn),
      } as unknown as SignalKeyStore;
      this.state = { creds, keys };
    }
    return this.state!;
  }

  /** Persist the creds blob (called on baileys' `creds.update`). Signal keys persist as they write. */
  async persist(): Promise<void> {
    if (!this.state) return;
    await this.writeValue('creds', this.state.creds);
  }

  /** Wipe every auth:* key (logout / session deletion). */
  async clear(): Promise<void> {
    const keys = await this.storage.list({ prefix: PREFIX });
    if (keys.size > 0) {
      await this.storage.delete([...keys.keys()]);
    }
    this.loaded = false;
    this.state = undefined;
  }

  private encode(value: unknown): string {
    return JSON.stringify(value, BufferJSON.replacer);
  }

  private decode(text: string): unknown {
    return JSON.parse(text, BufferJSON.reviver);
  }

  private async readValue(key: string): Promise<unknown | undefined> {
    const meta = await this.storage.get<Meta>(`${PREFIX}${key}`);
    if (!meta) return undefined;
    if (meta.v !== undefined) return this.decode(meta.v);
    const count = meta.c ?? 0;
    const chunkKeys = Array.from({ length: count }, (_, i) => `${PREFIX}${key}:${i}`);
    const chunks = await this.storage.get<string[]>(chunkKeys);
    const parts: string[] = [];
    for (const chunkKey of chunkKeys) {
      const chunk = chunks.get(chunkKey);
      if (typeof chunk === 'string') parts.push(chunk);
    }
    return this.decode(parts.join(''));
  }

  private async writeValue(key: string, value: unknown): Promise<void> {
    const text = this.encode(value);
    if (new TextEncoder().encode(text).byteLength <= CHUNK_SIZE) {
      await this.storage.put(`${PREFIX}${key}`, { v: text } satisfies Meta);
      return;
    }
    const entries: Record<string, unknown> = {};
    let count = 0;
    for (let offset = 0; offset < text.length; offset += CHUNK_SIZE, count++) {
      entries[`${PREFIX}${key}:${count}`] = text.slice(offset, offset + CHUNK_SIZE);
    }
    entries[`${PREFIX}${key}`] = { c: count } satisfies Meta;
    await this.storage.put(entries);
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}