import type { DocumentKind } from "@needy/shared";
import type { DbPool } from "../db.js";

/** One stored KYC artefact. Note what is absent: no URL, and no filename from the client.
 *  A URL in a row outlives the signature that was meant to time-limit it and tends to end up
 *  in logs; a client-supplied filename is untrusted text that would be rendered in the admin
 *  queue. Only an opaque server-generated key is kept. */
export interface KycDocument {
  id: string;
  userId: string;
  kind: DocumentKind;
  storageKey: string;
  /** The SNIFFED type, not the declared one. See services/fileType.ts. */
  contentType: string;
  sizeBytes: number;
  /** Content digest. Lets a reviewer see that two accounts submitted the identical file —
   *  which is one of the clearer signals of a duplicate or fraudulent registration. */
  sha256: string;
  createdAt: number;
}

export interface KycDocumentRepository {
  listForUser(userId: string): Promise<KycDocument[]>;
  get(userId: string, kind: DocumentKind): Promise<KycDocument | null>;
  getById(id: string): Promise<KycDocument | null>;
  /** Upsert on (userId, kind): re-uploading replaces, so a user retaking a blurry selfie
   *  does not leave a reviewer choosing between versions. Returns the key that was displaced,
   *  if any, so the caller can delete the orphaned object from storage. */
  put(doc: KycDocument): Promise<{ replacedStorageKey: string | null }>;
  /** Same digest, different user — a duplicate-identity signal for the review queue. */
  findOtherUsersWithDigest(sha256: string, exceptUserId: string): Promise<string[]>;
}

export function createInMemoryKycDocumentRepo(): KycDocumentRepository {
  const byUser = new Map<string, Map<DocumentKind, KycDocument>>();
  return {
    async listForUser(userId) {
      return [...(byUser.get(userId)?.values() ?? [])];
    },
    async get(userId, kind) {
      return byUser.get(userId)?.get(kind) ?? null;
    },
    async getById(id) {
      for (const kinds of byUser.values()) {
        for (const d of kinds.values()) if (d.id === id) return d;
      }
      return null;
    },
    async put(doc) {
      let kinds = byUser.get(doc.userId);
      if (!kinds) {
        kinds = new Map();
        byUser.set(doc.userId, kinds);
      }
      const replaced = kinds.get(doc.kind);
      kinds.set(doc.kind, doc);
      return { replacedStorageKey: replaced?.storageKey ?? null };
    },
    async findOtherUsersWithDigest(sha256, exceptUserId) {
      const hits = new Set<string>();
      for (const [userId, kinds] of byUser) {
        if (userId === exceptUserId) continue;
        for (const d of kinds.values()) if (d.sha256 === sha256) hits.add(userId);
      }
      return [...hits];
    },
  };
}

interface DocRow {
  id: string;
  user_id: string;
  kind: string;
  storage_key: string;
  content_type: string;
  size_bytes: number | string;
  sha256: string;
  created_at: number | string;
}

const rowToDoc = (r: DocRow): KycDocument => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind as DocumentKind,
  storageKey: r.storage_key,
  contentType: r.content_type,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  createdAt: Number(r.created_at),
});

export function createPgKycDocumentRepo(pool: DbPool): KycDocumentRepository {
  return {
    async listForUser(userId) {
      const { rows } = await pool.query<DocRow>(
        `SELECT * FROM kyc_documents WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      return rows.map(rowToDoc);
    },
    async get(userId, kind) {
      const { rows } = await pool.query<DocRow>(
        `SELECT * FROM kyc_documents WHERE user_id = $1 AND kind = $2`,
        [userId, kind],
      );
      return rows[0] ? rowToDoc(rows[0]) : null;
    },
    async getById(id) {
      const { rows } = await pool.query<DocRow>(`SELECT * FROM kyc_documents WHERE id = $1`, [id]);
      return rows[0] ? rowToDoc(rows[0]) : null;
    },
    async put(doc) {
      // RETURNING the pre-update key in one statement, rather than SELECT-then-UPSERT: the
      // two-step version races a concurrent re-upload and can leak the object it failed to
      // notice was displaced.
      const { rows } = await pool.query<{ replaced: string | null }>(
        `INSERT INTO kyc_documents (id, user_id, kind, storage_key, content_type, size_bytes, sha256, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, kind) DO UPDATE
           SET id = EXCLUDED.id,
               storage_key = EXCLUDED.storage_key,
               content_type = EXCLUDED.content_type,
               size_bytes = EXCLUDED.size_bytes,
               sha256 = EXCLUDED.sha256,
               created_at = EXCLUDED.created_at
         RETURNING (SELECT storage_key FROM kyc_documents k
                     WHERE k.user_id = $2 AND k.kind = $3) AS replaced`,
        [
          doc.id,
          doc.userId,
          doc.kind,
          doc.storageKey,
          doc.contentType,
          doc.sizeBytes,
          doc.sha256,
          doc.createdAt,
        ],
      );
      const replaced = rows[0]?.replaced ?? null;
      // The subselect sees the post-update row when it fires on the UPDATE branch, so filter
      // out the case where "replaced" is just the key we have only now written.
      return { replacedStorageKey: replaced && replaced !== doc.storageKey ? replaced : null };
    },
    async findOtherUsersWithDigest(sha256, exceptUserId) {
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM kyc_documents WHERE sha256 = $1 AND user_id <> $2`,
        [sha256, exceptUserId],
      );
      return rows.map((r) => r.user_id);
    },
  };
}
