import { getDb, closeDb, query } from './src/lib/db';

async function main() {
  const { rows: logs } = await query<any>('intervention_logs', { experiment_id: '6a6970025aa1ba717baa79c6' });
  console.log('Total logs:', logs.length);
  for (const l of logs.slice(0, 10)) {
    console.log(`  group=${l.post_group} content="${(l.comment_content || '').substring(0, 40)}"`);
  }
  const nonControl = logs.filter((l: any) => l.post_group !== 'control');
  console.log('Non-control:', nonControl.length);
  if (nonControl.length > 0) {
    console.log('First non-control content:', nonControl[0].comment_content);
  }
  await closeDb();
}

main();
