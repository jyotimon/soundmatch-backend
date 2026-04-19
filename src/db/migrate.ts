import { readFileSync } from 'fs';
import { join } from 'path';
import { pool, connectDatabase } from './client';

async function migrate() {
  await connectDatabase();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✅  Schema applied successfully');
  await pool.end();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('❌  Migration failed:', err);
  process.exit(1);
});
