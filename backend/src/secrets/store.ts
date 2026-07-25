import { sql } from "drizzle-orm"
import { db } from "../db.js"

export interface StoredConnection {
  host: string
  port: number
  database: string
  user: string
  password: string
  sslMode: string
}

function getEncryptionKey(): string {
  const key = process.env.SECRETS_ENCRYPTION_KEY
  if (!key) {
    throw new Error("SECRETS_ENCRYPTION_KEY is not set. Copy .env.example to .env and generate one.")
  }
  return key
}

// PROTOTYPE ONLY: encrypts connection credentials with pgcrypto in the same
// Neon database used for app data (see db/init.ts for the `pgcrypto`
// extension setup). This is the only module that should touch the
// `secrets` table or its encryption key — swap for a dedicated secrets
// manager (Vault/AWS Secrets Manager) before handling real customer
// production databases.

export async function storeConnectionSecret(dbInstanceId: string, conn: StoredConnection): Promise<void> {
  const key = getEncryptionKey()
  const payload = JSON.stringify(conn)

  await db.execute(sql`
    INSERT INTO secrets (db_instance_id, encrypted_connection)
    VALUES (${dbInstanceId}, encode(pgp_sym_encrypt(${payload}, ${key}), 'base64'))
    ON CONFLICT (db_instance_id)
    DO UPDATE SET encrypted_connection = excluded.encrypted_connection
  `)
}

export async function getConnectionSecret(dbInstanceId: string): Promise<StoredConnection | null> {
  const key = getEncryptionKey()

  const result = await db.execute<{ decrypted: string }>(sql`
    SELECT pgp_sym_decrypt(decode(encrypted_connection, 'base64'), ${key}) AS decrypted
    FROM secrets
    WHERE db_instance_id = ${dbInstanceId}
  `)

  const row = result.rows[0]
  if (!row) return null
  return JSON.parse(row.decrypted) as StoredConnection
}

export async function deleteConnectionSecret(dbInstanceId: string): Promise<void> {
  await db.execute(sql`DELETE FROM secrets WHERE db_instance_id = ${dbInstanceId}`)
}
