import { getDb, closeDb, query, deleteMany } from './src/lib/db';

async function main() {
  const eid = '6a696d9325e5ebf31e052c24';
  await getDb();
  
  // Delete posts
  const { rows: posts } = await query<any>('posts', { experiment_id: eid });
  for (const p of posts) {
    await deleteMany('post_snapshots', { post_id: p.id });
  }
  
  // Delete all experiment data
  await deleteMany('posts', { experiment_id: eid });
  await deleteMany('intervention_logs', { experiment_id: eid });
  
  console.log('Cleanup done for experiment:', eid);
  await closeDb();
}

main();
